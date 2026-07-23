// Builds a sanitized diagnostic block for a failed agent/PTY launch — the
// whole point of the "SPAWN EINVAL" investigation this exists for was that
// the bare error gave no way to tell WHICH executable, working directory,
// or argument was actually the problem, or whether it even reached
// child_process at all. Every field here is either non-sensitive by
// construction (paths, platform/version info, error metadata) or has had
// anything sensitive stripped (the current user's home directory prefix,
// wherever it appears in a path) before ever being logged or shown to the
// user via "Copy diagnostics".
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, extname, isAbsolute } from 'node:path'
import { app } from 'electron'

export interface SpawnDiagnostics {
  agentId: string
  mechanism: string
  executablePath: string | null
  executableExt: string | null
  executableExists: boolean | null
  argCount: number
  args: string[]
  cwd: string | null
  cwdExists: boolean | null
  platform: string
  arch: string
  electronVersion: string
  nodeVersion: string
  packaged: boolean
  pathDirsPreview: string[]
  errorName: string | null
  errorCode: string | null
  errorMessage: string | null
  errorStack: string | null
  cause: string | null
}

/** Replaces the current user's home directory with `~` wherever it
 *  appears — the one piece of a path that both (a) never changes the
 *  diagnostic value of the path (the rest of it, e.g.
 *  `AppData\Programs\OpenAI\Codex\bin\codex.cmd`, is what actually matters
 *  for diagnosis) and (b) is the one segment a user pasting this into a
 *  bug report might not want to share verbatim. */
function redactHome(value: string): string {
  const home = homedir()
  if (!home) return value
  return value.split(home).join('~')
}

function redactArg(arg: string): string {
  // Argument VALUES for these CLIs are flags/mode-ids/paths, never prompt
  // text or secrets (prompts are delivered over stdin, not argv — see each
  // transport's own module comment) — still, anything that looks like it
  // could be a bearer token/key (long opaque alphanumeric run) is masked
  // defensively rather than assumed safe.
  const looksLikeSecret = /^[A-Za-z0-9_-]{20,}$/.test(arg)
  return redactHome(looksLikeSecret ? `${arg.slice(0, 4)}…(redacted)` : arg)
}

function pathDirsPreview(): string[] {
  const raw = process.env.PATH ?? process.env.Path ?? ''
  return raw
    .split(delimiter)
    .filter(Boolean)
    .slice(0, 12)
    .map(redactHome)
}

export interface BuildSpawnDiagnosticsInput {
  agentId: string
  mechanism: string
  executablePath: string | null
  args?: string[]
  cwd?: string | null
  error: unknown
}

export function buildSpawnDiagnostics(input: BuildSpawnDiagnosticsInput): SpawnDiagnostics {
  const { agentId, mechanism, executablePath, args = [], cwd = null, error } = input

  let executableExists: boolean | null = null
  if (executablePath) {
    executableExists = isAbsolute(executablePath) ? existsSync(executablePath) : null // bare name — PATH-resolved, nothing on disk to check directly
  }

  let cwdExists: boolean | null = null
  if (cwd) {
    try {
      cwdExists = statSync(cwd).isDirectory()
    } catch {
      cwdExists = false
    }
  }

  const err = error instanceof Error ? error : null
  const code = err && 'code' in err ? String((err as NodeJS.ErrnoException).code ?? '') || null : null
  const cause = err && 'cause' in err && err.cause !== undefined ? String((err as { cause?: unknown }).cause) : null

  return {
    agentId,
    mechanism,
    executablePath: executablePath ? redactHome(executablePath) : null,
    executableExt: executablePath ? extname(executablePath).toLowerCase() || null : null,
    executableExists,
    argCount: args.length,
    args: args.map(redactArg),
    cwd: cwd ? redactHome(cwd) : null,
    cwdExists,
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron ?? 'unknown',
    nodeVersion: process.versions.node,
    packaged: app.isPackaged,
    pathDirsPreview: pathDirsPreview(),
    errorName: err?.name ?? null,
    errorCode: code,
    errorMessage: err?.message ?? (typeof error === 'string' ? error : String(error)),
    errorStack: err?.stack ?? null,
    cause
  }
}

/** Human-readable block appended to the error surfaced in chat — this is
 *  what "Copy diagnostics" actually copies (the whole error message
 *  already contains it, so no separate IPC round-trip is needed to fetch
 *  it). Kept plain-text/deterministic (no timestamps, no color) so it
 *  pastes cleanly into a bug report. */
export function formatSpawnDiagnostics(diag: SpawnDiagnostics): string {
  const lines = [
    '--- AgentDock diagnostics ---',
    `Agent: ${diag.agentId}`,
    `Launch mechanism: ${diag.mechanism}`,
    `Executable: ${diag.executablePath ?? '(none)'}${diag.executableExt ? ` (${diag.executableExt})` : ''}`,
    `Executable exists on disk: ${diag.executableExists === null ? 'n/a (PATH-resolved)' : diag.executableExists}`,
    `Arguments (${diag.argCount}): ${diag.args.join(' ') || '(none)'}`,
    `Working directory: ${diag.cwd ?? '(none)'}`,
    `Working directory exists: ${diag.cwdExists === null ? 'n/a' : diag.cwdExists}`,
    `Platform: ${diag.platform} (${diag.arch})`,
    `Electron: ${diag.electronVersion} · Node: ${diag.nodeVersion}`,
    `Mode: ${diag.packaged ? 'packaged' : 'development'}`,
    `PATH (first ${diag.pathDirsPreview.length}): ${diag.pathDirsPreview.join(delimiter) || '(empty)'}`,
    `Error: ${diag.errorName ?? 'Error'}${diag.errorCode ? ` (${diag.errorCode})` : ''}: ${diag.errorMessage ?? '(no message)'}`,
    ...(diag.cause ? [`Cause: ${diag.cause}`] : []),
    ...(diag.errorStack ? ['Stack:', diag.errorStack] : [])
  ]
  return lines.join('\n')
}
