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
  getNativeSessionId: ReturnType<typeof vi.fn>
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
    getNativeSessionId: vi.fn(() => null),
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

  it('writes the prompt and turnId to the transport exactly once per sendPrompt call', async () => {
    await sessionService.sendPrompt('s-once', 'hello there', 't1')
    expect(fakeHandle.send).toHaveBeenCalledTimes(1)
    expect(fakeHandle.send).toHaveBeenCalledWith('hello there', 't1', undefined)
  })

  it('CRITICAL (real bug fix): forwards images through to the transport handle, not just to message persistence', async () => {
    await sessionService.sendPrompt('s-images', 'describe this', 't1', ['/fake/attachments/img1.png'])
    expect(fakeHandle.send).toHaveBeenCalledWith('describe this', 't1', ['/fake/attachments/img1.png'])
  })

  it('assigns a strictly increasing sequence number to each broadcast event for a session', async () => {
    const received: number[] = []
    const unsubscribe = sessionService.onEvent('s-seq', (payload) => received.push(payload.sequence))

    await sessionService.sendPrompt('s-seq', 'hello', 't1')
    fakeHandle.emit({ type: 'activity_started', sessionId: 's-seq', turnId: 't1', activityId: 'a1', label: 'Pondering' })
    fakeHandle.emit({ type: 'assistant_completed', sessionId: 's-seq', turnId: 't1', messageId: 'm1', text: 'hi' })
    fakeHandle.emit({ type: 'turn_completed', sessionId: 's-seq', turnId: 't1' })

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

    await expect(sessionService.sendPrompt('s-fail', 'hello', 't1')).rejects.toThrow('Claude Code is not installed.')
    // The user's message and the delivery failure are still both real,
    // persisted facts even though the IPC call rejects — only the renderer's
    // knowledge of *delivery* is what needed to change here.
    expect(messageRepoAdd).toHaveBeenCalledWith('s-fail', 'user', { kind: 'text', text: 'hello' })
    expect(messageRepoAdd).toHaveBeenCalledWith('s-fail', 'error', { kind: 'text', text: 'Claude Code is not installed.' })
  })

  it('turn_completed persists the transport\'s real native session id, agent-agnostically', async () => {
    fakeHandle.getNativeSessionId = vi.fn(() => 'real-session-id')
    const { sessionRepo } = await import('../../src/main/db/repositories/session-repo')

    await sessionService.sendPrompt('s-native', 'hello', 't1')
    fakeHandle.emit({ type: 'turn_completed', sessionId: 's-native', turnId: 't1' })

    expect(sessionRepo.setNativeSessionId).toHaveBeenCalledWith('s-native', 'real-session-id')
  })

  it('response_artifacts persists a new assistant message with responseImages and broadcasts the event', async () => {
    const received: AgentEvent[] = []
    const unsubscribe = sessionService.onEvent('s-artifacts', (payload) => received.push(payload.event))

    await sessionService.sendPrompt('s-artifacts', 'make an image', 't1')
    fakeHandle.emit({
      type: 'response_artifacts',
      sessionId: 's-artifacts',
      turnId: 't1',
      messageId: 't1-artifacts',
      images: ['/codexhome/generated_images/tid/call_1.png']
    })

    expect(messageRepoAdd).toHaveBeenCalledWith('s-artifacts', 'assistant', {
      kind: 'text',
      text: '',
      responseImages: ['/codexhome/generated_images/tid/call_1.png']
    })
    expect(received.some((e) => e.type === 'response_artifacts')).toBe(true)
    unsubscribe()
  })

  it('turn_failed persists an error message and does not fabricate turn_completed', async () => {
    const received: AgentEvent[] = []
    const unsubscribe = sessionService.onEvent('s-fail2', (payload) => received.push(payload.event))

    await sessionService.sendPrompt('s-fail2', 'hello', 't1')
    fakeHandle.emit({ type: 'turn_failed', sessionId: 's-fail2', turnId: 't1', reason: 'process crashed' })

    expect(messageRepoAdd).toHaveBeenCalledWith('s-fail2', 'error', { kind: 'text', text: 'process crashed' })
    expect(received.some((e) => e.type === 'turn_completed')).toBe(false)
    unsubscribe()
  })
})

