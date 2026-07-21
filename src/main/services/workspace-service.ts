import { dialog, type BrowserWindow } from 'electron'
import { basename } from 'node:path'
import { workspaceRepo } from '../db/repositories/workspace-repo'
import { sessionRepo } from '../db/repositories/session-repo'
import { sessionService } from './session-service'
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
  },

  rename(id: string, name: string): Workspace {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('A project name cannot be empty.')
    workspaceRepo.rename(id, trimmed)
    const workspace = workspaceRepo.get(id)
    if (!workspace) throw new Error('Project not found.')
    return workspace
  },

  setCollapsed(id: string, collapsed: boolean): void {
    workspaceRepo.setCollapsed(id, collapsed)
  },

  /** Stops every live conversation under this project (reusing
   *  sessionService.delete's existing stop+cleanup, exactly as if each had
   *  been deleted individually) before removing the project row itself —
   *  the schema's ON DELETE CASCADE (see database.ts's `PRAGMA foreign_keys
   *  = ON`) would clean up the database rows either way, but only this
   *  stops the actual live processes and clears session-service's
   *  in-memory listener state for them. */
  delete(id: string): void {
    const sessions = sessionRepo.listByWorkspace(id)
    for (const session of sessions) {
      sessionService.delete(session.id)
    }
    workspaceRepo.delete(id)
    if (currentWorkspace?.id === id) currentWorkspace = null
  }
}
