// Small shared glue between a classifier's output and
// TranslationConflictDetector, used identically by every adapter: if a
// classifier produced nothing for this snapshot and the screen looks stuck
// (unchanged, cursor not at a fresh line) for long enough, append a
// terminal_attention_required event so the UI can offer the terminal
// fallback instead of silently doing nothing.
import type { AgentEvent } from '@shared/events/agent-event'
import type { ScreenSnapshot } from '../../terminal/TerminalScreenBuffer'
import { checkTranslationConflict, createConflictState, type ConflictState } from '../../terminal/TranslationConflictDetector'

export { createConflictState }
export type { ConflictState }

export function withConflictDetection(
  state: ConflictState,
  snapshot: ScreenSnapshot,
  events: AgentEvent[]
): { events: AgentEvent[]; state: ConflictState } {
  const handled = events.length > 0
  const result = checkTranslationConflict(state, snapshot, handled)
  if (!result.attentionNeeded) {
    return { events, state: result.state }
  }
  return {
    events: [
      ...events,
      {
        type: 'terminal_attention_required',
        reason: "Unrecognized terminal output — this agent may be waiting for input AgentDock doesn't know how to translate yet."
      }
    ],
    state: result.state
  }
}
