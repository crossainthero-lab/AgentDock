import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'

export function registerWindowIpc(window: BrowserWindow): void {
  ipcMain.on(IpcChannels.windowMinimize, () => window.minimize())
  ipcMain.on(IpcChannels.windowMaximize, () => {
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.on(IpcChannels.windowClose, () => window.close())
  ipcMain.handle(IpcChannels.windowIsMaximized, () => window.isMaximized())

  window.on('maximize', () => window.webContents.send(IpcChannels.windowMaximizeChange, true))
  window.on('unmaximize', () => window.webContents.send(IpcChannels.windowMaximizeChange, false))
}
