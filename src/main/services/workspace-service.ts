import { dialog, type BrowserWindow } from 'electron'
import { basename } from 'node:path'
import { workspaceRepo } from '../db/repositories/workspace-repo'
import type { Workspace } from '@shared/types'

let currentWorkspace: Workspace | null = null

export const workspaceService = {
  async open(window: BrowserWindow): Promise<Workspace | null> {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Open Project'
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const path = result.filePaths[0]
    const workspace = workspaceRepo.upsert(path, basename(path))
    currentWorkspace = workspace
    return workspace
  },

  list(): Workspace[] {
    return workspaceRepo.list()
  },

  getCurrent(): Workspace | null {
    return currentWorkspace
  },

  close(): void {
    currentWorkspace = null
  }
}
