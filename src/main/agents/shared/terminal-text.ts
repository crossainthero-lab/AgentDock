// Generic helpers shared by every adapter for writing into an interactive
// process's stdin.
const ESC = String.fromCharCode(0x1b)

/**
 * Writes a prompt into an interactive process's stdin. Multiline text is
 * wrapped in ANSI bracketed-paste markers (a standard terminal convention
 * supported by most readline/ink-based CLIs) so embedded newlines are
 * inserted as text rather than each one submitting early; a trailing `\r`
 * (Enter) submits the whole thing.
 */
export function formatPromptForPty(prompt: string): string {
  if (prompt.includes('\n')) {
    return `${ESC}[200~${prompt}${ESC}[201~\r`
  }
  return `${prompt}\r`
}

/**
 * Selects the Nth option in an arrow-key ("↑/↓ Navigate · enter Confirm")
 * menu without needing to know which option is currently highlighted:
 * overshoots upward first (clamping at the top of the list, which every
 * observed menu of this shape does rather than wrapping), then moves down
 * exactly `index` times, then confirms. See TerminalInteractionDetector's
 * arrow-menu detection for where these ids come from.
 */
export function formatArrowMenuSelection(index: number): string {
  const up = `${ESC}[A`.repeat(20)
  const down = `${ESC}[B`.repeat(index)
  return `${up}${down}\r`
}
