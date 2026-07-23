import type { BrowserWindow } from 'electron'
import { safeHandle } from './ipc-utils'
import { IpcChannels } from '@shared/ipc-channels'
import type { HandoffExecuteInput } from '@shared/types'
import { handoffService } from '../services/handoff-service'
import { ensureForwarding } from './session'

export function registerHandoffIpc(window: BrowserWindow): void {
  safeHandle(IpcChannels.handoffGenerateSummary, (_event, sessionId: string) =>
    handoffService.generateSummary(sessionId)
  )
  safeHandle(IpcChannels.handoffExecute, async (_event, input: HandoffExecuteInput) => {
    return handoffService.execute(input, (session) => ensureForwarding(window, session.id))
  })
}
