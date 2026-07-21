// Real sql.js database (a disposable temp userData dir), not a mock —
// migration safety and cascade-delete behavior are exactly the kind of
// thing a mocked repository layer can't actually prove.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import initSqlJs from 'sql.js'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? userDataDir : tmpdir()) }
}))

import { initDatabase, closeDatabase } from '../../src/main/db/database'
import { workspaceRepo } from '../../src/main/db/repositories/workspace-repo'
import { sessionRepo } from '../../src/main/db/repositories/session-repo'
import { messageRepo } from '../../src/main/db/repositories/message-repo'

describe('database migrations — safety over an existing pre-migration database', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'agentdock-migration-'))
  })

  afterEach(() => {
    closeDatabase()
    vi.restoreAllMocks()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('adds the new columns to a database created with the OLD schema, without losing any existing data', async () => {
    // Hand-build a real sqlite file using the OLD (pre-project) schema —
    // exactly what a real existing user's agentdock.sqlite3 looks like.
    const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
    const oldDb = new SQL.Database()
    oldDb.run(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        added_at TEXT NOT NULL, last_opened_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
        native_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `)
    oldDb.run(
      "INSERT INTO workspaces VALUES ('w1', 'C:\\old-project', 'old-project', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')"
    )
    oldDb.run(
      "INSERT INTO sessions VALUES ('s1', 'w1', 'claude-code', 'My real renamed title', 'idle', 'native-abc', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')"
    )
    const helloContent = JSON.stringify({ kind: 'text', text: 'hello' }).replace(/'/g, "''")
    oldDb.run(`INSERT INTO messages VALUES ('m1', 's1', 'user', '${helloContent}', '2024-01-01T00:00:00Z')`)
    const dbPath = join(userDataDir, 'agentdock.sqlite3')
    writeFileSync(dbPath, Buffer.from(oldDb.export()))
    oldDb.close()

    await initDatabase()

    // Existing data survived, untouched.
    const workspace = workspaceRepo.get('w1')!
    expect(workspace.path).toBe('C:\\old-project')
    expect(workspace.collapsed).toBe(false) // safe default for a pre-existing row

    const session = sessionRepo.get('s1')!
    expect(session.title).toBe('My real renamed title') // not a generic title -> never touched
    expect(session.titleSource).toBe('manual') // the safe default for pre-existing rows
    expect(session.continuedFromSessionId).toBeNull()

    expect(messageRepo.listBySession('s1')).toHaveLength(1)
  })

  it('retroactively derives a real title for a migrated session still sitting on the generic placeholder', async () => {
    const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
    const oldDb = new SQL.Database()
    oldDb.run(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        added_at TEXT NOT NULL, last_opened_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
        native_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `)
    oldDb.run("INSERT INTO workspaces VALUES ('w1', 'C:\\proj', 'proj', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')")
    oldDb.run(
      "INSERT INTO sessions VALUES ('s1', 'w1', 'codex', 'New Codex session', 'idle', NULL, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')"
    )
    const content = JSON.stringify({ kind: 'text', text: 'Please add a reset dashboard' }).replace(/'/g, "''")
    oldDb.run(`INSERT INTO messages VALUES ('m1', 's1', 'user', '${content}', '2024-01-01T00:00:00Z')`)
    const dbPath = join(userDataDir, 'agentdock.sqlite3')
    writeFileSync(dbPath, Buffer.from(oldDb.export()))
    oldDb.close()

    await initDatabase()

    const session = sessionRepo.get('s1')!
    expect(session.title).not.toBe('New Codex session')
    expect(session.title).toBe('Add a reset dashboard')
    expect(session.titleSource).toBe('generated')
  })

  it('running the migration twice in a row (two app launches) is a safe no-op the second time', async () => {
    await initDatabase()
    workspaceRepo.upsert('C:\\proj', 'proj')
    closeDatabase()

    // Simulate a second app launch against the now-current-schema file.
    await initDatabase()
    expect(workspaceRepo.list()).toHaveLength(1)
  })
})

describe('workspaceRepo — project CRUD and cascade delete', () => {
  beforeEach(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'agentdock-workspacerepo-'))
    await initDatabase()
  })

  afterEach(() => {
    closeDatabase()
    vi.restoreAllMocks()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('creates, lists, renames, and reads back a project', () => {
    const project = workspaceRepo.upsert('C:\\proj', 'proj')
    expect(project.collapsed).toBe(false)

    workspaceRepo.rename(project.id, 'Renamed Project')
    expect(workspaceRepo.get(project.id)!.name).toBe('Renamed Project')

    expect(workspaceRepo.list().map((p) => p.id)).toContain(project.id)
  })

  it('persists collapsed state', () => {
    const project = workspaceRepo.upsert('C:\\proj', 'proj')
    workspaceRepo.setCollapsed(project.id, true)
    expect(workspaceRepo.get(project.id)!.collapsed).toBe(true)
    workspaceRepo.setCollapsed(project.id, false)
    expect(workspaceRepo.get(project.id)!.collapsed).toBe(false)
  })

  it('shows multiple distinct projects at once, most-recently-opened first', () => {
    const a = workspaceRepo.upsert('C:\\a', 'a')
    // sql.js/sqlite string ordering ties on identical timestamps in the
    // same millisecond are possible in a fast test — upsert touching `a`
    // again after `b` proves the ordering genuinely reflects last_opened_at.
    workspaceRepo.upsert('C:\\b', 'b')
    workspaceRepo.upsert(a.path, a.name)

    const list = workspaceRepo.list()
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe(a.id)
  })

  it('CRITICAL: deleting a project cascades to its sessions and messages (real FK enforcement, not decorative)', () => {
    const project = workspaceRepo.upsert('C:\\proj', 'proj')
    const session = sessionRepo.create(project.id, 'claude-code', 'Some work')
    messageRepo.add(session.id, 'user', { kind: 'text', text: 'hello' })

    workspaceRepo.delete(project.id)

    expect(workspaceRepo.get(project.id)).toBeNull()
    expect(sessionRepo.get(session.id)).toBeNull()
    expect(messageRepo.listBySession(session.id)).toHaveLength(0)
  })
})

