import { safeOn } from './ipc-utils'
import { IpcChannels } from '@shared/ipc-channels'
import { sessionService } from '../services/session-service'

export function registerTerminalIpc(): void {
  safeOn(IpcChannels.terminalWrite, (_event, sessionId: string, data: string) => {
    sessionService.writeTerminal(sessionId, data)
  })
  safeOn(IpcChannels.terminalResize, (_event, sessionId: string, cols: number, rows: number) => {
    sessionService.resizeTerminal(sessionId, cols, rows)
  })
  safeOn(IpcChannels.terminalInterrupt, (_event, sessionId: string) => {
    sessionService.interrupt(sessionId)
  })
}
