// Thin helper layer over sql.js (a WASM build of SQLite) that mimics the
// call shape of better-sqlite3's `.prepare(sql).get/.all/.run(params)`.
//
// sql.js was chosen over better-sqlite3 because better-sqlite3 requires a
// native (node-gyp) compile step, and this machine does not have the MSVC
// C++ build tools component installed (Visual Studio is present but without
// "Desktop development with C++", so node-gyp cannot find a usable
// toolset). sql.js runs entirely as WASM — no native compilation, no
// Electron ABI rebuild step — at the cost of being fully in-memory: we
// export the whole database to a file after every mutation (see
// `database.ts`), which is fine at AgentDock's scale (local single-user
// session/message history).
import type { Database as SqlJsDatabase } from 'sql.js'

// `object` (rather than `Record<string, unknown>`) so callers can pass a
// named interface (e.g. a `Session`) directly without TS demanding an
// explicit string index signature on that interface.
export type SqlParams = object | unknown[]

export interface RunResult {
  changes: number
}

function normalizeParams(params?: SqlParams): unknown[] | Record<string, unknown> {
  if (!params) return []
  if (Array.isArray(params)) return params
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    out[`@${key}`] = value === undefined ? null : value
  }
  return out
}

export function run(db: SqlJsDatabase, sql: string, params?: SqlParams): RunResult {
  db.run(sql, normalizeParams(params) as never)
  return { changes: db.getRowsModified() }
}

export function get<T = unknown>(db: SqlJsDatabase, sql: string, params?: SqlParams): T | undefined {
  const stmt = db.prepare(sql)
  try {
    stmt.bind(normalizeParams(params) as never)
    if (stmt.step()) {
      return stmt.getAsObject() as T
    }
    return undefined
  } finally {
    stmt.free()
  }
}

export function all<T = unknown>(db: SqlJsDatabase, sql: string, params?: SqlParams): T[] {
  const stmt = db.prepare(sql)
  const rows: T[] = []
  try {
    stmt.bind(normalizeParams(params) as never)
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as T)
    }
  } finally {
    stmt.free()
  }
  return rows
}
