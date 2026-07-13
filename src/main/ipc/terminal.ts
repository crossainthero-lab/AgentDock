import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { sessionService } from '../services/session-service'

export function registerTerminalIpc(): void {
  ipcMain.on(IpcChannels.terminalWrite, (_event, sessionId: string, data: string) => {
    sessionService.writeTerminal(sessionId, data)
  })
  ipcMain.on(IpcChannels.terminalResize, (_event, sessionId: string, cols: number, rows: number) => {
    sessionService.resizeTerminal(sessionId, cols, rows)
  })
  ipcMain.on(IpcChannels.terminalInterrupt, (_event, sessionId: string) => {
    sessionService.interrupt(sessionId)
  })
}
