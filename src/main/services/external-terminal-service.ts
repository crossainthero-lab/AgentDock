// Launches a real, independent, interactive agent terminal session in a
// workspace — deliberately NOT a reattachment to AgentDock's own live
// session process (no such reattachment is implemented for either agent;
// this always starts a brand new process the user can see and type into
// directly). Branches by process.platform: Windows Terminal/cmd.exe on
// win32 (original implementation), Terminal.app via AppleScript on darwin.
// Linux is out of scope for this pass and reports a clear "not supported"
// result rather than guessing at a terminal emulator.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentId, LaunchTerminalResult } from '@shared/types'

export interface LaunchTerminalParams {
  agentId: AgentId
  executablePath: string
  workspacePath: string
  /** AgentDock's own permission-mode id for this agent ('default' means
   *  "omit the flag"). */
  permissionMode: string
  nativeSessionId: string | null
}

/** Builds the argv for a real *interactive* session — never the machine-
 *  parsing flags AgentDock's own structured transport uses (Claude's
 *  `--input-format stream-json`, Codex's `exec --json`), since a human is
 *  going to be looking at and typing into this terminal directly. Agent-
 *  specific because Claude and Codex have entirely different CLI shapes for
 *  "resume this conversation interactively". */
function buildInteractiveArgs(params: LaunchTerminalParams): string[] {
  if (params.agentId === 'claude-code') {
    const args: string[] = []
    if (params.permissionMode && params.permissionMode !== 'default') {
      args.push('--permission-mode', params.permissionMode)
    }
    if (params.nativeSessionId) {
      args.push('--resume', params.nativeSessionId)
    }
    return args
  }

  if (params.agentId === 'codex') {
    // The interactive `codex` TUI (not `codex exec`) — a real human is
    // present in this terminal to answer any approval prompt directly,
    // unlike AgentDock's own exec-based transport which has no one to ask.
    const sandboxArgs = codexSandboxArgs(params.permissionMode)
    return params.nativeSessionId ? ['resume', params.nativeSessionId, ...sandboxArgs] : sandboxArgs
  }

  // Antigravity already has a real, working in-app terminal (it's PTY-
  // backed) — this path exists for completeness/future use, not because
  // AgentDock currently offers this button for it.
  return []
}

function codexSandboxArgs(permissionMode: string): string[] {
  switch (permissionMode) {
    case 'bypass':
      return ['--dangerously-bypass-approvals-and-sandbox']
    case 'read-only':
    case 'workspace-write':
    case 'danger-full-access':
      return ['--sandbox', permissionMode]
    default:
      return []
  }
}

function trySpawnDetached(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const proc = spawn(command, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false })
    proc.once('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
    proc.once('spawn', () => {
      if (settled) return
      settled = true
      proc.unref()
      resolve()
    })
  })
}

async function launchWindowsTerminal(params: LaunchTerminalParams, interactiveArgs: string[], command: string): Promise<LaunchTerminalResult> {
  try {
    // Windows Terminal: `-d <dir>` sets the starting directory; everything
    // after is the command to run inside the new tab.
    await trySpawnDetached('wt.exe', ['-d', params.workspacePath, params.executablePath, ...interactiveArgs], params.workspacePath)
    return { launched: true, method: 'wt', command }
  } catch (wtErr) {
    console.warn(`[external-terminal] wt.exe unavailable (${describeError(wtErr)}), falling back to cmd.exe`)
    try {
      // `start "" /D <dir> <cmd> <args...>` opens a new console window
      // rooted at the workspace directory. The empty "" is the required
      // (and otherwise ambiguous) window-title argument to `start`.
      await trySpawnDetached(
        'cmd.exe',
        ['/c', 'start', '""', '/D', params.workspacePath, params.executablePath, ...interactiveArgs],
        params.workspacePath
      )
      return { launched: true, method: 'cmd', command }
    } catch (cmdErr) {
      const error = `Could not open a terminal: ${describeError(cmdErr)}`
      console.error(`[external-terminal] ${error}`)
      return { launched: false, method: null, command, error }
    }
  }
}

/** Single-quotes a value for safe interpolation into a POSIX `/bin/sh`
 *  command: closes the quote, inserts an escaped literal quote, reopens it.
 *  Handles spaces, double quotes, `$`, backticks, and apostrophes in the
 *  value itself — all of which are otherwise dangerous to interpolate into
 *  a shell command string built as plain text. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The actual `cd`+exec logic lives in a tiny generated shell script file,
 *  not inline in the AppleScript command string — this is deliberate: the
 *  workspace path and executable path (which can contain spaces, Unicode,
 *  or apostrophes — anything a real macOS username/folder name can
 *  contain) only ever need POSIX shell quoting (shQuote above), never
 *  AppleScript string quoting too. Only this script's own path — a
 *  crypto-random name under the OS temp directory, never derived from user
 *  input — gets embedded into the AppleScript string, so there is no
 *  second layer of escaping to get right (and no injection surface). */
function buildMacLaunchScript(scriptPath: string, params: LaunchTerminalParams, interactiveArgs: string[]): string {
  const lines = [
    '#!/bin/sh',
    // Deletes itself as the very first thing it does, once actually
    // running — never on a fixed timer guessed from outside. A timer-based
    // "delete after N seconds" is a genuine race: Terminal.app can take
    // longer than that to even open its first window (e.g. a cold launch),
    // in which case the file gets deleted out from under it before `do
    // script` ever reads it, and the user sees "No such file or
    // directory" instead of their agent starting — confirmed live on this
    // exact machine. Unlinking an already-open/executing script is safe on
    // POSIX: the shell already has the file open, so removing the
    // directory entry doesn't disturb the running process at all.
    `rm -f ${shQuote(scriptPath)}`,
    `cd ${shQuote(params.workspacePath)}`,
    `exec ${[params.executablePath, ...interactiveArgs].map(shQuote).join(' ')}`
  ]
  return lines.join('\n') + '\n'
}

async function launchMacTerminal(params: LaunchTerminalParams, interactiveArgs: string[], command: string): Promise<LaunchTerminalResult> {
  const scriptPath = join(tmpdir(), `agentdock-launch-${randomUUID()}.sh`)
  try {
    await writeFile(scriptPath, buildMacLaunchScript(scriptPath, params, interactiveArgs), { mode: 0o755 })
    await chmod(scriptPath, 0o755)
    const appleScript = `tell application "Terminal" to do script "${scriptPath}"\ntell application "Terminal" to activate`
    await trySpawnDetached('osascript', ['-e', appleScript], params.workspacePath)
    return { launched: true, method: 'terminal-app', command }
  } catch (err) {
    void unlink(scriptPath).catch(() => {})
    const error = `Could not open Terminal.app: ${describeError(err)}`
    console.error(`[external-terminal] ${error}`)
    return { launched: false, method: null, command, error }
  }
}

export async function launchExternalTerminal(params: LaunchTerminalParams): Promise<LaunchTerminalResult> {
  const interactiveArgs = buildInteractiveArgs(params)
  const command = [params.executablePath, ...interactiveArgs].join(' ')

  if (process.platform === 'darwin') return launchMacTerminal(params, interactiveArgs, command)
  if (process.platform === 'win32') return launchWindowsTerminal(params, interactiveArgs, command)

  const error = 'Opening an external terminal is not supported on this platform yet.'
  console.warn(`[external-terminal] ${error}`)
  return { launched: false, method: null, command, error }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
