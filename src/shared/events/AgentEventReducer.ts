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
import type { AgentChoice, AgentEvent } from './agent-event'
import type { MessageContent, SessionMessage } from '../types'
import { applyActivityEvent, categorizeToolLabel, createActivityState, resetActivity, type ActivityState } from './AgentActivityTracker'

export type DeliveryState = 'sending' | 'sent' | 'failed'
export type TurnStatus = 'submitted' | 'working' | 'streaming' | 'complete' | 'failed'

export interface AgentTurn {
  id: string
  sessionId: string
  userMessageId: string
  status: TurnStatus
  activityId: string
  assistantMessageId?: string
  startedAt: number
  completedAt?: number
}

export type ChatItem =
  | { kind: 'user'; id: string; text: string; deliveryState: DeliveryState; createdAt: number }
  | { kind: 'assistant'; id: string; text: string; createdAt: number }
  | { kind: 'system'; id: string; role: 'system' | 'error'; text: string; createdAt: number }
  | { kind: 'tool-activity'; id: string; tool: string; summary: string; detail: string; isError: boolean; createdAt: number }
  | { kind: 'interaction-record'; id: string; prompt: string; choiceLabel: string; createdAt: number }

export type PendingInteraction =
  | { kind: 'choice'; interactionId: string; prompt: string; options: AgentChoice[] }
  | { kind: 'permission'; interactionId: string; prompt: string; options: AgentChoice[] }
  | { kind: 'authentication'; message: string }
  | { kind: 'terminal_attention'; reason: string }

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
   *  against a CLI echo of the user's own prompt ever being misread as a
   *  genuine assistant reply. Classifiers already never emit an event for an
   *  echoed prompt line (confirmed against real captured transcripts), so
   *  this is defensive insurance, not the primary mechanism. Exact match
   *  only — a real reply that happens to quote part of the prompt back must
   *  not be suppressed. */
  recentUserPrompts: string[]
  pendingInteraction: PendingInteraction | null
  warning: string | null
  error: string | null
  isBusy: boolean
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
    isBusy: false
  }
}

