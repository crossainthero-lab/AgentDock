import { randomUUID } from 'node:crypto'
import { getDatabase, persist } from '../database'
import { all, get, run } from '../sqlite-adapter'
import type { AgentId, Session, SessionStatus } from '@shared/types'

interface SessionRow {
  id: string
  workspace_id: string
  agent_id: string
  title: string
  status: string
  native_session_id: string | null
  created_at: string
  updated_at: string
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id as AgentId,
    title: row.title,
    status: row.status as SessionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export const sessionRepo = {
  create(workspaceId: string, agentId: AgentId, title: string): Session {
    const now = new Date().toISOString()
    const session: Session = {
      id: randomUUID(),
      workspaceId,
      agentId,
      title,
      status: 'idle',
      createdAt: now,
      updatedAt: now
    }
    run(
      getDatabase(),
      `INSERT INTO sessions (id, workspace_id, agent_id, title, status, created_at, updated_at)
       VALUES (@id, @workspaceId, @agentId, @title, @status, @createdAt, @updatedAt)`,
      session
    )
    persist()
    return session
  },

  get(id: string): Session | null {
    const row = get<SessionRow>(getDatabase(), 'SELECT * FROM sessions WHERE id = @id', { id })
    return row ? rowToSession(row) : null
  },

  listByWorkspace(workspaceId: string): Session[] {
    const rows = all<SessionRow>(
      getDatabase(),
      'SELECT * FROM sessions WHERE workspace_id = @workspaceId ORDER BY updated_at DESC',
      { workspaceId }
    )
    return rows.map(rowToSession)
  },

  setStatus(id: string, status: SessionStatus): void {
    run(getDatabase(), 'UPDATE sessions SET status = @status, updated_at = @now WHERE id = @id', {
      status,
      now: new Date().toISOString(),
      id
    })
    persist()
  },

  setNativeSessionId(id: string, nativeSessionId: string): void {
    run(
      getDatabase(),
      'UPDATE sessions SET native_session_id = @nativeSessionId, updated_at = @now WHERE id = @id',
      { nativeSessionId, now: new Date().toISOString(), id }
    )
    persist()
  },

  getNativeSessionId(id: string): string | null {
    const row = get<{ native_session_id: string | null }>(
      getDatabase(),
      'SELECT native_session_id FROM sessions WHERE id = @id',
      { id }
    )
    return row?.native_session_id ?? null
  },

  touch(id: string): void {
    run(getDatabase(), 'UPDATE sessions SET updated_at = @now WHERE id = @id', {
      now: new Date().toISOString(),
      id
    })
    persist()
  },

  delete(id: string): void {
    run(getDatabase(), 'DELETE FROM sessions WHERE id = @id', { id })
    persist()
  }
}
