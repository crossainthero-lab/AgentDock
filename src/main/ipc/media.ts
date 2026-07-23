import { safeHandle } from './ipc-utils'
import { IpcChannels } from '@shared/ipc-channels'
import { mediaService } from '../services/media-service'

export function registerMediaIpc(): void {
  safeHandle(IpcChannels.mediaResolveImage, (_event, workspaceId: string, path: string) =>
    mediaService.resolveWorkspaceImage(workspaceId, path)
  )
  safeHandle(IpcChannels.mediaRevealInFolder, (_event, workspaceId: string, path: string) =>
    mediaService.revealInFolder(workspaceId, path)
  )
  safeHandle(IpcChannels.mediaOpenLocalPath, (_event, workspaceId: string, path: string) =>
    mediaService.openLocalPath(workspaceId, path)
  )
  safeHandle(IpcChannels.mediaOpenExternalLink, (_event, url: string) => mediaService.openExternalLink(url))
}
