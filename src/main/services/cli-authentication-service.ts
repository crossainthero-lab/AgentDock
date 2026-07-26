// Best-effort, side-effect-free authentication signal for the CLI Setup
// Assistant, plus the "Sign in" action itself.
//
// Deliberately conservative on detection: this only ever checks whether a
// credential FILE EXISTS on disk (never reads or parses its contents, never
// touches an OS keychain/credential manager) and returns 'unknown' — not a
// guessed 'required' or 'authenticated' — wherever no reliable, documented
// signal exists cross-platform. Guessing wrong in either direction would be
// worse than admitting AgentDock can't tell: a false "signed in" hides a
// real problem, and a false "sign-in required" is a nagging false alarm.
//
// "Sign in" itself never implements a login flow of its own — it starts the
// CLI's own bare interactive process in a dedicated PTY, which is exactly
// what makes each of these CLIs run their own native onboarding/auth flow
// when they aren't already authenticated. AgentDock never reads, stores, or
// inspects anything the user types into that PTY (the same trust boundary
// pty-service.ts already applies to every other PTY in this app).
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentAuthState, AgentId, CliSignInResult } from '@shared/types'
import { ptyService, type ManagedProcess } from './pty-service'

interface LiveSignInPty {
  proc: ManagedProcess
}

const livePtys = new Map<string, LiveSignInPty>()

/** Same env-var-first convention executable-resolver.ts's
 *  knownWindowsInstallDirs/knownMacInstallDirs already use instead of
 *  node:os's homedir() directly: on Windows, `os.homedir()` resolves via a
 *  native OS call (uv_os_homedir) that ignores USERPROFILE entirely on
 *  modern Node, so it can't be redirected for tests the way every other
 *  platform-path helper in this codebase already is. Falls back to the real
 *  homedir() so production behavior is unchanged. */
function homeDirectory(): string {
  const envHome = process.platform === 'win32' ? process.env['USERPROFILE'] : process.env['HOME']
  return envHome || homedir()
}

export const cliAuthenticationService = {
  async checkAuthState(agentId: AgentId): Promise<AgentAuthState> {
    if (agentId === 'codex') {
      // Codex's own documented default credential-file location (honors
      // CODEX_HOME the same way the real CLI does) — the one agent of the
      // three with a location AgentDock can check reliably and portably.
      const codexHome = process.env['CODEX_HOME'] || join(homeDirectory(), '.codex')
      return existsSync(join(codexHome, 'auth.json')) ? 'authenticated' : 'required'
    }
    if (agentId === 'claude-code') {
      // Claude Code authenticates via OAuth (credentials stored in the OS
      // keychain on macOS, or a local file elsewhere whose exact path/
      // format isn't stable enough to assert against confidently here) or
      // a plain ANTHROPIC_API_KEY environment variable — checking for the
      // env var is the one signal AgentDock can read safely and portably
      // without opening a keychain or guessing an on-disk format.
      return process.env['ANTHROPIC_API_KEY'] ? 'authenticated' : 'unknown'
    }
    // Antigravity: no independently confirmed, documented credential-file
    // location — 'unknown' is the honest answer rather than a guess.
    return 'unknown'
  },

  /** Starts `executablePath` bare (no args) in a dedicated PTY so the CLI's
   *  own native sign-in/onboarding flow runs for real. Returns a ptyId the
   *  renderer attaches a terminal view to via the cliSetup pty IPC
   *  channels — never a place AgentDock itself collects credentials. */
  signIn(agentId: AgentId, executablePath: string): CliSignInResult {
    try {
      const proc = ptyService.spawn(executablePath, [], { cwd: homeDirectory() })
      const ptyId = randomUUID()
      livePtys.set(ptyId, { proc })
      proc.onExit(() => livePtys.delete(ptyId))
      return { ok: true, ptyId, executablePath, error: null }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.error(`[cli-auth] sign-in spawn failed for ${agentId}:`, error)
      return { ok: false, ptyId: null, executablePath, error }
    }
  },

  getPty(ptyId: string): ManagedProcess | undefined {
    return livePtys.get(ptyId)?.proc
  },

  killPty(ptyId: string): void {
    livePtys.get(ptyId)?.proc.kill()
    livePtys.delete(ptyId)
  }
}
