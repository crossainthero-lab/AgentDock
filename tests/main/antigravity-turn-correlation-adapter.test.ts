// Adapter-level (real process lifecycle) regression tests for the reported
// turn-misattribution bug — see antigravity-turn-correlation.test.ts for the
// full root-cause account and the classifier/mapper-level tests. These
// three specifically need the full AntigravityAdapter/TerminalSessionController
// lifecycle (process spawn, reuse, exit), so they follow
// antigravity-adapter.test.ts's exact mocking pattern (vi.mock calls at true
// module scope — vitest hoists them above imports, so anything they
// reference must also be module-scope, not declared inside a describe()).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../src/shared/events/agent-event'
import type { AgentRunContext } from '../../src/main/agents/agent-adapter'

interface MockProc {
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
    pid: 4000 + spawnCalls.length,
    isRunning: true,
    write: vi.fn(),
    resize: vi.fn(),
    interrupt: vi.fn(),
    kill: vi.fn(() => {
      proc.isRunning = false
    }),
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

vi.mock('electron', () => ({
  clipboard: { readImage: () => ({ isEmpty: () => true }), readText: () => '', writeImage: () => {}, writeText: () => {}, clear: () => {} },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }
}))

import { antigravityAdapter } from '../../src/main/agents/antigravity/AntigravityAdapter'

