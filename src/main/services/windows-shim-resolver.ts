// Resolves what a Windows `.cmd`/`.bat` shim ultimately runs.
//
// Root-cause context: `.cmd`/`.bat` files are not valid Win32 executables —
// Windows' CreateProcess cannot launch one directly (unlike POSIX, where
// the kernel itself interprets a shebang line). A raw `child_process.spawn`
// pointed at one without a shell fails with an error Node surfaces as
// `spawn <path> EINVAL` (the translated form of Windows' own
// ERROR_BAD_EXE_FORMAT). This is exactly what happens when an npm-installed
// CLI (Claude Code, Codex, Antigravity's `agy`) resolves on PATH to its
// `.cmd` shim rather than a native `.exe` — a completely normal, common
// install shape that simply doesn't exist on a machine where the same CLI
// happens to be installed as a native binary instead, which is why this
// can work perfectly on one Windows machine and fail on another with an
// identical AgentDock build.
//
// Confirmed by reading the compiled source of both
// `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk`: each calls raw
// `child_process.spawn(executablePath, args, {...})` internally with no
// `shell` option and no `.cmd`/`.bat` awareness of its own. Claude's SDK
// exposes a `spawnClaudeCodeProcess` override (used with cross-spawn — see
// ClaudeAgentSdkTransport.ts) that sidesteps this entirely; Codex's SDK has
// no such override, so its `codexPathOverride` must never be handed a
// `.cmd`/`.bat` path in the first place — this module resolves it to the
// real target that shim ultimately invokes instead.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'

export interface ShimTarget {
  command: string
  args: string[]
}

/** True only for a file Windows cannot execute directly via CreateProcess
 *  — the two extensions that always require `cmd.exe` to interpret them. */
export function isWindowsShim(execPath: string): boolean {
  if (process.platform !== 'win32') return false
  const ext = extname(execPath).toLowerCase()
  return ext === '.cmd' || ext === '.bat'
}

/** Best-effort resolution of a `.cmd`/`.bat` shim's real target — handles
 *  the standard machine-generated shape (npm's own `cmd-shim` package,
 *  whose output format has been stable for years): a line ending in
 *  `"<real target>" %*`, the target either a JS entry point (run via a
 *  bundled or PATH `node`) or a platform-specific native binary referenced
 *  directly. Returns null (never throws) if the file can't be read or
 *  doesn't match a recognized shape — every caller must have a fallback
 *  for that case; this is deliberately not a general batch-file
 *  interpreter, only a recognizer for the common generated case. */
export function resolveShimTarget(shimPath: string): ShimTarget | null {
  let text: string
  try {
    text = readFileSync(shimPath, 'utf8')
  } catch {
    return null
  }

  const shimDir = dirname(shimPath)
  function resolveToken(token: string): string {
    return token.replace(/%~?dp0%?/gi, `${shimDir}\\`).replace(/\\{2,}/g, '\\')
  }

  // Every quoted path in the file, in order — the real invocation is
  // always the LAST one that ends in a recognizable extension; earlier
  // quoted strings only ever appear in %dp0%-detection boilerplate.
  const quoted = [...text.matchAll(/"([^"]+)"/g)].map((m) => resolveToken(m[1]))

  const lastJs = [...quoted].reverse().find((p) => /\.(m|c)?js$/i.test(p))
  if (lastJs && existsSync(lastJs)) {
    // A node.exe bundled next to the shim wins over a bare `node` resolved
    // from PATH later — matches the shim's own preference order.
    const bundledNode = join(shimDir, 'node.exe')
    return { command: existsSync(bundledNode) ? bundledNode : 'node', args: [lastJs] }
  }

  const lastExe = [...quoted].reverse().find((p) => /\.exe$/i.test(p))
  if (lastExe && existsSync(lastExe)) {
    return { command: lastExe, args: [] }
  }

  return null
}
