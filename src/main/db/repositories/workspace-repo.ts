import { randomUUID } from 'node:crypto'
import { getDatabase, persist } from '../database'
import { all, get, run } from '../sqlite-adapter'
import type { Workspace } from '@shared/types'

interface WorkspaceRow {
  id: string
  path: string
  name: string
  added_at: string
  last_opened_at: string
  collapsed: number
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    addedAt: row.added_at,
    lastOpenedAt: row.last_opened_at,
    collapsed: !!row.collapsed
  }
}

export const workspaceRepo = {
  findByPath(path: string): Workspace | null {
    const row = get<WorkspaceRow>(getDatabase(), 'SELECT * FROM workspaces WHERE path = @path', {
      path
    })
    return row ? rowToWorkspace(row) : null
  },

  upsert(path: string, name: string): Workspace {
    const existing = this.findByPath(path)
    const now = new Date().toISOString()
    if (existing) {
      run(getDatabase(), 'UPDATE workspaces SET last_opened_at = @now WHERE id = @id', {
        now,
        id: existing.id
      })
      persist()
      return { ...existing, lastOpenedAt: now }
    }
    const workspace: Workspace = { id: randomUUID(), path, name, addedAt: now, lastOpenedAt: now, collapsed: false }
    run(
      getDatabase(),
      `INSERT INTO workspaces (id, path, name, added_at, last_opened_at, collapsed)
       VALUES (@id, @path, @name, @addedAt, @lastOpenedAt, 0)`,
      workspace
    )
    persist()
    return workspace
  },

  list(): Workspace[] {
    const rows = all<WorkspaceRow>(
      getDatabase(),
      'SELECT * FROM workspaces ORDER BY last_opened_at DESC'
    )
    return rows.map(rowToWorkspace)
  },

  get(id: string): Workspace | null {
    const row = get<WorkspaceRow>(getDatabase(), 'SELECT * FROM workspaces WHERE id = @id', { id })
    return row ? rowToWorkspace(row) : null
  },

  rename(id: string, name: string): void {
    run(getDatabase(), 'UPDATE workspaces SET name = @name WHERE id = @id', { name, id })
    persist()
  },

  setCollapsed(id: string, collapsed: boolean): void {
    run(getDatabase(), 'UPDATE workspaces SET collapsed = @collapsed WHERE id = @id', { collapsed: collapsed ? 1 : 0, id })
    persist()
  },

  /** Cascades to every session (and, via sessions' own FK, every message) in
   *  this project — the schema's ON DELETE CASCADE does the real work. */
  delete(id: string): void {
    run(getDatabase(), 'DELETE FROM workspaces WHERE id = @id', { id })
    persist()
  }
}
