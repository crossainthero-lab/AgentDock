import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../src/shared/events/agent-event'
import type { AgentRunContext } from '../../src/main/agents/agent-adapter'

// A controllable stand-in for the SDK's `Thread` (runStreamed() returns an
// async generator of ThreadEvent; an aborted signal ends it the same way
// the real SDK's process-kill-on-abort does — by throwing, confirmed by
// reading the SDK's compiled source: an aborted child exits with a signal,
// which the SDK's own exec loop turns into a thrown Error).
/** Mirrors one real per-turn subprocess session's state — a fresh one is
 *  created for every runStreamed() call, matching how the real Thread
 *  spins up a genuinely new underlying process per turn even though the
 *  Thread object itself persists across turns. */
class MockTurnSession {
  readonly queue: unknown[] = []
  readonly waiting: Array<{ resolve: (r: IteratorResult<unknown>) => void; reject: (err: unknown) => void }> = []
  closed = false
  failure: Error | null = null
}

class MockThread {
  id: string | null
  private currentSession: MockTurnSession | null = null
  readonly runStreamedCalls: Array<{ input: unknown; signal?: AbortSignal }> = []

  constructor(id: string | null = null) {
    this.id = id
  }

  push(event: unknown): void {
    const e = event as { type?: string; thread_id?: string }
    if (e.type === 'thread.started' && typeof e.thread_id === 'string') this.id = e.thread_id
    const session = this.currentSession
    if (!session) throw new Error('MockThread.push() called before runStreamed()')
    const waiter = session.waiting.shift()
    if (waiter) waiter.resolve({ value: event, done: false })
    else session.queue.push(event)
  }

  /** Ends the current turn's stream by throwing — rejects an
   *  already-pending pull too, not just future ones (mirrors
   *  AbortController.abort() being synchronous). */
  fail(err: Error): void {
    const session = this.currentSession
    if (!session) return
    session.failure = err
    session.closed = true
    while (session.waiting.length > 0) session.waiting.shift()?.reject(err)
  }

  /** Ends the current turn's stream cleanly, as a real process exiting
   *  normally after finishing a turn would. */
  end(): void {
    const session = this.currentSession
    if (!session) return
    session.closed = true
    while (session.waiting.length > 0) session.waiting.shift()?.resolve({ value: undefined, done: true })
  }

  async runStreamed(input: unknown, turnOptions?: { signal?: AbortSignal }): Promise<{ events: AsyncGenerator<unknown> }> {
    this.runStreamedCalls.push({ input, signal: turnOptions?.signal })
    const session = new MockTurnSession()
    this.currentSession = session
    turnOptions?.signal?.addEventListener('abort', () => {
      if (this.currentSession === session) this.fail(new Error('Codex Exec exited with signal SIGTERM'))
    })
    async function* gen(): AsyncGenerator<unknown> {
      for (;;) {
        let result: IteratorResult<unknown>
        if (session.queue.length > 0) {
          result = { value: session.queue.shift(), done: false }
        } else if (session.closed) {
          if (session.failure) throw session.failure
          return
        } else {
          result = await new Promise<IteratorResult<unknown>>((resolve, reject) => session.waiting.push({ resolve, reject }))
        }
        if (result.done) return
        yield result.value
      }
    }
    return { events: gen() }
  }
}

class MockCodex {
  readonly threads: MockThread[] = []
  constructor(public readonly options: unknown) {}
  startThread(options: unknown): MockThread {
    const t = new MockThread()
    ;(t as unknown as { __startOptions: unknown }).__startOptions = options
    this.threads.push(t)
    return t
  }
  resumeThread(id: string, options: unknown): MockThread {
    const t = new MockThread(id)
    ;(t as unknown as { __resumeOptions: unknown }).__resumeOptions = options
    this.threads.push(t)
    return t
  }
}

const codexInstances: MockCodex[] = []

vi.mock('@openai/codex-sdk', () => ({
  Codex: vi.fn().mockImplementation((options: unknown) => {
    const instance = new MockCodex(options)
    codexInstances.push(instance)
    return instance
  })
}))

// Controllable per-test — real directory-scanning behavior is covered by
// codex-response-image-service.test.ts's own real-filesystem tests; here we
// only need to verify the adapter emits response_artifacts at the right
// moment (before turn_completed) with whatever the service reports.
const snapshotDirMock = vi.fn(async () => new Set<string>())
const diffNewImagesMock = vi.fn(async () => [] as string[])
vi.mock('../../src/main/services/codex-response-image-service', () => ({
  codexResponseImageService: {
    snapshotDir: (...args: unknown[]) => snapshotDirMock(...args),
    diffNewImages: (...args: unknown[]) => diffNewImagesMock(...args)
  }
}))

