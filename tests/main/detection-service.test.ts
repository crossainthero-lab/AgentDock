import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// detection-service.ts's probe used to run via `execFile(..., { shell:
// process.platform === 'win32' })` — the exact combination Node's own
// DEP0190 deprecation warns about ("arguments are not escaped, only
// concatenated"). It now goes through cross-spawn instead (same fix as
// vscode-launcher-service.ts/codex-model-catalog-service.ts), which is
// what this file mocks — proving both the happy path (.exe AND .cmd-shim
// candidates both "just work" through it) and that a plainly invalid
// candidate is rejected by spawn-guard's validation *before* cross-spawn
// is ever called at all.

interface MockChild extends EventEmitter {
  stdout: EventEmitter & { setEncoding: (enc: string) => void }
  stderr: EventEmitter & { setEncoding: (enc: string) => void }
  kill: ReturnType<typeof vi.fn>
}

const spawnCalls: Array<{ command: string; args: string[] }> = []
let nextChild: MockChild | null = null

function makeChild(): MockChild {
  const child = new EventEmitter() as MockChild
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
  child.kill = vi.fn()
  return child
}

vi.mock('cross-spawn', () => ({
  default: vi.fn((command: string, args: string[]) => {
    spawnCalls.push({ command, args })
    nextChild = makeChild()
    return nextChild
  })
}))

import { detectionService } from '../../src/main/services/detection-service'

describe('detectionService.testExecutable', () => {
  let tempRoot: string

  beforeEach(() => {
    spawnCalls.length = 0
    nextChild = null
    tempRoot = mkdtempSync(join(tmpdir(), 'agentdock-detect-'))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('reports a successful probe against a native .exe candidate', async () => {
    const exePath = join(tempRoot, 'codex.exe')
    writeFileSync(exePath, '')

    const resultPromise = detectionService.testExecutable('codex', exePath)
    await Promise.resolve()
    await Promise.resolve()
    nextChild!.stdout.emit('data', '1.2.3\n')
    nextChild!.emit('exit', 0)

    const result = await resultPromise
    expect(result.ok).toBe(true)
    expect(result.type).toBe('exe')
    expect(result.version).toBe('1.2.3')
    expect(spawnCalls).toEqual([{ command: exePath, args: ['--version'] }])
  })

  it('reports a successful probe against a .cmd shim candidate exactly the same way — the whole point of the fix', async () => {
    const cmdPath = join(tempRoot, 'codex.cmd')
    writeFileSync(cmdPath, '@echo off\r\n')

    const resultPromise = detectionService.testExecutable('codex', cmdPath)
    await Promise.resolve()
    await Promise.resolve()
    nextChild!.stdout.emit('data', '4.5.6\n')
    nextChild!.emit('exit', 0)

    const result = await resultPromise
    expect(result.ok).toBe(true)
    expect(result.type).toBe('cmd (npm shim)')
    expect(result.version).toBe('4.5.6')
  })

  it('reports failure with the exit code when the probe process exits non-zero', async () => {
    const exePath = join(tempRoot, 'codex.exe')
    writeFileSync(exePath, '')

    const resultPromise = detectionService.testExecutable('codex', exePath)
    await Promise.resolve()
    await Promise.resolve()
    nextChild!.stderr.emit('data', 'boom')
    nextChild!.emit('exit', 1)

    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/exited with code 1/)
    expect(result.error).toMatch(/boom/)
  })

  it('reports failure with the OS error code when the process never actually starts', async () => {
    const exePath = join(tempRoot, 'codex.exe')
    writeFileSync(exePath, '')

    const resultPromise = detectionService.testExecutable('codex', exePath)
    await Promise.resolve()
    await Promise.resolve()
    const err = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })
    nextChild!.emit('error', err)

    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/EACCES/)
  })

  it('rejects a candidate path that does not exist on disk WITHOUT ever calling cross-spawn — spawn-guard validation runs first', async () => {
    const missing = join(tempRoot, 'nope.exe')

    const result = await detectionService.testExecutable('codex', missing)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/does not exist/i)
    expect(spawnCalls).toHaveLength(0)
  })

  it('does not require existence on disk for a bare, PATH-resolved command name', async () => {
    const resultPromise = detectionService.testExecutable('codex', 'codex')
    await Promise.resolve()
    await Promise.resolve()
    nextChild!.stdout.emit('data', '1.0.0\n')
    nextChild!.emit('exit', 0)

    const result = await resultPromise
    expect(result.ok).toBe(true)
    expect(spawnCalls).toEqual([{ command: 'codex', args: ['--version'] }])
  })
})

// Confirms detectionService.detect/detectAll actually wire 'codex' through
// codex-runtime-resolver.ts (never the generic PATH-search detectOne used
// for claude-code/antigravity) — the real fix for the Windows codex.cmd
// launch bug. Deliberately exercises the REAL, installed
// @openai/codex-win32-x64 dependency's vendor path (this repo genuinely
// has it installed — see codex-runtime-resolver.test.ts's own "no mocking"
// test for the same real-package assertion) with only the final --version
// subprocess mocked via the same cross-spawn mock every other test in this
// file already uses, so this is a true end-to-end wiring test, not a
// re-test of resolveCodexRuntime's own logic (already covered in depth by
// codex-runtime-resolver.test.ts).
describe('detectionService.detect / detectAll — codex uses the runtime resolver, not PATH search', () => {
  let originalEnv: NodeJS.ProcessEnv
  let isolatedDir: string

  beforeEach(() => {
    spawnCalls.length = 0
    nextChild = null
    originalEnv = { ...process.env }
    // codex-runtime-resolver's tier-3 standalone fallback reads real
    // LOCALAPPDATA/USERPROFILE env vars — pointed at an empty temp dir here
    // so a real Codex install that happens to exist on whichever machine
    // runs this suite can never be found, keeping the "nothing resolves"
    // case below fully deterministic (never depends on this machine's
    // actual filesystem/username, per this fix's own test requirement).
    isolatedDir = mkdtempSync(join(tmpdir(), 'agentdock-detect-codex-isolated-'))
    process.env.LOCALAPPDATA = join(isolatedDir, 'AppData', 'Local')
    process.env.USERPROFILE = join(isolatedDir, 'Profile')
  })

  afterEach(() => {
    rmSync(isolatedDir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  it('reports installed:true with resolutionSource "sdk-bundled" when the bundled runtime responds to --version', async () => {
    const resultPromise = detectionService.detect('codex', null)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    nextChild!.stdout.emit('data', 'codex-cli 0.144.5\n')
    nextChild!.emit('exit', 0)

    const result = await resultPromise
    expect(result.installed).toBe(true)
    expect(result.resolutionSource).toBe('sdk-bundled')
    expect(result.executablePath).toMatch(/codex(\.exe)?$/i)
    expect(result.version).toBe('codex-cli 0.144.5')
    expect(result.error).toBeNull()
  })

  it('reports installed:false with a clear error when the bundled runtime exists but never responds and no standalone install is found', async () => {
    const resultPromise = detectionService.detect('codex', null)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    nextChild!.emit('exit', 1)

    const result = await resultPromise
    expect(result.installed).toBe(false)
    expect(result.resolutionSource).toBeUndefined()
    expect(result.executablePath).toBeNull()
    expect(result.error).toMatch(/could not locate|reinstall/i)
    // Only the one bundled-runtime probe ran — the (empty, isolated)
    // standalone candidates never existed on disk, so no second spawn.
    expect(spawnCalls).toHaveLength(1)
  })
})
