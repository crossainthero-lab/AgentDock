// ANTIGRAVITY-ONLY (see TerminalSessionController.ts's module comment) —
// Claude and Codex's structured JSON transports get real typed
// permission/choice fields directly from the protocol and never call this.
// Fallback prompt detection for AntigravityClassifier's PTY screen
// classification: numbered/lettered menus with an "Enter selection"/"Enter
// y/n" style footer, y/n confirmations, and "press enter to continue"
// banners — confirmed against real captured terminal output.
import type { AgentChoice } from '../agents/antigravity/classified-event'

export type GenericInteractionKind = 'permission' | 'choice' | 'confirm_enter'

export interface GenericInteractionGuess {
  kind: GenericInteractionKind
  prompt: string
  options: AgentChoice[]
  /** Index, within the `tail` array this was detected from, where the
   *  menu's own content genuinely begins — CRITICAL (real bug fix, proven
   *  via a real captured multi-interaction session): the classifier used to
   *  exclude the entire fixed-size tail window from prose whenever any
   *  interaction was detected, discarding real prose/tool-activity content
   *  that happened to sit chronologically before the menu but still inside
   *  that same window. Reporting the real start lets the classifier only
   *  exclude what's genuinely the menu, and still process everything
   *  earlier in the same window as ordinary content. */
  menuStartIndex: number
}

const NUMBERED_OPTION = /^\s*(?:[›❯>]\s*)?(\d{1,2})[.)]\s+(?:\(selected\)\s+)?(.+?)\s*$/
const LETTERED_OPTION = /^\s*([yn])[.)]\s+(.+?)\s*$/i
// Arrow-key menus have no numbering at all — one line prefixed with a
// cursor marker (the currently-highlighted option), the rest plain-indented
// — confirmed against a real captured Antigravity workspace-trust prompt
// ("› Yes, I trust this folder" / "  No, exit" / "↑/↓ Navigate · enter Confirm").
const ARROW_MARKER_OPTION = /^\s*[›❯>]\s+(\S.*?)\s*$/
const ARROW_PLAIN_OPTION = /^\s{2,}(\S.*?)\s*$/
const ARROW_FOOTER = /(↑\s*\/\s*↓|arrow keys?)\s*.*(navigate|select)/i
// Allows a trailing parenthetical after the "?" (e.g. "Continue? (y/n)"),
// not just a bare question mark at the very end of the line.
const QUESTION_LINE = /\?\s*(\([^)]*\))?\s*$/
// Exported so AntigravityClassifier's own "how much of the buffer might be
// part of a not-yet-detected menu, so don't treat it as prose yet" boundary
// stays consistent with what detectGenericInteraction below actually scans
// — a real bug found via live testing: the classifier used to hardcode a
// wider window (30) than this function's own 14, so whenever an
// interaction fired, up to 16 lines of genuine prose/tool-activity content
// chronologically just before the menu — but still within the classifier's
// wider exclusion zone — was silently discarded (processedLineCount
// advances past it unconditionally, with no later pass ever revisiting it).
export const TAIL_WINDOW = 14
// Real captured Antigravity command-permission prompt shape:
//   Requesting permission for:
//      echo hello-from-shell
//
//   Do you want to proceed?
//   > 1. Yes
// — the command/target being requested lives on the line(s) between this
// label and the question, and is lost entirely if only the question line
// is used as the prompt (the user would see "Do you want to proceed?"
// with no indication of what for).
const REQUEST_LABEL_LINE = /^(Requesting (permission|approval) for)[:.]?\s*$/i

function lastNonEmpty(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return lines[i].trim()
  }
  return null
}

function findPromptLine(tail: string[], fallback: string): string {
  const questionIdx = findLastIndex(tail, (l) => QUESTION_LINE.test(l.trim()))
  const requestIdx = findLastIndex(tail, (l) => REQUEST_LABEL_LINE.test(l.trim()))
  if (requestIdx !== -1 && questionIdx !== -1 && requestIdx < questionIdx) {
    const detail = tail
      .slice(requestIdx, questionIdx + 1)
      .map((l) => l.trim())
      .filter(Boolean)
    if (detail.length > 1) return detail.join('\n')
  }
  if (questionIdx !== -1) return tail[questionIdx].trim()
  return lastNonEmpty(tail) ?? fallback
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i
  }
  return -1
}

function findFirstIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = 0; i < items.length; i++) {
    if (predicate(items[i])) return i
  }
  return -1
}

/** The real start of the menu's own content — the earliest of its request-
 *  label line (e.g. "Requesting permission for:"), its question line (e.g.
 *  "Do you want to proceed?"), or its first option line, whichever exists
 *  and comes first. Everything before this index is unrelated prose/
 *  tool-activity that happened to land in the same tail window. */
function computeMenuStartIndex(tail: string[], firstOptionIndex: number): number {
  const requestIdx = findFirstIndex(tail, (l) => REQUEST_LABEL_LINE.test(l.trim()))
  const questionIdx = findFirstIndex(tail, (l) => QUESTION_LINE.test(l.trim()))
  const candidates = [requestIdx, questionIdx, firstOptionIndex].filter((i) => i !== -1)
  return candidates.length > 0 ? Math.min(...candidates) : firstOptionIndex
}

export function detectGenericInteraction(lines: string[]): GenericInteractionGuess | null {
  const tail = lines.slice(-TAIL_WINDOW)
  const joined = tail.join('\n')

  // Numbered/lettered menus take priority over the generic "press enter to
  // continue" hint below — that hint often just means "or press enter to
  // accept the highlighted option", and collapsing a real multi-option menu
  // (e.g. "1. Update now / 2. Skip / 3. Skip until next version") down to a
  // single blind "Continue" action would throw away the other choices.
  const numberedIndexed = tail
    .map((l, i) => ({ m: l.match(NUMBERED_OPTION), i }))
    .filter((e): e is { m: RegExpMatchArray; i: number } => e.m !== null)
  if (numberedIndexed.length >= 2) {
    const seen = new Set<string>()
    const options: AgentChoice[] = []
    for (const { m } of numberedIndexed) {
      if (seen.has(m[1])) continue
      seen.add(m[1])
      options.push({ id: m[1], label: m[2].trim() })
    }
    if (options.length >= 2) {
      // "would you like to" confirmed against a real captured Codex sandbox-
      // retry approval ("Would you like to make the following edits?") —
      // Codex doesn't use "do you want to" for this, unlike Claude.
      const isPermissionShaped = /permission required|do you want to|do you trust|would you like to/i.test(joined)
      return {
        kind: isPermissionShaped ? 'permission' : 'choice',
        prompt: findPromptLine(tail, 'Choose an option'),
        options,
        menuStartIndex: computeMenuStartIndex(tail, numberedIndexed[0].i)
      }
    }
  }

  const letteredIndexed = tail
    .map((l, i) => ({ m: l.match(LETTERED_OPTION), i }))
    .filter((e): e is { m: RegExpMatchArray; i: number } => e.m !== null)
  if (letteredIndexed.length >= 1 && /\by\/n\b|\byes\/no\b/i.test(joined)) {
    const yLine = letteredIndexed.find((e) => e.m[1].toLowerCase() === 'y')
    const nLine = letteredIndexed.find((e) => e.m[1].toLowerCase() === 'n')
    return {
      kind: 'permission',
      prompt: findPromptLine(tail, 'Confirm?'),
      options: [
        { id: 'y', label: yLine ? yLine.m[2].trim() : 'Yes' },
        { id: 'n', label: nLine ? nLine.m[2].trim() : 'No' }
      ],
      menuStartIndex: computeMenuStartIndex(tail, letteredIndexed[0].i)
    }
  }

  const footerIdx = findLastIndex(tail, (l) => ARROW_FOOTER.test(l))
  if (footerIdx !== -1) {
    const collected: { label: string; selected: boolean }[] = []
    let idx = footerIdx - 1
    while (idx >= 0) {
      const raw = tail[idx]
      const trimmed = raw.trim()
      // A blank spacer line (common between the footer and the options, or
      // between the options and the explanation text above them) doesn't
      // end the menu — only a genuinely prose-shaped line does.
      if (!trimmed) {
        idx -= 1
        continue
      }
      const markerMatch = raw.match(ARROW_MARKER_OPTION)
      const plainMatch = !markerMatch ? raw.match(ARROW_PLAIN_OPTION) : null
      const label = markerMatch?.[1] ?? plainMatch?.[1]
      // Stop at the first line that reads like prose (ends in ./:/?) rather
      // than a short option label — that's the explanation text above the
      // menu, not another option.
      if (!label || /[.:?]\s*$/.test(label)) break
      collected.unshift({ label: label.trim(), selected: Boolean(markerMatch) })
      idx -= 1
    }
    if (collected.length >= 2) {
      const options: AgentChoice[] = collected.map((c, i) => ({ id: `arrow:${i}`, label: c.label }))
      const isPermissionShaped = /do you want to|do you trust|permission/i.test(joined)
      // idx stopped one line before the first genuine option (a blank line,
      // a prose line, or the top of the tail) — the real first option is
      // idx + 1.
      return {
        kind: isPermissionShaped ? 'permission' : 'choice',
        prompt: findPromptLine(tail.slice(0, footerIdx), 'Choose an option'),
        options,
        menuStartIndex: computeMenuStartIndex(tail, idx + 1)
      }
    }
  }

  if (/press enter to continue/i.test(joined) || /^\s*Enter to continue/i.test(joined)) {
    const enterIdx = findFirstIndex(tail, (l) => /press enter to continue/i.test(l) || /^\s*Enter to continue/i.test(l))
    return {
      kind: 'confirm_enter',
      prompt: findPromptLine(tail, 'Press Enter to continue'),
      options: [{ id: 'enter', label: 'Continue' }],
      menuStartIndex: computeMenuStartIndex(tail, enterIdx === -1 ? tail.length - 1 : enterIdx)
    }
  }

  return null
}

