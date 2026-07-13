import { randomUUID } from 'node:crypto'
import { getDatabase, persist } from '../database'
import { all, run } from '../sqlite-adapter'
import type { MessageContent, MessageRole, SessionMessage } from '@shared/types'

interface MessageRow {
  id: string
  session_id: string
  role: string
  content_json: string
  created_at: string
}

function rowToMessage(row: MessageRow): SessionMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as MessageRole,
    content: JSON.parse(row.content_json) as MessageContent,
    createdAt: row.created_at
  }
}

export const messageRepo = {
  add(sessionId: string, role: MessageRole, content: MessageContent): SessionMessage {
    const message: SessionMessage = {
      id: randomUUID(),
      sessionId,
      role,
      content,
      createdAt: new Date().toISOString()
    }
    run(
      getDatabase(),
      'INSERT INTO messages (id, session_id, role, content_json, created_at) VALUES (@id, @sessionId, @role, @contentJson, @createdAt)',
      {
        id: message.id,
        sessionId: message.sessionId,
        role: message.role,
        contentJson: JSON.stringify(message.content),
        createdAt: message.createdAt
      }
    )
    persist()
    return message
  },

  listBySession(sessionId: string): SessionMessage[] {
    const rows = all<MessageRow>(
      getDatabase(),
      'SELECT * FROM messages WHERE session_id = @sessionId ORDER BY created_at ASC',
      { sessionId }
    )
    return rows.map(rowToMessage)
  }
}
