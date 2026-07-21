// The renderer's per-session conversation store — lives for the lifetime of
// the app (module-level Map), NOT for the lifetime of whichever component
// happens to have a session open.
//
// CRITICAL (real bug fix, found via a reproduction test — see
// tests/renderer/conversationStore.test.ts): the previous design kept this
// state in a `useState` local to `useSessionConversation`, reseeded from
// scratch (`seedFromPersisted`) on every mount, including every time the
// user switched back to a session they'd merely navigated away from. That
// reseed wipes `reducer.turn` back to null. Since every AgentEvent is
// turn-scoped (`AgentEventReducer.isForActiveTurn` requires
// `state.turn.id === event.turnId`), a turn that was genuinely still
// in-flight at the moment of the switch could *never* be matched again —
// every remaining delta, activity update, and even the final
// turn_completed/turn_failed for it was silently dropped as "stale_turn".
// The reply was still correctly persisted server-side the instant it
// happened (session-service.ts's messageRepo.add calls don't depend on
// anything in the renderer), so the only symptom visible to the user was
// "the response never showed up in the open chat" — until some *later*
// action re-ran a fresh `session.get()` (switching away and back yet again,
// or restarting the app) and re-seeded from the by-then-complete DB rows.
// That exactly matches the reported bug: saved but not shown, fixed only by
// an unrelated refresh.
//
// The fix: a session's live reducer state, and its `session.onEvent`/
// `onTrace` subscriptions, are created ONCE per session id and never torn
// down just because the component watching them unmounted (mirrors
// ipc/session.ts's `wired` Set on the main-process side, which already
// keeps exactly one forwarding subscription alive for a session's whole
// life). `seedFromPersisted` now only ever runs the first time a given
// session is opened in this app run; every subsequent switch back to it
// reuses the same, still-live entry — so a turn that kept streaming while
// the user was looking at a different session is caught up correctly, not
// wiped.
import { getAgentDock } from '../lib/agentDockClient'
import type { Session, SessionStatus } from '@shared/types'
import { AGENT_DISPLAY_NAMES } from '@shared/types'
import type { AgentEvent } from '@shared/events/agent-event'
import type { TraceEvent } from '@shared/events/trace-event'
import {
  applyEnvelope,
  beginRetry,
  beginSend,
  clearPendingInteraction,
  createReducerState,
  forceCompleteStaleTurn,
  markFailed,
  markSent,
  seedFromPersisted,
  type AgentEventReducerState,
  type ChatItem,
  type PendingInteraction
} from '@shared/events/AgentEventReducer'

export interface SessionConversationState {
  session: Session | null
  items: ChatItem[]
  activityLabel: string | null
  pendingInteraction: PendingInteraction | null
  warning: string | null
  status: SessionStatus
  isBusy: boolean
  loading: boolean
  traces: TraceEvent[]
  currentModel: string | null
  currentReasoningEffort: string | null
  effectivePermissionMode: string | null
}

const MAX_TRACE_ENTRIES = 300
/** Fallback only — see forceCompleteStaleTurn's own doc comment. Never the
 *  primary completion signal (turn_completed/turn_failed are). */
const MAX_TURN_AGE_MS = 3 * 60 * 1000
const STALE_TURN_CHECK_MS = 15_000

interface ConversationEntry {
  session: Session | null
  reducer: AgentEventReducerState
  loading: boolean
  traces: TraceEvent[]
  snapshot: SessionConversationState
  subscribers: Set<() => void>
  staleCheckTimer: ReturnType<typeof setInterval> | null
}

const entries = new Map<string, ConversationEntry>()

function sessionStatusForEvent(type: AgentEvent['type']): SessionStatus | null {
  switch (type) {
    case 'turn_completed':
      return 'idle'
    case 'turn_failed':
      return 'error'
    case 'turn_cancelled':
      return 'cancelled'
    case 'turn_exited':
      return 'exited'
    default:
      return null
  }
}

function deriveStatus(session: Session | null, reducer: AgentEventReducerState): SessionStatus {
  if (reducer.turn?.status === 'awaiting_interaction' && reducer.pendingInteraction) {
    return reducer.pendingInteraction.kind === 'permission' ? 'waiting_for_permission' : 'waiting_for_user'
  }
  if (reducer.isBusy) return 'running'
  if (reducer.error) return 'error'
  return session?.status ?? 'idle'
}