// A known nativeSessionId sidesteps the one-time /help-scrape conversation-
// id capture dance (its own dedicated test in antigravity-adapter.test.ts)
// so these tests can isolate turn-correlation specifically, exactly like
// antigravity-adapter.test.ts's own "CRITICAL: a live idle-footer
// transition..." test does.
const ctx: AgentRunContext = {
  session: { id: 's1', workspaceId: 'w1', agentId: 'antigravity', title: 't', status: 'idle', createdAt: '', updatedAt: '' },
  workspacePath: '/tmp/project',
  nativeSessionId: 'already-known-conv-id',
  permissionMode: 'default',
  executablePath: 'agy',
  model: null,
  reasoningEffort: null
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function feed(proc: MockProc, text: string): Promise<void> {
  for (const cb of proc._dataListeners) cb(text)
  await wait(550)
}

describe('Antigravity turn correlation — adapter-level (real process lifecycle)', () => {
  beforeEach(() => {
    spawnCalls.length = 0
  })

  // Test 7: session reuse — one process, multiple unique turns, a completed
  // turn cannot receive a later turn's events.
  it('CRITICAL: reuses one process across multiple turns, each with its own unique turnId, and a completed turn never receives a later turn\'s content', async () => {
    const handle = antigravityAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))

    handle.send('first task', 't1')
    const proc = spawnCalls[0].proc
    await feed(proc, '> first task\r\nesc to cancel   Gemini 3.1 Pro (High)')
    await feed(proc, '\r\n  First result.\r\n\r\n────\r\n>\r\n────\r\n? for shortcuts   Gemini 3.1 Pro (High)')

    const t1Events = events.filter((e) => e.turnId === 't1')
    expect(t1Events.some((e) => e.type === 'turn_completed')).toBe(true)
    expect(spawnCalls).toHaveLength(1) // same process, not respawned

    handle.send('second task', 't2')
    await feed(proc, '> second task\r\nesc to cancel   Gemini 3.1 Pro (High)')
    await feed(proc, '\r\n  Second result.\r\n\r\n────\r\n>\r\n────\r\n? for shortcuts   Gemini 3.1 Pro (High)')

    expect(spawnCalls).toHaveLength(1) // still the same process
    const t2Events = events.filter((e) => e.turnId === 't2')
    expect(t2Events.some((e) => e.type === 'turn_completed')).toBe(true)
    // t1's own events never got a second turn_completed replayed under t2,
    // and t2 never received t1's own text.
    expect(t2Events.some((e) => e.type === 'assistant_delta' && (e as { textDelta: string }).textDelta.includes('First result'))).toBe(
      false
    )
  }, 15000)

  // Test 8: process startup race — the first prompt is queued (via `-i` at
  // spawn, agy's own real mechanism) and executed exactly once once the
  // process is genuinely ready, even if agy's screen takes a while to
  // stabilize before showing anything.
  it('the first prompt survives a slow, multi-step process startup and is submitted/executed exactly once', async () => {
    const handle = antigravityAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))

    handle.send('Make a simple python script', 't1')
    expect(spawnCalls).toHaveLength(1)
    // The prompt is baked into the spawn argv itself (agy's own real
    // mechanism for this) — never a separately-timed follow-up write that
    // could race with readiness.
    expect(spawnCalls[0].args).toContain('-i')
    expect(spawnCalls[0].args[spawnCalls[0].args.length - 1]).toBe('Make a simple python script')

    const proc = spawnCalls[0].proc
    // Slow, multi-step startup — banner redraws, a busy spinner — before
    // anything resembling readiness appears. (Authentication's own distinct
    // "not signed in" flash is covered by its own dedicated detection test
    // elsewhere — deliberately not mixed into this one, which is about
    // startup timing, not auth-window edge cases.)
    await feed(proc, '      ▄▀▀▄  Antigravity CLI 1.1.4\r\n⣷  Initializing...')
    expect(events.some((e) => e.type === 'turn_completed')).toBe(false)

    await feed(proc, '\r\n\r\n> Make a simple python script\r\nesc to cancel   Gemini 3.1 Pro (High)')
    console.log('DEBUG events after feed2:', JSON.stringify(events))
    await feed(proc, '\r\n  Done.\r\n\r\n────\r\n>\r\n────\r\n? for shortcuts   Gemini 3.1 Pro (High)')
    console.log('DEBUG events after feed3:', JSON.stringify(events))

    expect(spawnCalls).toHaveLength(1) // never respawned/resubmitted
    expect(events.filter((e) => e.type === 'turn_completed')).toHaveLength(1) // exactly once
    expect(events).toContainEqual(expect.objectContaining({ type: 'assistant_delta', turnId: 't1', textDelta: 'Done.' }))
  }, 15000)

  // Test 9: process failure surfaces a clear error and never silently
  // attaches a future turn's response to the wrong message.
  it('a process crash surfaces turn_failed clearly and does not let a later turn silently inherit the failed one\'s state', async () => {
    const handle = antigravityAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))

    handle.send('do something', 't1')
    const proc = spawnCalls[0].proc
    await feed(proc, '> do something\r\nesc to cancel   Gemini 3.1 Pro (High)')
    proc.isRunning = false // a real crash means the OS process is gone
    for (const cb of proc._exitListeners) cb({ exitCode: 1, signal: null })

    const t1Events = events.filter((e) => e.turnId === 't1')
    expect(t1Events).toContainEqual({ type: 'turn_failed', sessionId: 's1', turnId: 't1', reason: 'Antigravity exited with code 1' })
    expect(t1Events.some((e) => e.type === 'turn_completed')).toBe(false)

    // A fresh send() after the crash spawns a genuinely new process and a
    // genuinely new turn — never silently resumes into the dead one.
    handle.send('try again', 't2')
    expect(spawnCalls).toHaveLength(2)
    const proc2 = spawnCalls[1].proc
    await feed(proc2, '> try again\r\nesc to cancel   Gemini 3.1 Pro (High)')
    await feed(proc2, '\r\n  Worked this time.\r\n\r\n────\r\n>\r\n────\r\n? for shortcuts   Gemini 3.1 Pro (High)')

    const t2Events = events.filter((e) => e.turnId === 't2')
    expect(t2Events.some((e) => e.type === 'turn_completed')).toBe(true)
    expect(t2Events.some((e) => e.type === 'turn_failed')).toBe(false)
  }, 15000)
})
