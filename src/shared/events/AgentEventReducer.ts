// The renderer's single source of truth for a session's visible chat state:
// user/assistant messages, tool activity, pending interactions, and the
// active turn. Pure and side-effect free (no React/DOM dependency) so it's
// unit-testable on its own, reusable by any consumer, and — critically — so
// there is exactly one place that decides what counts as "a new message"
// instead of the renderer reconstructing state from raw events itself.
//
// Ownership model: `items` is seeded ONCE from persisted history
// (seedFromPersisted, called on mount/session-switch only) and from then on
// mutated incrementally by local actions (beginSend/markSent/markFailed) and
// incoming events (applyEnvelope) — never wholesale re-fetched from the
// database in reaction to a live event. That's the fix for both "user
// message doesn't appear immediately" (it's inserted locally the instant
// send is requested, before any IPC round trip) and "assistant reply shows
// twice" (there is no second, disjoint "pending text" render path that a
// later DB reload could duplicate against).
//
// MessageAssembler model: there is no separate assembler data structure.
// `items` plus `updateItem` (below) already does exactly what per-message
// assembly needs — every assistant message and every activity is addressed
// by its transport-supplied `messageId`/`activityId`, found-or-created in
// `items` on first sight, then updated in place. This lets one turn produce
// N assistant bubbles and N activities (a real agentic loop: text → tool
// call → more text), which is a strictly more correct rendering than the
// old one-bubble-per-turn model and requires no extra bookkeeping beyond
// what `items` already tracks.
//
// Turn-scoping guard: every `AgentEvent` carries `sessionId`+`turnId`.
// `isForActiveTurn` (below) rejects any event whose `turnId` doesn't match
// the currently-open turn, or whose turn has already reached a terminal
// status. This is what makes "a response cannot contain output from two
// turns" and "a completed turn rejects stale deltas" true by construction —
// previously nothing correlated an incoming event to a specific turn at
// all, which was an undocumented second contributor (alongside the PTY
// reflow bug) to cross-turn message corruption.
import type { ActivityDetail, AgentChoice, AgentEvent, AgentInteraction } from './agent-event'
import type { MessageContent, SessionMessage } from '../types'
import { applyActivityEvent, categorizeToolLabel, createActivityState, resetActivity, type ActivityState } from './AgentActivityTracker'

export type DeliveryState = 'sending' | 'sent' | 'failed'
export type TurnStatus = 'submitted' | 'working' | 'streaming' | 'awaiting_interaction' | 'complete' | 'failed'

export interface AgentTurn {
  id: string
  sessionId: string
  userMessageId: string
  status: TurnStatus
  startedAt: number
  completedAt?: number
  /** Wall-clock time of the most recent event actually applied for this
   *  turn (bumped in applyEnvelope, right before applyEvent runs) — never
   *  regresses to startedAt on its own. This, not startedAt, is what
   *  forceCompleteStaleTurn measures staleness against: a real, long-running
   *  turn that keeps producing activity/deltas every so often must never be
   *  force-completed out from under it just because its TOTAL duration
   *  crossed a fixed threshold — only genuine silence (no events at all for
   *  that long) means the process is actually wedged. See
   *  forceCompleteStaleTurn's own doc comment for the full story (a real bug
   *  this fixes: a long Codex turn that legitimately produced multiple
   *  streamed updates over several minutes was being cut off mid-stream). */
  lastEventAt: number
}

export type ChatItem =
  | {
      kind: 'user'
      id: string
      text: string
      /** The user-typed task alone, when this message's delivered `text`
       *  carries additional internal context (a handoff continuation
       *  envelope) the user never wrote — see MessageContent's own doc
       *  comment. Renderers should always prefer this over `text` when
       *  present. */
      displayText?: string
      images?: string[]
      deliveryState: DeliveryState
      createdAt: number
    }
  | { kind: 'assistant'; id: string; text: string; responseImages?: string[]; createdAt: number }
  | { kind: 'system'; id: string; role: 'system' | 'error'; text: string; createdAt: number }
  | {
      kind: 'tool-activity'
      id: string
      tool: string
      summary: string
      detail: string
      isError: boolean
      createdAt: number
      richDetail?: ActivityDetail
    }
  | { kind: 'interaction-record'; id: string; prompt: string; choiceLabel: string; createdAt: number }

