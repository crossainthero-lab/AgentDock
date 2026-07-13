// Codex classifier — lower-confidence than Claude's: real captures (codex-cli
// 0.144.1, --no-alt-screen) show a full cursor-addressed TUI (an "Update
// available"/policy numbered menu on first run, a boxed banner, a "›"
// prefixed composer/transcript line, and a "<model> · <cwd>" status footer)
// rather than Claude's flat screen-reader-friendly lines. Without a verified
// transcript marker for Codex's own replies, this classifier leans on the
// shared generic interaction detector for prompts and treats new, non-chrome
// lines as prose — falling back to terminal_attention_required (via the
// adapter's conflict detection) whenever it can't confidently say either way.
import type { AgentEvent } from '@shared/events/agent-event'
import type { ScreenSnapshot } from '../../terminal/TerminalScreenBuffer'
import { detectAuthRequired, detectGenericInteraction } from '../../terminal/TerminalInteractionDetector'

// Status footer: "gpt-5.5 high · C:\some\path" — chrome, never prose.
const STATUS_FOOTER = /^[\w.\- ]+\s*·\s*[~A-Za-z].*[\\/].*$/
const CHROME_LINE =
  /^(›|>_|Tip:|You have|Update available|Run\s|See full release notes|model:|directory:|╭|╰|│)/

function isChromeLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed === '' || CHROME_LINE.test(trimmed) || STATUS_FOOTER.test(trimmed)
}

export class CodexClassifier {
  private processedLineCount = 0
  private activePromptKey: string | null = null
  private interactionCounter = 0

  reset(): void {
    this.processedLineCount = 0
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

    const tail = lines.slice(-30)
    const guess = detectGenericInteraction(tail)
    if (guess) {
      const key = tail.join('\n')
      if (key !== this.activePromptKey) {
        this.activePromptKey = key
        this.interactionCounter += 1
        const interactionId = `codex-${this.interactionCounter}`
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

    // Unlike Claude's classifier, there's no separate live-spinner re-check
    // here, so nothing is gained by withholding the last line — snapshots
    // only happen after an idle debounce, so everything visible is settled.
    const newLines = lines.slice(this.processedLineCount, lines.length)
    this.processedLineCount = lines.length

    const prose = newLines
      .filter((l) => !isChromeLine(l))
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n')
    if (prose) events.push({ type: 'assistant_message', text: prose })

    return events
  }
}
