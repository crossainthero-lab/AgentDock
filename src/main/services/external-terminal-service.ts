// Launches a real, independent, interactive agent terminal session in a
// workspace — deliberately NOT a reattachment to AgentDock's own live
// session process (no such reattachment is implemented for either agent;
// this always starts a brand new process the user can see and type into
// directly). Windows only, matching this project's actual target platform.
import { spawn } from 'node:child_process'
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

export async function launchExternalTerminal(params: LaunchTerminalParams): Promise<LaunchTerminalResult> {
  const interactiveArgs = buildInteractiveArgs(params)
  const command = [params.executablePath, ...interactiveArgs].join(' ')

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

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