export type PendingInteraction =
  | { kind: 'choice'; interactionId: string; prompt: string; options: AgentChoice[] }
  | { kind: 'permission'; interactionId: string; prompt: string; options: AgentChoice[] }
  | { kind: 'authentication'; message: string }
  | { kind: 'terminal_attention'; reason: string }

function pendingInteractionFrom(interaction: AgentInteraction): PendingInteraction {
  switch (interaction.kind) {
    case 'choice':
      return { kind: 'choice', interactionId: interaction.interactionId, prompt: interaction.prompt, options: interaction.options }
    case 'permission':
      return { kind: 'permission', interactionId: interaction.interactionId, prompt: interaction.prompt, options: interaction.options }
    case 'authentication':
      return { kind: 'authentication', message: interaction.message }
    case 'terminal_attention':
      return { kind: 'terminal_attention', reason: interaction.reason }
  }
}

export interface AgentEventReducerState {
  items: ChatItem[]
  turn: AgentTurn | null
  /** Short, present-tense status text ("Thinking…", "Reading files…") —
   *  the primary text ActivityTicker shows. Distinct from the richer
   *  "Worked for Ns · Read N files" aggregate `summarizeActivity` still
   *  produces from `activity` below, which remains available for a more
   *  detailed view but isn't the primary ticker text anymore. */
  currentPhrase: string | null
  activity: ActivityState
  /** Highest envelope sequence already applied for this session — anything
   *  at or below this is a duplicate/out-of-order redelivery, dropped. */
  lastSequence: number
  /** Ring buffer (last 50) of applied eventIds — belt-and-suspenders dedup
   *  alongside `lastSequence`, in case something ever redelivers the same
   *  event under a new sequence number rather than the same one. */
  seenEventIds: string[]
  /** Ring buffer (last 5) of exact submitted-prompt text — belt-and-suspenders
   *  against a PTY-classified echo of the user's own prompt ever being
   *  misread as a genuine assistant reply (Antigravity's classifier path;
   *  a no-op for Claude/Codex's structured deltas, which can never contain
   *  a literal echoed prompt line). Exact match only — a real reply that
   *  happens to quote part of the prompt back must not be suppressed. */
  recentUserPrompts: string[]
  pendingInteraction: PendingInteraction | null
  warning: string | null
  error: string | null
  isBusy: boolean
  /** The real model in use, as reported by the transport's own system/init
   *  message — null until the first one arrives, never guessed. */
  currentModel: string | null
  /** The real reasoning effort in use for the current model (Codex only
   *  today) — null until reported, never guessed. */
  currentReasoningEffort: string | null
  /** The real, effective permission mode reported the same way — may differ
   *  from what AgentDock requested (e.g. a policy override). */
  currentPermissionMode: string | null
}

export function createReducerState(): AgentEventReducerState {
  return {
    items: [],
    turn: null,
    currentPhrase: null,
    activity: createActivityState(),
    lastSequence: -1,
    seenEventIds: [],
    recentUserPrompts: [],
    pendingInteraction: null,
    warning: null,
    error: null,
    isBusy: false,
    currentModel: null,
    currentReasoningEffort: null,
    currentPermissionMode: null
  }
}

