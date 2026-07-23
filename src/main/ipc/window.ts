import type { BrowserWindow } from 'electron'
import { safeHandle, safeOn } from './ipc-utils'
import { IpcChannels } from '@shared/ipc-channels'

export function registerWindowIpc(window: BrowserWindow): void {
  safeOn(IpcChannels.windowMinimize, () => window.minimize())
  safeOn(IpcChannels.windowMaximize, () => {
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  safeOn(IpcChannels.windowClose, () => window.close())
  safeHandle(IpcChannels.windowIsMaximized, () => window.isMaximized())

  window.on('maximize', () => window.webContents.send(IpcChannels.windowMaximizeChange, true))
  window.on('unmaximize', () => window.webContents.send(IpcChannels.windowMaximizeChange, false))
}
