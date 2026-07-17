import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../src/shared/events/agent-event'
import type { AgentRunContext } from '../../src/main/agents/agent-adapter'

interface MockProc {
  pid: number
  isRunning: boolean
  kill: ReturnType<typeof vi.fn>
  onLine: (cb: (line: string) => void) => () => void
  onExit: (cb: (info: { exitCode: number | null; signal: number | null }) => void) => () => void
  _lineListeners: Array<(line: string) => void>
  _exitListeners: Array<(info: { exitCode: number | null; signal: number | null }) => void>
}

const spawnCalls: Array<{ command: string; args: string[]; proc: MockProc }> = []

function makeMockProc(): MockProc {
  const proc: MockProc = {
    pid: 2000 + spawnCalls.length,
    isRunning: true,
    kill: vi.fn(() => {
      proc.isRunning = false
    }),
    _lineListeners: [],
    _exitListeners: [],
    onLine(cb) {
      proc._lineListeners.push(cb)
      return () => {}
    },
    onExit(cb) {
      proc._exitListeners.push(cb)
      return () => {}
    }
  }
  return proc
}

function emitLine(proc: MockProc, obj: unknown): void {
  for (const cb of proc._lineListeners) cb(JSON.stringify(obj))
}

vi.mock('../../src/main/services/child-process-service', () => ({
  childProcessService: {
    spawn: (command: string, args: string[]) => {
      const proc = makeMockProc()
      spawnCalls.push({ command, args, proc })
      return proc
    },
    killAll: vi.fn()
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

  it('spawns `codex exec <prompt> --json -C <workspace>` for the first turn', () => {
    const handle = codexAdapter.start(ctx)
    handle.send('fix the bug', 't1')

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].command).toBe('codex')
    expect(spawnCalls[0].args).toEqual(['exec', 'fix the bug', '--json', '-C', '/tmp/project'])
  })

  it('maps permission modes to --sandbox flags', () => {
    const handle = codexAdapter.start({ ...ctx, permissionMode: 'workspace-write' })
    handle.send('go', 't1')

    expect(spawnCalls[0].args).toContain('--sandbox')
    expect(spawnCalls[0].args).toContain('workspace-write')
  })

  it('maps "bypass" to --dangerously-bypass-approvals-and-sandbox', () => {
    const handle = codexAdapter.start({ ...ctx, permissionMode: 'bypass' })
    handle.send('go', 't1')

    expect(spawnCalls[0].args).toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('resumes via `codex exec resume <threadId> <prompt> --json` once a thread_id has been captured', () => {
    const handle = codexAdapter.start({ ...ctx, nativeSessionId: 'thread-abc' })
    handle.send('continue please', 't1')

    expect(spawnCalls[0].args).toEqual(['exec', 'resume', 'thread-abc', 'continue please', '--json'])
  })

  it('spawns a fresh process every turn — never reuses a live process across turns', () => {
    const handle = codexAdapter.start(ctx)
    handle.send('first turn', 't1')
    emitLine(spawnCalls[0].proc, { type: 'turn.completed', usage: {} })
    for (const cb of spawnCalls[0].proc._exitListeners) cb({ exitCode: 0, signal: null })

    handle.send('second turn', 't2')
    expect(spawnCalls).toHaveLength(2)
  })

  it('interrupt() kills the in-flight process', () => {
    const handle = codexAdapter.start(ctx)
    handle.send('go', 't1')
    handle.interrupt()

    expect(spawnCalls[0].proc.kill).toHaveBeenCalled()
  })

  it('captures the real thread_id, round-tripping through getNativeSessionId()', () => {
    const handle = codexAdapter.start(ctx)
    expect(handle.getNativeSessionId()).toBeNull()
    handle.send('hello', 't1')
    emitLine(spawnCalls[0].proc, { type: 'thread.started', thread_id: 'thread-xyz' })
    expect(handle.getNativeSessionId()).toBe('thread-xyz')
  })

  it('turn.started produces the Working signal (turn_started)', () => {
    const handle = codexAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello', 't1')

    emitLine(spawnCalls[0].proc, { type: 'thread.started', thread_id: 't' })
    emitLine(spawnCalls[0].proc, { type: 'turn.started' })
    expect(events.filter((e) => e.type === 'turn_started')).toHaveLength(1)
  })

  it('an agent_message item.completed produces exactly one assistant message, and turn.completed completes the right turn', () => {
    const handle = codexAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('say pong', 't1')

    const proc = spawnCalls[0].proc
    emitLine(proc, { type: 'thread.started', thread_id: 't' })
    emitLine(proc, { type: 'turn.started' })
    emitLine(proc, { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'pong' } })
    emitLine(proc, { type: 'turn.completed', usage: {} })

    expect(events).toContainEqual({ type: 'assistant_completed', sessionId: 's1', turnId: 't1', messageId: 'item_0', text: 'pong' })
    expect(events).toContainEqual({ type: 'turn_completed', sessionId: 's1', turnId: 't1' })
  })

  it('turn.failed creates a failed state', () => {
    const handle = codexAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello', 't1')

    emitLine(spawnCalls[0].proc, { type: 'turn.failed', error: { message: 'boom' } })
    expect(events).toContainEqual({ type: 'turn_failed', sessionId: 's1', turnId: 't1', reason: 'boom' })
  })

  it('process exit without any completion event synthesizes turn_failed, never a fabricated turn_completed', () => {
    const handle = codexAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello', 't1')

    for (const cb of spawnCalls[0].proc._exitListeners) cb({ exitCode: 1, signal: null })

    expect(events.some((e) => e.type === 'turn_completed')).toBe(false)
    expect(events).toContainEqual({
      type: 'turn_failed',
      sessionId: 's1',
      turnId: 't1',
      reason: 'Codex exited unexpectedly (code 1) without completing this turn.'
    })
  })

  it('reports no fabricated models — an empty list since none are verified', () => {
    const caps = codexAdapter.getCapabilities()
    expect(caps.models).toEqual([])
    expect(caps.permissionModes.length).toBeGreaterThan(0)
  })
})
