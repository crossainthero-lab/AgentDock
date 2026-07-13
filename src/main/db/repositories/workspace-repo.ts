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
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    addedAt: row.added_at,
    lastOpenedAt: row.last_opened_at
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
    const workspace: Workspace = { id: randomUUID(), path, name, addedAt: now, lastOpenedAt: now }
    run(
      getDatabase(),
      'INSERT INTO workspaces (id, path, name, added_at, last_opened_at) VALUES (@id, @path, @name, @addedAt, @lastOpenedAt)',
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
  }
}
