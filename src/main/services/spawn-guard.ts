// Centralized pre-spawn validation — every process-launch call site in
// AgentDock (agent CLI launches, the model-catalog probe, PTY sessions, the
// VS Code launcher) runs its command/args/cwd/env through this before ever
// reaching child_process/cross-spawn/node-pty. The goal: a malformed value
// always produces a clear, specific AgentDock error message instead of a
// bare, undiagnosable `spawn ... EINVAL`/`ENOENT` bubbling straight up from
// Node/libuv.
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export class SpawnValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpawnValidationError'
  }
}

export interface SpawnPlan {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/** Strips one layer of matching leading/trailing quotes and trims
 *  whitespace — handles the extremely common real-world case of a path
 *  pasted from Windows Explorer's "Copy as path" (which always wraps the
 *  result in `"..."`) being saved verbatim as a custom executable override.
 *  Only ever removes a single matched pair, never touches interior quotes,
 *  and is a no-op for a value that isn't actually quoted. */
export function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).trim()
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).trim()
  return trimmed
}

/** Expands `%VAR%` (Windows) and `$VAR`/`${VAR}` (POSIX) references against
 *  the current process environment — lets a saved custom path like
 *  `%LOCALAPPDATA%\Programs\...\codex.exe` keep working across machines/
 *  user accounts instead of only ever matching whichever machine it was
 *  typed on. Unknown variables are left untouched (never silently deleted)
 *  so a typo is still visible in the resulting path rather than vanishing. */
export function expandEnvVars(value: string): string {
  return value
    .replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole)
    .replace(/\$\{([^}]+)\}/g, (whole, name: string) => process.env[name] ?? whole)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) => process.env[name] ?? whole)
}

export interface NormalizedOverrideResult {
  ok: boolean
  /** Present only when ok is true — trimmed, dequoted, env-expanded, and
   *  confirmed to exist as a file. */
  path?: string
  error?: string
}

/** The full requirement-3 pipeline for a user-configured executable
 *  override: trim -> strip accidental wrapping quotes -> expand env vars ->
 *  verify it exists -> verify it's a file (not a directory). Never trusts a
 *  value carried over from another machine's settings as though resolving
 *  it were optional — every override is re-verified on the machine it's
 *  actually used on. */
export function normalizeExecutableOverride(raw: string): NormalizedOverrideResult {
  const deQuoted = stripSurroundingQuotes(raw)
  if (deQuoted.length === 0) {
    return { ok: false, error: 'Custom path is empty.' }
  }
  const expanded = expandEnvVars(deQuoted)
  let stats
  try {
    stats = statSync(expanded)
  } catch {
    return { ok: false, error: `No file exists at "${expanded}".` }
  }
  if (!stats.isFile()) {
    return { ok: false, error: `"${expanded}" is a directory, not an executable file.` }
  }
  return { ok: true, path: expanded }
}

/** Throws a SpawnValidationError (never lets Node's own spawn/cross-spawn/
 *  node-pty see a value we already know is invalid) for:
 *   - an empty/non-string command, or one still wrapped in quotes
 *   - a NUL byte embedded in the command or any argument
 *   - a non-string, null, undefined, or object argument
 *   - a non-absolute or non-existent working directory
 *   - a non-string (and not merely absent) environment value
 *  `env` entries that are `undefined` are skipped rather than rejected —
 *  Node itself simply omits an `undefined`-valued env entry rather than
 *  erroring, so treating it as invalid here would reject perfectly normal
 *  `{ ...process.env, FOO: someOptional }` spreads. */
export function validateSpawnPlan(plan: SpawnPlan): void {
  if (typeof plan.command !== 'string' || plan.command.trim().length === 0) {
    throw new SpawnValidationError('No executable path was provided.')
  }
  if (plan.command.includes('\0')) {
    throw new SpawnValidationError('Executable path contains an invalid embedded null character.')
  }
  const trimmedCommand = plan.command.trim()
  if ((trimmedCommand.startsWith('"') && trimmedCommand.endsWith('"')) || (trimmedCommand.startsWith("'") && trimmedCommand.endsWith("'"))) {
    throw new SpawnValidationError(`Executable path is still wrapped in quotes, which cannot be spawned directly: ${plan.command}`)
  }

  if (!Array.isArray(plan.args)) {
    throw new SpawnValidationError('Argument list is missing or not an array.')
  }
  plan.args.forEach((arg, i) => {
    if (arg === null || arg === undefined) {
      throw new SpawnValidationError(`Argument ${i} is ${arg === null ? 'null' : 'undefined'} — every argument must be a string.`)
    }
    if (typeof arg !== 'string') {
      throw new SpawnValidationError(`Argument ${i} is a ${typeof arg}, not a string — every argument must be a string.`)
    }
    if (arg.includes('\0')) {
      throw new SpawnValidationError(`Argument ${i} contains an invalid embedded null character.`)
    }
  })

  if (plan.cwd !== undefined) {
    if (typeof plan.cwd !== 'string' || plan.cwd.length === 0) {
      throw new SpawnValidationError('Working directory is empty or invalid.')
    }
    if (!isAbsolute(plan.cwd)) {
      throw new SpawnValidationError(`Working directory must be an absolute path: ${plan.cwd}`)
    }
    let stats
    try {
      stats = statSync(plan.cwd)
    } catch {
      throw new SpawnValidationError(`Working directory does not exist: ${plan.cwd}`)
    }
    if (!stats.isDirectory()) {
      throw new SpawnValidationError(`Working directory is not a directory: ${plan.cwd}`)
    }
  }

  if (plan.env) {
    for (const [key, value] of Object.entries(plan.env)) {
      if (value === undefined) continue
      if (typeof value !== 'string') {
        throw new SpawnValidationError(`Environment variable "${key}" is a ${typeof value}, not a string.`)
      }
    }
  }

  // Only meaningful for an absolute path — a bare command name (e.g.
  // "git") is legitimately resolved from PATH by the OS/spawn mechanism
  // itself, so there's nothing to check on disk for it here.
  if (isAbsolute(plan.command) && !existsSync(plan.command)) {
    throw new SpawnValidationError(`Executable does not exist: ${plan.command}`)
  }
}
