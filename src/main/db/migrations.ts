// Additive, idempotent schema migrations for databases created before a
// given column existed. schema.ts's `CREATE TABLE IF NOT EXISTS` only
// covers a genuinely fresh install — an existing user's database keeps
// whatever columns its tables had the day it was first created, so any new
// column must be added here via ALTER TABLE, guarded so re-running it on
// every startup is always safe. Never destructive: only ADD COLUMN, never
// DROP/RENAME, and every step is wrapped so a migration failure can't take
// down the rest of app startup.
import type { Database as SqlJsDatabase } from 'sql.js'
import { all, get, run } from './sqlite-adapter'
import { deriveTitleFromPrompt, isGenericDefaultTitle } from '../services/title-service'

interface ColumnInfo {
  name: string
}

function hasColumn(db: SqlJsDatabase, table: string, column: string): boolean {
  const columns = all<ColumnInfo>(db, `PRAGMA table_info(${table})`)
  return columns.some((c) => c.name === column)
}

export function runMigrations(db: SqlJsDatabase): void {
  if (!hasColumn(db, 'workspaces', 'collapsed')) {
    run(db, 'ALTER TABLE workspaces ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0')
  }

  // Defaults to 'manual' here specifically — the safe choice for rows that
  // already existed before this column did, since there's no way to know
  // in hindsight whether a title was ever meaningfully auto-generated.
  // 'manual' just means "never touched automatically again", which is a
  // conservative no-op for any title that's already fine. The backfill
  // below immediately upgrades the one case where that's overly cautious:
  // sessions still sitting on the literal generic placeholder.
  const titleSourceIsNew = !hasColumn(db, 'sessions', 'title_source')
  if (titleSourceIsNew) {
    run(db, "ALTER TABLE sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT 'manual'")
  }

  if (!hasColumn(db, 'sessions', 'continued_from_session_id')) {
    run(db, 'ALTER TABLE sessions ADD COLUMN continued_from_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL')
  }

  if (titleSourceIsNew) {
    backfillGenericTitles(db)
  }
}

interface SessionTitleRow {
  id: string
  title: string
}

interface FirstUserMessageRow {
  content_json: string
}

/** One-time, best-effort improvement for sessions migrating in from before
 *  automatic titling existed: a session still showing the literal "New
 *  <Agent> session" placeholder gets a real topic title derived from its
 *  own first user message, exactly the way a brand-new session would get
 *  one today. Never touches a session whose title was ever changed to
 *  anything else — that's real content, not the untouched sign of a
 *  session no one has meaningfully renamed. */
function backfillGenericTitles(db: SqlJsDatabase): void {
  let sessions: SessionTitleRow[]
  try {
    sessions = all<SessionTitleRow>(db, 'SELECT id, title FROM sessions')
  } catch {
    return
  }

  for (const session of sessions) {
    if (!isGenericDefaultTitle(session.title)) continue
    try {
      const firstMessage = get<FirstUserMessageRow>(
        db,
        "SELECT content_json FROM messages WHERE session_id = @id AND role = 'user' ORDER BY created_at ASC LIMIT 1",
        { id: session.id }
      )
      if (!firstMessage) continue
      const content = JSON.parse(firstMessage.content_json) as { kind?: string; text?: string }
      if (content.kind !== 'text' || !content.text) continue
      const derived = deriveTitleFromPrompt(content.text)
      if (!derived) continue
      run(db, "UPDATE sessions SET title = @title, title_source = 'generated' WHERE id = @id", {
        title: derived,
        id: session.id
      })
    } catch (err) {
      // A single session's backfill failing (malformed JSON, etc.) must
      // never block startup or the rest of the backfill.
      console.warn(`[migrations] title backfill failed for session ${session.id}:`, err)
    }
  }
}
