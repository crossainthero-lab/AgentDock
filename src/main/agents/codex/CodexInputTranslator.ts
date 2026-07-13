// Translates a chosen option into PTY bytes for Codex's numbered/lettered/
// arrow-key menus and "press enter to continue" prompts (see CodexClassifier
// / TerminalInteractionDetector — the same generic shapes used for the
// verified "Update available"/workspace-trust menus).
import { formatArrowMenuSelection } from '../shared/terminal-text'

export const CodexInputTranslator = {
  formatInteractionResponse(optionId: string): string {
    if (optionId === 'enter') return '\r'
    if (optionId.startsWith('arrow:')) return formatArrowMenuSelection(Number(optionId.slice(6)))
    return `${optionId}\r`
  },

  formatCommand(commandId: string): string {
    return `/${commandId}\r`
  }
}
