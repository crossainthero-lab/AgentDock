// Runs the "Install for me" flow for one agent CLI — resolves a real,
// verified `npm` executable the same way agent CLIs themselves are resolved
// (never a bare "npm" handed to a shell), spawns the install through a real
// PTY (so output streams live and a genuine Ctrl+C-style interrupt/kill is
// always available), and re-runs detection once it finishes so the caller
// never needs a second round trip to know whether the CLI is usable now.
//
// Deliberately narrow: this only ever runs the exact, fixed argv from
// cli-install-definitions.ts (a real official package manager invocation)
// against a resolved, verified package-manager executable — never an
// arbitrary shell string, never anything derived from user input.
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, shell } from 'electron'
import type { AgentId, CliInstallOutcome, CliInstallPlan, CliInstallProgressEvent } from '@shared/types'
import { getInstallDefinition } from './cli-install-definitions'
import { knownInstallDirs, resolveExecutable } from './executable-resolver'
import { probeExecutable } from './executable-probe'
import { ptyService, type ManagedProcess } from './pty-service'
import { detectionService } from './detection-service'
import { settingsService } from './settings-service'

// npm installs are normally seconds; this is a hard ceiling so a hung
// installer (dead network, a prompt the non-interactive install can never
// answer) can never freeze the setup UI indefinitely — see requirement
// "Use timeouts and cancellation controls. Never let detection or
// installation freeze AgentDock."
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TAIL_LENGTH = 4000

interface LiveInstall {
  proc: ManagedProcess
  timeoutHandle: ReturnType<typeof setTimeout>
  cancelled: boolean
  timedOut: boolean
}

const liveInstalls = new Map<string, LiveInstall>()

function logsDir(): string {
  const dir = join(app.getPath('userData'), 'cli-setup-logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // Best-effort — a log write failure must never break the install itself.
  }
  return dir
}

function logPath(agentId: AgentId, installId: string): string {
  return join(logsDir(), `${agentId}-${installId}.log`)
}

function appendLog(agentId: AgentId, installId: string, text: string): void {
  try {
    appendFileSync(logPath(agentId, installId), text.endsWith('\n') ? text : `${text}\n`)
  } catch {
    // Best-effort — never fatal to the install.
  }
}

/** Resolves a real, verified `npm` the same way agent CLIs are resolved
 *  (see executable-resolver.ts) — never assumes "npm" alone is directly
 *  spawnable, since on Windows it's an npm.cmd shim (ptyService already
 *  knows how to resolve that shim to its real target, see
 *  windows-shim-resolver.ts). */
async function resolveNpm(): Promise<{ path: string; error?: string }> {
  const resolution = await resolveExecutable(['npm'], null, (path) => probeExecutable(path, ['--version']), knownInstallDirs())
  if (!resolution.resolvedPath) {
    return {
      path: '',
      error:
        'Could not find a working "npm" on PATH. Install Node.js (which bundles npm) from https://nodejs.org, then use "Check again".'
    }
  }
  return { path: resolution.resolvedPath }
}

/** Turns raw npm output + exit code into a specific, actionable message
 *  instead of a bare "exited with code N" — covers the failure modes the
 *  CLI Setup Assistant is required to handle distinctly (no network,
 *  permission denied). Falls back to a generic message when nothing
 *  recognizable is found rather than guessing. */
function describeNpmFailure(output: string, exitCode: number | null): string {
  if (/EACCES|permission denied/i.test(output)) {
    return 'Permission denied writing to your npm global directory. See https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally for how to fix npm permissions, or run the command yourself in a terminal with the appropriate privileges.'
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|network/i.test(output)) {
    return 'Could not reach the npm registry. Check your internet connection and try again.'
  }
  return `npm install exited with code ${exitCode ?? 'unknown'}.`
}