function sessionMessageToChatItem(m: SessionMessage): ChatItem | null {
  const createdAt = Date.parse(m.createdAt) || 0
  const content: MessageContent = m.content
  switch (content.kind) {
    case 'text':
      if (m.role === 'user') return { kind: 'user', id: m.id, text: content.text, deliveryState: 'sent', createdAt }
      if (m.role === 'error') return { kind: 'system', id: m.id, role: 'error', text: content.text, createdAt }
      if (m.role === 'system') return { kind: 'system', id: m.id, role: 'system', text: content.text, createdAt }
      return { kind: 'assistant', id: m.id, text: content.text, createdAt }
    case 'activity':
      return { kind: 'tool-activity', id: m.id, tool: content.tool, summary: content.summary, detail: content.detail, isError: content.isError, createdAt }
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

function extractToolName(label: string): string {
  const match = label.match(/^([A-Za-z][\w]*)/)
  return match ? match[1] : label
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
  agentDisplayName: string
}

/** Step 1 of sending a prompt — inserts the user message and creates the
 *  turn + working indicator immediately, before any IPC/PTY round trip. */
export function beginSend(state: AgentEventReducerState, params: BeginSendParams, now: number = Date.now()): AgentEventReducerState {
  const activityId = `activity:${params.sessionId}:${params.turnId}`
  const turn: AgentTurn = {
    id: params.turnId,
    sessionId: params.sessionId,
    userMessageId: params.userMessageId,
    status: 'submitted',
    activityId,
    startedAt: now
  }
  const userItem: ChatItem = { kind: 'user', id: params.userMessageId, text: params.text, deliveryState: 'sending', createdAt: now }
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

/** Step 2 — the PTY write actually succeeded. */
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
  const activityId = `activity:${params.sessionId}:${params.turnId}`
  const turn: AgentTurn = {
    id: params.turnId,
    sessionId: params.sessionId,
    userMessageId: params.userMessageId,
    status: 'submitted',
    activityId,
    startedAt: now
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
  reason?: 'duplicate_sequence' | 'echo'
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
  if (event.type === 'assistant_message' && state.recentUserPrompts.includes(event.text.trim())) {
    return { state: seen, accepted: false, reason: 'echo' }
  }

  return { state: applyEvent(seen, event, now), accepted: true }
}

function applyEvent(state: AgentEventReducerState, event: AgentEvent, now: number): AgentEventReducerState {
  const turn = state.turn

  switch (event.type) {
    case 'assistant_message': {
      if (turn?.assistantMessageId) {
        return {
          ...state,
          items: updateItem(state.items, turn.assistantMessageId, (i) => (i.kind === 'assistant' ? { ...i, text: i.text + event.text } : i)),
          turn: { ...turn, status: 'streaming' }
        }
      }
      const id = turn ? `assistant:${turn.id}` : `assistant:orphan:${now}:${state.items.length}`
      const item: ChatItem = { kind: 'assistant', id, text: event.text, createdAt: now }
      return {
        ...state,
        items: [...state.items, item],
        turn: turn ? { ...turn, assistantMessageId: id, status: 'streaming' } : turn
      }
    }

    case 'activity': {
      return {
        ...state,
        activity: applyActivityEvent(state.activity, event, now),
        currentPhrase: 'Thinking…',
        turn: turn && turn.status === 'submitted' ? { ...turn, status: 'working' } : turn,
        isBusy: true
      }
    }

    case 'tool_activity': {
      const tool = extractToolName(event.label)
      const items =
        event.status === 'running'
          ? state.items
          : [
              ...state.items,
              {
                kind: 'tool-activity' as const,
                id: `tool:${turn?.id ?? now}:${state.items.length}`,
                tool,
                summary: event.status === 'error' ? `${tool} failed` : `Ran ${event.label}`,
                detail: event.label,
                isError: event.status === 'error',
                createdAt: now
              }
            ]
      return {
        ...state,
        items,
        activity: applyActivityEvent(state.activity, event, now),
        currentPhrase: phraseForToolLabel(event.label),
        turn: turn && turn.status === 'submitted' ? { ...turn, status: 'working' } : turn,
        isBusy: true
      }
    }

    case 'choice_required':
      return {
        ...state,
        isBusy: true,
        pendingInteraction: { kind: 'choice', interactionId: event.interactionId, prompt: event.prompt, options: event.options }
      }
    case 'permission_required':
      return {
        ...state,
        isBusy: true,
        pendingInteraction: { kind: 'permission', interactionId: event.interactionId, prompt: event.prompt, options: event.options }
      }
    case 'authentication_required':
      return { ...state, isBusy: true, pendingInteraction: { kind: 'authentication', message: event.message } }
    case 'terminal_attention_required':
      return { ...state, isBusy: true, pendingInteraction: { kind: 'terminal_attention', reason: event.reason } }

    case 'warning':
      return { ...state, warning: event.message }

    case 'error': {
      const item: ChatItem = { kind: 'system', id: `error:${now}:${state.items.length}`, role: 'error', text: event.message, createdAt: now }
      return {
        ...state,
        items: [...state.items, item],
        turn: turn ? { ...turn, status: 'failed', completedAt: now } : turn,
        currentPhrase: null,
        error: event.message,
        isBusy: false
      }
    }

    case 'session_complete':
      return {
        ...state,
        turn: turn ? { ...turn, status: 'complete', completedAt: now } : turn,
        currentPhrase: null,
        isBusy: false
      }

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
 *  session_complete/error) for a turn that's been open implausibly long,
 *  e.g. a process that wedged without ever exiting cleanly. */
export function forceCompleteStaleTurn(state: AgentEventReducerState, maxAgeMs: number, now: number = Date.now()): AgentEventReducerState {
  if (!state.turn || state.turn.status === 'complete' || state.turn.status === 'failed') return state
  if (now - state.turn.startedAt < maxAgeMs) return state
  return {
    ...state,
    turn: { ...state.turn, status: 'failed', completedAt: now },
    currentPhrase: null,
    warning: 'This turn timed out without the agent returning to an input-ready state.',
    isBusy: false
  }
}
