import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCHEMA_SQL } from './schema'

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
  db.run(SCHEMA_SQL)
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

/** Flush the in-memory database to disk. Call after any mutating statement. */
export function persist(): void {
  if (!db || !dbFilePath) return
  writeFileSync(dbFilePath, Buffer.from(db.export()))
}

export function closeDatabase(): void {
  if (!db) return
  persist()
  db.close()
  db = null
}
