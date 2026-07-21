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

const clipboardState = { image: null as { path: string } | null, text: '' }
const clipboardWriteImageMock = vi.fn((img: { path: string }) => {
  clipboardState.image = img
  clipboardState.text = ''
})
const clipboardWriteTextMock = vi.fn((text: string) => {
  clipboardState.text = text
  clipboardState.image = null
})
const clipboardClearMock = vi.fn(() => {
  clipboardState.image = null
  clipboardState.text = ''
})
vi.mock('electron', () => ({
  clipboard: {
    readImage: () => (clipboardState.image ? { isEmpty: () => false, path: clipboardState.image.path } : { isEmpty: () => true }),
    readText: () => clipboardState.text,
    writeImage: (img: { path: string }) => clipboardWriteImageMock(img),
    writeText: (text: string) => clipboardWriteTextMock(text),
    clear: () => clipboardClearMock()
  },
  nativeImage: {
    createFromPath: (path: string) => (path.includes('unreadable') ? { isEmpty: () => true } : { isEmpty: () => false, path })
  }
}))

import { antigravityAdapter } from '../../src/main/agents/antigravity/AntigravityAdapter'

const ctx: AgentRunContext = {
  session: { id: 's1', workspaceId: 'w1', agentId: 'antigravity', title: 't', status: 'idle', createdAt: '', updatedAt: '' },
  workspacePath: '/tmp/project',
  nativeSessionId: null,
  permissionMode: 'default',
  executablePath: 'agy',
  model: null,
  reasoningEffort: null
}

/** Feeds raw text (as agy would over the PTY) into the mocked process and
 *  waits past TerminalSessionController's real idle-debounce so a real
 *  snapshot — driven through the real TerminalScreenBuffer/
 *  AntigravityClassifier/AntigravityEventMapper pipeline, not a stub — is
 *  actually produced. */
async function feed(proc: MockProc, text: string): Promise<void> {
  for (const cb of proc._dataListeners) cb(text)
  await new Promise((resolve) => setTimeout(resolve, 550))
}

const IDLE_SCREEN =
  '\r\n> \r\n────────────────────────────────────────\r\n? for shortcuts                                            Gemini 3.1 Pro (High)'

