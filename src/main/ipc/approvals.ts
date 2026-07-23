import type { BrowserWindow } from 'electron'
import { safeHandle } from './ipc-utils'
import { IpcChannels } from '@shared/ipc-channels'
import type { ApprovalDecision } from '@shared/types'
import { approvalService } from '../services/approval-service'

export function registerApprovalsIpc(window: BrowserWindow): void {
  approvalService.onRequest((request) => {
    if (window.isDestroyed()) return
    window.webContents.send(IpcChannels.approvalsRequest, request)
  })

  safeHandle(IpcChannels.approvalsRespond, (_event, approvalId: string, decision: ApprovalDecision) => {
    approvalService.respond(approvalId, decision)
  })
}
