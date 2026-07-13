import type { BrowserWindow } from 'electron'
import { registerWorkspaceIpc } from './workspace'
import { registerAgentIpc } from './agent'
import { registerSessionIpc } from './session'
import { registerGitIpc } from './git'
import { registerSettingsIpc } from './settings'
import { registerApprovalsIpc } from './approvals'
import { registerTerminalIpc } from './terminal'
import { registerHandoffIpc } from './handoff'
import { registerWindowIpc } from './window'

export function registerAllIpc(window: BrowserWindow): void {
  registerWorkspaceIpc(window)
  registerAgentIpc()
  registerSessionIpc(window)
  registerGitIpc()
  registerSettingsIpc()
  registerApprovalsIpc(window)
  registerTerminalIpc()
  registerHandoffIpc(window)
  registerWindowIpc(window)
}