describe('antigravityAdapter', () => {
  beforeEach(() => {
    spawnCalls.length = 0
    clipboardState.image = null
    clipboardState.text = ''
    clipboardWriteImageMock.mockClear()
    clipboardWriteTextMock.mockClear()
    clipboardClearMock.mockClear()
  })

  it('spawns agy interactively with --add-dir <workspacePath> and -i <prompt>', () => {
    const handle = antigravityAdapter.start(ctx)
    handle.send('fix the bug', 't1')

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].command).toBe('agy')
    expect(spawnCalls[0].args).toEqual(['--add-dir', '/tmp/project', '-i', 'fix the bug'])
  })

  it('maps permission modes to real agy flags, with --add-dir always present', () => {
    const accept = antigravityAdapter.start({ ...ctx, permissionMode: 'accept-edits' })
    accept.send('go', 't1')
    expect(spawnCalls[0].args).toEqual(['--mode', 'accept-edits', '--add-dir', '/tmp/project', '-i', 'go'])

    const bypass = antigravityAdapter.start({ ...ctx, permissionMode: 'bypass' })
    bypass.send('go', 't2')
    expect(spawnCalls[1].args).toEqual(['--dangerously-skip-permissions', '--add-dir', '/tmp/project', '-i', 'go'])
  })

  it('applies ctx.model via --model at spawn using the exact real model string', () => {
    const handle = antigravityAdapter.start({ ...ctx, model: 'Gemini 3.1 Pro (High)' })
    handle.send('go', 't1')
    expect(spawnCalls[0].args).toEqual(['--add-dir', '/tmp/project', '--model', 'Gemini 3.1 Pro (High)', '-i', 'go'])
  })

  it('emits model_info with the exact configured model on every send() so the header can display it, not just apply it', () => {
    const handle = antigravityAdapter.start({ ...ctx, model: 'Gemini 3.1 Pro (High)' })
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))

    handle.send('go', 't1')
    expect(events.filter((e) => e.type === 'model_info')).toEqual([{ type: 'model_info', sessionId: ctx.session.id, turnId: 't1', model: 'Gemini 3.1 Pro (High)' }])

    handle.send('again', 't2')
    expect(events.filter((e) => e.type === 'model_info')).toHaveLength(2)
  })

  it('emits no model_info when no model has been configured (no guessing at a default)', () => {
    const handle = antigravityAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('go', 't1')
    expect(events.some((e) => e.type === 'model_info')).toBe(false)
  })

  it('applies ctx.nativeSessionId via --conversation at spawn when resuming a persisted session', () => {
    const handle = antigravityAdapter.start({ ...ctx, nativeSessionId: 'de953c71-d7e7-436a-b438-8d46504f2735' })
    handle.send('go', 't1')
    expect(spawnCalls[0].args).toEqual([
      '--add-dir',
      '/tmp/project',
      '--conversation',
      'de953c71-d7e7-436a-b438-8d46504f2735',
      '-i',
      'go'
    ])
    expect(handle.getNativeSessionId()).toBe('de953c71-d7e7-436a-b438-8d46504f2735')
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

  it('a non-zero process exit maps to turn_failed, never a fabricated turn_completed', () => {
    const handle = antigravityAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello', 't1')

    for (const cb of spawnCalls[0].proc._exitListeners) cb({ exitCode: 1, signal: null })
    expect(events.some((e) => e.type === 'turn_completed')).toBe(false)
    expect(events).toContainEqual({ type: 'turn_failed', sessionId: 's1', turnId: 't1', reason: 'Antigravity exited with code 1' })
  })

  it('a clean process exit (fallback path — the process ended without turn_ready ever firing) still resolves as turn_completed', () => {
    const handle = antigravityAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello', 't1')

    for (const cb of spawnCalls[0].proc._exitListeners) cb({ exitCode: 0, signal: null })
    expect(events).toContainEqual({ type: 'turn_completed', sessionId: 's1', turnId: 't1' })
  })

  it('CRITICAL: a live idle-footer transition marks the turn complete WITHOUT the process exiting (the process stays alive for follow-ups)', async () => {
    // A known conversation id sidesteps the one-time /help capture dance
    // (its own dedicated test below) so this test isolates the turn_ready
    // -> turn_completed wiring specifically.
    const handle = antigravityAdapter.start({ ...ctx, nativeSessionId: 'already-known-conv-id' })
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello', 't1')

    const proc = spawnCalls[0].proc
    await feed(proc, '> hello\r\nhi there')
    expect(events.some((e) => e.type === 'turn_completed')).toBe(false)

    await feed(proc, IDLE_SCREEN)
    expect(events).toContainEqual({ type: 'turn_completed', sessionId: 's1', turnId: 't1' })
    // The process must still be alive — Antigravity's interactive session
    // persists across turns; only the busy->idle screen transition, not a
    // process exit, produced this completion.
    expect(proc.kill).not.toHaveBeenCalled()
    expect(proc.isRunning).toBe(true)
  }, 10000)

  it('interrupt() sends ESC (not Ctrl+C) and the resulting completion is reinterpreted as turn_cancelled', async () => {
    const handle = antigravityAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('write an essay', 't1')

    const proc = spawnCalls[0].proc
    await feed(proc, '> write an essay\r\n')

    handle.interrupt()
    expect(proc.write).toHaveBeenCalledWith('\x1b')
    expect(proc.write).not.toHaveBeenCalledWith('\x03')

    // ESC cancels the turn but agy returns to the exact same idle screen a
    // normal completion would show — the adapter must reinterpret it.
    await feed(proc, '> write an essay\r\n' + IDLE_SCREEN)
    expect(events).toContainEqual({ type: 'turn_cancelled', sessionId: 's1', turnId: 't1' })
    expect(events.some((e) => e.type === 'turn_completed')).toBe(false)
    expect(proc.kill).not.toHaveBeenCalled()
  }, 10000)

  it('stop() kills the process and emits turn_cancelled, never a fabricated turn_failed', () => {
    const handle = antigravityAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello', 't1')

    handle.stop()
    expect(spawnCalls[0].proc.kill).toHaveBeenCalled()
    for (const cb of spawnCalls[0].proc._exitListeners) cb({ exitCode: null, signal: 15 })

    expect(events).toContainEqual({ type: 'turn_cancelled', sessionId: 's1', turnId: 't1' })
    expect(events.some((e) => e.type === 'turn_failed')).toBe(false)
  })

  it('setModel() kills the live process; the next send() respawns with the new --model', () => {
    const handle = antigravityAdapter.start(ctx)
    handle.send('go', 't1')
    expect(spawnCalls).toHaveLength(1)

    handle.setModel('Claude Sonnet 4.6 (Thinking)')
    expect(spawnCalls[0].proc.kill).toHaveBeenCalled()
    spawnCalls[0].proc.isRunning = false

    handle.send('go again', 't2')
    expect(spawnCalls).toHaveLength(2)
    expect(spawnCalls[1].args).toEqual(['--add-dir', '/tmp/project', '--model', 'Claude Sonnet 4.6 (Thinking)', '-i', 'go again'])
  })

  it('setModel() after a conversation id is known resumes the SAME conversation under the new model', () => {
    const handle = antigravityAdapter.start({ ...ctx, nativeSessionId: 'known-conv-id' })
    handle.send('go', 't1')
    expect(spawnCalls).toHaveLength(1)

    handle.setModel('Claude Opus 4.6 (Thinking)')
    spawnCalls[0].proc.isRunning = false

    handle.send('go again', 't2')
    expect(spawnCalls[1].args).toEqual([
      '--add-dir',
      '/tmp/project',
      '--model',
      'Claude Opus 4.6 (Thinking)',
      '--conversation',
      'known-conv-id',
      '-i',
      'go again'
    ])
  })

  it('captures a real conversation id via a scripted /help scrape after the first turn, without leaking help-screen content into the chat', async () => {
    const handle = antigravityAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello', 't1')

    const proc = spawnCalls[0].proc
    // Real completions always take longer than the classifier's premature-
    // completion grace period (MIN_TURN_GRACE_MS) — feed a genuine
    // intermediate busy state first, matching real captured agy behavior,
    // so the idle footer below is trusted as this turn's actual completion
    // rather than requiring an artificial wait.
    await feed(proc, '> hello\r\nesc to cancel   Gemini 3.1 Pro (High)')
    // First turn completes -> capture should kick off instead of emitting
    // turn_completed immediately.
    await feed(proc, '> hello\r\nhi there' + IDLE_SCREEN)
    expect(events.some((e) => e.type === 'turn_completed')).toBe(false)
    expect(proc.write).toHaveBeenCalledWith('/help\r')
    expect(handle.getNativeSessionId()).toBeNull()

    // The /help overlay renders, including the real captured shape.
    await feed(
      proc,
      'Antigravity CLI   general    commands    shortcuts\r\n' +
        'Version 1.1.4\r\n' +
        'Conversation:   de953c71-d7e7-436a-b438-8d46504f2735\r\n'
    )

    expect(handle.getNativeSessionId()).toBe('de953c71-d7e7-436a-b438-8d46504f2735')
    expect(proc.write).toHaveBeenCalledWith('\x1b')
    expect(events).toContainEqual({ type: 'turn_completed', sessionId: 's1', turnId: 't1' })
    // No stray assistant/activity content from the help overlay itself.
    expect(events.some((e) => e.type === 'assistant_delta' && e.textDelta.includes('Conversation:'))).toBe(false)
  }, 10000)

  it('CRITICAL: attaching an image to a follow-up writes it to the OS clipboard, sends Ctrl+V, waits for the real "N media attached" confirmation, then sends the text and restores the original clipboard', async () => {
    clipboardState.text = 'the users original clipboard content'
    const handle = antigravityAdapter.start(ctx)
    handle.send('first turn', 't1')
    const proc = spawnCalls[0].proc

    handle.send('what color is this?', 't2', ['/fake/attachments/img1.png'])
    // Give the synchronous part of pasteImagesThenSend (clipboard write +
    // Ctrl+V) a moment to run before the confirmation screen arrives.
    await new Promise((r) => setTimeout(r, 50))

    expect(clipboardWriteImageMock).toHaveBeenCalledWith(expect.objectContaining({ path: '/fake/attachments/img1.png' }))
    expect(proc.write).toHaveBeenCalledWith('\x16')
    // The real prompt must not be sent yet — still waiting for confirmation.
    expect(proc.write).not.toHaveBeenCalledWith('what color is this?\r')

    await feed(proc, '\r\n▸ 📎 1 media attached (clipboard, 141 B, image/png)  (ctrl+o to expand)')
    // Poll loop runs every 200ms — give it room to notice and finish.
    await new Promise((r) => setTimeout(r, 600))

    expect(proc.write).toHaveBeenCalledWith('what color is this?\r')
    expect(clipboardWriteTextMock).toHaveBeenCalledWith('the users original clipboard content')
  }, 10000)

  it('spawns bare (no -i) when the FIRST message of a session includes attachments, then pastes and sends once idle', async () => {
    const handle = antigravityAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('describe this', 't1', ['/fake/attachments/first.png'])

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].args).toEqual(['--add-dir', '/tmp/project'])

    const proc = spawnCalls[0].proc
    // A real fresh spawn takes longer than the classifier's premature-
    // completion grace period (MIN_TURN_GRACE_MS) to reach idle (banner +
    // "Initializing..." spinner, per real captured agy startup behavior) —
    // feed that first so the idle footer below is trusted as genuine
    // readiness rather than requiring an artificial wait.
    await feed(proc, '      ▄▀▀▄  Antigravity CLI 1.1.4\r\n⣷  Initializing...')
    // Reaching idle for the first time (no prior turn) must not fire a
    // premature turn_completed — there's no real turn to resolve yet.
    await feed(proc, IDLE_SCREEN)
    expect(events.some((e) => e.type === 'turn_completed')).toBe(false)
    expect(clipboardWriteImageMock).toHaveBeenCalledWith(expect.objectContaining({ path: '/fake/attachments/first.png' }))
    expect(proc.write).toHaveBeenCalledWith('\x16')

    await feed(proc, '\r\n▸ 📎 1 media attached (clipboard, 141 B, image/png)  (ctrl+o to expand)')
    await new Promise((r) => setTimeout(r, 600))

    expect(proc.write).toHaveBeenCalledWith('describe this\r')
  }, 10000)

  it(
    'CRITICAL (real bug fix): a long/multi-line prompt (e.g. a continuation-handoff prompt) is spawned bare and ' +
      'delivered via bracketed-paste stdin, never as a raw -i argv value — proven root cause of a real Antigravity ' +
      'continuation failure (Windows argv/ConPTY quoting corrupting a large multi-line prompt)',
    async () => {
      const handle = antigravityAdapter.start(ctx)
      const receivedEvents: AgentEvent[] = []
      handle.onEvent((e) => receivedEvents.push(e))
      const longPrompt = 'add password reset\n\n--- Continuation context ---\nWorkspace: /tmp/project\n' + 'x'.repeat(600)
      handle.send(longPrompt, 't1')

      expect(spawnCalls).toHaveLength(1)
      // No -i at all — argv never carries the prompt text for this path.
      expect(spawnCalls[0].args).toEqual(['--add-dir', '/tmp/project'])

      const proc = spawnCalls[0].proc
      await feed(proc, '      ▄▀▀▄  Antigravity CLI 1.1.4\r\n⣷  Initializing...')
      await feed(proc, IDLE_SCREEN)
      expect(receivedEvents.some((e) => e.type === 'turn_completed')).toBe(false)

      await new Promise((r) => setTimeout(r, 100))
      // Delivered via bracketed paste (the same safe mechanism as follow-up
      // turns on an already-live process), never as a bare argv element.
      expect(proc.write).toHaveBeenCalledWith(`\x1b[200~${longPrompt}\x1b[201~\r`)
    },
    10000
  )

  it(
    'CRITICAL (real bug fix — confirmed root cause of a reported duplicated-handoff-prompt bug): a second send() ' +
      '(e.g. a retry) arriving while still bootstrapping replaces the pending prompt instead of writing to the PTY a ' +
      'second time — the process ends up receiving the prompt exactly once, never twice',
    async () => {
      const handle = antigravityAdapter.start(ctx)
      const receivedEvents: AgentEvent[] = []
      handle.onEvent((e) => receivedEvents.push(e))
      const originalPrompt = 'add password reset\n\n--- Continuation context ---\nWorkspace: /tmp/project\n' + 'x'.repeat(600)
      handle.send(originalPrompt, 't1')

      expect(spawnCalls).toHaveLength(1)
      const proc = spawnCalls[0].proc

      // A retry (or any second send for this same still-bootstrapping
      // process) arrives BEFORE the bare-spawned process has reached idle —
      // e.g. a stale-turn misfire marked the first attempt failed while agy
      // was still legitimately starting up.
      const retryPrompt = originalPrompt.replace('add password reset', 'add password reset (retry)')
      handle.send(retryPrompt, 't2')

      // Still exactly one process — a retry reuses the same live PTY, it
      // never spawns a second one.
      expect(spawnCalls).toHaveLength(1)
      // Nothing written yet — the process hasn't reached idle, so neither
      // the original nor the retry prompt should have hit the PTY.
      expect(proc.write).not.toHaveBeenCalled()

      await feed(proc, '      ▄▀▀▄  Antigravity CLI 1.1.4\r\n⣷  Initializing...')
      await feed(proc, IDLE_SCREEN)
      expect(receivedEvents.some((e) => e.type === 'turn_completed')).toBe(false)

      await new Promise((r) => setTimeout(r, 100))

      // Exactly one write to the PTY, ever — using the RETRY's prompt (the
      // latest one), never the stale original, and never both.
      const promptWrites = proc.write.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('add password reset')
      )
      expect(promptWrites).toHaveLength(1)
      expect(promptWrites[0][0]).toBe(`\x1b[200~${retryPrompt}\x1b[201~\r`)
      expect(proc.write).not.toHaveBeenCalledWith(`\x1b[200~${originalPrompt}\x1b[201~\r`)
    },
    10000
  )

  it('a short single-line prompt still spawns with -i (no unnecessary behavior change for the common case)', () => {
    const handle = antigravityAdapter.start(ctx)
    handle.send('fix the bug', 't1')
    expect(spawnCalls[0].args).toEqual(['--add-dir', '/tmp/project', '-i', 'fix the bug'])
  })

  it('skips an unreadable attachment with a warning instead of hanging, and still sends the text', async () => {
    const handle = antigravityAdapter.start(ctx)
    handle.send('first turn', 't1')
    const proc = spawnCalls[0].proc

    handle.send('go', 't2', ['/fake/attachments/unreadable.png'])
    await new Promise((r) => setTimeout(r, 100))

    expect(clipboardWriteImageMock).not.toHaveBeenCalled()
    expect(proc.write).toHaveBeenCalledWith('go\r')
  })

  it('reports the real `agy models` list as capabilities, with genuinely working live model switching', () => {
    const caps = antigravityAdapter.getCapabilities()
    expect(caps.models.length).toBeGreaterThan(0)
    expect(caps.models.map((m) => m.id)).toContain('Gemini 3.1 Pro (High)')
    expect(caps.supportsLiveModelSwitch).toBe(true)
  })
})
