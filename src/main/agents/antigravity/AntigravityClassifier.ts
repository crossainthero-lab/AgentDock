// Antigravity classifier — no verified transcript format captured for `agy`
// (only its --help/models output was safe to probe without disrupting a
// real authenticated session), so this leans entirely on the shared generic
// interaction detector for prompts and treats new output as prose by
// default, deferring to terminal_attention_required (via the adapter's
// conflict detection) whenever the screen stalls without a recognized
// prompt shape. Same shared pipeline as Claude/Codex — swapping in a richer
// ruleset later doesn't require touching anything outside this file.
import type { AgentEvent } from '@shared/events/agent-event'
import type { ScreenSnapshot } from '../../terminal/TerminalScreenBuffer'
import { detectAuthRequired, detectGenericInteraction } from '../../terminal/TerminalInteractionDetector'

export class AntigravityClassifier {
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

    // No separate live-spinner re-check here (unlike Claude's classifier),
    // so nothing is gained by withholding the last line — snapshots only
    // happen after an idle debounce, so everything visible is settled.
    const newLines = lines.slice(this.processedLineCount, lines.length)
    this.processedLineCount = lines.length

    const prose = newLines.map((l) => l.trim()).filter(Boolean).join('\n')
    if (prose) events.push({ type: 'assistant_message', text: prose })

    return events
  }
}