function sessionMessageToChatItem(m: SessionMessage): ChatItem | null {
  const createdAt = Date.parse(m.createdAt) || 0
  const content: MessageContent = m.content
  switch (content.kind) {
    case 'text':
      if (m.role === 'user')
        return {
          kind: 'user',
          id: m.id,
          text: content.text,
          displayText: content.displayText,
          images: content.images,
          deliveryState: 'sent',
          createdAt
        }
      if (m.role === 'error') return { kind: 'system', id: m.id, role: 'error', text: content.text, createdAt }
      if (m.role === 'system') return { kind: 'system', id: m.id, role: 'system', text: content.text, createdAt }
      return { kind: 'assistant', id: m.id, text: content.text, responseImages: content.responseImages, createdAt }
    case 'activity':
      return {
        kind: 'tool-activity',
        id: m.id,
        tool: content.tool,
        summary: content.summary,
        detail: content.detail,
        isError: content.isError,
        createdAt,
        richDetail: content.richDetail
      }
    case 'interaction-record':
      return { kind: 'interaction-record', id: m.id, prompt: content.prompt, choiceLabel: content.choiceLabel, createdAt }
    default:
      return null
  }
}

/** Seeds the store from persisted history. Call once on mount or when
 *  switching to a different session — never again while that mount is
 *  showing live events (see the module comment above). */
export function seedFromPersisted(messages: SessionMessage[]): AgentEventReducerState {
  const state = createReducerState()
  state.items = messages.map(sessionMessageToChatItem).filter((i): i is ChatItem => i !== null)
  return state
}

function updateItem(items: ChatItem[], id: string, updater: (item: ChatItem) => ChatItem): ChatItem[] {
  return items.map((item) => (item.id === id ? updater(item) : item))
}

function hasItem(items: ChatItem[], id: string): boolean {
  return items.some((item) => item.id === id)
}

function phraseForToolLabel(label: string): string {
  switch (categorizeToolLabel(label)) {
    case 'read':
      return 'Reading files…'
    case 'edit':
      return 'Editing files…'
    case 'exec':
      return 'Running command…'
    default:
      return 'Reviewing changes…'
  }
}

export interface BeginSendParams {
  sessionId: string
  userMessageId: string
  turnId: string
  text: string
  /** See ChatItem's own doc comment — the user-typed task alone, when it
   *  differs from the full `text` actually being delivered (a handoff
   *  continuation). */
  displayText?: string
  images?: string[]
  agentDisplayName: string
}

/** Step 1 of sending a prompt — inserts the user message and creates the
 *  turn + working indicator immediately, before any IPC/PTY round trip. */
export function beginSend(state: AgentEventReducerState, params: BeginSendParams, now: number = Date.now()): AgentEventReducerState {
  const turn: AgentTurn = {
    id: params.turnId,
    sessionId: params.sessionId,
    userMessageId: params.userMessageId,
    status: 'submitted',
    startedAt: now,
    lastEventAt: now
  }
  const userItem: ChatItem = {
    kind: 'user',
    id: params.userMessageId,
    text: params.text,
    displayText: params.displayText,
    images: params.images,
    deliveryState: 'sending',
    createdAt: now
  }
  return {
    ...state,
    items: [...state.items, userItem],
    turn,
    currentPhrase: `${params.agentDisplayName} is working…`,
    activity: resetActivity(),
    recentUserPrompts: [...state.recentUserPrompts, params.text.trim()].slice(-5),
    pendingInteraction: null,
    warning: null,
    error: null,
    isBusy: true
  }
}

/** Step 2 — the IPC send actually succeeded (main process accepted it and
 *  started/resumed the transport). */
export function markSent(state: AgentEventReducerState, userMessageId: string): AgentEventReducerState {
  return {
    ...state,
    items: updateItem(state.items, userMessageId, (i) => (i.kind === 'user' ? { ...i, deliveryState: 'sent' } : i)),
    turn: state.turn && state.turn.userMessageId === userMessageId ? { ...state.turn, status: 'working' } : state.turn
  }
}

/** Step 2 (failure path) — the send genuinely failed (process couldn't be
 *  reached/spawned). The user message and its retry affordance stay visible. */
export function markFailed(state: AgentEventReducerState, userMessageId: string, message: string, now: number = Date.now()): AgentEventReducerState {
  return {
    ...state,
    items: updateItem(state.items, userMessageId, (i) => (i.kind === 'user' ? { ...i, deliveryState: 'failed' } : i)),
    turn: state.turn && state.turn.userMessageId === userMessageId ? { ...state.turn, status: 'failed', completedAt: now } : state.turn,
    currentPhrase: null,
    error: message,
    isBusy: false
  }
}

