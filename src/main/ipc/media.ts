import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { mediaService } from '../services/media-service'

export function registerMediaIpc(): void {
  ipcMain.handle(IpcChannels.mediaResolveImage, (_event, workspaceId: string, path: string) =>
    mediaService.resolveWorkspaceImage(workspaceId, path)
  )
  ipcMain.handle(IpcChannels.mediaRevealInFolder, (_event, workspaceId: string, path: string) =>
    mediaService.revealInFolder(workspaceId, path)
  )
  ipcMain.handle(IpcChannels.mediaOpenLocalPath, (_event, workspaceId: string, path: string) =>
    mediaService.openLocalPath(workspaceId, path)
  )
  ipcMain.handle(IpcChannels.mediaOpenExternalLink, (_event, url: string) => mediaService.openExternalLink(url))
}
