import type { BrowserWindow } from 'electron'
import { safeHandle } from './ipc-utils'
import { IpcChannels } from '@shared/ipc-channels'
import { workspaceService } from '../services/workspace-service'

export function registerWorkspaceIpc(window: BrowserWindow): void {
  safeHandle(IpcChannels.workspaceOpen, () => workspaceService.open(window))
  safeHandle(IpcChannels.workspaceList, () => workspaceService.list())
  safeHandle(IpcChannels.workspaceGetCurrent, () => workspaceService.getCurrent())
  safeHandle(IpcChannels.workspaceClose, () => workspaceService.close())
  safeHandle(IpcChannels.workspaceRename, (_event, id: string, name: string) => workspaceService.rename(id, name))
  safeHandle(IpcChannels.workspaceDelete, (_event, id: string) => workspaceService.delete(id))
  safeHandle(IpcChannels.workspaceSetCollapsed, (_event, id: string, collapsed: boolean) =>
    workspaceService.setCollapsed(id, collapsed)
  )
  ipcMain.handle(IpcChannels.workspaceFindMissing, () => workspaceService.findMissingWorkspaces())
  ipcMain.handle(IpcChannels.workspaceRemoveMissing, () => workspaceService.removeMissingWorkspaces())
}
