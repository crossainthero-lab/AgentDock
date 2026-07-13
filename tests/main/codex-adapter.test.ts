import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    pid: 2000 + spawnCalls.length,
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

import { codexAdapter } from '../../src/main/agents/codex/CodexAdapter'

const ctx: AgentRunContext = {
  session: { id: 's1', workspaceId: 'w1', agentId: 'codex', title: 't', status: 'idle', createdAt: '', updatedAt: '' },
  workspacePath: '/tmp/project',
  nativeSessionId: null,
  permissionMode: 'default',
  executablePath: 'codex'
}

describe('codexAdapter', () => {
  beforeEach(() => {
    spawnCalls.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('spawns codex interactively with --no-alt-screen, -C <workspace>, and the prompt in argv', () => {
    const handle = codexAdapter.start(ctx)
    handle.send('fix the bug')

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].command).toBe('codex')
    expect(spawnCalls[0].args).toEqual(['--no-alt-screen', '-C', '/tmp/project', 'fix the bug'])
  })

  it('maps the real -a/--ask-for-approval values through unchanged', () => {
    const handle = codexAdapter.start({ ...ctx, permissionMode: 'on-request' })
    handle.send('go')

    expect(spawnCalls[0].args).toEqual(['--no-alt-screen', '--ask-for-approval', 'on-request', '-C', '/tmp/project', 'go'])
  })

  it('maps "bypass" to --dangerously-bypass-approvals-and-sandbox', () => {
    const handle = codexAdapter.start({ ...ctx, permissionMode: 'bypass' })
    handle.send('go')

    expect(spawnCalls[0].args).toEqual([
      '--no-alt-screen',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      '/tmp/project',
      'go'
    ])
  })

  it('reuses the same live process for a second send() instead of spawning again', () => {
    const handle = codexAdapter.start(ctx)
    handle.send('first turn')
    expect(spawnCalls).toHaveLength(1)

    handle.send('second turn')
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].proc.write).toHaveBeenCalledWith('second turn\r')
  })

  it('always forwards raw data via onRawData, regardless of content', () => {
    const handle = codexAdapter.start(ctx)
    const rawChunks: string[] = []
    handle.onRawData((chunk) => rawChunks.push(chunk))
    handle.send('hello')

    for (const cb of spawnCalls[0].proc._dataListeners) cb('raw chunk \x1b[2K')

    expect(rawChunks).toContain('raw chunk \x1b[2K')
  })

  it('emits session_complete on process exit', () => {
    const handle = codexAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello')

    for (const cb of spawnCalls[0].proc._exitListeners) cb({ exitCode: 0, signal: null })
    expect(events).toContainEqual({ type: 'session_complete', exitCode: 0 })
  })

  it('reports no fabricated models — an empty list since none are verified', () => {
    const caps = codexAdapter.getCapabilities()
    expect(caps.models).toEqual([])
    expect(caps.permissionModes.length).toBeGreaterThan(0)
  })
})