/** Retries a previously-failed send — reuses the same user message item
 *  (transitions it back to 'sending' in place) rather than creating a new
 *  bubble, but opens a fresh turn since it's a new attempt at delivery. */
export function beginRetry(
  state: AgentEventReducerState,
  params: { sessionId: string; userMessageId: string; text: string; turnId: string; agentDisplayName: string },
  now: number = Date.now()
): AgentEventReducerState {
  const turn: AgentTurn = {
    id: params.turnId,
    sessionId: params.sessionId,
    userMessageId: params.userMessageId,
    status: 'submitted',
    startedAt: now,
    lastEventAt: now
  }
  return {
    ...state,
    items: updateItem(state.items, params.userMessageId, (i) => (i.kind === 'user' ? { ...i, deliveryState: 'sending' } : i)),
    turn,
    currentPhrase: `${params.agentDisplayName} is working…`,
    activity: resetActivity(),
    recentUserPrompts: [...state.recentUserPrompts, params.text.trim()].slice(-5),
    pendingInteraction: null,
    warning: null,
    error: null,
    isBusy: true
  }
}

export interface ApplyEnvelopeResult {
  state: AgentEventReducerState
  accepted: boolean
  reason?: 'duplicate_sequence' | 'echo' | 'stale_turn'
}

/** True only while `event.turnId` names the currently-open turn and that
 *  turn hasn't already reached a terminal status — the guard that stops a
 *  stray/late/wrong-turn event from ever mutating the wrong message. */
function isForActiveTurn(state: AgentEventReducerState, event: AgentEvent): boolean {
  const turn = state.turn
  return !!turn && turn.id === event.turnId && turn.status !== 'complete' && turn.status !== 'failed'
}

/** Applies one incoming (sequence, event) pair. Returns whether it was
 *  accepted so the caller can emit the matching trace entry
 *  (EVENT_ACCEPTED / EVENT_DROPPED_AS_DUPLICATE) — this function stays pure,
 *  it doesn't push trace entries itself. */
export function applyEnvelope(
  state: AgentEventReducerState,
  envelope: { event: AgentEvent; sequence: number; eventId?: string },
  now: number = Date.now()
): ApplyEnvelopeResult {
  if (envelope.sequence <= state.lastSequence) {
    return { state, accepted: false, reason: 'duplicate_sequence' }
  }
  if (envelope.eventId && state.seenEventIds.includes(envelope.eventId)) {
    return { state, accepted: false, reason: 'duplicate_sequence' }
  }
  const seen = {
    ...state,
    lastSequence: envelope.sequence,
    seenEventIds: envelope.eventId ? [...state.seenEventIds, envelope.eventId].slice(-50) : state.seenEventIds
  }

  const event = envelope.event

  if (!isForActiveTurn(seen, event)) {
    return { state: seen, accepted: false, reason: 'stale_turn' }
  }

  if (event.type === 'assistant_delta' && state.recentUserPrompts.includes(event.textDelta.trim())) {
    return { state: seen, accepted: false, reason: 'echo' }
  }

  // Real, fresh evidence the agent is still alive and making progress —
  // bumped for every accepted event, not just deltas, since a long turn can
  // go quiet on text while still emitting activity (tool calls, reasoning
  // steps). This is what forceCompleteStaleTurn measures against instead of
  // startedAt (see AgentTurn.lastEventAt's doc comment).
  const withFreshActivity = seen.turn ? { ...seen, turn: { ...seen.turn, lastEventAt: now } } : seen

  return { state: applyEvent(withFreshActivity, event, now), accepted: true }
}

/** Transport-supplied ids (`messageId`/`activityId`) are only guaranteed
 *  unique *within* a turn — Codex's `item.id`s (`item_0`, `item_1`, ...)
 *  restart from zero every turn, so a raw id can collide across turns. All
 *  item lookups/creations below go through this turn-qualified key instead
 *  of the raw transport id, so a same-numbered item from a different turn
 *  can never be found-and-merged into. */