function traceForAcceptedEvent(
  prev: AgentEventReducerState,
  next: AgentEventReducerState,
  event: AgentEvent
): Array<Omit<TraceEvent, 'sessionId' | 'timestamp'>> {
  const turnId = next.turn?.id ?? prev.turn?.id
  if (event.type === 'assistant_delta') {
    return [{ kind: prev.turn?.status === 'streaming' ? 'ASSISTANT_MESSAGE_UPDATED' : 'ASSISTANT_MESSAGE_CREATED', turnId }]
  }
  if (event.type === 'activity_started') {
    return [{ kind: 'ACTIVITY_CREATED', turnId }]
  }
  if (event.type === 'activity_updated' || event.type === 'activity_completed') {
    return [{ kind: 'ACTIVITY_UPDATED', turnId }]
  }
  if (event.type === 'turn_completed' || event.type === 'turn_failed') {
    return [{ kind: 'TURN_COMPLETED', turnId }]
  }
  return []
}

function toPublicState(entry: ConversationEntry): SessionConversationState {
  return {
    session: entry.session,
    items: entry.reducer.items,
    activityLabel: entry.reducer.currentPhrase,
    pendingInteraction: entry.reducer.pendingInteraction,
    warning: entry.reducer.warning,
    status: deriveStatus(entry.session, entry.reducer),
    isBusy: entry.reducer.isBusy,
    loading: entry.loading,
    traces: entry.traces,
    currentModel: entry.reducer.currentModel,
    currentReasoningEffort: entry.reducer.currentReasoningEffort,
    effectivePermissionMode: entry.reducer.currentPermissionMode
  }
}

function pushTrace(entry: ConversationEntry, sessionId: string, trace: Omit<TraceEvent, 'sessionId' | 'timestamp'>): void {
  const full: TraceEvent = { ...trace, sessionId, timestamp: Date.now() }
  entry.traces = [...entry.traces, full].slice(-MAX_TRACE_ENTRIES)
}

function notify(entry: ConversationEntry): void {
  entry.snapshot = toPublicState(entry)
  for (const cb of entry.subscribers) cb()
}

function ensureStaleCheckTimer(sessionId: string, entry: ConversationEntry): void {
  if (entry.reducer.isBusy && !entry.staleCheckTimer) {
    entry.staleCheckTimer = setInterval(() => {
      const current = entries.get(sessionId)
      if (!current) return
      const next = forceCompleteStaleTurn(current.reducer, MAX_TURN_AGE_MS)
      if (next !== current.reducer) {
        current.reducer = next
        notify(current)
      }
      if (!current.reducer.isBusy && current.staleCheckTimer) {
        clearInterval(current.staleCheckTimer)
        current.staleCheckTimer = null
      }
    }, STALE_TURN_CHECK_MS)
  } else if (!entry.reducer.isBusy && entry.staleCheckTimer) {
    clearInterval(entry.staleCheckTimer)
    entry.staleCheckTimer = null
  }
}

/** Idempotent — safe to call on every mount/render. Creates the entry (and
 *  kicks off the one-time persisted-history seed, and the live event/trace
 *  subscriptions) only the first time a given session is touched; every
 *  later call just returns the same still-live entry. */
function ensureTracked(sessionId: string): ConversationEntry {
  const existing = entries.get(sessionId)
  if (existing) return existing

  const entry: ConversationEntry = {
    session: null,
    reducer: createReducerState(),
    loading: true,
    traces: [],
    snapshot: null as unknown as SessionConversationState,
    subscribers: new Set(),
    staleCheckTimer: null
  }
  entry.snapshot = toPublicState(entry)
  entries.set(sessionId, entry)

  void getAgentDock()
    .session.get(sessionId)
    .then((withMessages) => {
      const current = entries.get(sessionId)
      if (!current) return
      if (!withMessages) {
        current.loading = false
        notify(current)
        return
      }
      const { messages, ...s } = withMessages
      current.session = s
      current.reducer = seedFromPersisted(messages)
      current.loading = false
      notify(current)
    })

  getAgentDock().session.onEvent(sessionId, (payload) => {
    const current = entries.get(sessionId)
    if (!current) return
    const prev = current.reducer
    const result = applyEnvelope(prev, payload)
    current.reducer = result.state
    if (result.accepted) {
      for (const t of traceForAcceptedEvent(prev, result.state, payload.event)) {
        pushTrace(current, sessionId, { ...t, eventId: payload.eventId, sequence: payload.sequence })
      }
      pushTrace(current, sessionId, { kind: 'EVENT_ACCEPTED', eventId: payload.eventId, sequence: payload.sequence, detail: payload.event.type })
      const terminalStatus = sessionStatusForEvent(payload.event.type)
      if (terminalStatus && current.session) current.session = { ...current.session, status: terminalStatus }
    } else {
      pushTrace(current, sessionId, {
        kind: 'EVENT_DROPPED_AS_DUPLICATE',
        eventId: payload.eventId,
        sequence: payload.sequence,
        detail: result.reason
      })
    }
    ensureStaleCheckTimer(sessionId, current)
    notify(current)
  })
  pushTrace(entry, sessionId, { kind: 'LISTENER_ATTACHED', detail: 'renderer:session.onEvent' })

  getAgentDock().session.onTrace(sessionId, (trace) => {
    const current = entries.get(sessionId)
    if (!current) return
    current.traces = [...current.traces, trace].slice(-MAX_TRACE_ENTRIES)
    notify(current)
  })

  return entry
}