describe('sessionRepo — title source and continuation lineage', () => {
  let projectId: string

  beforeEach(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'agentdock-sessionrepo-'))
    await initDatabase()
    projectId = workspaceRepo.upsert('C:\\proj', 'proj').id
  })

  afterEach(() => {
    closeDatabase()
    vi.restoreAllMocks()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('defaults titleSource to "default" and continuedFromSessionId to null', () => {
    const session = sessionRepo.create(projectId, 'claude-code', 'New Claude Code session')
    expect(session.titleSource).toBe('default')
    expect(session.continuedFromSessionId).toBeNull()
  })

  it('records an explicit continuation lineage', () => {
    const source = sessionRepo.create(projectId, 'claude-code', 'Build login')
    const next = sessionRepo.create(projectId, 'codex', 'Add password reset (continued)', 'handoff', source.id)
    expect(next.continuedFromSessionId).toBe(source.id)
    expect(next.titleSource).toBe('handoff')
  })

  it('setTitle updates both the title and its source, never silently', () => {
    const session = sessionRepo.create(projectId, 'claude-code', 'New Claude Code session')
    sessionRepo.setTitle(session.id, 'Build login', 'generated')
    let updated = sessionRepo.get(session.id)!
    expect(updated.title).toBe('Build login')
    expect(updated.titleSource).toBe('generated')

    sessionRepo.setTitle(session.id, 'My own name', 'manual')
    updated = sessionRepo.get(session.id)!
    expect(updated.title).toBe('My own name')
    expect(updated.titleSource).toBe('manual')
  })

  it('when the continued-from session is deleted, the reference is cleared rather than left dangling', () => {
    const source = sessionRepo.create(projectId, 'claude-code', 'Build login')
    const next = sessionRepo.create(projectId, 'codex', 'Continued', 'handoff', source.id)
    sessionRepo.delete(source.id)
    expect(sessionRepo.get(next.id)!.continuedFromSessionId).toBeNull()
  })
})
