import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from '../../src/shared/events/agent-event'
import type { AgentDetection } from '../../src/shared/types'

// A real, always-existing directory (unlike a fake "/tmp/project" path) —
// session-service.sendPrompt now validates the workspace path is a real,
// accessible directory before starting an agent (see
// validateWorkspacePath's own doc comment), so every test below that
// exercises sendPrompt needs a workspace path that genuinely exists on
// whatever machine/OS runs this suite.
const FAKE_WORKSPACE_PATH = tmpdir()

// titleSource defaults to 'manual' here specifically so the large majority
// of tests below (which have nothing to do with titling) never trigger the
// new title-generation-on-first-message path — see the dedicated "session
// title generation" describe block for tests that explicitly opt in by
// overriding it back to 'default'.
const sessionRow = {
  id: 's1',
  workspaceId: 'w1',
  agentId: 'claude-code' as const,
  title: 't',
  titleSource: 'manual' as 'default' | 'generated' | 'handoff' | 'manual',
  continuedFromSessionId: null as string | null,
  status: 'idle' as const,
  createdAt: '',
  updatedAt: ''
}

// vi.mock factories are hoisted above all other top-level code (including
// `const` declarations) — vi.hoisted() is required so this fn reference is
// created before the hoisted mock factories below try to close over it.
const { messageRepoAdd, sessionRepoSetTitle } = vi.hoisted(() => ({ messageRepoAdd: vi.fn(), sessionRepoSetTitle: vi.fn() }))

