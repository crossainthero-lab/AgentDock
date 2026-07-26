import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliInstallProgressEvent } from '../../src/shared/types'
import type { ResolveResult } from '../../src/main/services/executable-resolver'

interface MockExitInfo {
  exitCode: number | null
  signal: number | null
}

interface MockProc {
  pid: number
  isRunning: boolean
  kill: ReturnType<typeof vi.fn>
  onData: (cb: (chunk: string) => void) => () => void
  onExit: (cb: (info: MockExitInfo) => void) => () => void
  emitData(chunk: string): void
  emitExit(info: MockExitInfo): void
}

let lastProc: MockProc | null = null
const spawnCalls: Array<{ command: string; args: string[] }> = []
let spawnShouldThrow: Error | null = null

function makeMockProc(): MockProc {
  const dataListeners: Array<(chunk: string) => void> = []
  const exitListeners: Array<(info: MockExitInfo) => void> = []
  const proc: MockProc = {
    pid: 1234,
    isRunning: true,
    kill: vi.fn(() => {
      proc.emitExit({ exitCode: null, signal: null })
    }),
    onData(cb) {
      dataListeners.push(cb)
      return () => {}
    },
    onExit(cb) {
      exitListeners.push(cb)
      return () => {}
    },
    emitData(chunk) {
      for (const l of dataListeners) l(chunk)
    },
    emitExit(info) {
      if (!proc.isRunning) return
      proc.isRunning = false
      for (const l of exitListeners) l(info)
    }
  }
  return proc
}

vi.mock('../../src/main/services/pty-service', () => ({
  ptyService: {
    spawn: (command: string, args: string[]) => {
      if (spawnShouldThrow) {
        const err = spawnShouldThrow
        spawnShouldThrow = null
        throw err
      }
      spawnCalls.push({ command, args })
      lastProc = makeMockProc()
      return lastProc
    }
  }
}))

let resolveExecutableResult: ResolveResult = {
  resolvedPath: '/usr/local/bin/npm',
  checked: [],
  pathDirCount: 1,
  strategy: 'path-search',
  rejected: []
}
vi.mock('../../src/main/services/executable-resolver', () => ({
  resolveExecutable: vi.fn(async () => resolveExecutableResult),
  knownInstallDirs: vi.fn(() => [])
}))

vi.mock('../../src/main/services/executable-probe', () => ({
  probeExecutable: vi.fn(async () => ({ ok: true, output: '10.0.0' }))
}))

const detectMock = vi.fn()
vi.mock('../../src/main/services/detection-service', () => ({
  detectionService: { detect: (...args: unknown[]) => detectMock(...args) }
}))

const settingsGetMock = vi.fn()
vi.mock('../../src/main/services/settings-service', () => ({
  settingsService: { get: () => settingsGetMock() }
}))

let userDataDir: string
const openPathMock = vi.fn(async () => '')
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  shell: { openPath: (p: string) => openPathMock(p) }
}))

import { cliInstallationService } from '../../src/main/services/cli-installation-service'

/** Waits for the given condition without pinning the test to an exact
 *  number of chained microtask ticks (install() awaits resolveNpm(), which
 *  itself awaits the mocked resolveExecutable()) — same spirit as the
 *  repeated `await Promise.resolve()` flushes other tests in this suite
 *  use, just not brittle to the exact chain length. */
async function flushUntil(check: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks && !check(); i++) {
    await Promise.resolve()
  }
}

