// Covers requirement areas that don't fit neatly under an existing test
// file: settings/workspace state that was valid on one machine (or was
// simply never re-validated) being handled safely on another, the
// Settings "reset stale configuration" action, and spawn-diagnostics'
// packaged-vs-development and path-redaction behavior. A real sql.js
// database under a disposable temp userData dir is used throughout — not a
// mock — since "does this actually persist/clear correctly" is exactly
// what a mocked repository layer can't prove.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

let userDataDir: string
let isPackaged = false

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? userDataDir : tmpdir()),
    getVersion: () => '0.1.0-test',
    get isPackaged() {
      return isPackaged
    }
  },
  dialog: { showOpenDialog: vi.fn() }
}))

import { initDatabase, closeDatabase } from '../../src/main/db/database'
import { settingsService } from '../../src/main/services/settings-service'
import { workspaceService } from '../../src/main/services/workspace-service'
import { workspaceRepo } from '../../src/main/db/repositories/workspace-repo'
import { codexModelCatalogRepo } from '../../src/main/db/repositories/codex-model-catalog-repo'
import { buildSpawnDiagnostics } from '../../src/main/services/spawn-diagnostics'

describe('settingsService.resetAgentDetection', () => {
  beforeEach(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'agentdock-reset-'))
    await initDatabase()
  })

  afterEach(() => {
    closeDatabase()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('clears every agent custom path and the cached Codex model catalogue, leaving other preferences untouched', () => {
    settingsService.update({
      agents: {
        'claude-code': { customPath: 'C:\\Users\\dev-machine-only\\.local\\bin\\claude.exe', permissionMode: 'plan' },
        codex: { customPath: 'C:\\Users\\dev-machine-only\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe', model: 'gpt-5.6-sol' }
      }
    })
    codexModelCatalogRepo.set({ models: [{ id: 'gpt-5.6-sol', label: 'Sol', description: '' }], fetchedAt: new Date().toISOString() })

    const reset = settingsService.resetAgentDetection()

    expect(reset.agents['claude-code'].customPath).toBeNull()
    expect(reset.agents.codex.customPath).toBeNull()
    // Preferences that aren't machine-specific paths survive the reset —
    // this is a targeted fix, not a full factory reset.
    expect(reset.agents['claude-code'].permissionMode).toBe('plan')
    expect(reset.agents.codex.model).toBe('gpt-5.6-sol')
    expect(codexModelCatalogRepo.get()).toBeNull()
  })
})

describe('workspaceService.findMissingWorkspaces / removeMissingWorkspaces', () => {
  let realProjectDir: string

  beforeEach(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'agentdock-reset-'))
    await initDatabase()
    realProjectDir = mkdtempSync(join(tmpdir(), 'agentdock-real-project-'))
  })

  afterEach(() => {
    closeDatabase()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(realProjectDir, { recursive: true, force: true })
  })

  it('reports only the workspace whose folder does not exist on this machine — simulating settings copied from another computer', () => {
    workspaceRepo.upsert(realProjectDir, 'Real Project')
    // A path that made sense on whatever machine these settings originally
    // came from, but resolves to nothing here.
    const missingPath = join(tmpdir(), 'agentdock-never-existed-on-this-machine')
    workspaceRepo.upsert(missingPath, 'Ghost Project')

    const missing = workspaceService.findMissingWorkspaces()

    expect(missing).toHaveLength(1)
    expect(missing[0].name).toBe('Ghost Project')
  })

  it('removes only the missing workspace row and never touches the real folder on disk', () => {
    const real = workspaceRepo.upsert(realProjectDir, 'Real Project')
    const missingPath = join(tmpdir(), 'agentdock-never-existed-on-this-machine')
    workspaceRepo.upsert(missingPath, 'Ghost Project')

    const removed = workspaceService.removeMissingWorkspaces()

    expect(removed).toHaveLength(1)
    expect(removed[0].name).toBe('Ghost Project')
    expect(workspaceRepo.list().map((w) => w.id)).toEqual([real.id])
    // The whole point: this only ever clears AgentDock's own bookkeeping
    // row — the real project's actual folder is completely unaffected.
    expect(existsSync(realProjectDir)).toBe(true)
  })

  it('reports nothing missing when every saved workspace folder still exists', () => {
    workspaceRepo.upsert(realProjectDir, 'Real Project')
    expect(workspaceService.findMissingWorkspaces()).toHaveLength(0)
    expect(workspaceService.removeMissingWorkspaces()).toHaveLength(0)
    expect(workspaceRepo.list()).toHaveLength(1)
  })
})

describe('buildSpawnDiagnostics — packaged vs development mode, and redaction', () => {
  afterEach(() => {
    isPackaged = false
  })

  it('reflects development mode when app.isPackaged is false', () => {
    isPackaged = false
    const diag = buildSpawnDiagnostics({ agentId: 'codex', mechanism: 'test', executablePath: null, error: new Error('boom') })
    expect(diag.packaged).toBe(false)
  })

  it('reflects packaged mode when app.isPackaged is true', () => {
    isPackaged = true
    const diag = buildSpawnDiagnostics({ agentId: 'codex', mechanism: 'test', executablePath: null, error: new Error('boom') })
    expect(diag.packaged).toBe(true)
  })

  it('redacts the current user home directory out of the executable path and cwd', () => {
    const home = homedir()
    const fakeExecutable = join(home, 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')
    const fakeCwd = join(home, 'Documents', 'My Project')
    const diag = buildSpawnDiagnostics({
      agentId: 'codex',
      mechanism: 'test',
      executablePath: fakeExecutable,
      cwd: fakeCwd,
      error: new Error('boom')
    })
    expect(diag.executablePath).not.toContain(home)
    expect(diag.executablePath).toContain('~')
    expect(diag.cwd).not.toContain(home)
  })

  it('captures error name/code/message/stack when the error is a real Error', () => {
    const err = Object.assign(new Error('spawn C:\\codex\\codex.cmd EINVAL'), { code: 'EINVAL' })
    const diag = buildSpawnDiagnostics({ agentId: 'codex', mechanism: 'sdk-spawn', executablePath: null, error: err })
    expect(diag.errorCode).toBe('EINVAL')
    expect(diag.errorMessage).toMatch(/EINVAL/)
    expect(diag.errorStack).toBeTruthy()
  })
})