const AUTH_PATTERNS = [
  /please (visit|open|go to)\b.*\bhttps?:\/\//i,
  /not authenticated/i,
  /authentication required/i,
  /please\s+log\s*in/i,
  /run\s+`?\/login/i,
  /you('re| are) not logged in/i,
  // Real captured Antigravity wording, confirmed live: "Welcome to the
  // Antigravity CLI. You are currently not signed in." — deliberately a
  // separate pattern from "not logged in" above rather than a wording
  // tweak to it, since both are genuinely distinct real phrasings across
  // different CLIs and either could change independently.
  /you('re| are) (currently )?not signed in/i
]

/** Generic auth-prompt heuristic shared by every classifier — none of these
 *  CLIs' login flows were safe to trigger against a real authenticated
 *  account during development (it would sign the user out), so this is
 *  pattern-based rather than captured-and-verified like the other detectors.
 *  Confirmed live for Antigravity specifically: a real "not signed in"
 *  screen is immediately followed by an animated "Signing in…" spinner
 *  line, which — being the actual last non-blank line most of the time —
 *  would otherwise become the message shown to the user instead of the
 *  actual informative sentence. Returns the real line that matched instead
 *  of blindly the last non-blank one. */
export function detectAuthRequired(lines: string[]): string | null {
  const tail = lines.slice(-TAIL_WINDOW)
  const joined = tail.join('\n')
  for (const pattern of AUTH_PATTERNS) {
    if (!pattern.test(joined)) continue
    // Prefer the specific line that matched (a real captured Antigravity
    // "not signed in" screen is immediately followed by an animated
    // "Signing in…" spinner line, which — being the actual last non-blank
    // line — would otherwise become the displayed message instead of the
    // real informative sentence). Falls back to the last non-blank line
    // for a pattern whose match genuinely spans multiple lines.
    const matchedLine = [...tail].reverse().find((l) => pattern.test(l))
    return (matchedLine ?? lastNonEmpty(tail))?.trim() || 'This agent needs you to authenticate.'
  }
  return null
}
