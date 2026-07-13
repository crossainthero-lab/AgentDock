// Pure reducer turning a stream of AgentEvents into renderer-ready state:
// clean assistant prose (no terminal noise), one in-place-updating activity
// summary, and at most one open interaction card at a time. No React/DOM
// dependency so it's unit-testable on its own and reusable by any consumer.
import type { AgentChoice, AgentEvent } from './agent-event'
import { applyActivityEvent, createActivityState, resetActivity, type ActivityState } from './AgentActivityTracker'

export type PendingInteraction =
  | { kind: 'choice'; interactionId: string; prompt: string; options: AgentChoice[] }
  | { kind: 'permission'; interactionId: string; prompt: string; options: AgentChoice[] }
  | { kind: 'authentication'; message: string }
  | { kind: 'terminal_attention'; reason: string }

export interface AgentEventReducerState {
  cleanText: string
  activity: ActivityState
  pendingInteraction: PendingInteraction | null
  warning: string | null
  error: string | null
  isBusy: boolean
}

export function createReducerState(): AgentEventReducerState {
  return {
    cleanText: '',
    activity: createActivityState(),
    pendingInteraction: null,
    warning: null,
    error: null,
    isBusy: false
  }
}

/** Call locally the moment a prompt/command/interaction-response is
 *  submitted — there is no wire event for "a new turn began", since the
 *  renderer already knows synchronously (it's the one making the call). */
export function beginTurn(state: AgentEventReducerState): AgentEventReducerState {
  return { ...createReducerState(), activity: resetActivity(), isBusy: true }
}

export function applyAgentEvent(
  state: AgentEventReducerState,
  event: AgentEvent,
  now: number = Date.now()
): AgentEventReducerState {
  switch (event.type) {
    case 'assistant_message':
      return { ...state, cleanText: state.cleanText + event.text, isBusy: false }
    case 'activity':
    case 'tool_activity':
      return { ...state, activity: applyActivityEvent(state.activity, event, now), isBusy: true }
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
    case 'error':
      return { ...state, error: event.message, isBusy: false }
    case 'session_complete':
      return { ...state, isBusy: false }
    default:
      return state
  }
}

/** Clears an interaction once the user has answered it (locally, optimistic —
 *  doesn't wait for a round trip through the agent process). */
export function clearPendingInteraction(state: AgentEventReducerState): AgentEventReducerState {
  return { ...state, pendingInteraction: null }
}
