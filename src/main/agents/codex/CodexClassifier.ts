// Codex classifier — rules below are grounded in real captured output from
// `codex-cli 0.144.1` (--no-alt-screen), captured via a real node-pty
// session against this exact adapter's argv (see scripts/capture-cli-output*
// in project history / plan notes), not guessed:
//
//   ╭...╮ / │ ... │ / ╰...╯          -- boxed banners (update notice, the
//                                        "OpenAI Codex" banner) — chrome
//   › <text>                          -- echo of the composer line (either
//                                        what the user sent, or dimmed
//                                        placeholder ghost text) — chrome
//   <model> · <cwd>                   -- status footer — chrome
//   ■ <text>                          -- a system/meta notice glyph, e.g.
//                                        "■ No active thread is available."
//                                        — always chrome, never real reply
//                                        content
//   • <text>                          -- Codex's own turn-content bullet.
//                                        Real captures show THREE different
//                                        things share this exact glyph:
//                                          - system notices, e.g. "You have
//                                            N usage limit resets..."
//                                            (chrome)
//                                          - a file-edit summary, e.g.
//                                            "Added foo.txt (+1 -0)"
//                                            followed by indented diff lines
//                                            (tool_activity, not prose)
//                                          - the actual reply text (prose)
//                                        so bullets are distinguished by
//                                        their remainder text, not glyph
//                                        alone.
//
// A real captured sandbox-retry approval ("Would you like to make the
// following edits?" / "Reason: command failed; retry without sandbox?" /
// three numbered options ending "Press enter to confirm or esc to cancel")
// confirmed the shared generic interaction detector already recognizes this
// shape once its permission-phrase list includes "would you like to" (see
// TerminalInteractionDetector.ts) — Codex has no interaction rules of its
// own beyond that shared detector.
import type { AgentEvent } from '@shared/events/agent-event'
import type { ScreenSnapshot } from '../../terminal/TerminalScreenBuffer'
import { detectAuthRequired, detectGenericInteraction } from '../../terminal/TerminalInteractionDetector'

// Status footer: "gpt-5.5 high · C:\some\path" — chrome, never prose.
const STATUS_FOOTER = /^[\w.\- ]+\s*·\s*[~A-Za-z].*[\\/].*$/
const CHROME_LINE =
  /^(›|>_|Tip:|You have|Update available|Run\s|See full release notes|model:|directory:|╭|╰|│)/
const BULLET_PREFIX = /^([•■])\s*/
const SYSTEM_NOTICE_AFTER_BULLET = /^You have\b/i
const FILE_EDIT_LINE = /^(Added|Edited|Updated|Deleted|Modified|Removed)\s+.+\(\+\d+\s+-\d+\)$/i
const DIFF_DETAIL_LINE = /^\d+\s*[+-]/

function isChromeLine(trimmed: string): boolean {
  return trimmed === '' || CHROME_LINE.test(trimmed) || STATUS_FOOTER.test(trimmed)
}

export class CodexClassifier {
  private processedLineCount = 0
  private activePromptKey: string | null = null
  private interactionCounter = 0
  private expectingDiffDetail = false

  reset(): void {
    this.processedLineCount = 0
    this.activePromptKey = null
    this.expectingDiffDetail = false
  }

  classify(snapshot: ScreenSnapshot): AgentEvent[] {
    const { lines } = snapshot
    const events: AgentEvent[] = []

    const authMessage = detectAuthRequired(lines)
    if (authMessage) {
      events.push({ type: 'authentication_required', message: authMessage })
      return events
    }

    const tailStart = Math.max(0, lines.length - 30)
    const tail = lines.slice(tailStart)
    const guess = detectGenericInteraction(tail)
    if (guess) {
      // A menu can settle in the same snapshot as real content that arrived
      // just before it (e.g. a reply + file-edit summary immediately
      // followed by a sandbox-retry approval) — classify that first instead
      // of silently discarding it by jumping processedLineCount straight to
      // the end of the buffer.
      this.emitContent(lines.slice(this.processedLineCount, tailStart), events)

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

    const newLines = lines.slice(this.processedLineCount, lines.length)
    this.processedLineCount = lines.length
    this.emitContent(newLines, events)

    return events
  }

  private emitContent(rawLines: string[], events: AgentEvent[]): void {
    const proseLines: string[] = []
    const flushProse = (): void => {
      const text = proseLines.join('\n').trim()
      if (text) events.push({ type: 'assistant_message', text })
      proseLines.length = 0
    }

    for (const rawLine of rawLines) {
      const trimmed = rawLine.trim()
      if (trimmed === '') continue

      if (this.expectingDiffDetail) {
        if (DIFF_DETAIL_LINE.test(trimmed)) continue
        this.expectingDiffDetail = false
      }

      if (isChromeLine(trimmed)) continue

      const bulletMatch = trimmed.match(BULLET_PREFIX)
      if (bulletMatch) {
        const glyph = bulletMatch[1]
        const remainder = trimmed.slice(bulletMatch[0].length)

        if (glyph === '■') continue // always a system/meta notice, never a reply
        if (SYSTEM_NOTICE_AFTER_BULLET.test(remainder)) continue

        if (FILE_EDIT_LINE.test(remainder)) {
          flushProse()
          events.push({ type: 'tool_activity', label: remainder, status: 'done' })
          this.expectingDiffDetail = true
          continue
        }

        proseLines.push(remainder)
        continue
      }

      proseLines.push(trimmed)
    }
    flushProse()
  }
}