function scopedId(turnId: string, rawId: string): string {
  return `${turnId}:${rawId}`
}

function applyEvent(state: AgentEventReducerState, event: AgentEvent, now: number): AgentEventReducerState {
  const turn = state.turn
  if (!turn) return state

  switch (event.type) {
    case 'turn_started': {
      // Never regress a turn that's already streaming/awaiting interaction
      // back down to 'working' — this can arrive after the first delta if
      // the transport's own "started" event happens to be delivered late.
      if (turn.status !== 'submitted') return state
      return { ...state, turn: { ...turn, status: 'working' }, isBusy: true }
    }

    case 'assistant_delta': {
      const id = scopedId(turn.id, event.messageId)
      if (hasItem(state.items, id)) {
        return {
          ...state,
          items: updateItem(state.items, id, (i) => (i.kind === 'assistant' ? { ...i, text: i.text + event.textDelta } : i)),
          turn: { ...turn, status: 'streaming' },
          isBusy: true
        }
      }
      const item: ChatItem = { kind: 'assistant', id, text: event.textDelta, createdAt: now }
      return { ...state, items: [...state.items, item], turn: { ...turn, status: 'streaming' }, isBusy: true }
    }

    case 'assistant_completed': {
      // The transport's final/authoritative text for this message. If
      // deltas already streamed it, the accumulated text IS the final text
      // — never re-appended or overwritten here (that's the literal "final
      // result must not duplicate streamed text" rule). Only used to seed
      // the message if no delta ever arrived for it (Codex's normal path —
      // it delivers full text in one `item.completed`, never streams).
      const id = scopedId(turn.id, event.messageId)
      if (hasItem(state.items, id)) return state
      const item: ChatItem = { kind: 'assistant', id, text: event.text, createdAt: now }
      return { ...state, items: [...state.items, item] }
    }

    // A new bubble, not merged into the preceding assistant_completed item —
    // discovered only after that item already exists (a directory diff at
    // turn.completed, well after the text arrived), and items are addressed
    // by id/found-or-created, never mutated after the fact once inserted
    // (see the module comment's MessageAssembler model) — a fresh id keeps
    // this consistent with that rule instead of special-casing an update.
    case 'response_artifacts': {
      const id = scopedId(turn.id, event.messageId)
      if (hasItem(state.items, id)) return state
      const item: ChatItem = { kind: 'assistant', id, text: '', responseImages: event.images, createdAt: now }
      return { ...state, items: [...state.items, item] }
    }

    case 'activity_started': {
      const id = scopedId(turn.id, event.activityId)
      const item: ChatItem = {
        kind: 'tool-activity',
        id,
        tool: event.tool ?? event.label,
        summary: `Running ${event.label}…`,
        detail: event.label,
        isError: false,
        createdAt: now,
        richDetail: event.detail
      }
      return {
        ...state,
        items: hasItem(state.items, id) ? state.items : [...state.items, item],
        activity: applyActivityEvent(state.activity, event, now),
        currentPhrase: phraseForToolLabel(event.label),
        turn: { ...turn, status: turn.status === 'submitted' ? 'working' : turn.status },
        isBusy: true
      }
    }

    case 'activity_updated': {
      return {
        ...state,
        items: updateItem(state.items, scopedId(turn.id, event.activityId), (i) =>
          i.kind === 'tool-activity' ? { ...i, detail: event.label ?? i.detail, richDetail: event.detail ?? i.richDetail } : i
        ),
        activity: applyActivityEvent(state.activity, event, now),
        currentPhrase: event.label ? phraseForToolLabel(event.label) : state.currentPhrase,
        isBusy: true
      }
    }

    case 'activity_completed': {
      return {
        ...state,
        items: updateItem(state.items, scopedId(turn.id, event.activityId), (i) => {
          if (i.kind !== 'tool-activity') return i
          return {
            ...i,
            summary: event.summary ?? (event.status === 'error' ? `${i.tool} failed` : `Ran ${i.detail}`),
            isError: event.status === 'error',
            richDetail: event.detail ?? i.richDetail
          }
        }),
        activity: applyActivityEvent(state.activity, event, now),
        isBusy: true
      }
    }

    case 'interaction_required':
      return {
        ...state,
        isBusy: true,
        pendingInteraction: pendingInteractionFrom(event.interaction),
        turn: { ...turn, status: 'awaiting_interaction' }
      }

    case 'turn_completed':
      return {
        ...state,
        turn: { ...turn, status: 'complete', completedAt: now },
        currentPhrase: null,
        isBusy: false
      }

    case 'turn_failed': {
      const item: ChatItem = { kind: 'system', id: `error:${turn.id}`, role: 'error', text: event.reason, createdAt: now }
      return {
        ...state,
        items: [...state.items, item],
        turn: { ...turn, status: 'failed', completedAt: now },
        currentPhrase: null,
        error: event.reason,
        isBusy: false
      }
    }

    // A user-initiated Stop/Interrupt — not an error, so unlike turn_failed
    // this adds no red error bubble to the transcript.
    case 'turn_cancelled':
      return {
        ...state,
        turn: { ...turn, status: 'failed', completedAt: now },
        currentPhrase: null,
        isBusy: false
      }

    // The underlying process/query ended unexpectedly (crash, killed
    // externally) with no result and no user-initiated stop — genuinely
    // distinct from both a clean completion and a cancellation.
    case 'turn_exited': {
      const item: ChatItem = { kind: 'system', id: `error:${turn.id}`, role: 'error', text: event.reason, createdAt: now }
      return {
        ...state,
        items: [...state.items, item],
        turn: { ...turn, status: 'failed', completedAt: now },
        currentPhrase: null,
        error: event.reason,
        isBusy: false
      }
    }

    case 'model_info':
      return { ...state, currentModel: event.model, currentReasoningEffort: event.reasoningEffort ?? state.currentReasoningEffort }

    case 'permission_mode_info':
      return { ...state, currentPermissionMode: event.permissionMode }

    default:
      return state
  }
}

