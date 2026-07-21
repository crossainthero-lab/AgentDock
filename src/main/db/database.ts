import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCHEMA_SQL } from './schema'
import { runMigrations } from './migrations'

let db: SqlJsDatabase | null = null
let dbFilePath = ''

export async function initDatabase(): Promise<void> {
  if (db) return

  const userDataDir = app.getPath('userData')
  if (!existsSync(userDataDir)) {
    mkdirSync(userDataDir, { recursive: true })
  }
  dbFilePath = join(userDataDir, 'agentdock.sqlite3')

  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
  const SQL = await initSqlJs({ locateFile: () => wasmPath })

  db = existsSync(dbFilePath) ? new SQL.Database(readFileSync(dbFilePath)) : new SQL.Database()
  // Off by default in SQLite unless set per-connection — without it, every
  // `ON DELETE CASCADE` in schema.ts (messages/approval_memory -> sessions,
  // sessions -> workspaces) is purely decorative and deleting a project or
  // session would silently orphan its rows instead of cleaning them up.
  db.run('PRAGMA foreign_keys = ON')
  db.run(SCHEMA_SQL)
  runMigrations(db)
  persist()
}

export function getDatabasePath(): string {
  return dbFilePath
}

export function getDatabase(): SqlJsDatabase {
  if (!db) {
    throw new Error('Database accessed before initDatabase() completed')
  }
  return db
}

/** Flush the in-memory database to disk. Call after any mutating statement.
 *
 * CRITICAL (real bug fix, confirmed via direct reproduction): sql.js's
 * `db.export()` — needed here to get the bytes to write — has the side
 * effect of resetting this *live* connection's `PRAGMA foreign_keys` back
 * to off, even though nothing about that pragma is actually persisted into
 * the exported bytes (it's a per-connection runtime setting, by SQLite's
 * own design, and export()/import() round-tripping doesn't preserve
 * runtime pragmas — this is exporting the same open connection's own
 * state, not reopening a file). Without re-enabling it here, every
 * `ON DELETE CASCADE`/`ON DELETE SET NULL` in schema.ts would work for
 * exactly the first mutation of the process and silently stop working
 * (orphaning rows instead of cascading) the moment the second persist()
 * call — which happens after nearly every repo method — ran. */
export function persist(): void {
  if (!db || !dbFilePath) return
  writeFileSync(dbFilePath, Buffer.from(db.export()))
  db.run('PRAGMA foreign_keys = ON')
}

export function closeDatabase(): void {
  if (!db) return
  persist()
  db.close()
  db = null
}
