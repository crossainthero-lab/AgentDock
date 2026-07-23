import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'

// A real, always-existing directory — spawn-guard.ts's validateSpawnPlan()
// now requires `cwd` to actually exist on disk before ever reaching
// pty.spawn()/child_process.spawn(), so these tests (which fake the actual
// spawn call but not that validation, which runs first) need a real path
// here, never a made-up one like '/tmp/project' that doesn't exist on
// Windows.
const REAL_CWD = tmpdir()

// Neither pty-service.ts nor child-process-service.ts had any test
// coverage before this pass — both are exactly what src/main/index.ts's
// window-all-closed/before-quit handlers call (ptyService.killAll() +
// childProcessService.killAll()) to guarantee no orphaned `claude`/`codex`/
// `agy` process survives AgentDock closing. That guarantee is
// platform-agnostic by construction (Node's default `.kill()` sends
// SIGTERM on POSIX / calls TerminateProcess on Windows), but it was never
// actually verified — this file closes that gap for both process
// primitives Antigravity (PTY) and Claude/Codex (plain child_process) use.

describe('pty-service — killAll (process shutdown cleanup)', () => {
  interface FakePty extends EventEmitter {
    pid: number
    kill: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
    onData: (cb: (chunk: string) => void) => void
    onExit: (cb: (info: { exitCode: number | null; signal: number | null }) => void) => void
  }

  let spawnedPtys: FakePty[]

  beforeEach(() => {
    vi.resetModules()
    spawnedPtys = []
    vi.doMock('node-pty', () => ({
      spawn: vi.fn(() => {
        let pid = spawnedPtys.length + 1000
        const emitter = new EventEmitter() as FakePty
        emitter.pid = pid
        emitter.kill = vi.fn()
        emitter.write = vi.fn()
        emitter.onData = (cb) => void emitter.on('data', cb)
        emitter.onExit = (cb) => void emitter.on('exit', cb)
        spawnedPtys.push(emitter)
        return emitter
      })
    }))
  })

  it('killAll() kills every live PTY process, e.g. an Antigravity session that never sent its own exit', async () => {
    const { ptyService } = await import('../../src/main/services/pty-service')
    ptyService.spawn('agy', [], { cwd: REAL_CWD })
    ptyService.spawn('agy', ['resume', 'abc'], { cwd: REAL_CWD })

    expect(spawnedPtys).toHaveLength(2)
    ptyService.killAll()

    for (const proc of spawnedPtys) {
      expect(proc.kill).toHaveBeenCalledTimes(1)
    }
  })

  it('does not throw if one process throws on kill() — every process still gets a kill attempt (best-effort shutdown)', async () => {
    const { ptyService } = await import('../../src/main/services/pty-service')
    ptyService.spawn('agy', [], { cwd: REAL_CWD })
    ptyService.spawn('agy', [], { cwd: REAL_CWD })
    spawnedPtys[0].kill.mockImplementation(() => {
      throw new Error('ESRCH: no such process')
    })

    expect(() => ptyService.killAll()).not.toThrow()
    expect(spawnedPtys[0].kill).toHaveBeenCalledTimes(1)
    expect(spawnedPtys[1].kill).toHaveBeenCalledTimes(1)
  })

  it('a process that already exited before killAll() runs is not killed again (already removed from the live set)', async () => {
    const { ptyService } = await import('../../src/main/services/pty-service')
    ptyService.spawn('agy', [], { cwd: REAL_CWD })
    const proc = spawnedPtys[0]
    proc.emit('exit', { exitCode: 0, signal: undefined })

    ptyService.killAll()
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('calling killAll() twice in a row (e.g. window-all-closed then before-quit) is safe and does not double-kill', async () => {
    const { ptyService } = await import('../../src/main/services/pty-service')
    ptyService.spawn('agy', [], { cwd: REAL_CWD })
    ptyService.killAll()
    ptyService.killAll()

    expect(spawnedPtys[0].kill).toHaveBeenCalledTimes(1)
  })
})

describe('child-process-service — killAll (process shutdown cleanup)', () => {
  interface FakeChild extends EventEmitter {
    pid: number
    kill: ReturnType<typeof vi.fn>
    stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
    stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
  }

  let spawnedChildren: FakeChild[]

  beforeEach(() => {
    vi.resetModules()
    spawnedChildren = []
    vi.doMock('node:child_process', () => {
      const spawn = vi.fn(() => {
        const child = new EventEmitter() as FakeChild
        child.pid = spawnedChildren.length + 2000
        child.kill = vi.fn()
        child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
        child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
        spawnedChildren.push(child)
        return child
      })
      return { spawn, default: { spawn } }
    })
  })

  it('killAll() kills every live structured-transport process, e.g. a Claude/Codex turn still in flight', async () => {
    const { childProcessService } = await import('../../src/main/services/child-process-service')
    childProcessService.spawn('claude', ['-p'], { cwd: REAL_CWD })
    childProcessService.spawn('codex', ['exec'], { cwd: REAL_CWD })

    expect(spawnedChildren).toHaveLength(2)
    childProcessService.killAll()

    for (const proc of spawnedChildren) {
      expect(proc.kill).toHaveBeenCalledTimes(1)
    }
  })

  it('does not throw if one process throws on kill() — every process still gets a kill attempt', async () => {
    const { childProcessService } = await import('../../src/main/services/child-process-service')
    childProcessService.spawn('claude', ['-p'], { cwd: REAL_CWD })
    childProcessService.spawn('codex', ['exec'], { cwd: REAL_CWD })
    spawnedChildren[0].kill.mockImplementation(() => {
      throw new Error('ESRCH: no such process')
    })

    expect(() => childProcessService.killAll()).not.toThrow()
    expect(spawnedChildren[0].kill).toHaveBeenCalledTimes(1)
    expect(spawnedChildren[1].kill).toHaveBeenCalledTimes(1)
  })

  it('a process that already exited before killAll() runs is not killed again', async () => {
    const { childProcessService } = await import('../../src/main/services/child-process-service')
    childProcessService.spawn('claude', ['-p'], { cwd: REAL_CWD })
    const proc = spawnedChildren[0]
    proc.emit('exit', 0, null)

    childProcessService.killAll()
    expect(proc.kill).not.toHaveBeenCalled()
  })
})
