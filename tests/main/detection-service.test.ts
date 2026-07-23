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
