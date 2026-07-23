import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { filesystemService } from '../services/filesystem-service'
import { explorerContextMenuService } from '../services/explorer-context-menu-service'

export function registerFilesystemIpc(window: BrowserWindow): void {
  ipcMain.handle(IpcChannels.fsList, (_event, workspaceId: string, relPath: string) => filesystemService.list(workspaceId, relPath))

  ipcMain.handle(IpcChannels.fsRead, (_event, workspaceId: string, relPath: string) => filesystemService.read(workspaceId, relPath))

  ipcMain.handle(IpcChannels.fsCheckImportConflicts, (_event, workspaceId: string, destRelPath: string, fileNames: string[]) =>
    filesystemService.checkImportConflicts(workspaceId, destRelPath, fileNames)
  )

  ipcMain.handle(IpcChannels.fsBrowseImportFiles, () => filesystemService.browseImportFiles(window))

  ipcMain.handle(
    IpcChannels.fsImportFiles,
    (_event, workspaceId: string, destRelPath: string, files: { sourcePath: string; targetName: string }[]) =>
      filesystemService.importFiles(workspaceId, destRelPath, files)
  )

  ipcMain.handle(IpcChannels.fsImportFileAutoRename, (_event, workspaceId: string, destRelPath: string, sourcePath: string) =>
    filesystemService.importFileAutoRename(workspaceId, destRelPath, sourcePath)
  )

  ipcMain.handle(IpcChannels.fsImportFromDataUrl, (_event, workspaceId: string, destRelPath: string, fileName: string, dataUrl: string) =>
    filesystemService.importFromDataUrl(workspaceId, destRelPath, fileName, dataUrl)
  )

  ipcMain.handle(IpcChannels.fsWatch, (_event, workspaceId: string, relPath: string) =>
    filesystemService.watch(workspaceId, relPath, (wid, rp) => {
      window.webContents.send(IpcChannels.fsChanged, { workspaceId: wid, relPath: rp })
    })
  )

  ipcMain.handle(IpcChannels.fsUnwatch, (_event, workspaceId: string, relPath: string) => {
    filesystemService.unwatch(workspaceId, relPath)
  })

  ipcMain.handle(IpcChannels.fsShowContextMenu, (_event, workspaceId: string, relPath: string, isDirectory: boolean) => {
    explorerContextMenuService.show(window, workspaceId, relPath, isDirectory)
  })
}
