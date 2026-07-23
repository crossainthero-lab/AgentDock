import type { BrowserWindow } from 'electron'
import { safeHandle } from './ipc-utils'
import { IpcChannels } from '@shared/ipc-channels'
import type { AttachmentResolveResult, AttachmentSaveResult, CodexModelCatalogResult } from '@shared/types'
import { codexModelCatalogService } from '../services/codex-model-catalog-service'
import { codexAttachmentService } from '../services/codex-attachment-service'
import { codexResponseImageService } from '../services/codex-response-image-service'
import { detectionService } from '../services/detection-service'
import { settingsService } from '../services/settings-service'
import { sessionRepo } from '../db/repositories/session-repo'

function currentCodexModel(): string | null {
  return settingsService.get().agents.codex.model
}

/** A response-image path is only ever meaningful relative to its own
 *  session's workspace/attachment-storage/generated_images roots — resolved
 *  here, once, from the sessionId the renderer already has, rather than
 *  trusting a workspaceId/threadId passed up from the renderer. */
function responseImageContext(sessionId: string): { workspaceId: string | null; threadId: string | null } {
  const session = sessionRepo.get(sessionId)
  return {
    workspaceId: session?.workspaceId ?? null,
    threadId: sessionRepo.getNativeSessionId(sessionId)
  }
}

export function registerCodexIpc(window: BrowserWindow): void {
  safeHandle(IpcChannels.codexModelCatalogGet, (): CodexModelCatalogResult => {
    return codexModelCatalogService.getCached(currentCodexModel())
  })

  safeHandle(IpcChannels.codexModelCatalogRefresh, async (): Promise<CodexModelCatalogResult> => {
    const customPath = settingsService.get().agents.codex.customPath
    const detection = await detectionService.detect('codex', customPath)
    if (!detection.installed || !detection.executablePath) {
      return codexModelCatalogService.getCached(currentCodexModel(), detection.error ?? 'Codex is not installed.')
    }
    return codexModelCatalogService.refresh(detection.executablePath, currentCodexModel())
  })

  safeHandle(IpcChannels.codexAttachmentsBrowse, (): Promise<string[]> => {
    return codexAttachmentService.browse(window)
  })

  safeHandle(IpcChannels.codexAttachmentsSaveFromPath, (_event, sessionId: string, sourcePath: string): Promise<AttachmentSaveResult> => {
    return codexAttachmentService.saveFromPath(sessionId, sourcePath)
  })

  safeHandle(
    IpcChannels.codexAttachmentsSaveFromDataUrl,
    (_event, sessionId: string, dataUrl: string): Promise<AttachmentSaveResult> => {
      return codexAttachmentService.saveFromDataUrl(sessionId, dataUrl)
    }
  )

  safeHandle(
    IpcChannels.codexAttachmentsResolve,
    (_event, sessionId: string, attachmentPath: string): Promise<AttachmentResolveResult> => {
      return codexAttachmentService.resolve(sessionId, attachmentPath)
    }
  )

  safeHandle(
    IpcChannels.codexResponseImageResolve,
    (_event, sessionId: string, requestedPath: string): Promise<AttachmentResolveResult> => {
      return codexResponseImageService.resolve({ sessionId, requestedPath, ...responseImageContext(sessionId) })
    }
  )

  safeHandle(
    IpcChannels.codexResponseImageReveal,
    (_event, sessionId: string, requestedPath: string): Promise<{ ok: boolean; error?: string }> => {
      return codexResponseImageService.revealInFolder({ sessionId, requestedPath, ...responseImageContext(sessionId) })
    }
  )

  safeHandle(
    IpcChannels.codexResponseImageOpenExternally,
    (_event, sessionId: string, requestedPath: string): Promise<{ ok: boolean; error?: string }> => {
      return codexResponseImageService.openExternally({ sessionId, requestedPath, ...responseImageContext(sessionId) })
    }
  )
}
