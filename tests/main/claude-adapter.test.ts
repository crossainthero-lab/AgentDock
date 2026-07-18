import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../src/shared/events/agent-event'
import type { AgentRunContext } from '../../src/main/agents/agent-adapter'

// A controllable stand-in for the SDK's `Query` (an AsyncGenerator plus
// interrupt/setModel/setPermissionMode control methods). Tests push
// SDKMessage-shaped objects into it and can end it (clean or via `fail`) to
// simulate the process exiting.
class MockQuery {
  private readonly queue: unknown[] = []
  private readonly waiting: Array<{ resolve: (r: IteratorResult<unknown>) => void; reject: (err: unknown) => void }> = []
  private closed = false
  private failure: Error | null = null
  readonly interrupt = vi.fn(async () => ({ still_queued: [] }))
  readonly setModel = vi.fn(async () => {})
  readonly setPermissionMode = vi.fn(async () => {})

  push(msg: unknown): void {
    const waiter = this.waiting.shift()
    if (waiter) waiter.resolve({ value: msg, done: false })
    else this.queue.push(msg)
  }

  /** Ends the generator cleanly (as if the CLI process exited normally). */
  end(): void {
    this.closed = true
    while (this.waiting.length > 0) this.waiting.shift()?.resolve({ value: undefined, done: true })
  }

  /** Ends the generator by throwing (as if the SDK's read loop errored) —
   *  rejects any already-pending `next()` call, not just future ones. */
  fail(err: Error): void {
    this.failure = err
    this.closed = true
    while (this.waiting.length > 0) this.waiting.shift()?.reject(err)
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: (): Promise<IteratorResult<unknown>> => {
        if (this.queue.length > 0) return Promise.resolve({ value: this.queue.shift(), done: false })
        if (this.closed) return this.failure ? Promise.reject(this.failure) : Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }))
      }
    }
  }
}

interface QueryCall {
  prompt: AsyncIterable<unknown>
  options: Record<string, unknown>
  mock: MockQuery
}

const queryCalls: QueryCall[] = []

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    const mock = new MockQuery()
    queryCalls.push({ prompt: params.prompt, options: params.options, mock })
    return mock
  })
}))

import { claudeAdapter } from '../../src/main/agents/claude/ClaudeAdapter'

const ctx: AgentRunContext = {
  session: { id: 's1', workspaceId: 'w1', agentId: 'claude-code', title: 't', status: 'idle', createdAt: '', updatedAt: '' },
  workspacePath: '/tmp/project',
  nativeSessionId: null,
  permissionMode: 'default',
  executablePath: 'claude'
}

/** Drains the first pushed value out of an AsyncIterable without consuming
 *  more than one item — used to assert what the transport wrote as the
 *  initial user message. */
