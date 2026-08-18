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
  return { messageId: null, heartbeatActivityId: null, toolActivityCounter: 0, collectedImagePaths: [] }
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
          if (!state.messageId) state.messageId = `${turnId}:m0`
          events.push({ ...base, type: 'assistant_delta', messageId: state.messageId, textDelta: classifiedEvent.text })
          break
        }

        case 'activity': {
          if (!state.heartbeatActivityId) {
            state.heartbeatActivityId = `${turnId}:heartbeat`
            events.push({ ...base, type: 'activity_started', activityId: state.heartbeatActivityId, label: classifiedEvent.label })
          } else {
            events.push({
              ...base,
              type: 'activity_updated',
              activityId: state.heartbeatActivityId,
              label: classifiedEvent.label,
              elapsedMs: classifiedEvent.elapsedMs
            })
          }
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
          if (state.collectedImagePaths.length > 0) {
            events.push({ ...base, type: 'response_artifacts', messageId: `${turnId}:artifacts`, images: [...state.collectedImagePaths] })
            state.collectedImagePaths = []
          }
          events.push({ ...base, type: 'turn_completed' })
          break

        case 'session_complete':
          // A safety-net fallback only: the process actually exiting.
          // exitCode 0 here means the process ended (e.g. the user closed
          // it) without turn_ready ever having fired for the in-flight turn
          // — still resolve it as complete rather than leaving it stuck.
          // isForActiveTurn silently drops this if turn_ready already
          // completed the turn, so this never double-fires a bubble.
          if (classifiedEvent.exitCode === 0 && state.collectedImagePaths.length > 0) {
            events.push({ ...base, type: 'response_artifacts', messageId: `${turnId}:artifacts`, images: [...state.collectedImagePaths] })
            state.collectedImagePaths = []
          }
          events.push(
            classifiedEvent.exitCode === 0
              ? { ...base, type: 'turn_completed' }
              : { ...base, type: 'turn_failed', reason: `Antigravity exited with code ${classifiedEvent.exitCode ?? 'unknown'}` }
          )
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
