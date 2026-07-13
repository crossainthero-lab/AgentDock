import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { workspaceService } from '../services/workspace-service'

export function registerWorkspaceIpc(window: BrowserWindow): void {
  ipcMain.handle(IpcChannels.workspaceOpen, () => workspaceService.open(window))
  ipcMain.handle(IpcChannels.workspaceList, () => workspaceService.list())
  ipcMain.handle(IpcChannels.workspaceGetCurrent, () => workspaceService.getCurrent())
  ipcMain.handle(IpcChannels.workspaceClose, () => workspaceService.close())
}