export const cliInstallationService = {
  async buildPlan(agentId: AgentId): Promise<CliInstallPlan> {
    const def = getInstallDefinition(agentId)
    const base = {
      agentId,
      summary: def.summary,
      displayCommand: def.displayCommand,
      requiresAdmin: def.requiresAdmin,
      manualInstructions: def.manualInstructions,
      manualUrl: def.manualUrl
    }
    if (!def.supported) {
      return { ...base, supported: false, unsupportedReason: def.summary }
    }
    const npm = await resolveNpm()
    if (npm.error) {
      return { ...base, supported: false, unsupportedReason: npm.error }
    }
    return { ...base, supported: true, unsupportedReason: null }
  },

  /** Runs the install, streaming progress via `onProgress` (also persisted
   *  to a per-install log file under userData/cli-setup-logs — see
   *  logsDirectory()) and resolving once it finishes, fails, times out, or
   *  is cancelled via cancelInstall(installId). */
  async install(agentId: AgentId, installId: string, onProgress: (event: CliInstallProgressEvent) => void): Promise<CliInstallOutcome> {
    const def = getInstallDefinition(agentId)

    function emit(kind: CliInstallProgressEvent['kind'], text?: string): void {
      onProgress({ installId, agentId, kind, text, timestamp: new Date().toISOString() })
      if (text) appendLog(agentId, installId, text)
    }

    if (!def.supported) {
      const error = 'Automatic installation is not available for this CLI. Use the manual instructions instead.'
      emit('error', error)
      return { installId, agentId, ok: false, cancelled: false, timedOut: false, exitCode: null, error, detection: null }
    }

    const npm = await resolveNpm()
    if (npm.error) {
      emit('error', npm.error)
      return { installId, agentId, ok: false, cancelled: false, timedOut: false, exitCode: null, error: npm.error, detection: null }
    }

    emit('started', `Running: npm ${def.installArgs.join(' ')}`)

    return new Promise((resolve) => {
      let proc: ManagedProcess
      try {
        proc = ptyService.spawn(npm.path, def.installArgs, { cwd: app.getPath('home') })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        emit('error', error)
        resolve({ installId, agentId, ok: false, cancelled: false, timedOut: false, exitCode: null, error, detection: null })
        return
      }

      let tail = ''
      const state: LiveInstall = {
        proc,
        cancelled: false,
        timedOut: false,
        timeoutHandle: setTimeout(() => {
          state.timedOut = true
          proc.kill()
        }, INSTALL_TIMEOUT_MS)
      }
      liveInstalls.set(installId, state)

      proc.onData((chunk) => {
        tail = (tail + chunk).slice(-MAX_TAIL_LENGTH)
        emit('output', chunk)
      })

      proc.onExit((info) => {
        clearTimeout(state.timeoutHandle)
        liveInstalls.delete(installId)
        void (async () => {
          if (state.cancelled) {
            emit('cancelled')
            resolve({
              installId,
              agentId,
              ok: false,
              cancelled: true,
              timedOut: false,
              exitCode: info.exitCode,
              error: 'Installation was cancelled.',
              detection: null
            })
            return
          }
          if (state.timedOut) {
            const error = `Installation timed out after ${Math.round(INSTALL_TIMEOUT_MS / 60000)} minutes.`
            emit('timeout', error)
            resolve({ installId, agentId, ok: false, cancelled: false, timedOut: true, exitCode: info.exitCode, error, detection: null })
            return
          }

          const ok = info.exitCode === 0
          const customPath = settingsService.get().agents[agentId].customPath
          const detection = await detectionService.detect(agentId, customPath).catch(() => null)
          const error = ok ? null : describeNpmFailure(tail, info.exitCode)
          emit('exit', error ?? 'Installation finished successfully.')
          resolve({ installId, agentId, ok, cancelled: false, timedOut: false, exitCode: info.exitCode, error, detection })
        })()
      })
    })
  },

  /** Kills an in-progress install. A no-op if it already finished — never
   *  throws just because the caller's cancel arrived a moment too late. */
  cancelInstall(installId: string): void {
    const state = liveInstalls.get(installId)
    if (!state) return
    state.cancelled = true
    clearTimeout(state.timeoutHandle)
    state.proc.kill()
  },

  logsDirectory(): string {
    return logsDir()
  },

  /** Resolves the real, already-verified command the "Open terminal"
   *  manual-install fallback should pre-fill — the exact same npm
   *  executable + argv install() would spawn, so the terminal the user
   *  sees is never a guess. Null when automatic install isn't available for
   *  this agent, or npm itself couldn't be resolved. */
  async resolveCommandForTerminal(agentId: AgentId): Promise<{ executablePath: string; args: string[] } | null> {
    const def = getInstallDefinition(agentId)
    if (!def.supported) return null
    const npm = await resolveNpm()
    if (npm.error) return null
    return { executablePath: npm.path, args: def.installArgs }
  },

  async openLogsFolder(): Promise<{ ok: boolean; error?: string }> {
    const error = await shell.openPath(logsDir())
    return error ? { ok: false, error } : { ok: true }
  },

  generateInstallId(): string {
    return randomUUID()
  }
}