/** React-facing subscribe function for useSyncExternalStore — ensures the
 *  session is tracked (idempotent) and registers for re-render notifications.
 *  Deliberately never tears down the underlying event/trace subscription on
 *  unsubscribe — see the module comment. */
export function subscribe(sessionId: string, onStoreChange: () => void): () => void {
  const entry = ensureTracked(sessionId)
  entry.subscribers.add(onStoreChange)
  return () => {
    entry.subscribers.delete(onStoreChange)
  }
}

export function getSnapshot(sessionId: string): SessionConversationState {
  return ensureTracked(sessionId).snapshot
}

/** Called when a session is permanently deleted — releases its entry so it
 *  doesn't linger for the rest of the app's life pointing at a session that
 *  no longer exists. */
export function forget(sessionId: string): void {
  const entry = entries.get(sessionId)
  if (entry?.staleCheckTimer) clearInterval(entry.staleCheckTimer)
  entries.delete(sessionId)
}

/** Test-only — this module is deliberately a process-lifetime singleton
 *  (that's the whole fix; see the module comment), which means test cases
 *  reusing the same session id would otherwise leak state into each other.
 *  Not used by app code. */
export function __resetAllForTests(): void {
  for (const entry of entries.values()) {
    if (entry.staleCheckTimer) clearInterval(entry.staleCheckTimer)
  }
  entries.clear()
}

/** Step 1+2 of sending a prompt, against whichever entry is currently
 *  tracked for this session (created if this is somehow the very first
 *  touch — in practice always already tracked by the time a composer can
 *  call this, since the session must have been opened first). Optimistic
 *  user-message insert happens synchronously, before the IPC round trip,
 *  same guarantee the old component-local implementation made. */
export async function sendPrompt(sessionId: string, agentId: Session['agentId'], text: string, images?: string[]): Promise<void> {
  const entry = ensureTracked(sessionId)
  const userMessageId = crypto.randomUUID()
  const turnId = crypto.randomUUID()
  const agentDisplayName = AGENT_DISPLAY_NAMES[agentId]

  entry.reducer = beginSend(entry.reducer, { sessionId, userMessageId, turnId, text, images, agentDisplayName })
  pushTrace(entry, sessionId, { kind: 'USER_MESSAGE_CREATED', turnId, eventId: userMessageId })
  pushTrace(entry, sessionId, { kind: 'TURN_CREATED', turnId })
  pushTrace(entry, sessionId, { kind: 'ACTIVITY_CREATED', turnId })
  ensureStaleCheckTimer(sessionId, entry)
  notify(entry)

  try {
    await getAgentDock().session.sendPrompt(sessionId, text, turnId, images)
    const current = entries.get(sessionId)
    if (!current) return
    current.reducer = markSent(current.reducer, userMessageId)
    notify(current)
  } catch (err) {
    const current = entries.get(sessionId)
    if (!current) return
    const message = err instanceof Error ? err.message : String(err)
    current.reducer = markFailed(current.reducer, userMessageId, message)
    notify(current)
  }
}

export async function retryMessage(sessionId: string, agentId: Session['agentId'], userMessageId: string): Promise<void> {
  const entry = ensureTracked(sessionId)
  const failed = entry.reducer.items.find((i) => i.id === userMessageId)
  if (!failed || failed.kind !== 'user') return
  const text = failed.text
  const turnId = crypto.randomUUID()
  const agentDisplayName = AGENT_DISPLAY_NAMES[agentId]

  entry.reducer = beginRetry(entry.reducer, { sessionId, userMessageId, text, turnId, agentDisplayName })
  pushTrace(entry, sessionId, { kind: 'TURN_CREATED', turnId })
  pushTrace(entry, sessionId, { kind: 'ACTIVITY_CREATED', turnId })
  ensureStaleCheckTimer(sessionId, entry)
  notify(entry)

  try {
    await getAgentDock().session.sendPrompt(sessionId, text, turnId)
    const current = entries.get(sessionId)
    if (!current) return
    current.reducer = markSent(current.reducer, userMessageId)
    notify(current)
  } catch (err) {
    const current = entries.get(sessionId)
    if (!current) return
    const message = err instanceof Error ? err.message : String(err)
    current.reducer = markFailed(current.reducer, userMessageId, message)
    notify(current)
  }
}

export async function respondToInteraction(sessionId: string, interactionId: string, optionId: string): Promise<void> {
  const entry = ensureTracked(sessionId)
  entry.reducer = clearPendingInteraction(entry.reducer)
  notify(entry)
  await getAgentDock().session.respondToInteraction(sessionId, interactionId, optionId)
}
