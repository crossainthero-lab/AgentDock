import { useEffect, useRef, useState } from 'react'
import { getAgentDock } from '../lib/agentDockClient'
import type { LaunchTerminalResult, Session, SessionStatus } from '@shared/types'
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
  /** The real model in use, reported by the transport itself — null until
   *  known. Never guessed/hardcoded. */
  currentModel: string | null
  /** The real, effective permission mode reported the same way. */
  effectivePermissionMode: string | null
}

export interface SessionConversationActions {
  sendPrompt(text: string): Promise<void>
  retryMessage(userMessageId: string): Promise<void>
  interrupt(): Promise<void>
  stop(): Promise<void>
  respondToInteraction(interactionId: string, optionId: string): Promise<void>
  setModel(modelId: string): Promise<void>
  runCommand(commandId: string): Promise<void>
  openExternalTerminal(): Promise<LaunchTerminalResult>
}

const EMPTY_REDUCER_STATE = createReducerState()
const MAX_TRACE_ENTRIES = 300
/** Fallback only — see forceCompleteStaleTurn's own doc comment. Never the
 *  primary completion signal (turn_completed/turn_failed are). */
const MAX_TURN_AGE_MS = 3 * 60 * 1000
const STALE_TURN_CHECK_MS = 15_000

function toPublicState(
  session: Session | null,
  reducer: AgentEventReducerState,
  loading: boolean,
  traces: TraceEvent[]
): SessionConversationState {
  return {
    session,
    items: reducer.items,
    activityLabel: reducer.currentPhrase,
    pendingInteraction: reducer.pendingInteraction,
    warning: reducer.warning,
    status: deriveStatus(session, reducer),
    isBusy: reducer.isBusy,
    loading,
    traces,
    currentModel: reducer.currentModel,
    effectivePermissionMode: reducer.currentPermissionMode
  }
}

/** `session.status` (persisted, only refreshed on mount/event-driven local
 *  sync — see the onEvent handler's setSession calls below) covers most
 *  states, but a pending interaction is tracked live and reliably by the
 *  pure reducer itself (turn.status/pendingInteraction — no round trip
 *  needed), so it's checked first for the two "waiting for..." states. */
/** The terminal-ish AgentEvent types that also change persisted
 *  SessionStatus server-side (see session-service.ts's onEvent switch) —
 *  kept in exact sync so the header never shows a stale status until the
 *  next full refetch. Anything not listed here doesn't change status on
 *  its own (e.g. assistant_delta, activity_started). */
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
  if (reducer.error) return 'error'
  return session?.status ?? 'idle'
}

/** Computes which high-level trace kind(s) an accepted event corresponds to,
 *  by comparing turn state just before/after applying it — kept local to
 *  this hook since it's purely a renderer-side observability concern, not
 *  something the pure reducer needs to know about. */
