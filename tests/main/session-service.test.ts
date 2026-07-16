import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../src/shared/events/agent-event'
import type { AgentDetection } from '../../src/shared/types'

const sessionRow = {
  id: 's1',
  workspaceId: 'w1',
  agentId: 'claude-code' as const,
  title: 't',
  status: 'idle' as const,
  createdAt: '',
  updatedAt: ''
}

// vi.mock factories are hoisted above all other top-level code (including
// `const` declarations) — vi.hoisted() is required so this fn reference is
// created before the hoisted mock factories below try to close over it.
const { messageRepoAdd } = vi.hoisted(() => ({ messageRepoAdd: vi.fn() }))

vi.mock('../../src/main/db/repositories/session-repo', () => ({
  sessionRepo: {
    get: vi.fn(() => sessionRow),
    setStatus: vi.fn(),
    getNativeSessionId: vi.fn(() => null),
    setNativeSessionId: vi.fn()
  }
}))
vi.mock('../../src/main/db/repositories/message-repo', () => ({
  messageRepo: { add: messageRepoAdd, listBySession: vi.fn(() => []) }
}))
vi.mock('../../src/main/db/repositories/workspace-repo', () => ({
  workspaceRepo: { get: vi.fn(() => ({ id: 'w1', path: '/tmp/project' })) }
}))
vi.mock('../../src/main/services/settings-service', () => ({
  settingsService: {
    get: vi.fn(() => ({ agents: { 'claude-code': { customPath: null, permissionMode: 'default' } } }))
  }
}))
vi.mock('../../src/main/services/detection-service', () => ({
  detectionService: { detect: vi.fn(async () => ({ installed: true, executablePath: 'claude' })) }
}))
vi.mock('../../src/main/agents/claude/ClaudeAdapter', () => ({
  getClaudeNativeSessionId: vi.fn(() => null)
}))

interface FakeHandle {
  isRunning: boolean
  send: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  interrupt: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  onEvent: (cb: (e: AgentEvent) => void) => () => void
  onRawData: () => () => void
  onProcessExit: () => () => void
  respondToInteraction: ReturnType<typeof vi.fn>
  setModel: ReturnType<typeof vi.fn>
  runCommand: ReturnType<typeof vi.fn>
  emit(event: AgentEvent): void
}

function makeFakeHandle(): FakeHandle {
  const listeners = new Set<(e: AgentEvent) => void>()
  return {
    isRunning: true,
    send: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    interrupt: vi.fn(),
    stop: vi.fn(),
    onEvent(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    onRawData: () => () => {},
    onProcessExit: () => () => {},
    respondToInteraction: vi.fn(),
    setModel: vi.fn(),
    runCommand: vi.fn(),
    emit(event) {
      for (const l of listeners) l(event)
    }
  }
}

let fakeHandle: FakeHandle

vi.mock('../../src/main/agents/adapter-registry', () => ({
  getAdapter: vi.fn(() => ({
    id: 'claude-code',
    displayName: 'Claude Code',
    start: vi.fn(() => fakeHandle)
  }))
}))

import { sessionService } from '../../src/main/services/session-service'
import { detectionService } from '../../src/main/services/detection-service'

describe('sessionService — delivery and event sequencing', () => {
  beforeEach(() => {
    fakeHandle = makeFakeHandle()
    messageRepoAdd.mockClear()
  })

  it('writes the prompt to the PTY exactly once per sendPrompt call', async () => {
    await sessionService.sendPrompt('s-once', 'hello there')
    expect(fakeHandle.send).toHaveBeenCalledTimes(1)
    expect(fakeHandle.send).toHaveBeenCalledWith('hello there')
  })

  it('assigns a strictly increasing sequence number to each broadcast event for a session', async () => {
    const received: number[] = []
    const unsubscribe = sessionService.onEvent('s-seq', (payload) => received.push(payload.sequence))

    await sessionService.sendPrompt('s-seq', 'hello')
    fakeHandle.emit({ type: 'activity', label: 'Pondering' })
    fakeHandle.emit({ type: 'assistant_message', text: 'hi' })
    fakeHandle.emit({ type: 'session_complete', exitCode: 0 })

    expect(received).toEqual([1, 2, 3])
    unsubscribe()
  })

  it('rejects (rather than silently resolving) when the agent genuinely cannot be reached', async () => {
    vi.mocked(detectionService.detect).mockResolvedValueOnce({
      agentId: 'claude-code',
      installed: false,
      version: null,
      executablePath: null,
      error: 'Claude Code is not installed.',
      structuredOutput: true
    } satisfies AgentDetection)

    await expect(sessionService.sendPrompt('s-fail', 'hello')).rejects.toThrow('Claude Code is not installed.')
    // The user's message and the delivery failure are still both real,
    // persisted facts even though the IPC call rejects — only the renderer's
    // knowledge of *delivery* is what needed to change here.
    expect(messageRepoAdd).toHaveBeenCalledWith('s-fail', 'user', { kind: 'text', text: 'hello' })
    expect(messageRepoAdd).toHaveBeenCalledWith('s-fail', 'error', { kind: 'text', text: 'Claude Code is not installed.' })
  })
})

describe('sessionService.respondToInteraction — duplicate-submission prevention', () => {
  beforeEach(() => {
    fakeHandle = makeFakeHandle()
    messageRepoAdd.mockClear()
  })

  it('does not forward a second call for an already-answered interactionId into the PTY', async () => {
    await sessionService.sendPrompt('s1', 'do something')
    fakeHandle.emit({
      type: 'choice_required',
      interactionId: 'x-1',
      prompt: 'Pick one',
      options: [
        { id: '1', label: 'A' },
        { id: '2', label: 'B' }
      ]
    })

    sessionService.respondToInteraction('s1', 'x-1', '1')
    expect(fakeHandle.respondToInteraction).toHaveBeenCalledTimes(1)
    expect(fakeHandle.respondToInteraction).toHaveBeenCalledWith('x-1', '1')

    // A double-click, or a UI race, re-firing the exact same answer — must
    // not re-send input into the live CLI a second time.
    sessionService.respondToInteraction('s1', 'x-1', '1')
    expect(fakeHandle.respondToInteraction).toHaveBeenCalledTimes(1)
  })

  it('ignores a response naming an interactionId that is not the current pending one', async () => {
    await sessionService.sendPrompt('s1', 'do something')
    fakeHandle.emit({
      type: 'choice_required',
      interactionId: 'x-1',
      prompt: 'Pick one',
      options: [{ id: '1', label: 'A' }]
    })

    sessionService.respondToInteraction('s1', 'stale-id', '1')
    expect(fakeHandle.respondToInteraction).not.toHaveBeenCalled()
  })
})
