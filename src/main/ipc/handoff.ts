import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import type { HandoffExecuteInput } from '@shared/types'
import { handoffService } from '../services/handoff-service'
import { ensureForwarding } from './session'

export function registerHandoffIpc(window: BrowserWindow): void {
  ipcMain.handle(IpcChannels.handoffGenerateSummary, (_event, sessionId: string) =>
    handoffService.generateSummary(sessionId)
  )
  ipcMain.handle(IpcChannels.handoffExecute, async (_event, input: HandoffExecuteInput) => {
    return handoffService.execute(input, (session) => ensureForwarding(window, session.id))
  })
}
