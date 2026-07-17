// Translates AntigravityClassifier's output (the old flat, PTY-classified
// vocabulary — see classified-event.ts) into the shared, turn-scoped
// AgentEvent model the rest of the app speaks. This is where turnId/
// messageId bookkeeping lives for Antigravity — the PTY classification
// model has no native concept of either, unlike Claude/Codex's structured
// transports which get real ids straight from the protocol.
import type { AgentEvent } from '@shared/events/agent-event'
import type { ClassifiedScreenEvent } from './classified-event'

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
}

export function createAntigravityMapperState(): AntigravityMapperState {
  return { messageId: null, heartbeatActivityId: null, toolActivityCounter: 0 }
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

        case 'session_complete':
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
