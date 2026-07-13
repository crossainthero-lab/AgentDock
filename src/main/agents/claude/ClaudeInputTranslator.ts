// Turns a user's answer to a native control into the exact PTY bytes Claude
// Code expects. Verified against real captures (claude 2.1.207):
//  - Permission/choice menus accept the option's own digit/letter + Enter.
//  - The /model picker accepts a digit to highlight an entry, then "s" to
//    apply it for this session only (not "Enter", which sets it as the
//    default for all future sessions — not what a per-session button should
//    do).
import { formatArrowMenuSelection } from '../shared/terminal-text'

export const ClaudeInputTranslator = {
  formatInteractionResponse(optionId: string): string {
    if (optionId.startsWith('arrow:')) return formatArrowMenuSelection(Number(optionId.slice(6)))
    return `${optionId}\r`
  },

  formatOpenModelMenu(): string {
    return '/model\r'
  },

  /** Sent once the classifier confirms the model picker actually opened
   *  (see ClaudeAdapter's armed-auto-select handling) — picks `modelId`
   *  (the picker's numbered position) for this session only. */
  formatModelSelection(modelId: string): string {
    return `${modelId}s`
  },

  formatCommand(commandId: string): string {
    return `/${commandId}\r`
  }
}