describe('sessionService — new session-state transitions (waiting_for_permission/waiting_for_user/cancelled/exited)', () => {
  beforeEach(() => {
    fakeHandle = makeFakeHandle()
    messageRepoAdd.mockClear()
  })

  it('interaction_required with kind:permission sets status to waiting_for_permission', async () => {
    const { sessionRepo } = await import('../../src/main/db/repositories/session-repo')
    await sessionService.sendPrompt('s-perm', 'run a command', 't1')
    vi.mocked(sessionRepo.setStatus).mockClear()

    fakeHandle.emit({
      type: 'interaction_required',
      sessionId: 's-perm',
      turnId: 't1',
      interaction: { kind: 'permission', interactionId: 'i1', prompt: 'Allow Bash?', options: [{ id: 'allow', label: 'Allow' }] }
    })

    expect(sessionRepo.setStatus).toHaveBeenCalledWith('s-perm', 'waiting_for_permission')
  })

  it('interaction_required with kind:choice (e.g. AskUserQuestion) sets status to waiting_for_user, not waiting_for_permission', async () => {
    const { sessionRepo } = await import('../../src/main/db/repositories/session-repo')
    await sessionService.sendPrompt('s-choice', 'ask me something', 't1')
    vi.mocked(sessionRepo.setStatus).mockClear()

    fakeHandle.emit({
      type: 'interaction_required',
      sessionId: 's-choice',
      turnId: 't1',
      interaction: { kind: 'choice', interactionId: 'i1', prompt: 'Pick a color', options: [{ id: 'red', label: 'Red' }] }
    })

    expect(sessionRepo.setStatus).toHaveBeenCalledWith('s-choice', 'waiting_for_user')
  })

  it('turn_cancelled sets status to cancelled and clears the running handle', async () => {
    const { sessionRepo } = await import('../../src/main/db/repositories/session-repo')
    await sessionService.sendPrompt('s-cancel', 'go', 't1')
    vi.mocked(sessionRepo.setStatus).mockClear()

    fakeHandle.emit({ type: 'turn_cancelled', sessionId: 's-cancel', turnId: 't1' })
    expect(sessionRepo.setStatus).toHaveBeenCalledWith('s-cancel', 'cancelled')
    expect(sessionService.isRunning('s-cancel')).toBe(false)
  })

  it('turn_exited sets status to exited and persists an error message, distinct from turn_failed', async () => {
    const { sessionRepo } = await import('../../src/main/db/repositories/session-repo')
    await sessionService.sendPrompt('s-exit', 'go', 't1')
    vi.mocked(sessionRepo.setStatus).mockClear()

    fakeHandle.emit({ type: 'turn_exited', sessionId: 's-exit', turnId: 't1', reason: 'connection lost' })
    expect(sessionRepo.setStatus).toHaveBeenCalledWith('s-exit', 'exited')
    expect(messageRepoAdd).toHaveBeenCalledWith('s-exit', 'error', { kind: 'text', text: 'connection lost' })
  })
})

describe('sessionService.respondToInteraction — status only flips back to running after successful delivery', () => {
  beforeEach(() => {
    fakeHandle = makeFakeHandle()
    messageRepoAdd.mockClear()
  })

  it('sets status to running only after handle.respondToInteraction succeeds', async () => {
    const { sessionRepo } = await import('../../src/main/db/repositories/session-repo')
    await sessionService.sendPrompt('s-resp', 'run a command', 't1')
    fakeHandle.emit({
      type: 'interaction_required',
      sessionId: 's-resp',
      turnId: 't1',
      interaction: { kind: 'permission', interactionId: 'i1', prompt: 'Allow?', options: [{ id: 'allow', label: 'Allow' }] }
    })
    vi.mocked(sessionRepo.setStatus).mockClear()

    sessionService.respondToInteraction('s-resp', 'i1', 'allow')
    expect(fakeHandle.respondToInteraction).toHaveBeenCalledWith('i1', 'allow')
    expect(sessionRepo.setStatus).toHaveBeenCalledWith('s-resp', 'running')
  })

  it('does NOT flip status to running (and leaves the prompt answerable) if delivery throws', async () => {
    const { sessionRepo } = await import('../../src/main/db/repositories/session-repo')
    await sessionService.sendPrompt('s-resp-fail', 'run a command', 't1')
    fakeHandle.emit({
      type: 'interaction_required',
      sessionId: 's-resp-fail',
      turnId: 't1',
      interaction: { kind: 'permission', interactionId: 'i1', prompt: 'Allow?', options: [{ id: 'allow', label: 'Allow' }] }
    })
    fakeHandle.respondToInteraction.mockImplementationOnce(() => {
      throw new Error('delivery failed')
    })
    vi.mocked(sessionRepo.setStatus).mockClear()

    expect(() => sessionService.respondToInteraction('s-resp-fail', 'i1', 'allow')).not.toThrow()
    expect(sessionRepo.setStatus).not.toHaveBeenCalledWith('s-resp-fail', 'running')

    // The interaction must still be answerable — a retried, successful
    // delivery for the SAME interactionId should still work.
    sessionService.respondToInteraction('s-resp-fail', 'i1', 'allow')
    expect(sessionRepo.setStatus).toHaveBeenCalledWith('s-resp-fail', 'running')
  })
})

describe('sessionService.respondToInteraction — duplicate-submission prevention', () => {
  beforeEach(() => {
    fakeHandle = makeFakeHandle()
    messageRepoAdd.mockClear()
  })

  it('does not forward a second call for an already-answered interactionId into the transport', async () => {
    await sessionService.sendPrompt('s1', 'do something', 't1')
    fakeHandle.emit({
      type: 'interaction_required',
      sessionId: 's1',
      turnId: 't1',
      interaction: {
        kind: 'choice',
        interactionId: 'x-1',
        prompt: 'Pick one',
        options: [
          { id: '1', label: 'A' },
          { id: '2', label: 'B' }
        ]
      }
    })

    sessionService.respondToInteraction('s1', 'x-1', '1')
    expect(fakeHandle.respondToInteraction).toHaveBeenCalledTimes(1)
    expect(fakeHandle.respondToInteraction).toHaveBeenCalledWith('x-1', '1')

    // A double-click, or a UI race, re-firing the exact same answer — must
    // not re-send input into the live transport a second time.
    sessionService.respondToInteraction('s1', 'x-1', '1')
    expect(fakeHandle.respondToInteraction).toHaveBeenCalledTimes(1)
  })

  it('ignores a response naming an interactionId that is not the current pending one', async () => {
    await sessionService.sendPrompt('s1', 'do something', 't1')
    fakeHandle.emit({
      type: 'interaction_required',
      sessionId: 's1',
      turnId: 't1',
      interaction: { kind: 'choice', interactionId: 'x-1', prompt: 'Pick one', options: [{ id: '1', label: 'A' }] }
    })

    sessionService.respondToInteraction('s1', 'stale-id', '1')
    expect(fakeHandle.respondToInteraction).not.toHaveBeenCalled()
  })
})
