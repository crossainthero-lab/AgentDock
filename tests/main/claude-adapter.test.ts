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
    pid: 1000 + spawnCalls.length,
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

import { claudeAdapter, getClaudeNativeSessionId } from '../../src/main/agents/claude/ClaudeAdapter'

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

  afterEach(() => {
    vi.useRealTimers()
  })

  it('spawns claude interactively with --ax-screen-reader and the prompt in argv', () => {
    const handle = claudeAdapter.start(ctx)
    handle.send('do the thing')

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].command).toBe('claude')
    expect(spawnCalls[0].args).toEqual(['--ax-screen-reader', 'do the thing'])
  })

  it('adds --continue when this session previously had a live process', () => {
    const handle = claudeAdapter.start({ ...ctx, nativeSessionId: 'claude-session-started' })
    handle.send('continue please')

    expect(spawnCalls[0].args).toEqual(['--ax-screen-reader', '--continue', 'continue please'])
  })

  it('adds --permission-mode when not default', () => {
    const handle = claudeAdapter.start({ ...ctx, permissionMode: 'plan' })
    handle.send('go')

    expect(spawnCalls[0].args).toEqual(['--ax-screen-reader', '--permission-mode', 'plan', 'go'])
  })

  it('reuses the same live process for a second send() instead of spawning again', () => {
    const handle = claudeAdapter.start(ctx)
    handle.send('first turn')
    expect(spawnCalls).toHaveLength(1)

    handle.send('second turn')
    expect(spawnCalls).toHaveLength(1) // still just one spawn
    expect(spawnCalls[0].proc.write).toHaveBeenCalledWith('second turn\r')
  })

  it('wraps multiline prompts in bracketed paste before submitting with \\r', () => {
    const handle = claudeAdapter.start(ctx)
    handle.send('first turn')
    handle.send('line one\nline two')

    expect(spawnCalls[0].proc.write).toHaveBeenCalledWith('\x1b[200~line one\nline two\x1b[201~\r')
  })

  it('spawns again if the previous process already exited', () => {
    const handle = claudeAdapter.start(ctx)
    handle.send('first turn')
    spawnCalls[0].proc.isRunning = false
    for (const cb of spawnCalls[0].proc._exitListeners) cb({ exitCode: 0, signal: null })

    handle.send('second turn, new process')
    expect(spawnCalls).toHaveLength(2)
    expect(spawnCalls[1].args).toContain('second turn, new process')
  })

  it('always forwards raw data via onRawData, regardless of content', () => {
    const handle = claudeAdapter.start(ctx)
    const rawChunks: string[] = []
    handle.onRawData((chunk) => rawChunks.push(chunk))
    handle.send('hello')

    for (const cb of spawnCalls[0].proc._dataListeners) cb('some \x1b[31mraw\x1b[0m output')

    expect(rawChunks).toContain('some \x1b[31mraw\x1b[0m output')
  })

  it('classifies a settled "claude: <reply>" line into one assistant_message after the idle window', async () => {
    // Real timers deliberately, not fake ones — the screen buffer's write()
    // is processed asynchronously by @xterm/headless, and the idle debounce
    // that gates snapshotting is a real setTimeout in TerminalSessionController.
    const handle = claudeAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello')

    for (const cb of spawnCalls[0].proc._dataListeners) {
      cb('you: hello\r\n')
      // Real Claude Code sessions always print a "<verb> for Ns" footer and
      // status bar right after the reply in the same flush — matching that
      // shape here (rather than ending exactly on the reply line) is what
      // lets the classifier treat "claude: ..." as settled instead of
      // holding it back as a possibly-still-live last line.
      cb('claude: Hi there, how can I help?\r\nBrewed for 1s\r\nmanual mode on\r\n')
    }
    expect(events.some((e) => e.type === 'assistant_message')).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 700))

    const textEvents = events.filter((e) => e.type === 'assistant_message')
    expect(textEvents).toHaveLength(1)
    expect(textEvents[0]).toMatchObject({ type: 'assistant_message', text: 'Hi there, how can I help?' })
  })

  it('emits session_complete on process exit', () => {
    const handle = claudeAdapter.start(ctx)
    const events: AgentEvent[] = []
    handle.onEvent((e) => events.push(e))
    handle.send('hello')

    for (const cb of spawnCalls[0].proc._exitListeners) cb({ exitCode: 0, signal: null })

    expect(events).toContainEqual({ type: 'session_complete', exitCode: 0 })
  })

  it('exposes a "has started" marker via getClaudeNativeSessionId once a process has run', () => {
    const handle = claudeAdapter.start(ctx)
    expect(getClaudeNativeSessionId(handle)).toBeNull()
    handle.send('hello')
    expect(getClaudeNativeSessionId(handle)).toBe('claude-session-started')
  })

  it('reports real capabilities (models/permission modes) grounded in the CLI', () => {
    const caps = claudeAdapter.getCapabilities()
    expect(caps.agentId).toBe('claude-code')
    expect(caps.models.length).toBeGreaterThan(0)
    expect(caps.supportsLiveModelSwitch).toBe(true)
  })
})
