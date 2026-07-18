// Defensive pre-pass before Markdown parsing. Claude's own assistant text
// (delivered via the Claude Agent SDK's content-block deltas) is already
// plain text with no ANSI in it — but this renderer is shared groundwork
// for Codex/Antigravity too, and any text that ever originated from a raw
// terminal screen can carry escape sequences that would otherwise show up
// as literal control characters or garbled Markdown.
//
// Matches CSI sequences (ESC [ ... letter), OSC sequences (ESC ] ... BEL or
// ESC \\), and other common two-character ESC sequences.
// eslint-disable-next-line no-control-regex
const CSI_OR_OSC = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g
// eslint-disable-next-line no-control-regex
const OTHER_C0_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

export function stripAnsi(text: string): string {
  if (!text) return text
  return text.replace(CSI_OR_OSC, '').replace(OTHER_C0_CONTROL, '')
}