import { codexAdapter } from '../../src/main/agents/codex/CodexAdapter'

const ctx: AgentRunContext = {
  session: { id: 's1', workspaceId: 'w1', agentId: 'codex', title: 't', status: 'idle', createdAt: '', updatedAt: '' },
  workspacePath: '/tmp/project',
  nativeSessionId: null,
  permissionMode: 'default',
  executablePath: 'codex',
  model: null,
  reasoningEffort: null
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('codexAdapter', () => {
  beforeEach(() => {
    codexInstances.length = 0
    snapshotDirMock.mockClear().mockResolvedValue(new Set<string>())
    diffNewImagesMock.mockClear().mockResolvedValue([])
  })

  it('constructs the SDK Codex client with the resolved executable path', async () => {
    const handle = codexAdapter.start(ctx)
    handle.send('do the thing', 't1')
    await flushMicrotasks()

    expect(codexInstances).toHaveLength(1)
    expect(codexInstances[0].options).toMatchObject({ codexPathOverride: 'codex' })
  })

  it('starts a fresh thread with the workspace cwd and never-ask approval policy (no human present in exec/JSON mode)', async () => {
    const handle = codexAdapter.start(ctx)
    handle.send('do the thing', 't1')
    await flushMicrotasks()

    const thread = codexInstances[0].threads[0]
    expect((thread as unknown as { __startOptions: unknown }).__startOptions).toMatchObject({
      workingDirectory: '/tmp/project',
      approvalPolicy: 'never'
    })
  })

  it('reuses the same live thread for a second turn instead of starting a new one', async () => {
    const handle = codexAdapter.start(ctx)
    handle.send('first turn', 't1')
    await flushMicrotasks()

    // A Thread only supports one active runStreamed() call at a time
    // (confirmed against the real SDK — see CodexAgentSdkTransport's
    // launchChain doc comment), so the second turn's own runStreamed()
    // call is legitimately queued behind the first turn's completion.
    const thread = codexInstances[0].threads[0]
    thread.push({ type: 'turn.completed', usage: {} })
    thread.end()
    await flushMicrotasks()

    handle.send('second turn', 't2')
    await flushMicrotasks()

    expect(codexInstances).toHaveLength(1)
    expect(codexInstances[0].threads).toHaveLength(1)
    expect(codexInstances[0].threads[0].runStreamedCalls).toHaveLength(2)
  })

  it('maps sandbox permission modes to the SDK sandboxMode option, and "bypass" to the closest achievable equivalent', async () => {
    const handle = codexAdapter.start({ ...ctx, permissionMode: 'workspace-write' })
    handle.send('go', 't1')
    await flushMicrotasks()
    expect((codexInstances[0].threads[0] as unknown as { __startOptions: { sandboxMode: string } }).__startOptions.sandboxMode).toBe(
      'workspace-write'
    )

    codexInstances.length = 0
    const handle2 = codexAdapter.start({ ...ctx, permissionMode: 'bypass' })
    handle2.send('go', 't1')
    await flushMicrotasks()
    expect((codexInstances[0].threads[0] as unknown as { __startOptions: { sandboxMode: string } }).__startOptions.sandboxMode).toBe(
      'danger-full-access'
    )
  })

  it('a same-session follow-up sent right after completion never gets a fabricated turn_exited (regression: real live run exposed this)', async () => {
    const handle = codexAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('first turn', 't1')
    await flushMicrotasks()

    const thread = codexInstances[0].threads[0]
    thread.push({ type: 'turn.completed', usage: {} })
    await flushMicrotasks()

    // The user's follow-up is sent before the underlying process for turn
    // 1 has actually finished exiting (end() not called yet) — exactly
    // the ordering that produced a fabricated turn_exited for turn 2 on a
    // real live run before this was fixed.
    handle.send('second turn', 't2')
    await flushMicrotasks()
    expect(thread.runStreamedCalls).toHaveLength(1) // turn 2's own call is still queued

    thread.end() // turn 1's process finally exits cleanly, late
    await flushMicrotasks()
    expect(thread.runStreamedCalls).toHaveLength(2) // now turn 2 has actually started

    thread.push({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'second reply' } })
    thread.push({ type: 'turn.completed', usage: {} })
    await flushMicrotasks()

    expect(events.filter((e) => e.type === 'turn_exited')).toEqual([])
    expect(events).toContainEqual({ type: 'assistant_completed', sessionId: 's1', turnId: 't2', messageId: 'item_0', text: 'second reply' })
    expect(events.filter((e) => e.type === 'turn_completed' && e.turnId === 't2')).toHaveLength(1)
  })

  it('resumes via resumeThread(id) when a persisted native session id is present', async () => {
    const handle = codexAdapter.start({ ...ctx, nativeSessionId: 'prior-thread-id' })
    handle.send('continue please', 't1')
    await flushMicrotasks()

    expect(codexInstances[0].threads[0].id).toBe('prior-thread-id')
  })

  it('maps a full turn (thread.started, command, agent_message, turn.completed) correctly', async () => {
    const handle = codexAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('say pong', 't1')
    await flushMicrotasks()

    const thread = codexInstances[0].threads[0]
    thread.push({ type: 'thread.started', thread_id: 'real-thread-id' })
    thread.push({ type: 'turn.started' })
    thread.push({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'pong' }
    })
    thread.push({ type: 'turn.completed', usage: {} })
    await flushMicrotasks()

    expect(events).toEqual([
      { type: 'turn_started', sessionId: 's1', turnId: 't1' },
      { type: 'assistant_completed', sessionId: 's1', turnId: 't1', messageId: 'item_0', text: 'pong' },
      { type: 'turn_completed', sessionId: 's1', turnId: 't1' }
    ])
    expect(handle.getNativeSessionId()).toBe('real-thread-id')
  })

  it('interrupt() aborts the in-flight thread and emits turn_cancelled — not a fabricated error', async () => {
    const handle = codexAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('count to 50', 't1')
    await flushMicrotasks()

    const thread = codexInstances[0].threads[0]
    thread.push({ type: 'thread.started', thread_id: 'tid' })

    handle.interrupt()
    await flushMicrotasks()

    expect(events).toContainEqual({ type: 'turn_cancelled', sessionId: 's1', turnId: 't1' })
    expect(events.some((e) => e.type === 'turn_failed' || e.type === 'turn_exited')).toBe(false)
  })

  it('a genuine crash (no user-initiated stop/interrupt) emits turn_exited, not turn_cancelled', async () => {
    const handle = codexAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('go', 't1')
    await flushMicrotasks()

    const thread = codexInstances[0].threads[0]
    thread.fail(new Error('Codex Exec exited with code 1: some crash'))
    await flushMicrotasks()

    expect(events.some((e) => e.type === 'turn_cancelled')).toBe(false)
    const exited = events.find((e) => e.type === 'turn_exited')
    expect(exited).toBeDefined()
    expect((exited as { reason: string }).reason).toContain('some crash')
  })

  it('a turn.failed event maps to turn_failed with the reported reason', async () => {
    const handle = codexAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('go', 't1')
    await flushMicrotasks()

    const thread = codexInstances[0].threads[0]
    thread.push({ type: 'turn.failed', error: { message: 'sandbox denied' } })
    await flushMicrotasks()

    expect(events).toContainEqual({ type: 'turn_failed', sessionId: 's1', turnId: 't1', reason: 'sandbox denied' })
  })

  it('stop() ends the thread so a later send() on the same handle starts a brand new one, reusing the same Codex client', async () => {
    const handle = codexAdapter.start(ctx)
    handle.send('go', 't1')
    await flushMicrotasks()
    handle.stop()
    await flushMicrotasks()

    handle.send('go again', 't2')
    await flushMicrotasks()

    expect(codexInstances).toHaveLength(1)
    expect(codexInstances[0].threads).toHaveLength(2)
  })

  it('respondToInteraction is a documented no-op (codex exec has no live approval channel)', () => {
    const handle = codexAdapter.start(ctx)
    expect(() => handle.respondToInteraction('x', 'allow')).not.toThrow()
  })

  it('reports real capabilities (sandbox permission modes) and no static/hardcoded model list — the real list comes from the live catalogue (codex-model-catalog-service.ts), never a fixed static array', () => {
    const caps = codexAdapter.getCapabilities()
    expect(caps.agentId).toBe('codex')
    expect(caps.permissionModes.length).toBeGreaterThan(0)
    expect(caps.models).toEqual([])
    expect(caps.supportsLiveModelSwitch).toBe(true)
  })

  it('passes ctx.model through to the SDK ThreadOptions and reports it via model_info at turn start', async () => {
    const handle = codexAdapter.start({ ...ctx, model: 'gpt-5.6-sol' })
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('go', 't1')
    await flushMicrotasks()

    expect((codexInstances[0].threads[0] as unknown as { __startOptions: { model?: string } }).__startOptions.model).toBe('gpt-5.6-sol')
    expect(events).toContainEqual({ type: 'model_info', sessionId: 's1', turnId: 't1', model: 'gpt-5.6-sol' })
  })

  it('emits no model_info when no model override is configured (never invents a model name)', async () => {
    const handle = codexAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('go', 't1')
    await flushMicrotasks()

    expect(events.some((e) => e.type === 'model_info')).toBe(false)
  })

  it('send() with images builds a UserInput[] of one text entry plus one local_image entry per path — Codex\'s real native image mechanism, not embedded base64', async () => {
    const handle = codexAdapter.start(ctx)
    handle.send('compare these', 't1', ['/tmp/attachments/s1/a.png', '/tmp/attachments/s1/b.jpg'])
    await flushMicrotasks()

    const thread = codexInstances[0].threads[0]
    expect(thread.runStreamedCalls[0].input).toEqual([
      { type: 'text', text: 'compare these' },
      { type: 'local_image', path: '/tmp/attachments/s1/a.png' },
      { type: 'local_image', path: '/tmp/attachments/s1/b.jpg' }
    ])
  })

  it('send() with no images passes the plain prompt string, not an array (unchanged text-only path)', async () => {
    const handle = codexAdapter.start(ctx)
    handle.send('just text', 't1')
    await flushMicrotasks()

    const thread = codexInstances[0].threads[0]
    expect(thread.runStreamedCalls[0].input).toBe('just text')
  })

  it('setModel() updates the model used by the next turn on this handle', async () => {
    const handle = codexAdapter.start(ctx)
    handle.setModel('gpt-5.6-sol')
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('go', 't1')
    await flushMicrotasks()

    expect((codexInstances[0].threads[0] as unknown as { __startOptions: { model?: string } }).__startOptions.model).toBe('gpt-5.6-sol')
    expect(events).toContainEqual({ type: 'model_info', sessionId: 's1', turnId: 't1', model: 'gpt-5.6-sol' })
  })

  it('emits response_artifacts BEFORE turn_completed when the response-image service reports new generated images', async () => {
    diffNewImagesMock.mockResolvedValue(['/codexhome/generated_images/tid/call_1.png'])

    const handle = codexAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('make an image', 't1')
    await flushMicrotasks()

    const thread = codexInstances[0].threads[0]
    thread.push({ type: 'thread.started', thread_id: 'tid' })
    thread.push({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Generated the image.' } })
    thread.push({ type: 'turn.completed', usage: {} })
    await flushMicrotasks()

    const types = events.map((e) => e.type)
    const artifactsIndex = types.indexOf('response_artifacts')
    const completedIndex = types.indexOf('turn_completed')
    expect(artifactsIndex).toBeGreaterThanOrEqual(0)
    expect(completedIndex).toBeGreaterThan(artifactsIndex)
    expect(events).toContainEqual({
      type: 'response_artifacts',
      sessionId: 's1',
      turnId: 't1',
      messageId: 't1-artifacts',
      images: ['/codexhome/generated_images/tid/call_1.png']
    })
  })

  it('emits no response_artifacts for an ordinary text-only turn (nothing new found)', async () => {
    diffNewImagesMock.mockResolvedValue([])

    const handle = codexAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('just say hi', 't1')
    await flushMicrotasks()

    const thread = codexInstances[0].threads[0]
    thread.push({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'hi' } })
    thread.push({ type: 'turn.completed', usage: {} })
    await flushMicrotasks()

    expect(events.some((e) => e.type === 'response_artifacts')).toBe(false)
  })

  it('snapshots the generated_images directory using the resumed thread id when one is already known', async () => {
    const handle = codexAdapter.start({ ...ctx, nativeSessionId: 'prior-thread-id' })
    handle.send('go', 't1')
    await flushMicrotasks()

    const thread = codexInstances[0].threads[0]
    // The snapshot is taken lazily on the first event of the turn (see
    // CodexAdapter's handleMessage doc comment) — there must be at least
    // one event before it fires.
    thread.push({ type: 'turn.started' })
    await flushMicrotasks()

    expect(snapshotDirMock).toHaveBeenCalledWith('prior-thread-id')
  })
})
