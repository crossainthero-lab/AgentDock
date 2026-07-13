import { useEffect, useRef, useState } from 'react'
import { getAgentDock } from '../lib/agentDockClient'
import type { Session, SessionMessage, SessionStatus } from '@shared/types'
import type { AgentEvent } from '@shared/events/agent-event'
import {
  applyAgentEvent,
  beginTurn,
  clearPendingInteraction,
  createReducerState,
  type AgentEventReducerState,
  type PendingInteraction
} from '@shared/events/AgentEventReducer'
import { summarizeActivity } from '@shared/events/AgentActivityTracker'

export interface SessionConversationState {
  session: Session | null
  messages: SessionMessage[]
  pendingText: string
  activityLabel: string | null
  pendingInteraction: PendingInteraction | null
  warning: string | null
  status: SessionStatus
  isBusy: boolean
  loading: boolean
}

export interface SessionConversationActions {
  sendPrompt(text: string): Promise<void>
  interrupt(): Promise<void>
  stop(): Promise<void>
  respondToInteraction(interactionId: string, optionId: string): Promise<void>
  setModel(modelId: string): Promise<void>
  runCommand(commandId: string): Promise<void>
}

const EMPTY_REDUCER_STATE = createReducerState()

function toPublicState(session: Session | null, messages: SessionMessage[], reducer: AgentEventReducerState, loading: boolean, now: number): SessionConversationState {
  return {
    session,
    messages,
    pendingText: reducer.cleanText,
    activityLabel: summarizeActivity(reducer.activity, now),
    pendingInteraction: reducer.pendingInteraction,
    warning: reducer.warning,
    status: reducer.error ? 'error' : session?.status ?? 'idle',
    isBusy: reducer.isBusy,
    loading
  }
}

export function useSessionConversation(sessionId: string | null): SessionConversationState & SessionConversationActions {
  const [session, setSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [reducerState, setReducerState] = useState<AgentEventReducerState>(EMPTY_REDUCER_STATE)
  const [, forceTick] = useState(0)

  useEffect(() => {
    if (!sessionId) {
      setSession(null)
      setMessages([])
      setReducerState(EMPTY_REDUCER_STATE)
      return
    }

    let cancelled = false
    setLoading(true)
    setReducerState(createReducerState())

    async function loadPersisted(): Promise<void> {
      const withMessages = await getAgentDock().session.get(sessionId as string)
      if (cancelled || !withMessages) return
      const { messages: msgs, ...s } = withMessages
      setSession(s)
      setMessages(msgs)
      setLoading(false)
    }

    void loadPersisted()

    const unsubscribe = getAgentDock().session.onEvent(sessionId, (event: AgentEvent) => {
      if (cancelled) return
      setReducerState((prev) => applyAgentEvent(prev, event))
      if (event.type === 'assistant_message' || event.type === 'session_complete' || event.type === 'error') {
        void loadPersisted()
      }
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [sessionId])

  // Ticks the "Worked for Ns" label forward once a second while busy.
  useEffect(() => {
    if (!reducerState.activity.active) return
    const timer = setInterval(() => forceTick((t) => t + 1), 1000)
    return () => clearInterval(timer)
  }, [reducerState.activity.active])

  async function sendPrompt(text: string): Promise<void> {
    if (!sessionId) return
    setReducerState((prev) => beginTurn(prev))
    await getAgentDock().session.sendPrompt(sessionId, text)
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

  const publicState = toPublicState(session, messages, reducerState, loading, Date.now())

  return { ...publicState, sendPrompt, interrupt, stop, respondToInteraction, setModel, runCommand }
}
