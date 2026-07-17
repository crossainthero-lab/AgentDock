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
    pid: 1000 + spawnCalls.length,
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

import { claudeAdapter } from '../../src/main/agents/claude/ClaudeAdapter'

const ctx: AgentRunContext = {
  session: { id: 's1', workspaceId: 'w1', agentId: 'claude-code', title: 't', status: 'idle', createdAt: '', updatedAt: '' },
  workspacePath: '/tmp/project',
  nativeSessionId: null,
  permissionMode: 'default',
  executablePath: 'claude'
}

describe('claudeAdapter', () => {
  beforeEach(() => {
    spawnCalls.length = 0
  })

  it('spawns a one-shot structured process with the prompt in argv, no --input-format', () => {
    const handle = claudeAdapter.start(ctx)
    handle.send('do the thing', 't1')

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].command).toBe('claude')
    expect(spawnCalls[0].args).toEqual(['-p', 'do the thing', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'])
  })

  it('adds --resume with the persisted native session id, not a sentinel', () => {
    const handle = claudeAdapter.start({ ...ctx, nativeSessionId: 'a-real-uuid-1234' })
    handle.send('continue please', 't1')

    expect(spawnCalls[0].args).toContain('--resume')
    expect(spawnCalls[0].args).toContain('a-real-uuid-1234')
  })

  it('adds --permission-mode when not default', () => {
    const handle = claudeAdapter.start({ ...ctx, permissionMode: 'plan' })
    handle.send('go', 't1')

    expect(spawnCalls[0].args).toContain('--permission-mode')
    expect(spawnCalls[0].args).toContain('plan')
  })

  it('spawns a fresh process every turn — never reuses a live process across turns', () => {
    const handle = claudeAdapter.start(ctx)
    handle.send('first turn', 't1')
    emitLine(spawnCalls[0].proc, { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's' })
    for (const cb of spawnCalls[0].proc._exitListeners) cb({ exitCode: 0, signal: null })

    handle.send('second turn', 't2')
    expect(spawnCalls).toHaveLength(2)
  })

  it('interrupt() kills the in-flight process', () => {
    const handle = claudeAdapter.start(ctx)
    handle.send('go', 't1')
    handle.interrupt()

    expect(spawnCalls[0].proc.kill).toHaveBeenCalled()
  })

  it('maps a full turn (init, deltas, result) into turn_started, assistant_delta(s), turn_completed — no duplication', () => {
    const handle = claudeAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('say pong', 't1')

    const proc = spawnCalls[0].proc
    emitLine(proc, { type: 'system', subtype: 'init', session_id: 'real-session-id' })
    emitLine(proc, { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } })
    emitLine(proc, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
    emitLine(proc, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'p' } } })
    emitLine(proc, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ong' } } })
    emitLine(proc, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }] } })
    emitLine(proc, { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    emitLine(proc, { type: 'stream_event', event: { type: 'message_stop' } })
    emitLine(proc, { type: 'result', subtype: 'success', is_error: false, result: 'pong', session_id: 'real-session-id' })

    expect(events).toEqual([
      { type: 'turn_started', sessionId: 's1', turnId: 't1' },
      { type: 'assistant_delta', sessionId: 's1', turnId: 't1', messageId: 'm1', textDelta: 'p' },
      { type: 'assistant_delta', sessionId: 's1', turnId: 't1', messageId: 'm1', textDelta: 'ong' },
      { type: 'assistant_completed', sessionId: 's1', turnId: 't1', messageId: 'm1', text: 'pong' },
      { type: 'turn_completed', sessionId: 's1', turnId: 't1', result: 'pong' }
    ])
    expect(handle.getNativeSessionId()).toBe('real-session-id')
  })

  it('captures the real session_id, not a boolean sentinel', () => {
    const handle = claudeAdapter.start(ctx)
    expect(handle.getNativeSessionId()).toBeNull()
    handle.send('hello', 't1')
    emitLine(spawnCalls[0].proc, { type: 'system', subtype: 'init', session_id: 'abc-123' })
    expect(handle.getNativeSessionId()).toBe('abc-123')
  })

  it('a well-behaved turn completes only via the structured result event, not process exit', () => {
    const handle = claudeAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello', 't1')

    emitLine(spawnCalls[0].proc, { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's' })
    expect(events).toContainEqual({ type: 'turn_completed', sessionId: 's1', turnId: 't1', result: 'ok' })

    // Process exit after a well-behaved result must not add a second/duplicate completion.
    for (const cb of spawnCalls[0].proc._exitListeners) cb({ exitCode: 0, signal: null })
    expect(events.filter((e) => e.type === 'turn_completed' || e.type === 'turn_failed')).toHaveLength(1)
  })

  it('a non-success result maps to turn_failed', () => {
    const handle = claudeAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello', 't1')

    emitLine(spawnCalls[0].proc, { type: 'result', subtype: 'error', is_error: true, result: 'Something broke', session_id: 's' })
    expect(events).toContainEqual({ type: 'turn_failed', sessionId: 's1', turnId: 't1', reason: 'Something broke' })
  })

  it('process exit without any result event synthesizes turn_failed, never a fabricated turn_completed', () => {
    const handle = claudeAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello', 't1')

    for (const cb of spawnCalls[0].proc._exitListeners) cb({ exitCode: 1, signal: null })

    expect(events.some((e) => e.type === 'turn_completed')).toBe(false)
    expect(events).toContainEqual({
      type: 'turn_failed',
      sessionId: 's1',
      turnId: 't1',
      reason: 'Claude exited unexpectedly (code 1) without completing this turn.'
    })
  })

  it('a tool_use content block never produces assistant text, only activity events', () => {
    const handle = claudeAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('run ls', 't1')

    const proc = spawnCalls[0].proc
    emitLine(proc, { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } })
    emitLine(proc, {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_1', name: 'Bash', input: {} } }
    })
    emitLine(proc, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } } })
    emitLine(proc, { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })

    expect(events).toEqual([
      { type: 'activity_started', sessionId: 's1', turnId: 't1', activityId: 'tool_1', label: 'Bash', tool: 'Bash' },
      { type: 'activity_completed', sessionId: 's1', turnId: 't1', activityId: 'tool_1', label: 'Bash', tool: 'Bash', status: 'done' }
    ])
  })

  it('reports real capabilities (permission modes) grounded in the CLI', () => {
    const caps = claudeAdapter.getCapabilities()
    expect(caps.agentId).toBe('claude-code')
    expect(caps.permissionModes.length).toBeGreaterThan(0)
  })
})
