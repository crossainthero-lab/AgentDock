// Finds and launches the user's local VS Code installation to open a file
// or folder. Never a hardcoded per-user path — searches PATH first, then a
// small set of well-known per-platform install locations, each resolved
// from an environment variable or a fixed system-wide default (e.g.
// `%LOCALAPPDATA%`), never a literal username. Spawns detached and never
// awaits VS Code's own exit, so a slow or hung launch can never freeze
// AgentDock.
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
// Not node:child_process's own `spawn` — a plain `.cmd` shim (how VS Code's
// `code` command is installed on Windows) can only be run through a shell,
// and Node's own `shell: true` + array-args combination does NOT safely
// escape those arguments (Node emits DEP0190 over exactly this: "arguments
// are not escaped, only concatenated" — a real shell-injection risk for any
// path containing shell metacharacters). cross-spawn is the small,
// well-established fix specifically for this Windows .cmd/.bat case: same
// call signature as node's spawn, but correctly quotes each argument itself
// rather than relying on the shell to do it.
import spawn from 'cross-spawn'

function pathEnvDirs(): string[] {
  const raw = process.env.PATH ?? process.env.Path ?? ''
  return raw.split(delimiter).filter(Boolean)
}

function candidateNames(): string[] {
  return process.platform === 'win32' ? ['code.cmd', 'code.exe'] : ['code']
}

function wellKnownInstallPaths(): string[] {
  if (process.platform === 'win32') {
    const candidates: string[] = []
    const localAppData = process.env.LOCALAPPDATA
    const programFiles = process.env['ProgramFiles']
    const programFilesX86 = process.env['ProgramFiles(x86)']
    if (localAppData) candidates.push(join(localAppData, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'))
    if (programFiles) candidates.push(join(programFiles, 'Microsoft VS Code', 'bin', 'code.cmd'))
    if (programFilesX86) candidates.push(join(programFilesX86, 'Microsoft VS Code', 'bin', 'code.cmd'))
    return candidates
  }
  if (process.platform === 'darwin') {
    return ['/usr/local/bin/code', '/opt/homebrew/bin/code', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code']
  }
  // Linux: covers the .deb/.rpm install location, a manual /usr/local
  // install, and the Snap package — the common cases without guessing at
  // every possible distro packaging.
  return ['/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code', '/usr/share/code/bin/code']
}

// undefined = not yet searched this session; null = searched and not found.
let cachedExecutablePath: string | null | undefined

function findCodeExecutable(): string | null {
  if (cachedExecutablePath !== undefined) return cachedExecutablePath
  const names = candidateNames()
  for (const dir of pathEnvDirs()) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) {
        cachedExecutablePath = candidate
        return candidate
      }
    }
  }
  for (const candidate of wellKnownInstallPaths()) {
    if (existsSync(candidate)) {
      cachedExecutablePath = candidate
      return candidate
    }
  }
  cachedExecutablePath = null
  return null
}

export interface LaunchResult {
  ok: boolean
  error?: string
}

export const vscodeLauncherService = {
  /** Test-only: clears the cached lookup so a test can simulate VS Code
   *  appearing/disappearing between calls. Production code never needs
   *  this — a VS Code install completed mid-session just needs a restart
   *  to be picked up, which is an acceptable, rare trade-off. */
  _resetCacheForTests(): void {
    cachedExecutablePath = undefined
  },

  isAvailable(): boolean {
    return findCodeExecutable() !== null
  },

  /** Opens `targetPath` (an absolute file or folder path) in VS Code — a
   *  folder is opened as its own workspace, matching `code <folder>`'s
   *  normal CLI behavior. Spawns detached and returns immediately; never
   *  waits for VS Code to finish starting or exiting. */
  async open(targetPath: string): Promise<LaunchResult> {
    const executablePath = findCodeExecutable()
    if (!executablePath) {
      return {
        ok: false,
        error:
          'VS Code was not found. Install it, or run "Shell Command: Install \'code\' command in PATH" from VS Code\'s Command Palette.'
      }
    }
    try {
      // cross-spawn decides on its own whether executablePath needs the
      // cmd.exe wrapper (Windows .cmd shim) or can run directly (code.exe,
      // the POSIX `code` binary) — either way it quotes `targetPath`
      // correctly itself, so a path containing spaces or shell
      // metacharacters is passed through as one literal argument, never
      // parsed as shell syntax.
      const child = spawn(executablePath, [targetPath], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true
      })
      child.on('error', (err) => {
        // The caller already got an optimistic `ok: true` back (spawning
        // itself succeeded synchronously) — a failure surfacing this late
        // can only be logged, not still returned to that caller.
        console.error('[vscode-launcher] failed to launch VS Code:', err)
      })
      child.unref()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to launch VS Code.' }
    }
  }
}
