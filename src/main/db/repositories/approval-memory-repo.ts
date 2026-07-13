import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { getDatabase, persist } from '../database'
import { get, run } from '../sqlite-adapter'
import type { ApprovalDecision } from '@shared/types'

export function hashCommand(command: string): string {
  return createHash('sha256').update(command).digest('hex')
}

export const approvalMemoryRepo = {
  /** Returns the remembered decision for this command within this session, if the user chose "allow for session". */
  getSessionDecision(sessionId: string, command: string): ApprovalDecision | null {
    const row = get<{ decision: string }>(
      getDatabase(),
      `SELECT decision FROM approval_memory
       WHERE session_id = @sessionId AND command_hash = @hash AND decision = 'allow-session'
       ORDER BY created_at DESC LIMIT 1`,
      { sessionId, hash: hashCommand(command) }
    )
    return (row?.decision as ApprovalDecision | undefined) ?? null
  },

  record(sessionId: string, command: string, decision: ApprovalDecision): void {
    run(
      getDatabase(),
      'INSERT INTO approval_memory (id, session_id, command_hash, decision, created_at) VALUES (@id, @sessionId, @hash, @decision, @now)',
      {
        id: randomUUID(),
        sessionId,
        hash: hashCommand(command),
        decision,
        now: new Date().toISOString()
      }
    )
    persist()
  }
}
