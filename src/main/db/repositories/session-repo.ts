import { randomUUID } from 'node:crypto'
import { getDatabase, persist } from '../database'
import { all, get, run } from '../sqlite-adapter'
import type { AgentId, Session, SessionStatus, TitleSource } from '@shared/types'

interface SessionRow {
  id: string
  workspace_id: string
  agent_id: string
  title: string
  title_source: string
  continued_from_session_id: string | null
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
    titleSource: row.title_source as TitleSource,
    continuedFromSessionId: row.continued_from_session_id,
    status: row.status as SessionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export const sessionRepo = {
  create(
    workspaceId: string,
    agentId: AgentId,
    title: string,
    titleSource: TitleSource = 'default',
    continuedFromSessionId: string | null = null
  ): Session {
    const now = new Date().toISOString()
    const session: Session = {
      id: randomUUID(),
      workspaceId,
      agentId,
      title,
      titleSource,
      continuedFromSessionId,
      status: 'idle',
      createdAt: now,
      updatedAt: now
    }
    run(
      getDatabase(),
      `INSERT INTO sessions (id, workspace_id, agent_id, title, title_source, continued_from_session_id, status, created_at, updated_at)
       VALUES (@id, @workspaceId, @agentId, @title, @titleSource, @continuedFromSessionId, @status, @createdAt, @updatedAt)`,
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

  /** `source` records how this new title came to be — see TitleSource's doc
   *  comment for what governs whether it can ever be auto-changed again. */
  setTitle(id: string, title: string, source: TitleSource): void {
    run(getDatabase(), 'UPDATE sessions SET title = @title, title_source = @source, updated_at = @now WHERE id = @id', {
      title,
      source,
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