async function firstValue<T>(iterable: AsyncIterable<T>): Promise<T> {
  const it = iterable[Symbol.asyncIterator]()
  const { value } = await it.next()
  return value as T
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('claudeAdapter', () => {
  beforeEach(() => {
    queryCalls.length = 0
  })

  it('starts a query with the resolved executable, cwd, and no --input-format/-p leakage (SDK owns argv)', async () => {
    const handle = claudeAdapter.start(ctx)
    handle.send('do the thing', 't1')
    await flushMicrotasks()

    expect(queryCalls).toHaveLength(1)
    expect(queryCalls[0].options.cwd).toBe('/tmp/project')
    expect(queryCalls[0].options.pathToClaudeCodeExecutable).toBe('claude')
    expect(queryCalls[0].options.includePartialMessages).toBe(true)
    expect(typeof queryCalls[0].options.canUseTool).toBe('function')
  })

  it('delivers the prompt as a user message over the pushed input iterable, not a positional CLI arg', async () => {
    const handle = claudeAdapter.start(ctx)
    handle.send('do the thing', 't1')
    await flushMicrotasks()

    const first = await firstValue(queryCalls[0].prompt)
    expect(first).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
      parent_tool_use_id: null
    })
  })

  it('reuses the same live query for a second turn instead of spawning a new one', async () => {
    const handle = claudeAdapter.start(ctx)
    handle.send('first turn', 't1')
    await flushMicrotasks()
    handle.send('second turn', 't2')
    await flushMicrotasks()

    expect(queryCalls).toHaveLength(1)
  })

  it('passes --resume equivalent (options.resume) with the persisted native session id', async () => {
    const handle = claudeAdapter.start({ ...ctx, nativeSessionId: 'a-real-uuid-1234' })
    handle.send('continue please', 't1')
    await flushMicrotasks()

    expect(queryCalls[0].options.resume).toBe('a-real-uuid-1234')
  })

  it('sets allowDangerouslySkipPermissions only for bypassPermissions mode', async () => {
    const handle = claudeAdapter.start({ ...ctx, permissionMode: 'bypassPermissions' })
    handle.send('go', 't1')
    await flushMicrotasks()

    expect(queryCalls[0].options.permissionMode).toBe('bypassPermissions')
    expect(queryCalls[0].options.allowDangerouslySkipPermissions).toBe(true)
  })

  it('omits permissionMode entirely for the "default" sentinel', async () => {
    const handle = claudeAdapter.start({ ...ctx, permissionMode: 'default' })
    handle.send('go', 't1')
    await flushMicrotasks()

    expect(queryCalls[0].options.permissionMode).toBeUndefined()
  })

  it('captures model and effective permission mode from system/init', async () => {
    const handle = claudeAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello', 't1')
    await flushMicrotasks()

    queryCalls[0].mock.push({ type: 'system', subtype: 'init', session_id: 'sid', model: 'claude-sonnet-5', permissionMode: 'acceptEdits' })
    await flushMicrotasks()

    expect(events).toContainEqual({ type: 'model_info', sessionId: 's1', turnId: 't1', model: 'claude-sonnet-5' })
    expect(events).toContainEqual({ type: 'permission_mode_info', sessionId: 's1', turnId: 't1', permissionMode: 'acceptEdits' })
    expect(handle.getNativeSessionId()).toBe('sid')
  })

  it('maps a full turn (init, deltas, result) into turn_started, assistant_delta(s), turn_completed', async () => {
    const handle = claudeAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('say pong', 't1')
    await flushMicrotasks()

    const q = queryCalls[0].mock
    q.push({ type: 'system', subtype: 'init', session_id: 'real-session-id' })
    q.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } })
    q.push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
    q.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'p' } } })
    q.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ong' } } })
    q.push({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    q.push({ type: 'stream_event', event: { type: 'message_stop' } })
    q.push({ type: 'result', subtype: 'success', is_error: false, result: 'pong', session_id: 'real-session-id' })
    await flushMicrotasks()

    expect(events).toEqual([
      { type: 'turn_started', sessionId: 's1', turnId: 't1' },
      { type: 'assistant_delta', sessionId: 's1', turnId: 't1', messageId: 'm1', textDelta: 'p' },
      { type: 'assistant_delta', sessionId: 's1', turnId: 't1', messageId: 'm1', textDelta: 'ong' },
      { type: 'assistant_completed', sessionId: 's1', turnId: 't1', messageId: 'm1', text: 'pong' },
      { type: 'turn_completed', sessionId: 's1', turnId: 't1', result: 'pong' }
    ])
    expect(handle.getNativeSessionId()).toBe('real-session-id')
  })

  it('interrupt() calls Query.interrupt() and, once the subsequent error result arrives, emits turn_cancelled — not turn_failed', async () => {
    const handle = claudeAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('count to 50', 't1')
    await flushMicrotasks()

    handle.interrupt()
    expect(queryCalls[0].mock.interrupt).toHaveBeenCalled()

    // Confirmed live behavior: Query.interrupt() causes a subsequent
    // `result` message with is_error:true (subtype 'error_during_execution')
    // — the query itself stays alive for future turns.
    queryCalls[0].mock.push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['aborted'], session_id: 's' })
    await flushMicrotasks()

    expect(events).toContainEqual({ type: 'turn_cancelled', sessionId: 's1', turnId: 't1' })
    expect(events.some((e) => e.type === 'turn_failed')).toBe(false)
  })

  it('stop() ends the query and emits turn_cancelled if no result had arrived yet', async () => {
    const handle = claudeAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello', 't1')
    await flushMicrotasks()

    handle.stop()
    queryCalls[0].mock.end()
    await flushMicrotasks()

    expect(events).toContainEqual({ type: 'turn_cancelled', sessionId: 's1', turnId: 't1' })
  })

  it('a genuine crash (no user-initiated stop/interrupt, generator throws) emits turn_exited, not turn_cancelled', async () => {
    const handle = claudeAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello', 't1')
    await flushMicrotasks()

    queryCalls[0].mock.fail(new Error('process crashed'))
    await flushMicrotasks()

    expect(events.some((e) => e.type === 'turn_cancelled')).toBe(false)
    const exited = events.find((e) => e.type === 'turn_exited')
    expect(exited).toBeDefined()
    expect((exited as { reason: string }).reason).toContain('process crashed')
  })

  it('a non-success result (not user-caused) maps to turn_failed', async () => {
    const handle = claudeAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello', 't1')
    await flushMicrotasks()

    queryCalls[0].mock.push({ type: 'result', subtype: 'error', is_error: true, result: 'Something broke', session_id: 's' })
    await flushMicrotasks()

    expect(events).toContainEqual({ type: 'turn_failed', sessionId: 's1', turnId: 't1', reason: 'Something broke' })
  })

  describe('canUseTool permission bridge', () => {
    it('an ordinary tool call raises a permission interaction; Allow resolves with behavior:allow and the original input', async () => {
      const handle = claudeAdapter.start(ctx)
      const events: AgentEvent[] = []
      handle.onEvent((e) => events.push(e))
      handle.send('run a command', 't1')
      await flushMicrotasks()

      const canUseTool = queryCalls[0].options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        opts: { toolUseID: string; signal: AbortSignal; title?: string }
      ) => Promise<unknown>

      const signal = new AbortController().signal
      const resultPromise = canUseTool('Bash', { command: 'ls' }, { toolUseID: 'tu1', signal, title: 'Claude wants to run `ls`.' })
      await flushMicrotasks()

      const interaction = events.find((e) => e.type === 'interaction_required')
      expect(interaction).toBeDefined()
      expect((interaction as { interaction: { kind: string; interactionId: string; prompt: string } }).interaction).toEqual({
        kind: 'permission',
        interactionId: 'tu1',
        prompt: 'Claude wants to run `ls`.',
        options: [
          { id: 'allow', label: 'Allow' },
          { id: 'deny', label: 'Deny' }
        ]
      })

      handle.respondToInteraction('tu1', 'allow')
      const result = await resultPromise
      expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    })

    it('Deny resolves with behavior:deny — this is the real decision returned to the SDK, not a simulated one', async () => {
      const handle = claudeAdapter.start(ctx)
      handle.send('run a command', 't1')
      await flushMicrotasks()

      const canUseTool = queryCalls[0].options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        opts: { toolUseID: string; signal: AbortSignal }
      ) => Promise<{ behavior: string; message?: string }>

      const signal = new AbortController().signal
      const resultPromise = canUseTool('Bash', { command: 'rm -rf /' }, { toolUseID: 'tu2', signal })
      await flushMicrotasks()
      handle.respondToInteraction('tu2', 'deny')

      const result = await resultPromise
      expect(result.behavior).toBe('deny')
      expect(result.message).toBeTruthy()
    })

    it('a duplicate respondToInteraction call for an already-resolved id is a no-op (no throw, no second resolve)', async () => {
      const handle = claudeAdapter.start(ctx)
      handle.send('run a command', 't1')
      await flushMicrotasks()

      const canUseTool = queryCalls[0].options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        opts: { toolUseID: string; signal: AbortSignal }
      ) => Promise<unknown>
      const signal = new AbortController().signal
      const resultPromise = canUseTool('Bash', {}, { toolUseID: 'tu3', signal })
      await flushMicrotasks()

      handle.respondToInteraction('tu3', 'allow')
      const result = await resultPromise
      expect(() => handle.respondToInteraction('tu3', 'deny')).not.toThrow()
      // Original decision is unchanged — a second call cannot flip it.
      expect(result).toEqual({ behavior: 'allow', updatedInput: {} })
    })

    it('AskUserQuestion asks each question in sequence and delivers all answers via updatedInput.answers', async () => {
      const handle = claudeAdapter.start(ctx)
      const events: AgentEvent[] = []
      handle.onEvent((e) => events.push(e))
      handle.send('ask me something', 't1')
      await flushMicrotasks()

      const canUseTool = queryCalls[0].options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        opts: { toolUseID: string; signal: AbortSignal }
      ) => Promise<unknown>
      const signal = new AbortController().signal

      const input = {
        questions: [
          { question: 'Pick a color', header: 'Color', options: [{ label: 'Red', description: 'r' }, { label: 'Blue', description: 'b' }] },
          { question: 'Pick a size', header: 'Size', options: [{ label: 'Small', description: 's' }, { label: 'Large', description: 'l' }] }
        ]
      }
      const resultPromise = canUseTool('AskUserQuestion', input, { toolUseID: 'tu4', signal })
      await flushMicrotasks()

      const first = events.find((e) => e.type === 'interaction_required')
      expect(first).toBeDefined()
      expect((first as { interaction: { interactionId: string; prompt: string } }).interaction.interactionId).toBe('tu4:q0')
      expect((first as { interaction: { prompt: string } }).interaction.prompt).toBe('Pick a color')

      handle.respondToInteraction('tu4:q0', 'Red')
      await flushMicrotasks()

      const second = events.filter((e) => e.type === 'interaction_required')[1]
      expect(second).toBeDefined()
      expect((second as { interaction: { interactionId: string } }).interaction.interactionId).toBe('tu4:q1')

      handle.respondToInteraction('tu4:q1', 'Large')
      const result = await resultPromise

      expect(result).toEqual({
        behavior: 'allow',
        updatedInput: { ...input, answers: { 'Pick a color': 'Red', 'Pick a size': 'Large' } }
      })
    })
  })

  it('setModel() applies live via Query.setModel() once a query exists', async () => {
    const handle = claudeAdapter.start(ctx)
    handle.send('hello', 't1')
    await flushMicrotasks()

    handle.setModel('opus')
    expect(queryCalls[0].mock.setModel).toHaveBeenCalledWith('opus')
  })

  it('setModel() before any turn queues the model for the first spawn', async () => {
    const handle = claudeAdapter.start(ctx)
    handle.setModel('haiku')
    handle.send('hello', 't1')
    await flushMicrotasks()

    expect(queryCalls[0].options.model).toBe('haiku')
  })

  it('setPermissionMode() applies live via Query.setPermissionMode()', async () => {
    const handle = claudeAdapter.start(ctx)
    handle.send('hello', 't1')
    await flushMicrotasks()

    handle.setPermissionMode?.('plan')
    expect(queryCalls[0].mock.setPermissionMode).toHaveBeenCalledWith('plan')
  })

  it('reports real capabilities (permission modes) grounded in the SDK', () => {
    const caps = claudeAdapter.getCapabilities()
    expect(caps.agentId).toBe('claude-code')
    expect(caps.permissionModes.length).toBeGreaterThan(0)
    expect(caps.supportsLiveModelSwitch).toBe(true)
    expect(caps.supportsLivePermissionSwitch).toBe(true)
  })
})
