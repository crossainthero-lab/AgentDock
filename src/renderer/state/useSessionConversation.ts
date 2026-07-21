// Thin, per-render view onto conversationStore.ts — the actual reducer
// state, and the live session.onEvent/onTrace subscriptions backing it, are
// owned by that module-level store (keyed by sessionId, alive for the
// app's whole life), NOT by this hook. See conversationStore.ts's module
// comment for why: a session's in-flight turn must keep receiving events
// even while the user is looking at a different session, or a reply that
// streamed in while switched away is silently lost.
import { useCallback, useSyncExternalStore } from 'react'
import { getAgentDock } from '../lib/agentDockClient'
import type { LaunchTerminalResult } from '@shared/types'
import * as conversationStore from './conversationStore'
import type { SessionConversationState } from './conversationStore'

export type { SessionConversationState }

export interface SessionConversationActions {
  sendPrompt(text: string, images?: string[]): Promise<void>
  retryMessage(userMessageId: string): Promise<void>
  interrupt(): Promise<void>
  stop(): Promise<void>
  respondToInteraction(interactionId: string, optionId: string): Promise<void>
  setModel(modelId: string): Promise<void>
  runCommand(commandId: string): Promise<void>
  openExternalTerminal(): Promise<LaunchTerminalResult>
}

const EMPTY_STATE: SessionConversationState = {
  session: null,
  items: [],
  activityLabel: null,
  pendingInteraction: null,
  warning: null,
  status: 'idle',
  isBusy: false,
  loading: true,
  traces: [],
  currentModel: null,
  currentReasoningEffort: null,
  effectivePermissionMode: null
}

const noopSubscribe = (): (() => void) => () => {}

export function useSessionConversation(sessionId: string | null): SessionConversationState & SessionConversationActions {
  const subscribe = useCallback(
    (onStoreChange: () => void) => (sessionId ? conversationStore.subscribe(sessionId, onStoreChange) : noopSubscribe()),
    [sessionId]
  )
  const getSnapshot = useCallback(() => (sessionId ? conversationStore.getSnapshot(sessionId) : EMPTY_STATE), [sessionId])

  const state = useSyncExternalStore(subscribe, getSnapshot)

  async function sendPrompt(text: string, images?: string[]): Promise<void> {
    if (!sessionId || !state.session) return
    await conversationStore.sendPrompt(sessionId, state.session.agentId, text, images)
  }

  async function retryMessage(userMessageId: string): Promise<void> {
    if (!sessionId || !state.session) return
    await conversationStore.retryMessage(sessionId, state.session.agentId, userMessageId)
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
    await conversationStore.respondToInteraction(sessionId, interactionId, optionId)
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

  return { ...state, sendPrompt, retryMessage, interrupt, stop, respondToInteraction, setModel, runCommand, openExternalTerminal }
}
