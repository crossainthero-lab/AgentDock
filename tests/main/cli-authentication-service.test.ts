import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let homeDir: string
let originalUserProfile: string | undefined
let originalHome: string | undefined

// The service resolves the home directory via USERPROFILE/HOME (see its own
// homeDirectory() helper) rather than node:os's homedir() directly — same
// env-var-first convention executable-resolver.ts's known-install-dir
// helpers already use, specifically because os.homedir() on Windows calls
// into a native OS binding that ignores USERPROFILE and so can't be
// redirected for a test this way. Setting both env vars keeps this suite
// deterministic regardless of which OS actually runs it.
function setMockHome(dir: string): void {
  process.env.USERPROFILE = dir
  process.env.HOME = dir
}

interface MockProc {
  pid: number
  isRunning: boolean
  kill: ReturnType<typeof vi.fn>
  onData: (cb: (chunk: string) => void) => () => void
  onExit: (cb: (info: { exitCode: number | null; signal: number | null }) => void) => () => void
  emitExit(): void
}

const spawnCalls: Array<{ command: string; args: string[]; cwd?: string }> = []
let lastProc: MockProc | null = null
let spawnShouldThrow: Error | null = null

function makeMockProc(): MockProc {
  const exitListeners: Array<(info: { exitCode: number | null; signal: number | null }) => void> = []
  const proc: MockProc = {
    pid: 42,
    isRunning: true,
    kill: vi.fn(() => {
      proc.isRunning = false
    }),
    onData: () => () => {},
    onExit(cb) {
      exitListeners.push(cb)
      return () => {}
    },
    emitExit() {
      proc.isRunning = false
      for (const l of exitListeners) l({ exitCode: 0, signal: null })
    }
  }
  return proc
}

vi.mock('../../src/main/services/pty-service', () => ({
  ptyService: {
    spawn: (command: string, args: string[], options: { cwd: string }) => {
      if (spawnShouldThrow) {
        const err = spawnShouldThrow
        spawnShouldThrow = null
        throw err
      }
      spawnCalls.push({ command, args, cwd: options.cwd })
      lastProc = makeMockProc()
      return lastProc
    }
  }
}))

import { cliAuthenticationService } from '../../src/main/services/cli-authentication-service'

describe('cliAuthenticationService.checkAuthState', () => {
  let originalCodexHome: string | undefined
  let originalApiKey: string | undefined

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'agentdock-auth-home-'))
    originalCodexHome = process.env.CODEX_HOME
    originalApiKey = process.env.ANTHROPIC_API_KEY
    originalUserProfile = process.env.USERPROFILE
    originalHome = process.env.HOME
    delete process.env.CODEX_HOME
    delete process.env.ANTHROPIC_API_KEY
    setMockHome(homeDir)
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = originalCodexHome
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalApiKey
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  it('codex: reports "authenticated" when ~/.codex/auth.json exists', async () => {
    const codexDir = join(homeDir, '.codex')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(join(codexDir, 'auth.json'), '{}')

    await expect(cliAuthenticationService.checkAuthState('codex')).resolves.toBe('authenticated')
  })

  it('codex: reports "required" when no credential file exists — this is the "authentication required" case', async () => {
    await expect(cliAuthenticationService.checkAuthState('codex')).resolves.toBe('required')
  })

  it('codex: honors a custom CODEX_HOME the same way the real CLI does', async () => {
    const customHome = mkdtempSync(join(tmpdir(), 'agentdock-custom-codex-home-'))
    process.env.CODEX_HOME = customHome
    mkdirSync(customHome, { recursive: true })
    writeFileSync(join(customHome, 'auth.json'), '{}')

    await expect(cliAuthenticationService.checkAuthState('codex')).resolves.toBe('authenticated')
    rmSync(customHome, { recursive: true, force: true })
  })

  it('never reads or returns the contents of the credential file — existence only', async () => {
    const codexDir = join(homeDir, '.codex')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(join(codexDir, 'auth.json'), '{"secret":"this-must-never-be-inspected"}')

    const state = await cliAuthenticationService.checkAuthState('codex')
    expect(state).toBe('authenticated')
    expect(JSON.stringify(state)).not.toMatch(/secret|this-must-never-be-inspected/)
  })

  it('claude-code: reports "authenticated" when ANTHROPIC_API_KEY is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-real-key'
    await expect(cliAuthenticationService.checkAuthState('claude-code')).resolves.toBe('authenticated')
  })

  it('claude-code: reports "unknown" (never a guessed "required") when there is no reliable signal', async () => {
    await expect(cliAuthenticationService.checkAuthState('claude-code')).resolves.toBe('unknown')
  })

  it('antigravity: always reports "unknown" — no confirmed cross-platform credential signal', async () => {
    await expect(cliAuthenticationService.checkAuthState('antigravity')).resolves.toBe('unknown')
  })
})

describe('cliAuthenticationService.signIn', () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'agentdock-auth-home-'))
    originalUserProfile = process.env.USERPROFILE
    originalHome = process.env.HOME
    setMockHome(homeDir)
    spawnCalls.length = 0
    lastProc = null
    spawnShouldThrow = null
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  it('starts the CLI bare (no args) in a PTY rooted at the home directory, and returns a usable ptyId', () => {
    const result = cliAuthenticationService.signIn('codex', '/usr/local/bin/codex')

    expect(result.ok).toBe(true)
    expect(result.ptyId).toBeTruthy()
    expect(result.executablePath).toBe('/usr/local/bin/codex')
    expect(spawnCalls).toEqual([{ command: '/usr/local/bin/codex', args: [], cwd: homeDir }])
    expect(cliAuthenticationService.getPty(result.ptyId!)).toBe(lastProc)
  })

  it('reports a clean failure instead of throwing when the PTY cannot be spawned', () => {
    spawnShouldThrow = new Error('spawn failed')
    const result = cliAuthenticationService.signIn('codex', '/usr/local/bin/codex')

    expect(result.ok).toBe(false)
    expect(result.ptyId).toBeNull()
    expect(result.error).toMatch(/spawn failed/)
  })

  it('killPty() kills the underlying process and forgets it', () => {
    const result = cliAuthenticationService.signIn('claude-code', '/usr/local/bin/claude')
    const ptyId = result.ptyId!

    cliAuthenticationService.killPty(ptyId)

    expect(lastProc!.kill).toHaveBeenCalled()
    expect(cliAuthenticationService.getPty(ptyId)).toBeUndefined()
  })

  it('forgets a PTY once it exits on its own (e.g. the user finished signing in and exited the CLI)', () => {
    const result = cliAuthenticationService.signIn('antigravity', '/usr/local/bin/agy')
    const ptyId = result.ptyId!

    lastProc!.emitExit()

    expect(cliAuthenticationService.getPty(ptyId)).toBeUndefined()
  })
})