vi.mock('../../src/main/db/repositories/session-repo', () => ({
  sessionRepo: {
    get: vi.fn(() => sessionRow),
    setStatus: vi.fn(),
    getNativeSessionId: vi.fn(() => null),
    setNativeSessionId: vi.fn(),
    setTitle: sessionRepoSetTitle
  }
}))
vi.mock('../../src/main/db/repositories/message-repo', () => ({
  messageRepo: { add: messageRepoAdd, listBySession: vi.fn(() => []) }
}))
vi.mock('../../src/main/db/repositories/workspace-repo', () => ({
  workspaceRepo: { get: vi.fn(() => ({ id: 'w1', path: FAKE_WORKSPACE_PATH })) }
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
import { workspaceRepo } from '../../src/main/db/repositories/workspace-repo'

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

  it(
    'CRITICAL (real bug fix): persists displayText alongside the full delivered text, without ' +
      'altering what the transport actually receives',
    async () => {
      const fullPrompt = 'Add a daily focus timer.\n\n--- Continuation context ---\nWorkspace: C:\\project\n...'
      await sessionService.sendPrompt('s-display', fullPrompt, 't1', undefined, 'Add a daily focus timer.')

      // The transport (what actually reaches the agent) is always the full,
      // unmodified text — displayText exists purely for how the message is
      // shown/persisted, never for what gets delivered.
      expect(fakeHandle.send).toHaveBeenCalledWith(fullPrompt, 't1', undefined)
      // The persisted row carries BOTH: `text` is still the full delivered
      // prompt (so re-sending/regenerating history stays correct), and
      // `displayText` is the clean, user-authored task the bubble should
      // show instead.
      expect(messageRepoAdd).toHaveBeenCalledWith('s-display', 'user', {
        kind: 'text',
        text: fullPrompt,
        displayText: 'Add a daily focus timer.',
        images: undefined
      })
    }
  )

  it('omits displayText entirely for an ordinary (non-handoff) message — text alone is both what was typed and delivered', async () => {
    await sessionService.sendPrompt('s-ordinary', 'just a normal message', 't1')
    expect(messageRepoAdd).toHaveBeenCalledWith('s-ordinary', 'user', {
      kind: 'text',
      text: 'just a normal message',
      displayText: undefined,
      images: undefined
    })
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

  describe('workspace path validation (Windows portability: a saved project folder can be moved/deleted/inaccessible)', () => {
    it('CRITICAL (portability fix): rejects with a clear error, never spawns the agent, when the saved workspace folder no longer exists', async () => {
      const missingPath = join(FAKE_WORKSPACE_PATH, 'this-folder-does-not-exist-' + Date.now())
      vi.mocked(workspaceRepo.get).mockReturnValueOnce({ id: 'w1', path: missingPath } as ReturnType<typeof workspaceRepo.get>)

      await expect(sessionService.sendPrompt('s-missing-ws', 'hello', 't1')).rejects.toThrow(/could not be found/)

      expect(fakeHandle.send).not.toHaveBeenCalled()
      expect(messageRepoAdd).toHaveBeenCalledWith('s-missing-ws', 'error', {
        kind: 'text',
        text: expect.stringContaining('could not be found')
      })
    })

    it('rejects with a clear error when the saved workspace path is a file, not a folder', async () => {
      const filePath = join(FAKE_WORKSPACE_PATH, 'not-a-folder-' + Date.now() + '.txt')
      writeFileSync(filePath, 'not a directory')
      try {
        vi.mocked(workspaceRepo.get).mockReturnValueOnce({ id: 'w1', path: filePath } as ReturnType<typeof workspaceRepo.get>)
        await expect(sessionService.sendPrompt('s-file-ws', 'hello', 't1')).rejects.toThrow(/is not a folder/)
        expect(fakeHandle.send).not.toHaveBeenCalled()
      } finally {
        rmSync(filePath, { force: true })
      }
    })

    it('proceeds normally (no false-positive rejection) when the workspace folder genuinely exists, including a path with spaces and Unicode characters', async () => {
      const unicodeDir = join(FAKE_WORKSPACE_PATH, 'My Projéct 日本語 ' + Date.now())
      mkdirSync(unicodeDir, { recursive: true })
      try {
        vi.mocked(workspaceRepo.get).mockReturnValueOnce({ id: 'w1', path: unicodeDir } as ReturnType<typeof workspaceRepo.get>)
        await expect(sessionService.sendPrompt('s-unicode-ws', 'hello', 't1')).resolves.toBeUndefined()
        expect(fakeHandle.send).toHaveBeenCalledTimes(1)
      } finally {
        rmSync(unicodeDir, { recursive: true, force: true })
      }
    })

    // Never assumes the user profile / a project lives on C: — proves it
    // against a REAL second drive when this machine happens to have one
    // (skips cleanly, rather than faking a drive letter, when it doesn't;
    // the important thing being verified is that validateWorkspacePath's
    // own logic — a plain statSync call — never special-cases any specific
    // drive letter, which the Windows-portability audit already confirmed
    // is true of every path in src/main).
    const secondDrive = ['D:\\', 'E:\\', 'F:\\'].find((d) => {
      try {
        return statSync(d).isDirectory()
      } catch {
        return false
      }
    })
    it.skipIf(!secondDrive)('works correctly for a workspace on a non-C: drive', async () => {
      const dir = join(secondDrive as string, 'agentdock-portability-test-' + Date.now())
      mkdirSync(dir, { recursive: true })
      try {
        vi.mocked(workspaceRepo.get).mockReturnValueOnce({ id: 'w1', path: dir } as ReturnType<typeof workspaceRepo.get>)
        await expect(sessionService.sendPrompt('s-other-drive-ws', 'hello', 't1')).resolves.toBeUndefined()
        expect(fakeHandle.send).toHaveBeenCalledTimes(1)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
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

describe('sessionService.sendPrompt — automatic title generation on the first message', () => {
  beforeEach(() => {
    fakeHandle = makeFakeHandle()
    messageRepoAdd.mockClear()
    sessionRepoSetTitle.mockClear()
    sessionRow.titleSource = 'manual'
  })

  it('generates a real title from the first prompt when the session is still on the generic placeholder', async () => {
    sessionRow.titleSource = 'default'
    await sessionService.sendPrompt('s1', 'Build Project Pulse', 't1')
    expect(sessionRepoSetTitle).toHaveBeenCalledWith('s1', 'Build Project Pulse', 'generated')
  })

  it('never regenerates a title once it has already been auto-generated ("generated" is not "default")', async () => {
    sessionRow.titleSource = 'generated'
    await sessionService.sendPrompt('s1', 'A completely different message', 't1')
    expect(sessionRepoSetTitle).not.toHaveBeenCalled()
  })

  it('never overwrites a manually-renamed title', async () => {
    sessionRow.titleSource = 'manual'
    await sessionService.sendPrompt('s1', 'Some new message', 't1')
    expect(sessionRepoSetTitle).not.toHaveBeenCalled()
  })

  it('never overwrites a handoff-assigned title', async () => {
    sessionRow.titleSource = 'handoff'
    await sessionService.sendPrompt('s1', 'Some new message', 't1')
    expect(sessionRepoSetTitle).not.toHaveBeenCalled()
  })

  it('leaves the generic placeholder in place when nothing meaningful can be derived from the prompt', async () => {
    sessionRow.titleSource = 'default'
    await sessionService.sendPrompt('s1', '??', 't1')
    expect(sessionRepoSetTitle).not.toHaveBeenCalled()
  })

  it('derives the title from displayText, not the full delivered text, when the two differ', async () => {
    sessionRow.titleSource = 'default'
    // Deliberately different first lines, so this test actually
    // discriminates which one deriveTitleFromPrompt reads from.
    const fullPrompt = 'Internal continuation preamble the user never wrote.\n\nReal task follows.'
    await sessionService.sendPrompt('s1', fullPrompt, 't1', undefined, 'Add a daily focus timer.')
    expect(sessionRepoSetTitle).toHaveBeenCalledWith('s1', 'Add a daily focus timer', 'generated')
  })
})

describe('sessionService.rename', () => {
  beforeEach(() => {
    sessionRow.titleSource = 'manual'
  })

  it('sets titleSource to manual, permanently protecting it from automatic titling', () => {
    sessionService.rename('s1', '  My Own Title  ')
    expect(sessionRepoSetTitle).toHaveBeenCalledWith('s1', 'My Own Title', 'manual')
  })

  it('rejects an empty title rather than silently clearing it', () => {
    expect(() => sessionService.rename('s1', '   ')).toThrow()
  })
})