function traceForAcceptedEvent(
  prev: AgentEventReducerState,
  next: AgentEventReducerState,
  event: AgentEvent
): Array<Omit<TraceEvent, 'sessionId' | 'timestamp'>> {
  const turnId = next.turn?.id ?? prev.turn?.id
  if (event.type === 'assistant_delta') {
    // Diagnostic labeling only, not correctness-critical — approximates
    // "first delta of the turn" via the turn's pre-event status (the
    // reducer flips status to 'streaming' on the very first delta it
    // applies), rather than reaching into the reducer's internal per-message
    // item-id scheme.
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

export function useSessionConversation(sessionId: string | null): SessionConversationState & SessionConversationActions {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [reducerState, setReducerState] = useState<AgentEventReducerState>(EMPTY_REDUCER_STATE)
  const [traces, setTraces] = useState<TraceEvent[]>([])
  const [, forceTick] = useState(0)

  const reducerRef = useRef(reducerState)
  reducerRef.current = reducerState
  const sessionRef = useRef(session)
  sessionRef.current = session

  function pushTrace(entry: Omit<TraceEvent, 'sessionId' | 'timestamp'>): void {
    if (!sessionId) return
    const full: TraceEvent = { ...entry, sessionId, timestamp: Date.now() }
    setTraces((prev) => [...prev, full].slice(-MAX_TRACE_ENTRIES))
  }

  useEffect(() => {
    if (!sessionId) {
      setSession(null)
      setReducerState(EMPTY_REDUCER_STATE)
      setTraces([])
      return
    }

    let cancelled = false
    setLoading(true)
    setReducerState(createReducerState())
    setTraces([])

    async function loadOnce(): Promise<void> {
      // Fetched exactly once per mount/session-switch — NEVER again in
      // reaction to a live event (that's what used to cause both the
      // "message appears late" and "message appears twice" bugs: the whole
      // list was re-fetched from the DB mid-turn instead of being updated
      // incrementally).
      const withMessages = await getAgentDock().session.get(sessionId as string)
      if (cancelled || !withMessages) return
      const { messages, ...s } = withMessages
      setSession(s)
      setReducerState(seedFromPersisted(messages))
      setLoading(false)
    }

    void loadOnce()

    const unsubscribeEvent = getAgentDock().session.onEvent(sessionId, (payload) => {
      if (cancelled) return
      // Deliberately not the `setReducerState(prev => ...)` functional form
      // here — that updater callback can be invoked more than once by React
      // (e.g. Strict Mode's double-invocation of updater functions), and
      // pushTrace has a side effect (another setState). Computing off
      // `reducerRef.current` (kept in sync synchronously, right below) and
      // calling `setReducerState` with a plain value instead avoids ever
      // double-firing that side effect — which would otherwise corrupt the
      // very trace log meant to prove events aren't being duplicated.
      const prev = reducerRef.current
      const result = applyEnvelope(prev, payload)
      reducerRef.current = result.state
      setReducerState(result.state)
      if (result.accepted) {
        for (const t of traceForAcceptedEvent(prev, result.state, payload.event)) {
          pushTrace({ ...t, eventId: payload.eventId, sequence: payload.sequence })
        }
        pushTrace({ kind: 'EVENT_ACCEPTED', eventId: payload.eventId, sequence: payload.sequence, detail: payload.event.type })
        // Keep the locally-held `session.status` live rather than frozen at
        // load time — session-service already persisted the matching status
        // server-side by the time this event was broadcast (see
        // session-service.ts's onEvent switch), this just mirrors it here
        // so the header doesn't need a full session refetch to reflect it.
        const terminalStatus = sessionStatusForEvent(payload.event.type)
        if (terminalStatus) setSession((s) => (s ? { ...s, status: terminalStatus } : s))
      } else {
        pushTrace({ kind: 'EVENT_DROPPED_AS_DUPLICATE', eventId: payload.eventId, sequence: payload.sequence, detail: result.reason })
      }
    })
    pushTrace({ kind: 'LISTENER_ATTACHED', detail: 'renderer:session.onEvent' })

    const unsubscribeTrace = getAgentDock().session.onTrace(sessionId, (trace) => {
      if (cancelled) return
      setTraces((prev) => [...prev, trace].slice(-MAX_TRACE_ENTRIES))
    })

    return () => {
      cancelled = true
      unsubscribeEvent()
      unsubscribeTrace()
      pushTrace({ kind: 'LISTENER_REMOVED', detail: 'renderer:session.onEvent' })
    }
  }, [sessionId])

  // Ticks the ticker label / stale-turn fallback check forward.
  useEffect(() => {
    if (!reducerState.isBusy) return
    const timer = setInterval(() => {
      forceTick((t) => t + 1)
      setReducerState((prev) => forceCompleteStaleTurn(prev, MAX_TURN_AGE_MS))
    }, STALE_TURN_CHECK_MS)
    return () => clearInterval(timer)
  }, [reducerState.isBusy])

  async function sendPrompt(text: string): Promise<void> {
    if (!sessionId || !sessionRef.current) return
    const userMessageId = crypto.randomUUID()
    const turnId = crypto.randomUUID()
    const agentDisplayName = AGENT_DISPLAY_NAMES[sessionRef.current.agentId]

    // Optimistic, local, immediate — inserted before any IPC/PTY round trip.
    setReducerState((prev) => beginSend(prev, { sessionId, userMessageId, turnId, text, agentDisplayName }))
    pushTrace({ kind: 'USER_MESSAGE_CREATED', turnId, eventId: userMessageId })
    pushTrace({ kind: 'TURN_CREATED', turnId })
    pushTrace({ kind: 'ACTIVITY_CREATED', turnId })

    try {
      await getAgentDock().session.sendPrompt(sessionId, text, turnId)
      setReducerState((prev) => markSent(prev, userMessageId))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setReducerState((prev) => markFailed(prev, userMessageId, message))
    }
  }

  async function retryMessage(userMessageId: string): Promise<void> {
    if (!sessionId || !sessionRef.current) return
    const failed = reducerRef.current.items.find((i) => i.id === userMessageId)
    if (!failed || failed.kind !== 'user') return
    const text = failed.text
    const turnId = crypto.randomUUID()
    const agentDisplayName = AGENT_DISPLAY_NAMES[sessionRef.current.agentId]

    setReducerState((prev) => beginRetry(prev, { sessionId, userMessageId, text, turnId, agentDisplayName }))
    pushTrace({ kind: 'TURN_CREATED', turnId })
    pushTrace({ kind: 'ACTIVITY_CREATED', turnId })

    try {
      await getAgentDock().session.sendPrompt(sessionId, text, turnId)
      setReducerState((prev) => markSent(prev, userMessageId))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setReducerState((prev) => markFailed(prev, userMessageId, message))
    }
  }

  async function interrupt(): Promise<void> {
    if (!sessionId) return
    await getAgentDock().session.interrupt(sessionId)
  }

  async function stop(): Promise<void> {
    if (!sessionId) return
    await getAgentDock().session.stop(sessionId)
  }

  async function respondToInteraction(interactionId: string, optionId: string): Promise<void> {
    if (!sessionId) return
    setReducerState((prev) => clearPendingInteraction(prev))
    await getAgentDock().session.respondToInteraction(sessionId, interactionId, optionId)
  }

  async function setModel(modelId: string): Promise<void> {
    if (!sessionId) return
    await getAgentDock().session.setModel(sessionId, modelId)
  }

  async function runCommand(commandId: string): Promise<void> {
    if (!sessionId) return
    await getAgentDock().session.runCommand(sessionId, commandId)
  }

  async function openExternalTerminal(): Promise<LaunchTerminalResult> {
    if (!sessionId) return { launched: false, method: null, command: '', error: 'No active session.' }
    return getAgentDock().session.openExternalTerminal(sessionId)
  }

  const publicState = toPublicState(session, reducerState, loading, traces)

  return { ...publicState, sendPrompt, retryMessage, interrupt, stop, respondToInteraction, setModel, runCommand, openExternalTerminal }
}
