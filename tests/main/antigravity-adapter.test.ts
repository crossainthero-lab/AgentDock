import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../src/shared/events/agent-event'
import type { AgentRunContext } from '../../src/main/agents/agent-adapter'

interface MockProc {
  id: string
  pid: number
  isRunning: boolean
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  interrupt: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  onData: (cb: (chunk: string) => void) => () => void
  onExit: (cb: (info: { exitCode: number | null; signal: number | null }) => void) => () => void
  _dataListeners: Array<(chunk: string) => void>
  _exitListeners: Array<(info: { exitCode: number | null; signal: number | null }) => void>
}

const spawnCalls: Array<{ command: string; args: string[]; proc: MockProc }> = []

function makeMockProc(): MockProc {
  const proc: MockProc = {
    id: `proc-${spawnCalls.length}`,
    pid: 3000 + spawnCalls.length,
    isRunning: true,
    write: vi.fn(),
    resize: vi.fn(),
    interrupt: vi.fn(),
    kill: vi.fn(),
    _dataListeners: [],
    _exitListeners: [],
    onData(cb) {
      proc._dataListeners.push(cb)
      return () => {}
    },
    onExit(cb) {
      proc._exitListeners.push(cb)
      return () => {}
    }
  }
  return proc
}

vi.mock('../../src/main/services/pty-service', () => ({
  ptyService: {
    spawn: (command: string, args: string[]) => {
      const proc = makeMockProc()
      spawnCalls.push({ command, args, proc })
      return proc
    }
  }
}))

import { antigravityAdapter } from '../../src/main/agents/antigravity/AntigravityAdapter'

const ctx: AgentRunContext = {
  session: { id: 's1', workspaceId: 'w1', agentId: 'antigravity', title: 't', status: 'idle', createdAt: '', updatedAt: '' },
  workspacePath: '/tmp/project',
  nativeSessionId: null,
  permissionMode: 'default',
  executablePath: 'agy'
}

describe('antigravityAdapter', () => {
  beforeEach(() => {
    spawnCalls.length = 0
  })

  it('spawns agy interactively with -i <prompt>', () => {
    const handle = antigravityAdapter.start(ctx)
    handle.send('fix the bug', 't1')

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].command).toBe('agy')
    expect(spawnCalls[0].args).toEqual(['-i', 'fix the bug'])
  })

  it('maps permission modes to real agy flags', () => {
    const accept = antigravityAdapter.start({ ...ctx, permissionMode: 'accept-edits' })
    accept.send('go', 't1')
    expect(spawnCalls[0].args).toEqual(['--mode', 'accept-edits', '-i', 'go'])

    const bypass = antigravityAdapter.start({ ...ctx, permissionMode: 'bypass' })
    bypass.send('go', 't2')
    expect(spawnCalls[1].args).toEqual(['--dangerously-skip-permissions', '-i', 'go'])
  })

  it('reuses the same live process for a second send() instead of spawning again', () => {
    const handle = antigravityAdapter.start(ctx)
    handle.send('first turn', 't1')
    expect(spawnCalls).toHaveLength(1)

    handle.send('second turn', 't2')
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].proc.write).toHaveBeenCalledWith('second turn\r')
  })

  it('always forwards raw data via onRawData, regardless of content', () => {
    const handle = antigravityAdapter.start(ctx)
    const rawChunks: string[] = []
    handle.onRawData((chunk) => rawChunks.push(chunk))
    handle.send('hello', 't1')

    for (const cb of spawnCalls[0].proc._dataListeners) cb('raw chunk')

    expect(rawChunks).toContain('raw chunk')
  })

  it('a clean process exit maps to turn_completed, scoped to the turn in flight', () => {
    const handle = antigravityAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello', 't1')

    for (const cb of spawnCalls[0].proc._exitListeners) cb({ exitCode: 0, signal: null })
    expect(events).toContainEqual({ type: 'turn_completed', sessionId: 's1', turnId: 't1' })
  })

  it('a non-zero process exit maps to turn_failed, never a fabricated turn_completed', () => {
    const handle = antigravityAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello', 't1')

    for (const cb of spawnCalls[0].proc._exitListeners) cb({ exitCode: 1, signal: null })
    expect(events.some((e) => e.type === 'turn_completed')).toBe(false)
    expect(events).toContainEqual({ type: 'turn_failed', sessionId: 's1', turnId: 't1', reason: 'Antigravity exited with code 1' })
  })

  it('getNativeSessionId() is always null — no verified resume mechanism', () => {
    const handle = antigravityAdapter.start(ctx)
    handle.send('hello', 't1')
    expect(handle.getNativeSessionId()).toBeNull()
  })

  it('reports the real `agy models` list as capabilities', () => {
    const caps = antigravityAdapter.getCapabilities()
    expect(caps.models.length).toBeGreaterThan(0)
    expect(caps.supportsLiveModelSwitch).toBe(false)
  })
})
