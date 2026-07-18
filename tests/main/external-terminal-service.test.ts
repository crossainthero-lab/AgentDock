import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

interface SpawnCall {
  command: string
  args: string[]
  proc: EventEmitter
}

const spawnCalls: SpawnCall[] = []
/** Command names that should fail to spawn (simulating "not installed") —
 *  keyed by the exact `command` argument passed to spawn(). */
const failingCommands = new Set<string>()

vi.mock('node:child_process', () => {
  const spawn = vi.fn((command: string, args: string[]) => {
    const proc = new EventEmitter() as EventEmitter & { unref: () => void }
    proc.unref = vi.fn()
    spawnCalls.push({ command, args, proc })
    // Real child_process emits 'error' or 'spawn' asynchronously — mirror
    // that so the service's Promise-based wrapper resolves correctly.
    setTimeout(() => {
      if (failingCommands.has(command)) proc.emit('error', new Error(`${command}: ENOENT`))
      else proc.emit('spawn')
    }, 0)
    return proc
  })
  return { spawn, default: { spawn } }
})

import { launchExternalTerminal } from '../../src/main/services/external-terminal-service'

const baseParams = {
  agentId: 'claude-code' as const,
  executablePath: 'C:\\Users\\billy\\.local\\bin\\claude.exe',
  workspacePath: 'C:\\Users\\billy\\Documents\\My Project',
  permissionMode: 'default',
  nativeSessionId: null as string | null
}

const codexParams = {
  agentId: 'codex' as const,
  executablePath: 'C:\\Users\\billy\\.local\\bin\\codex.exe',
  workspacePath: 'C:\\Users\\billy\\Documents\\My Project',
  permissionMode: 'default',
  nativeSessionId: null as string | null
}

describe('launchExternalTerminal', () => {
  beforeEach(() => {
    spawnCalls.length = 0
    failingCommands.clear()
  })

  it('tries wt.exe first, with -d <workspacePath> and the interactive claude invocation', async () => {
    const result = await launchExternalTerminal(baseParams)

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].command).toBe('wt.exe')
    expect(spawnCalls[0].args).toEqual(['-d', baseParams.workspacePath, baseParams.executablePath])
    expect(result).toEqual({ launched: true, method: 'wt', command: baseParams.executablePath })
  })

  it('never includes the structured-transport flags (-p/--output-format/--input-format) — this is for a human, not a machine parser', async () => {
    await launchExternalTerminal(baseParams)
    const args = spawnCalls[0].args.join(' ')
    expect(args).not.toContain('-p')
    expect(args).not.toContain('--output-format')
    expect(args).not.toContain('--input-format')
  })

  it('includes --permission-mode only when it is not the "default" sentinel', async () => {
    await launchExternalTerminal({ ...baseParams, permissionMode: 'plan' })
    expect(spawnCalls[0].args).toContain('--permission-mode')
    expect(spawnCalls[0].args).toContain('plan')

    spawnCalls.length = 0
    await launchExternalTerminal({ ...baseParams, permissionMode: 'default' })
    expect(spawnCalls[0].args).not.toContain('--permission-mode')
  })

  it('includes --resume when a native session id is known', async () => {
    await launchExternalTerminal({ ...baseParams, nativeSessionId: 'real-session-uuid' })
    expect(spawnCalls[0].args).toContain('--resume')
    expect(spawnCalls[0].args).toContain('real-session-uuid')
  })

  it('falls back to cmd.exe when wt.exe is unavailable, opening in the correct workspace directory', async () => {
    failingCommands.add('wt.exe')
    const result = await launchExternalTerminal(baseParams)

    expect(spawnCalls.map((c) => c.command)).toEqual(['wt.exe', 'cmd.exe'])
    const cmdCall = spawnCalls[1]
    expect(cmdCall.args).toEqual(['/c', 'start', '""', '/D', baseParams.workspacePath, baseParams.executablePath])
    expect(result).toEqual({ launched: true, method: 'cmd', command: baseParams.executablePath })
  })

  it('surfaces a real, non-empty error when both wt.exe and cmd.exe fail — never a silent no-op', async () => {
    failingCommands.add('wt.exe')
    failingCommands.add('cmd.exe')
    const result = await launchExternalTerminal(baseParams)

    expect(result.launched).toBe(false)
    expect(result.method).toBeNull()
    expect(result.error).toBeTruthy()
    expect(result.error).toContain('cmd.exe')
  })

  describe('Codex', () => {
    it('launches the interactive `codex` TUI (not `exec`), with no resume/sandbox args by default', async () => {
      const result = await launchExternalTerminal(codexParams)
      expect(spawnCalls[0].args).toEqual(['-d', codexParams.workspacePath, codexParams.executablePath])
      expect(result.command).toBe(codexParams.executablePath)
    })

    it('uses `resume <threadId>` (top-level interactive resume, distinct from `exec resume`) when a thread id is known', async () => {
      await launchExternalTerminal({ ...codexParams, nativeSessionId: 'real-thread-id' })
      const args = spawnCalls[0].args
      expect(args).toContain('resume')
      expect(args).toContain('real-thread-id')
      expect(args.join(' ')).not.toContain('exec')
    })

    it('maps sandbox permission modes to --sandbox, and "bypass" to the dedicated dangerous flag', async () => {
      await launchExternalTerminal({ ...codexParams, permissionMode: 'workspace-write' })
      expect(spawnCalls[0].args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write']))

      spawnCalls.length = 0
      await launchExternalTerminal({ ...codexParams, permissionMode: 'bypass' })
      expect(spawnCalls[0].args).toContain('--dangerously-bypass-approvals-and-sandbox')

      spawnCalls.length = 0
      await launchExternalTerminal({ ...codexParams, permissionMode: 'default' })
      expect(spawnCalls[0].args.join(' ')).not.toContain('--sandbox')
    })
  })
})
