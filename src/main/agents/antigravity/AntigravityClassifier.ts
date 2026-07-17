// Antigravity classifier — rules below are grounded in real captured output
// from `agy` 1.1.1/1.1.2 (`-i <prompt>`), captured via a real node-pty
// session against this exact adapter's argv (see project history / plan
// notes), not guessed. Previously this classifier had no agent-specific
// rules at all and treated every new line as prose — real captures showed
// that dumps the entire startup banner (ASCII art, account email, model,
// workspace path), the echoed prompt, and the live "thinking" status
// straight into the chat alongside the actual reply. Real shape observed,
// twice, for two unrelated turns:
//
//   <ASCII art banner>
//   Antigravity CLI <version>
//   <email> (<plan>)
//   <model>
//   <workspace path>
//   ──── (separator)
//   > <echoed prompt>
//                                      -- all of the above: startup chrome,
//                                         shown exactly once, before the
//                                         first echoed prompt line ever
//                                         appears
//   ▸ Thought for Ns, N tokens        -- live "thinking" status (-> activity)
//     Prioritizing Tool Usage         -- a fixed reasoning-subtitle line
//                                         directly under the Thought line —
//                                         identical verbatim across two
//                                         unrelated real turns, so treated
//                                         as part of that same status, not
//                                         prose
//   ● <Verb>(<args>) (ctrl+o to expand) -- a real tool call (-> tool_activity)
//   ──── / > / ? for shortcuts ...    -- idle composer chrome after a reply
import type { ClassifiedScreenEvent } from './classified-event'
import type { ScreenSnapshot } from '../../terminal/TerminalScreenBuffer'
import { detectAuthRequired, detectGenericInteraction } from '../../terminal/TerminalInteractionDetector'

const SEPARATOR_LINE = /^─+$/
const ECHO_LINE = /^>\s?/
const FOOTER_LINE = /^\?\s*for shortcuts\b/i
const THOUGHT_LINE = /^▸\s*Thought for (\d+)s/
const TOOL_ACTIVITY_LINE = /^●\s*([A-Za-z][\w]*)\(([^)]*)\)(?:\s*\(ctrl\+o to expand\))?\s*$/

export class AntigravityClassifier {
  private processedLineCount = 0
  private activePromptKey: string | null = null
  private interactionCounter = 0
  /** Everything before the first echoed "> <prompt>" line is one-time
   *  startup chrome (banner/account/model/cwd) — suppressed unconditionally
   *  rather than pattern-matched, since matching would mean hardcoding a
   *  real account email/model string into source. */
  private sawFirstEcho = false
  /** True right after emitting an `activity` for a "Thought for Ns" line —
   *  the very next non-blank line is that same status's fixed subtitle, not
   *  a real reply, so it's swallowed once rather than shown as prose. */
  private expectingThoughtLabel = false

  reset(): void {
    this.processedLineCount = 0
    this.activePromptKey = null
    this.sawFirstEcho = false
    this.expectingThoughtLabel = false
  }

  classify(snapshot: ScreenSnapshot): ClassifiedScreenEvent[] {
    const { lines } = snapshot
    const events: ClassifiedScreenEvent[] = []

    const authMessage = detectAuthRequired(lines)
    if (authMessage) {
      events.push({ type: 'authentication_required', message: authMessage })
      return events
    }

    const tailStart = Math.max(0, lines.length - 30)
    const tail = lines.slice(tailStart)
    const guess = detectGenericInteraction(tail)
    if (guess) {
      // See CodexClassifier — classify real content that arrived just
      // before the menu in this same batch first, instead of discarding it.
      this.emitContent(lines.slice(this.processedLineCount, tailStart), events)

      const key = tail.join('\n')
      if (key !== this.activePromptKey) {
        this.activePromptKey = key
        this.interactionCounter += 1
        const interactionId = `antigravity-${this.interactionCounter}`
        if (guess.kind === 'permission') {
          events.push({ type: 'permission_required', interactionId, prompt: guess.prompt, options: guess.options })
        } else {
          events.push({ type: 'choice_required', interactionId, prompt: guess.prompt, options: guess.options })
        }
      }
      this.processedLineCount = lines.length
      return events
    }
    this.activePromptKey = null

    const newLines = lines.slice(this.processedLineCount, lines.length)
    this.processedLineCount = lines.length
    this.emitContent(newLines, events)

    return events
  }

  private emitContent(rawLines: string[], events: ClassifiedScreenEvent[]): void {
    const proseLines: string[] = []
    const flushProse = (): void => {
      const text = proseLines.join('\n').trim()
      if (text) events.push({ type: 'assistant_message', text })
      proseLines.length = 0
    }

    for (const rawLine of rawLines) {
      const trimmed = rawLine.trim()

      if (!this.sawFirstEcho) {
        if (ECHO_LINE.test(trimmed)) this.sawFirstEcho = true
        continue
      }

      if (trimmed === '') continue
      if (SEPARATOR_LINE.test(trimmed) || FOOTER_LINE.test(trimmed) || ECHO_LINE.test(trimmed)) continue

      const thoughtMatch = trimmed.match(THOUGHT_LINE)
      if (thoughtMatch) {
        flushProse()
        this.expectingThoughtLabel = true
        events.push({ type: 'activity', label: 'Thinking', elapsedMs: Number(thoughtMatch[1]) * 1000 })
        continue
      }

      if (this.expectingThoughtLabel) {
        this.expectingThoughtLabel = false
        continue
      }

      const toolMatch = trimmed.match(TOOL_ACTIVITY_LINE)
      if (toolMatch) {
        flushProse()
        events.push({ type: 'tool_activity', label: `${toolMatch[1]}(${toolMatch[2]})`, status: 'done' })
        continue
      }

      proseLines.push(trimmed)
    }
    flushProse()
  }
}
