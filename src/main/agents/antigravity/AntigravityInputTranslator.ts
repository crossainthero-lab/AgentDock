// Translates a chosen option into PTY bytes for Antigravity's numbered/
// lettered/arrow-key menus, via the same generic shapes as Codex — real
// captured `agy` prompts (workspace trust) use the arrow-key shape.
import { formatArrowMenuSelection } from '../shared/terminal-text'

export const AntigravityInputTranslator = {
  formatInteractionResponse(optionId: string): string {
    if (optionId === 'enter') return '\r'
    if (optionId.startsWith('arrow:')) return formatArrowMenuSelection(Number(optionId.slice(6)))
    return `${optionId}\r`
  }
}
