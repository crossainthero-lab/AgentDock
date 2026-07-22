import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'

/** These tests exercise one specific platform's branch of
 *  external-terminal-service.ts at a time (Windows Terminal/cmd.exe, or
 *  macOS Terminal.app) — the module itself branches on `process.platform`,
 *  so a test suite that always runs on whatever OS happens to host CI/dev
 *  needs to pin the platform it's testing, restoring the real one
 *  afterward, rather than assuming the host OS matches the branch under
 *  test. */
function stubPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}
const realPlatform = process.platform

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
    stubPlatform('win32')
  })

  afterEach(() => {
    stubPlatform(realPlatform)
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

describe('launchExternalTerminal — macOS', () => {
  const macParams = {
    agentId: 'claude-code' as const,
    executablePath: '/opt/homebrew/bin/claude',
    workspacePath: "/Users/pat o'brien/My Projects/café ☕",
    permissionMode: 'default',
    nativeSessionId: null as string | null
  }

  beforeEach(() => {
    spawnCalls.length = 0
    failingCommands.clear()
    stubPlatform('darwin')
  })

  afterEach(() => {
    stubPlatform(realPlatform)
  })

  it('opens Terminal.app via osascript, activating it, rather than any Windows-only binary', async () => {
    const result = await launchExternalTerminal(macParams)

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].command).toBe('osascript')
    expect(spawnCalls[0].args[0]).toBe('-e')
    const appleScript = spawnCalls[0].args[1]
    expect(appleScript).toContain('tell application "Terminal" to do script')
    expect(appleScript).toContain('tell application "Terminal" to activate')
    expect(result).toEqual({ launched: true, method: 'terminal-app', command: macParams.executablePath })
  })

  it('CRITICAL (real bug fix): the script deletes itself as its own first statement — never on an external fixed timer — so a slow-to-open Terminal.app can never hit "No such file or directory" (confirmed live: a naive 10s-timeout cleanup raced Terminal.app actually reading the file and lost)', async () => {
    await launchExternalTerminal(macParams)

    const appleScript = spawnCalls[0].args[1]
    const scriptPathMatch = /do script "([^"]+)"/.exec(appleScript)
    const scriptPath = scriptPathMatch![1]
    const content = await readFile(scriptPath, 'utf-8')
    const lines = content.trim().split('\n')

    expect(lines[0]).toBe('#!/bin/sh')
    expect(lines[1]).toBe(`rm -f '${scriptPath}'`)
    // The rm line must come before cd/exec — it has to run (and thus only
    // ever fire once the shell has actually started) before anything else,
    // never queued to run "later" from outside the script's own execution.
    const cdIndex = lines.findIndex((l) => l.startsWith('cd '))
    expect(cdIndex).toBeGreaterThan(1)
  })

  it('writes a generated shell script whose cd/exec lines correctly single-quote a workspace path containing spaces, an apostrophe, and Unicode', async () => {
    await launchExternalTerminal(macParams)

    const appleScript = spawnCalls[0].args[1]
    const scriptPathMatch = /do script "([^"]+)"/.exec(appleScript)
    expect(scriptPathMatch).not.toBeNull()
    const scriptPath = scriptPathMatch![1]

    const content = await readFile(scriptPath, 'utf-8')
    expect(content).toContain('#!/bin/sh')
    // Real POSIX single-quote escaping: an embedded apostrophe becomes
    // '\'' — never a bare unescaped quote that would break the command.
    expect(content).toContain("cd '/Users/pat o'\\''brien/My Projects/café ☕'")
    expect(content).toContain("exec '/opt/homebrew/bin/claude'")
  })

  it('includes --resume for Claude and maps Codex sandbox permission modes the same as on Windows', async () => {
    await launchExternalTerminal({ ...macParams, nativeSessionId: 'real-session-uuid' })
    const scriptPathMatch = /do script "([^"]+)"/.exec(spawnCalls[0].args[1])
    const content = await readFile(scriptPathMatch![1], 'utf-8')
    expect(content).toContain('--resume')
    expect(content).toContain('real-session-uuid')
  })

  it('surfaces a real, non-empty error when osascript itself is unavailable — never a silent no-op', async () => {
    failingCommands.add('osascript')
    const result = await launchExternalTerminal(macParams)

    expect(result.launched).toBe(false)
    expect(result.method).toBeNull()
    expect(result.error).toBeTruthy()
  })
})

describe('launchExternalTerminal — unsupported platform', () => {
  beforeEach(() => {
    spawnCalls.length = 0
    failingCommands.clear()
    stubPlatform('linux')
  })

  afterEach(() => {
    stubPlatform(realPlatform)
  })

  it('reports a clear not-supported error instead of guessing at a terminal emulator', async () => {
    const result = await launchExternalTerminal({
      agentId: 'claude-code',
      executablePath: '/usr/bin/claude',
      workspacePath: '/home/pat/project',
      permissionMode: 'default',
      nativeSessionId: null
    })

    expect(spawnCalls).toHaveLength(0)
    expect(result.launched).toBe(false)
    expect(result.method).toBeNull()
    expect(result.error).toBeTruthy()
  })
})
