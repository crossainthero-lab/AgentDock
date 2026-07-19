// Translates AntigravityClassifier's output (the old flat, PTY-classified
// vocabulary — see classified-event.ts) into the shared, turn-scoped
// AgentEvent model the rest of the app speaks. This is where turnId/
// messageId bookkeeping lives for Antigravity — the PTY classification
// model has no native concept of either, unlike Claude/Codex's structured
// transports which get real ids straight from the protocol.
import type { AgentEvent } from '@shared/events/agent-event'
import type { ClassifiedScreenEvent } from './classified-event'

// Real captured tool-call shapes, confirmed live: "● Create(C:/scratch/
// capture-test.txt) (ctrl+o to expand)" and the equivalent for Edit —
// Antigravity has no dedicated generated-image directory the way Codex
// does (confirmed: no such thing was ever found), so a genuine response
// image is just a file the model itself created/edited in the workspace,
// named in its own tool-call line. Only Create/Edit are treated as
// candidates — a Read or other tool naming an image path isn't Antigravity
// producing an image, just looking at an existing one.
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
function extractCreatedOrEditedImagePath(label: string): string | null {
  const match = label.match(/^(?:Create|Edit)\(([^)]+)\)$/)
  if (!match) return null
  const path = match[1].trim()
  const dot = path.lastIndexOf('.')
  const ext = dot === -1 ? '' : path.slice(dot).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext) ? path : null
}

export interface AntigravityMapperState {
  /** Set lazily on the first classified assistant_message this turn — every
   *  later one this same turn appends as another delta to it, deliberately
   *  collapsing to one bubble per turn (matching today's shipped behavior).
   *  PTY chunk boundaries are scan-timing artifacts, not a reliable "this is
   *  a new logical message" signal the way Claude/Codex's real message ids
   *  are, so splitting into multiple bubbles here isn't attempted. */
  messageId: string | null
  /** All assistant text streamed so far this turn, concatenated in the same
   *  order as the assistant_delta events built from it — CRITICAL (real bug
   *  fix): session-service.ts only ever persists an assistant message from
   *  an `assistant_completed` event, exactly like Claude/Codex; a turn that
   *  only emitted `assistant_delta` (this mapper's only output before this
   *  fix) left the reply visible purely in the renderer's live in-memory
   *  state and never actually saved to messageRepo — surviving neither a
   *  session-switch reseed nor an app restart. Flushed as `assistant_completed`
   *  when the turn resolves (turn_ready/session_complete), same messageId as
   *  the deltas so the renderer's already-existing bubble absorbs it as a
   *  no-op (see AgentEventReducer's assistant_completed case) while
   *  session-service still gets the full text to persist. */
  accumulatedText: string
  /** The most recent individual assistant_message chunk's own text (not the
   *  whole accumulated history) — CRITICAL (real bug fix, proven via a real
   *  captured session): agy redraws a reply-in-progress line in place as it
   *  grows (e.g. "Here is the summary:" becomes "Here is the summary: the
   *  full text." in a later snapshot of the SAME logical line) — these are
   *  textually different strings, so the exact-match dedup above correctly
   *  does not treat the second as a duplicate, but naively appending it
   *  would duplicate the shared prefix ("Here is the summary:Here is the
   *  summary: the full text."). Tracked separately so a growing chunk can
   *  be recognized and only its genuinely new suffix appended — the
   *  "replace cumulative snapshots" behavior real streaming needs. */
  lastAssistantMessageText: string
  /** True once this turn has been resolved via turn_ready or session_complete
   *  — CRITICAL (real bug fix): `this.mapperState` on the adapter is a plain
   *  field, not cleared until the *next* send(), so if the underlying agy
   *  process eventually exits for any reason (idle timeout, agy's own
   *  /exit, the whole app quitting) well after a turn already resolved via
   *  turn_ready, the adapter's onExit handler runs session_complete through
   *  this same, by-then-stale state — without this guard it would silently
   *  re-emit (and re-persist, via session-service's assistant_completed/
   *  response_artifacts/turn_completed handling) the same already-completed
   *  turn's message and images a second time. */
  resolved: boolean
  /** Set lazily on the first classified `activity` (generic thinking/busy
   *  heartbeat) this turn — later ones update the same activity row rather
   *  than adding another. */
  heartbeatActivityId: string | null
  toolActivityCounter: number
  /** Image paths discovered from real Create/Edit tool-call lines so far
   *  this turn, in the order Antigravity produced them — flushed as one
   *  response_artifacts event when the turn resolves (turn_ready/
   *  session_complete), the same "discovered during the turn, emitted once
   *  at completion" shape Codex's generated-image work uses. */
  collectedImagePaths: string[]
}