/** Clears an interaction once the user has answered it (locally, optimistic —
 *  doesn't wait for a round trip through the agent process). */
export function clearPendingInteraction(state: AgentEventReducerState): AgentEventReducerState {
  return { ...state, pendingInteraction: null }
}

/** Fallback-only safety net (never the primary completion signal — that's
 *  turn_completed/turn_failed) for a turn that's gone genuinely SILENT for
 *  implausibly long — e.g. a process that wedged without ever exiting
 *  cleanly.
 *
 *  CRITICAL (real bug fix): this used to measure elapsed time since
 *  turn.startedAt — the turn's TOTAL duration — rather than since its most
 *  recent activity. A real Codex turn given a task big enough to produce
 *  several minutes' worth of streamed updates (multiple tool calls,
 *  reasoning steps, deltas) was being force-failed mid-stream the moment its
 *  total wall-clock age crossed maxAgeMs, even though it kept emitting
 *  genuine events the entire time — after which every one of its real,
 *  still-arriving events was rejected as stale_turn (the turn's status was
 *  now 'failed'), so the response looked cut off and the user had to
 *  manually ask the agent to continue. Measuring from lastEventAt instead
 *  means only genuine SILENCE (no events at all) for maxAgeMs ever trips
 *  this — a turn that keeps producing anything, however slowly, never gets
 *  force-completed out from under it. */
export function forceCompleteStaleTurn(state: AgentEventReducerState, maxAgeMs: number, now: number = Date.now()): AgentEventReducerState {
  if (!state.turn || state.turn.status === 'complete' || state.turn.status === 'failed') return state
  // A real pending permission/question can legitimately take longer than
  // the staleness window to answer — never force-fail out from under it.
  if (state.turn.status === 'awaiting_interaction') return state
  if (now - state.turn.lastEventAt < maxAgeMs) return state
  return {
    ...state,
    turn: { ...state.turn, status: 'failed', completedAt: now },
    currentPhrase: null,
    warning: 'This turn timed out without the agent returning to an input-ready state.',
    isBusy: false
  }
}
