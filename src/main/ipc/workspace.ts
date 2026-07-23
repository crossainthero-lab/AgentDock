import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { workspaceService } from '../services/workspace-service'

export function registerWorkspaceIpc(window: BrowserWindow): void {
  ipcMain.handle(IpcChannels.workspaceOpen, () => workspaceService.open(window))
  ipcMain.handle(IpcChannels.workspaceList, () => workspaceService.list())
  ipcMain.handle(IpcChannels.workspaceGetCurrent, () => workspaceService.getCurrent())
  ipcMain.handle(IpcChannels.workspaceClose, () => workspaceService.close())
  ipcMain.handle(IpcChannels.workspaceRename, (_event, id: string, name: string) => workspaceService.rename(id, name))
  ipcMain.handle(IpcChannels.workspaceDelete, (_event, id: string) => workspaceService.delete(id))
  ipcMain.handle(IpcChannels.workspaceSetCollapsed, (_event, id: string, collapsed: boolean) =>
    workspaceService.setCollapsed(id, collapsed)
  )
  ipcMain.handle(IpcChannels.workspaceFindMissing, () => workspaceService.findMissingWorkspaces())
  ipcMain.handle(IpcChannels.workspaceRemoveMissing, () => workspaceService.removeMissingWorkspaces())
}