export function createAntigravityMapperState(): AntigravityMapperState {
  return {
    messageId: null,
    accumulatedText: '',
    lastAssistantMessageText: '',
    resolved: false,
    heartbeatActivityId: null,
    toolActivityCounter: 0,
    collectedImagePaths: []
  }
}

export const AntigravityEventMapper = {
  map(
    classified: ClassifiedScreenEvent[],
    prev: AntigravityMapperState,
    sessionId: string,
    turnId: string
  ): { events: AgentEvent[]; state: AntigravityMapperState } {
    const state = { ...prev }
    const base = { sessionId, turnId }
    const events: AgentEvent[] = []

    for (const classifiedEvent of classified) {
      switch (classifiedEvent.type) {
        case 'assistant_message': {
          // CRITICAL (real bug fix): the classifier's line-diffing can, in
          // rare cases (a full-screen clear/redraw mid-turn — confirmed via
          // real capture that agy does issue these), re-expose buffer
          // content it already emitted earlier this same turn as if it
          // were newly-arrived text. A blind, unconditional append would
          // duplicate that text straight into the visible reply — this
          // skips a chunk that's already present verbatim in what's been
          // accumulated so far this turn, the deduplication the task
          // explicitly calls for ("never replay previous transcript
          // history into the current bubble").
          if (classifiedEvent.text && state.accumulatedText.includes(classifiedEvent.text)) break

          // CRITICAL (real bug fix — see lastAssistantMessageText's doc
          // comment): a growing redraw of the SAME logical line ("X" then
          // later "X extended.") must only contribute its new suffix, not
          // the whole thing again.
          let delta = classifiedEvent.text
          if (delta && state.lastAssistantMessageText && delta.startsWith(state.lastAssistantMessageText)) {
            delta = delta.slice(state.lastAssistantMessageText.length)
          }
          if (!delta) break

          if (!state.messageId) state.messageId = `${turnId}:m0`
          state.accumulatedText += delta
          state.lastAssistantMessageText = classifiedEvent.text
          events.push({ ...base, type: 'assistant_delta', messageId: state.messageId, textDelta: delta })
          break
        }

        case 'activity': {
          // Deliberately only ever `activity_updated`, never
          // `activity_started` — this is a generic "still working, nothing
          // specific classified yet" heartbeat (see busyHeartbeatEvent), not
          // a real tool call. `activity_started` would create a permanent
          // tool-activity ChatItem with no real tool name to show (the
          // reducer falls back to the raw label, producing a nonsense
          // "Ran Working" line — a real bug found via live testing).
          // `activity_updated` still drives the ticker/currentPhrase and the
          // ActivityTracker summary correctly (see AgentActivityTracker) — it
          // just never has a prior item to attach to, which is a safe no-op.
          if (!state.heartbeatActivityId) state.heartbeatActivityId = `${turnId}:heartbeat`
          events.push({
            ...base,
            type: 'activity_updated',
            activityId: state.heartbeatActivityId,
            label: classifiedEvent.label,
            elapsedMs: classifiedEvent.elapsedMs
          })
          break
        }

        case 'tool_activity': {
          // The classifier only ever reports a settled done/error call, never
          // 'running' — synthesize the started+completed pair together.
          const activityId = `${turnId}:tool:${state.toolActivityCounter++}`
          const tool = extractToolName(classifiedEvent.label)
          events.push({ ...base, type: 'activity_started', activityId, label: classifiedEvent.label, tool })
          events.push({
            ...base,
            type: 'activity_completed',
            activityId,
            label: classifiedEvent.label,
            tool,
            status: classifiedEvent.status === 'error' ? 'error' : 'done'
          })
          if (classifiedEvent.status !== 'error') {
            const imagePath = extractCreatedOrEditedImagePath(classifiedEvent.label)
            if (imagePath && !state.collectedImagePaths.includes(imagePath)) state.collectedImagePaths.push(imagePath)
          }
          break
        }

        case 'choice_required':
          events.push({
            ...base,
            type: 'interaction_required',
            interaction: { kind: 'choice', interactionId: classifiedEvent.interactionId, prompt: classifiedEvent.prompt, options: classifiedEvent.options }
          })
          break

        case 'permission_required':
          events.push({
            ...base,
            type: 'interaction_required',
            interaction: { kind: 'permission', interactionId: classifiedEvent.interactionId, prompt: classifiedEvent.prompt, options: classifiedEvent.options }
          })
          break

        case 'authentication_required':
          events.push({
            ...base,
            type: 'interaction_required',
            interaction: { kind: 'authentication', interactionId: `${turnId}:auth`, message: classifiedEvent.message }
          })
          break

        case 'terminal_attention_required':
          events.push({
            ...base,
            type: 'interaction_required',
            interaction: { kind: 'terminal_attention', interactionId: `${turnId}:attention`, reason: classifiedEvent.reason }
          })
          break

        case 'warning':
          // No UI consumer of a bare warning today (before or after this
          // migration) — dropped rather than surfaced as a fake activity.
          break

        case 'error':
          events.push({ ...base, type: 'turn_failed', reason: classifiedEvent.message })
          break

        case 'turn_ready':
          // The primary, live completion signal (see classified-event.ts's
          // doc comment) — fires while the process is still running, for
          // every turn including the first. Any images discovered from
          // real Create/Edit tool calls this turn are flushed first, so
          // they land on their own message right before the turn resolves.
          if (state.messageId) {
            events.push({ ...base, type: 'assistant_completed', messageId: state.messageId, text: state.accumulatedText })
          }
          if (state.collectedImagePaths.length > 0) {
            events.push({ ...base, type: 'response_artifacts', messageId: `${turnId}:artifacts`, images: [...state.collectedImagePaths] })
            state.collectedImagePaths = []
          }
          events.push({ ...base, type: 'turn_completed' })
          state.resolved = true
          break

        case 'session_complete':
          // A safety-net fallback only: the process actually exiting.
          // exitCode 0 here means the process ended (e.g. the user closed
          // it) without turn_ready ever having fired for the in-flight turn
          // — still resolve it as complete rather than leaving it stuck.
          // Guarded by `resolved` (see its doc comment) so a stale exit long
          // after turn_ready already resolved this same turn — the process
          // stays alive and gets reused across turns, so this can arrive
          // arbitrarily late — never re-emits/re-persists a duplicate.
          if (state.resolved) break
          if (classifiedEvent.exitCode === 0 && state.messageId) {
            events.push({ ...base, type: 'assistant_completed', messageId: state.messageId, text: state.accumulatedText })
          }
          if (classifiedEvent.exitCode === 0 && state.collectedImagePaths.length > 0) {
            events.push({ ...base, type: 'response_artifacts', messageId: `${turnId}:artifacts`, images: [...state.collectedImagePaths] })
            state.collectedImagePaths = []
          }
          events.push(
            classifiedEvent.exitCode === 0
              ? { ...base, type: 'turn_completed' }
              : { ...base, type: 'turn_failed', reason: `Antigravity exited with code ${classifiedEvent.exitCode ?? 'unknown'}` }
          )
          state.resolved = true
          break
      }
    }

    return { events, state }
  }
}

function extractToolName(label: string): string {
  const match = label.match(/^([A-Za-z][\w]*)/)
  return match ? match[1] : label
}
