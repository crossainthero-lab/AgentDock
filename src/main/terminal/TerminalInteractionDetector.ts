// Agent-agnostic fallback prompt detection, shared by every classifier.
// Confirmed against real captured output (Claude Code and Codex both use
// these shapes for at least their generic prompts): numbered/lettered menus
// with an "Enter selection"/"Enter y/n" style footer, y/n confirmations, and
// "press enter to continue" banners. Agent-specific classifiers try their
// own richer rules first and fall back to this when nothing more specific
// matches — Codex and Antigravity rely on it as their primary mechanism.
import type { AgentChoice } from '@shared/events/agent-event'

export type GenericInteractionKind = 'permission' | 'choice' | 'confirm_enter'

export interface GenericInteractionGuess {
  kind: GenericInteractionKind
  prompt: string
  options: AgentChoice[]
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
const TAIL_WINDOW = 14

function lastNonEmpty(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return lines[i].trim()
  }
  return null
}

function findPromptLine(tail: string[], fallback: string): string {
  const questionLine = [...tail].reverse().find((l) => QUESTION_LINE.test(l.trim()))
  if (questionLine) return questionLine.trim()
  return lastNonEmpty(tail) ?? fallback
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i
  }
  return -1
}

export function detectGenericInteraction(lines: string[]): GenericInteractionGuess | null {
  const tail = lines.slice(-TAIL_WINDOW)
  const joined = tail.join('\n')

  // Numbered/lettered menus take priority over the generic "press enter to
  // continue" hint below — that hint often just means "or press enter to
  // accept the highlighted option", and collapsing a real multi-option menu
  // (e.g. "1. Update now / 2. Skip / 3. Skip until next version") down to a
  // single blind "Continue" action would throw away the other choices.
  const numbered = tail
    .map((l) => l.match(NUMBERED_OPTION))
    .filter((m): m is RegExpMatchArray => m !== null)
  if (numbered.length >= 2) {
    const seen = new Set<string>()
    const options: AgentChoice[] = []
    for (const m of numbered) {
      if (seen.has(m[1])) continue
      seen.add(m[1])
      options.push({ id: m[1], label: m[2].trim() })
    }
    if (options.length >= 2) {
      const isPermissionShaped = /permission required|do you want to|do you trust/i.test(joined)
      return {
        kind: isPermissionShaped ? 'permission' : 'choice',
        prompt: findPromptLine(tail, 'Choose an option'),
        options
      }
    }
  }

  const lettered = tail.map((l) => l.match(LETTERED_OPTION)).filter((m): m is RegExpMatchArray => m !== null)
  if (lettered.length >= 1 && /\by\/n\b|\byes\/no\b/i.test(joined)) {
    const yLine = lettered.find((m) => m[1].toLowerCase() === 'y')
    const nLine = lettered.find((m) => m[1].toLowerCase() === 'n')
    return {
      kind: 'permission',
      prompt: findPromptLine(tail, 'Confirm?'),
      options: [
        { id: 'y', label: yLine ? yLine[2].trim() : 'Yes' },
        { id: 'n', label: nLine ? nLine[2].trim() : 'No' }
      ]
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
      return {
        kind: isPermissionShaped ? 'permission' : 'choice',
        prompt: findPromptLine(tail.slice(0, footerIdx), 'Choose an option'),
        options
      }
    }
  }

  if (/press enter to continue/i.test(joined) || /^\s*Enter to continue/i.test(joined)) {
    return {
      kind: 'confirm_enter',
      prompt: findPromptLine(tail, 'Press Enter to continue'),
      options: [{ id: 'enter', label: 'Continue' }]
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
  /you('re| are) not logged in/i
]

/** Generic auth-prompt heuristic shared by every classifier — none of these
 *  CLIs' login flows were safe to trigger against a real authenticated
 *  account during development (it would sign the user out), so this is
 *  pattern-based rather than captured-and-verified like the other detectors. */
export function detectAuthRequired(lines: string[]): string | null {
  const tail = lines.slice(-TAIL_WINDOW)
  const joined = tail.join('\n')
  for (const pattern of AUTH_PATTERNS) {
    if (pattern.test(joined)) {
      return lastNonEmpty(tail) ?? 'This agent needs you to authenticate.'
    }
  }
  return null
}
