// Classifies a reconstructed Claude Code screen (run with --ax-screen-reader,
// see ClaudeAdapter) into shared AgentEvents. Rules below are grounded in
// real captured sessions against claude 2.1.207, not guessed:
//
//   you: <text>                       -- echo of what was sent (ignored)
//   claude: <text>                    -- the settled reply for this turn
//   tool: <Name> (<args>)             -- a tool call
//   <Verb>ing…   ( Ns · ... )         -- live status/spinner (redraws the
//                                          same row while busy — Claude Code
//                                          uses a rotating set of whimsical
//                                          verbs: Pondering, Wrangling,
//                                          Deciphering, Razzmatazzing, ...)
//   <Verb> for Ns                     -- turn-complete footer (redundant
//                                          with the activity ticker; ignored)
//   Permission Required: ...          -- anchors a permission/trust block,
//                                          ending in "Enter y/n:" or
//                                          "Enter selection [1-N]:"
//   Select model / other pickers      -- same numbered-menu shape, no
//                                          "Permission Required" prefix
//   manual mode on / effort: ... /model status line / banner / tips
//                                      -- persistent chrome (ignored)
//
// Important: Claude keeps a fixed-height status footer at the bottom of the
// screen (verb/spinner row, "manual mode on" row, "effort:" row, "$" prompt
// row) that's redrawn in place via cursor-addressed escapes rather than
// scrolled — confirmed against a real running session. That means the
// spinner is *not* reliably "the last line", and "lines seen so far" isn't
// a safe boundary either (the footer never grows past a few rows). So
// rather than tracking a moving "settled up to here" cursor, this scans for
// not-yet-emitted claude:/tool: lines anywhere past the last one actually
// matched (idempotent — footer/chrome lines simply never match, so
// re-scanning them every tick is harmless), and independently re-checks a
// tail window for the live spinner every call, deduped by exact text.
import type { AgentEvent } from '@shared/events/agent-event'
import type { ScreenSnapshot } from '../../terminal/TerminalScreenBuffer'
import { detectAuthRequired, detectGenericInteraction } from '../../terminal/TerminalInteractionDetector'

const FOOTER_LINE = /^Enter (y\/n|selection\s*\[\d+-\d+\])/i
const SPINNER_LINE = /^([\p{L}][\p{L}\d']*)…\s*(?:\(\s*(\d+)s(?:\s*·[^)]*)?\))?/u
const CLAUDE_LINE = /^claude:\s?(.*)$/
const TOOL_LINE = /^tool:\s*(.+)$/i
// Claude's whimsical verb list includes accented characters (e.g.
// "Sautéed for 3s"), confirmed against a real session — \p{L} (any Unicode
// letter) avoids missing those the way [A-Za-z] would.
const BOUNDARY_LINE =
  /^(you:|tool:|claude:|permission required:|manual mode|effort:|\$|[\p{L}][\p{L}\d']*…|[\p{L}][\p{L}\d']* for \d+s)/iu
const SPINNER_TAIL_WINDOW = 15

function isBoundaryLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed === '' || BOUNDARY_LINE.test(trimmed)
}

export class ClaudeClassifier {
  /** Highest absolute `lines` index already turned into an event — never
   *  goes backward, but also never advances past a non-matching line, so a
   *  redraw-in-place footer row can't get "consumed" without ever matching. */
  private lastEmittedLineIndex = -1
  private lastSpinnerText: string | null = null
  private activePromptKey: string | null = null
  private interactionCounter = 0

  reset(): void {
    this.lastEmittedLineIndex = -1
    this.lastSpinnerText = null
    this.activePromptKey = null
  }

  classify(snapshot: ScreenSnapshot): AgentEvent[] {
    const { lines } = snapshot
    const events: AgentEvent[] = []

    const authMessage = detectAuthRequired(lines)
    if (authMessage) {
      events.push({ type: 'authentication_required', message: authMessage })
      return events
    }

    const tail = lines.slice(-40)
    const footerIdx = findLastIndex(tail, (l) => FOOTER_LINE.test(l.trim()))
    if (footerIdx !== -1) {
      const blockLines = tail.slice(Math.max(0, footerIdx - 15), footerIdx + 1)
      const guess = detectGenericInteraction(blockLines)
      if (guess && guess.kind !== 'confirm_enter') {
        const key = blockLines.join('\n')
        if (key !== this.activePromptKey) {
          this.activePromptKey = key
          this.interactionCounter += 1
          const interactionId = `claude-${this.interactionCounter}`
          events.push(
            guess.kind === 'permission'
              ? { type: 'permission_required', interactionId, prompt: guess.prompt, options: guess.options }
              : { type: 'choice_required', interactionId, prompt: guess.prompt, options: guess.options }
          )
        }
        return events
      }
    } else {
      this.activePromptKey = null
    }

    let i = Math.max(0, this.lastEmittedLineIndex + 1)
    while (i < lines.length) {
      const trimmed = lines[i].trim()
      const claudeMatch = trimmed.match(CLAUDE_LINE)
      if (claudeMatch) {
        const parts = [claudeMatch[1]]
        let j = i + 1
        while (j < lines.length && !isBoundaryLine(lines[j])) {
          // Not .trim() — TerminalScreenBuffer already strips trailing
          // padding per line (xterm's translateToString(true)), so any
          // leading whitespace still present here is real content (e.g. a
          // code block's indentation), not terminal padding to discard.
          parts.push(lines[j])
          j += 1
        }
        const text = parts.join('\n').trim()
        if (text) events.push({ type: 'assistant_message', text })
        this.lastEmittedLineIndex = j - 1
        i = j
        continue
      }

      const toolMatch = trimmed.match(TOOL_LINE)
      if (toolMatch) {
        events.push({ type: 'tool_activity', label: toolMatch[1].trim(), status: 'done' })
        this.lastEmittedLineIndex = i
        i += 1
        continue
      }

      i += 1
    }

    const spinnerTail = lines.slice(-SPINNER_TAIL_WINDOW)
    for (let k = spinnerTail.length - 1; k >= 0; k--) {
      const trimmed = spinnerTail[k].trim()
      const spinnerMatch = trimmed.match(SPINNER_LINE)
      if (spinnerMatch) {
        if (trimmed !== this.lastSpinnerText) {
          this.lastSpinnerText = trimmed
          const elapsedMs = spinnerMatch[2] ? Number(spinnerMatch[2]) * 1000 : undefined
          events.push({ type: 'activity', label: spinnerMatch[1], elapsedMs })
        }
        break
      }
    }

    return events
  }
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i
  }
  return -1
}
