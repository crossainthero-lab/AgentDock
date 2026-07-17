// ANTIGRAVITY-ONLY (see TerminalSessionController.ts's module comment).
// Flags when a classifier's interpretation can't be trusted: the screen has
// stopped changing, the cursor isn't sitting at a fresh "prose finished"
// position, and the classifier had nothing to say about it. That combination
// means the CLI is very likely sitting at an interactive prompt this
// classifier doesn't recognize — better to hand the user a real terminal
// than to silently do nothing or guess wrong.
import type { ScreenSnapshot } from './TerminalScreenBuffer'

export interface ConflictState {
  lastKey: string | null
  unchangedSinceMs: number | null
  /** Whether attentionNeeded already fired for the current stall episode —
   *  prevents re-emitting terminal_attention_required on every idle tick
   *  while the same unrecognized prompt just sits there. Resets once the
   *  screen actually changes. */
  notified: boolean
}

export function createConflictState(): ConflictState {
  return { lastKey: null, unchangedSinceMs: null, notified: false }
}

const STALL_THRESHOLD_MS = 6000

export interface ConflictCheckResult {
  state: ConflictState
  attentionNeeded: boolean
}

/**
 * @param classifierHandled true if the agent-specific classifier (or the
 *   generic fallback) already produced a meaningful event for this snapshot —
 *   no need to second-guess it.
 */
export function checkTranslationConflict(
  state: ConflictState,
  snapshot: ScreenSnapshot,
  classifierHandled: boolean,
  now: number = Date.now()
): ConflictCheckResult {
  const key = snapshot.lines.join('\n')

  if (key !== state.lastKey) {
    return { state: { lastKey: key, unchangedSinceMs: now, notified: false }, attentionNeeded: false }
  }

  const unchangedSinceMs = state.unchangedSinceMs ?? now
  const unchangedForMs = now - unchangedSinceMs
  const shouldNotify =
    !state.notified && !classifierHandled && !snapshot.atRestingPosition && unchangedForMs >= STALL_THRESHOLD_MS

  return { state: { lastKey: key, unchangedSinceMs, notified: state.notified || shouldNotify }, attentionNeeded: shouldNotify }
}
