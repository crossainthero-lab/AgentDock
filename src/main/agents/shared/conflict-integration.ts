// ANTIGRAVITY-ONLY (see TerminalSessionController.ts's module comment) —
// Claude/Codex's structured transports get real turn/tool lifecycle events
// directly from the protocol and have no use for either half of this file.
// Small glue between a classifier's output and
// TranslationConflictDetector, used identically by every adapter: if a
// classifier produced nothing for this snapshot and the screen looks stuck
// (unchanged, cursor not at a fresh line) for long enough, append a
// terminal_attention_required event so the UI can offer the terminal
// fallback instead of silently doing nothing.
import type { ClassifiedScreenEvent } from '../antigravity/classified-event'
import type { ScreenSnapshot } from '../../terminal/TerminalScreenBuffer'
import { checkTranslationConflict, createConflictState, type ConflictState } from '../../terminal/TranslationConflictDetector'

export { createConflictState }
export type { ConflictState }

export function withConflictDetection(
  state: ConflictState,
  snapshot: ScreenSnapshot,
  events: ClassifiedScreenEvent[]
): { events: ClassifiedScreenEvent[]; state: ConflictState } {
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

/**
 * Backs the generic "{Agent} is working…" heartbeat every adapter forwards
 * from TerminalSessionController.onBusy — used identically by all three
 * adapters, same reasoning as the rest of this file. `hasSpecificActivity`
 * starts false at the beginning of every turn (reset in each adapter's
 * send()) and flips true the moment the classifier actually produces a real
 * `activity`/`tool_activity` event, so the generic heartbeat stops competing
 * with a more specific label once one is available — see
 * TerminalSessionController.onBusy's doc comment for why a generic signal is
 * needed at all (a fast-redrawing spinner never lets the idle-debounced
 * snapshot fire).
 */
export interface BusyHeartbeatState {
  hasSpecificActivity: boolean
}

export function createBusyHeartbeatState(): BusyHeartbeatState {
  return { hasSpecificActivity: false }
}

export function noteClassifiedActivity(state: BusyHeartbeatState, events: ClassifiedScreenEvent[]): void {
  if (events.some((e) => e.type === 'activity' || e.type === 'tool_activity')) {
    state.hasSpecificActivity = true
  }
}

/** Returns the generic heartbeat event, or null if a specific one has
 *  already been seen this turn (nothing to add). */
export function busyHeartbeatEvent(state: BusyHeartbeatState): ClassifiedScreenEvent | null {
  return state.hasSpecificActivity ? null : { type: 'activity', label: 'Working' }
}
