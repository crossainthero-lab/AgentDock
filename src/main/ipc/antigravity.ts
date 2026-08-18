import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import type { AttachmentResolveResult, AttachmentSaveResult } from '@shared/types'
import { antigravityAttachmentService } from '../services/antigravity-attachment-service'
import { antigravityResponseImageService } from '../services/antigravity-response-image-service'
import { sessionRepo } from '../db/repositories/session-repo'

function workspaceIdFor(sessionId: string): string | null {
  return sessionRepo.get(sessionId)?.workspaceId ?? null
}

export function registerAntigravityIpc(window: BrowserWindow): void {
  ipcMain.handle(IpcChannels.antigravityAttachmentsBrowse, (): Promise<string[]> => {
    return antigravityAttachmentService.browse(window)
  })

  ipcMain.handle(
    IpcChannels.antigravityAttachmentsSaveFromPath,
    (_event, sessionId: string, sourcePath: string): Promise<AttachmentSaveResult> => {
      return antigravityAttachmentService.saveFromPath(sessionId, sourcePath)
    }
  )

  ipcMain.handle(
    IpcChannels.antigravityAttachmentsSaveFromDataUrl,
    (_event, sessionId: string, dataUrl: string): Promise<AttachmentSaveResult> => {
      return antigravityAttachmentService.saveFromDataUrl(sessionId, dataUrl)
    }
  )

  ipcMain.handle(
    IpcChannels.antigravityAttachmentsResolve,
    (_event, sessionId: string, attachmentPath: string): Promise<AttachmentResolveResult> => {
      return antigravityAttachmentService.resolve(sessionId, attachmentPath)
    }
  )

  ipcMain.handle(
    IpcChannels.antigravityResponseImageResolve,
    (_event, sessionId: string, requestedPath: string): Promise<AttachmentResolveResult> => {
      return antigravityResponseImageService.resolve({ sessionId, requestedPath, workspaceId: workspaceIdFor(sessionId) })
    }
  )

  ipcMain.handle(
    IpcChannels.antigravityResponseImageReveal,
    (_event, sessionId: string, requestedPath: string): Promise<{ ok: boolean; error?: string }> => {
      return antigravityResponseImageService.revealInFolder({ sessionId, requestedPath, workspaceId: workspaceIdFor(sessionId) })
    }
  )

  ipcMain.handle(
    IpcChannels.antigravityResponseImageOpenExternally,
    (_event, sessionId: string, requestedPath: string): Promise<{ ok: boolean; error?: string }> => {
      return antigravityResponseImageService.openExternally({ sessionId, requestedPath, workspaceId: workspaceIdFor(sessionId) })
    }
  )
}