describe('cliInstallationService', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'agentdock-cli-install-'))
    spawnCalls.length = 0
    lastProc = null
    spawnShouldThrow = null
    resolveExecutableResult = { resolvedPath: '/usr/local/bin/npm', checked: [], pathDirCount: 1, strategy: 'path-search', rejected: [] }
    detectMock.mockReset()
    settingsGetMock.mockReset()
    settingsGetMock.mockReturnValue({
      agents: { 'claude-code': { customPath: null }, codex: { customPath: null }, antigravity: { customPath: null } }
    })
    openPathMock.mockClear()
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  describe('buildPlan', () => {
    it('reports the exact official npm command for a supported agent', async () => {
      const plan = await cliInstallationService.buildPlan('claude-code')
      expect(plan.supported).toBe(true)
      expect(plan.displayCommand).toBe('npm install -g @anthropic-ai/claude-code')
    })

    it('reports codex\'s own official npm command', async () => {
      const plan = await cliInstallationService.buildPlan('codex')
      expect(plan.supported).toBe(true)
      expect(plan.displayCommand).toBe('npm install -g @openai/codex')
    })

    it('reports unsupported for Antigravity — no confirmed official scriptable install method', async () => {
      const plan = await cliInstallationService.buildPlan('antigravity')
      expect(plan.supported).toBe(false)
      expect(plan.unsupportedReason).toBeTruthy()
      expect(plan.manualInstructions).toMatch(/antigravity/i)
    })

    it('reports unsupported when npm itself cannot be resolved on this machine', async () => {
      resolveExecutableResult = { resolvedPath: null, checked: [], pathDirCount: 0, strategy: 'not-found', rejected: [] }
      const plan = await cliInstallationService.buildPlan('codex')
      expect(plan.supported).toBe(false)
      expect(plan.unsupportedReason).toMatch(/npm/i)
    })
  })

  describe('install — success', () => {
    it('spawns the resolved npm executable with the real argv, streams output, and re-detects afterward', async () => {
      detectMock.mockResolvedValue({
        agentId: 'claude-code',
        installed: true,
        version: '1.2.3',
        executablePath: '/usr/local/bin/claude',
        error: null,
        structuredOutput: true
      })
      const progress: CliInstallProgressEvent[] = []
      const installId = 'install-1'

      const outcomePromise = cliInstallationService.install('claude-code', installId, (e) => progress.push(e))
      await flushUntil(() => lastProc !== null)
      lastProc!.emitData('added 1 package\n')
      lastProc!.emitExit({ exitCode: 0, signal: null })

      const outcome = await outcomePromise

      expect(outcome.ok).toBe(true)
      expect(outcome.cancelled).toBe(false)
      expect(outcome.detection?.installed).toBe(true)
      expect(spawnCalls[0]).toEqual({ command: '/usr/local/bin/npm', args: ['install', '-g', '@anthropic-ai/claude-code'] })
      expect(progress.some((e) => e.kind === 'output' && e.text === 'added 1 package\n')).toBe(true)
      expect(progress.some((e) => e.kind === 'exit')).toBe(true)

      const logPath = join(userDataDir, 'cli-setup-logs', `claude-code-${installId}.log`)
      expect(readFileSync(logPath, 'utf8')).toMatch(/added 1 package/)
    })
  })

  describe('install — failure', () => {
    it('reports a specific "permission denied" reason instead of a bare exit code, and still re-detects (partial install)', async () => {
      detectMock.mockResolvedValue({ agentId: 'codex', installed: false, version: null, executablePath: null, error: 'not found', structuredOutput: true })

      const outcomePromise = cliInstallationService.install('codex', 'install-2', () => {})
      await flushUntil(() => lastProc !== null)
      lastProc!.emitData('npm ERR! EACCES: permission denied\n')
      lastProc!.emitExit({ exitCode: 1, signal: null })

      const outcome = await outcomePromise

      expect(outcome.ok).toBe(false)
      expect(outcome.cancelled).toBe(false)
      expect(outcome.error).toMatch(/permission denied/i)
      expect(detectMock).toHaveBeenCalled()
      expect(outcome.detection?.installed).toBe(false)
    })

    it('reports a network-failure reason when npm cannot reach the registry', async () => {
      detectMock.mockResolvedValue({ agentId: 'codex', installed: false, version: null, executablePath: null, error: 'not found', structuredOutput: true })

      const outcomePromise = cliInstallationService.install('codex', 'install-net', () => {})
      await flushUntil(() => lastProc !== null)
      lastProc!.emitData('npm ERR! network ENOTFOUND registry.npmjs.org\n')
      lastProc!.emitExit({ exitCode: 1, signal: null })

      const outcome = await outcomePromise
      expect(outcome.ok).toBe(false)
      expect(outcome.error).toMatch(/internet connection|registry/i)
    })

    it('refuses automatic installation for an agent with no supported install method — never spawns anything', async () => {
      const outcome = await cliInstallationService.install('antigravity', 'install-5', () => {})
      expect(outcome.ok).toBe(false)
      expect(spawnCalls).toHaveLength(0)
    })

    it('fails clearly, without spawning anything, when npm cannot be resolved at all', async () => {
      resolveExecutableResult = { resolvedPath: null, checked: [], pathDirCount: 0, strategy: 'not-found', rejected: [] }
      const outcome = await cliInstallationService.install('codex', 'install-6', () => {})
      expect(outcome.ok).toBe(false)
      expect(outcome.error).toMatch(/npm/i)
      expect(spawnCalls).toHaveLength(0)
    })

    it('surfaces a spawn-time failure (e.g. a rejected Windows shim) as a clean error instead of throwing', async () => {
      spawnShouldThrow = new Error('"npm.cmd" is a Windows .cmd/.bat shim AgentDock could not resolve to a real executable.')
      const outcome = await cliInstallationService.install('codex', 'install-7', () => {})
      expect(outcome.ok).toBe(false)
      expect(outcome.error).toMatch(/shim/i)
    })
  })

  describe('install — cancellation and timeout', () => {
    it('cancelInstall() kills the process and the outcome reports cancelled, not a generic failure', async () => {
      const outcomePromise = cliInstallationService.install('codex', 'install-3', () => {})
      await flushUntil(() => lastProc !== null)

      cliInstallationService.cancelInstall('install-3')

      const outcome = await outcomePromise
      expect(outcome.cancelled).toBe(true)
      expect(outcome.ok).toBe(false)
      expect(outcome.timedOut).toBe(false)
      expect(lastProc!.kill).toHaveBeenCalled()
      // Cancellation short-circuits before the post-install re-detect.
      expect(detectMock).not.toHaveBeenCalled()
    })

    it('cancelInstall() is a safe no-op once the install already finished', async () => {
      detectMock.mockResolvedValue({ agentId: 'codex', installed: true, version: '1', executablePath: '/bin/codex', error: null, structuredOutput: true })
      const outcomePromise = cliInstallationService.install('codex', 'install-4', () => {})
      await flushUntil(() => lastProc !== null)
      lastProc!.emitExit({ exitCode: 0, signal: null })
      await outcomePromise

      expect(() => cliInstallationService.cancelInstall('install-4')).not.toThrow()
    })
  })

  describe('resolveCommandForTerminal — backs the "Open terminal" manual fallback', () => {
    it('returns the same resolved npm command install() would run', async () => {
      const resolved = await cliInstallationService.resolveCommandForTerminal('codex')
      expect(resolved).toEqual({ executablePath: '/usr/local/bin/npm', args: ['install', '-g', '@openai/codex'] })
    })

    it('returns null for an agent with no supported install method', async () => {
      const resolved = await cliInstallationService.resolveCommandForTerminal('antigravity')
      expect(resolved).toBeNull()
    })
  })

  describe('openLogsFolder', () => {
    it('reveals the on-disk install-logs directory', async () => {
      const result = await cliInstallationService.openLogsFolder()
      expect(result.ok).toBe(true)
      expect(openPathMock).toHaveBeenCalledWith(join(userDataDir, 'cli-setup-logs'))
    })
  })
})
