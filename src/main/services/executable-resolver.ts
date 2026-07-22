// Resolves a CLI executable to an absolute, verified-to-exist-and-work path
// using the same PATH/PATHEXT semantics Windows itself uses (matching what
// `where.exe`/`Get-Command` would report), instead of relying on a shell at
// detection time and a bare command name at spawn time.
//
// Root-cause history: this resolver used to return the FIRST path/extension
// combination that merely existed on disk. Two bugs in that made it possible
// to resolve a real user's Codex/Claude install to a broken candidate:
//
//  1. It checked the bare, extensionless name BEFORE any real Windows
//     extension (.EXE/.CMD/.BAT/.COM). Installing `@openai/codex-sdk` (a
//     dependency of this project) transitively installs `@openai/codex`,
//     which npm gives standard cross-platform bin shims in this project's
//     OWN `node_modules/.bin/`: `codex` (a POSIX `#!/bin/sh` shebang
//     script — not a valid Windows executable), `codex.cmd` (the real
//     Windows shim), and `codex.ps1`. Since `npm run dev`/electron-vite
//     prepend `node_modules/.bin` onto PATH for the dev process, and the
//     resolver checked the bare name first, it matched the POSIX shell
//     script and handed it straight to `spawn()`, which cannot execute it
//     on Windows — surfacing as `spawn ...\node_modules\.bin\codex ENOENT`.
//  2. It never validated a found path actually runs — a stale, corrupted,
//     or wrong-format file at the right name/extension would still "win".
//
// Fixed by: (a) never searching inside any node_modules tree — a
// standalone external CLI like Codex or Claude is never legitimately
// installed as this project's own dependency; (b) trying real Windows
// extensions before the bare name; (c) actually running each candidate
// (a real subprocess probe) and rejecting ones that don't work, moving on
// to the next candidate instead of trusting existsSync alone.
import { accessSync, constants as fsConstants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

export interface CandidateSearchResult {
  /** Every path that exists on disk, in priority order. For a configured
   *  custom path this is at most one entry; for PATH search it's every
   *  existing match across every PATH directory and extension. */
  candidates: string[]
  /** Every path/extension combination that was checked, in order — for
   *  diagnostics shown to the user on failure. */
  checked: string[]
  pathDirCount: number
}

export interface ValidationOutcome {
  ok: boolean
  /** Human-readable reason the candidate was rejected — surfaced in
   *  diagnostics. Only meaningful when ok is false. */
  reason?: string
  /** Raw stdout/stderr from the probe when it succeeded — lets the caller
   *  parse a version string without re-running a second probe. */
  output?: string
}

export type ValidateCandidate = (path: string) => Promise<ValidationOutcome>

export interface ResolveResult {
  resolvedPath: string | null
  checked: string[]
  pathDirCount: number
  /** Which strategy produced the winning candidate — logged for diagnostics
   *  so a resolution decision is never a mystery. 'known-location' is a
   *  known-install-location fallback (see knownWindowsInstallDirs) — PATH
   *  search found nothing, but a real standard install directory did. */
  strategy: 'custom-path' | 'path-search' | 'known-location' | 'not-found'
  /** Candidates that existed on disk but failed real validation — e.g. the
   *  POSIX shell shim case above. Empty when the winning candidate was the
   *  first one tried. */
  rejected: Array<{ path: string; reason: string }>
  /** The winning candidate's probe output, carried forward so callers never
   *  need a second redundant subprocess spawn just to read it back. */
  output?: string
}

function windowsExtensions(): string[] {
  const raw = process.env.PATHEXT
  // PATHEXT is always semicolon-delimited — that's a fixed property of the
  // Windows environment-variable format itself, not of whatever host OS
  // this process happens to be running on. Deliberately hardcoded (never
  // `path.delimiter`, which reflects the actual current platform): the two
  // coincide when this really is running on win32, but relying on that
  // coincidence would silently break PATHEXT parsing in any context where
  // they diverge (e.g. this exact function exercised under a platform
  // stub in a cross-platform test suite).
  const exts = (raw ? raw.split(';') : ['.COM', '.EXE', '.BAT', '.CMD']).map((e) => e.trim()).filter(Boolean)
  // Bare/extensionless goes LAST, not first. A real Windows executable
  // always carries one of these extensions; a bare match only ever exists
  // for Unix-style shebang scripts (e.g. npm's cross-platform bin shims),
  // which Windows cannot execute directly via CreateProcess. Only fall
  // back to it if nothing with a real extension matched anywhere on PATH.
  return [...exts, '']
}

/** Windows env var names are case-insensitive but Node's process.env keys
 *  are case-preserving — PATH can arrive as "PATH", "Path", or (seen in
 *  practice when different launchers each set their own casing) both at
 *  once with different contents. Merging every case-variant's directories
 *  into one deduplicated list means a real install is never missed just
 *  because a different key held the useful value. */
function pathEnvValue(): string {
  const seen = new Set<string>()
  const dirs: string[] = []
  for (const key of Object.keys(process.env)) {
    if (key.toLowerCase() !== 'path') continue
    const value = process.env[key]
    if (!value) continue
    for (const dir of value.split(delimiter)) {
      const trimmed = dir.trim()
      const lower = trimmed.toLowerCase()
      if (trimmed && !seen.has(lower)) {
        seen.add(lower)
        dirs.push(trimmed)
      }
    }
  }
  return dirs.join(delimiter)
}

/** A standalone CLI tool like Codex or Claude is never meant to be resolved
 *  from AgentDock's own dependency tree — see the module comment above for
 *  the exact real-world collision this prevents. */
function isInsideNodeModules(dir: string): boolean {
  const normalized = dir.replace(/\\/g, '/').toLowerCase()
  return normalized.includes('/node_modules/') || normalized.endsWith('/node_modules')
}

function pathDirs(): string[] {
  return pathEnvValue()
    .split(delimiter)
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((dir) => !isInsideNodeModules(dir))
}

function withExtension(candidate: string, ext: string): string {
  if (!ext) return candidate
  return candidate.toLowerCase().endsWith(ext.toLowerCase()) ? candidate : candidate + ext
}

/** Finds every existing candidate for a single name/path, in priority
 *  order (real extensions before bare). Pure and synchronous — no
 *  subprocess validation here, just existsSync. Deduplicates: when the
 *  candidate name already ends with a real extension (e.g. a custom path
 *  of "codex.exe"), appending the bare "" extension resolves to the exact
 *  same string as the .EXE attempt, which would otherwise double-count
 *  the same file as two separate candidates.
 *
 *  `dirs` is searched in the given order (PATH directories first, then any
 *  known-install-location fallbacks — see resolveExecutable's own doc
 *  comment) — trying every extension before moving to the next directory,
 *  so a real .exe two directories down still beats a bare shim in the
 *  first directory. */
function findOne(candidate: string, dirs: string[], checked: string[]): string[] {
  const isWindows = process.platform === 'win32'
  const extensions = isWindows ? windowsExtensions() : ['']
  const found: string[] = []
  const seen = new Set<string>()

  function tryPath(full: string): void {
    checked.push(full)
    const key = full.toLowerCase()
    if (seen.has(key)) return
    if (existsSync(full)) {
      found.push(full)
      seen.add(key)
    }
  }

  if (isAbsolute(candidate)) {
    for (const ext of extensions) {
      tryPath(withExtension(candidate, ext))
    }
    return found
  }

  for (const dir of dirs) {
    for (const ext of extensions) {
      tryPath(join(dir, withExtension(candidate, ext)))
    }
  }
  return found
}

/** Fixed, non-PATH-dependent directories real installers for these CLIs are
 *  known to use on Windows (confirmed live on a real machine: Claude under
 *  `%USERPROFILE%\.local\bin`, Codex under both
 *  `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` and npm's own global bin dir,
 *  Antigravity under `%LOCALAPPDATA%\agy\bin`) — tried ONLY as a last
 *  resort, after PATH search has already failed, for the real case an
 *  installer placed a CLI in its own standard location without ever adding
 *  that location to PATH. Deliberately generic (not agent-specific) here:
 *  the caller supplies whichever of these it wants considered via
 *  `extraSearchDirs`; this just centralizes the actual directory list so
 *  every call site stays consistent. */
export function knownWindowsInstallDirs(): string[] {
  if (process.platform !== 'win32') return []
  const home = process.env['USERPROFILE'] ?? ''
  const localAppData = process.env['LOCALAPPDATA'] ?? ''
  const appData = process.env['APPDATA'] ?? ''
  const dirs = [
    home && join(home, '.local', 'bin'),
    localAppData && join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'),
    localAppData && join(localAppData, 'agy', 'bin'),
    localAppData && join(localAppData, 'Programs', 'agy', 'bin'),
    appData && join(appData, 'npm')
  ]
  return dirs.filter((d): d is string => !!d)
}

/** Fixed, non-PATH-dependent directories real installers for these CLIs are
 *  known to use on macOS — tried ONLY as a last resort, after PATH search
 *  has already failed, exactly like knownWindowsInstallDirs above.
 *
 *  Both Homebrew prefixes (`/opt/homebrew` for Apple Silicon, `/usr/local`
 *  for Intel) are always included regardless of this process's own
 *  `process.arch` — a Homebrew install's prefix depends on which Homebrew
 *  was actually used to install it (e.g. an Intel Homebrew running under
 *  Rosetta on Apple Silicon hardware, or vice versa via arch-specific
 *  terminals), not on how AgentDock itself was built, so checking only the
 *  "expected" prefix for the current arch could miss a real install. This
 *  stays a fixed directory list (no `brew --prefix` subprocess call, no
 *  shell profile sourcing) so discovery is deterministic and side-effect
 *  free, matching the Windows fallback's own design. */
export function knownMacInstallDirs(): string[] {
  if (process.platform !== 'darwin') return []
  const home = homedir()
  const npmPrefix = process.env['npm_config_prefix']
  const dirs = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    home && join(home, '.local', 'bin'),
    home && join(home, '.npm-global', 'bin'),
    npmPrefix && join(npmPrefix, 'bin')
  ]
  return dirs.filter((d): d is string => !!d)
}

/** Dispatches to whichever known-install-location list applies to the
 *  current platform — the single call site every caller should use instead
 *  of picking a platform-specific function directly. Empty on any platform
 *  without a defined fallback list (e.g. Linux, for now). */
export function knownInstallDirs(): string[] {
  if (process.platform === 'win32') return knownWindowsInstallDirs()
  if (process.platform === 'darwin') return knownMacInstallDirs()
  return []
}

/** A macOS app launched via Finder/Dock/Spotlight inherits launchd's own
 *  minimal PATH (typically just `/usr/bin:/bin:/usr/sbin:/sbin`) — not the
 *  richer PATH a login shell builds from `/etc/paths.d`, Homebrew's
 *  shellenv, or the user's own shell rc file. That's the whole reason
 *  knownMacInstallDirs exists as a last-resort fallback inside
 *  resolveExecutable, but other code in this app spawns bare command names
 *  directly (e.g. git-service.ts spawning `git`) and relies entirely on the
 *  OS's own PATH search rather than going through resolveExecutable at all.
 *  Appending the same known directories onto this process's own
 *  `process.env.PATH` once at startup — never replacing it, never sourcing
 *  the user's shell profile — means every child process this app spawns
 *  for the rest of its life sees a PATH at least as complete as a
 *  Terminal-launched instance would, without the risk or cost of actually
 *  executing shell startup scripts. Call once, early, from the main
 *  process entry point. */
export function augmentPathForMacGuiLaunch(): void {
  if (process.platform !== 'darwin') return
  const existingLower = new Set(pathDirs().map((d) => d.toLowerCase()))
  const additions = knownMacInstallDirs().filter((d) => !existingLower.has(d.toLowerCase()))
  if (additions.length === 0) return
  const current = process.env.PATH ?? ''
  process.env.PATH = current ? `${current}${delimiter}${additions.join(delimiter)}` : additions.join(delimiter)
}

/** Whether a resolved candidate can actually be executed, permission-wise.
 *  Windows has no notion of an execute permission bit — executability there
 *  is determined entirely by extension (see windowsExtensions above), so
 *  this is always true on win32. On macOS/Linux, a file can exist with the
 *  right name and still be un-runnable (e.g. a zip download that lost its
 *  `+x` bit) — checking this before spawning a probe subprocess turns a
 *  generic spawn failure into a specific, actionable diagnostic. */
function hasExecutePermission(path: string): boolean {
  if (process.platform === 'win32') return true
  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export function findCandidates(
  candidateNames: string[],
  customPath: string | null,
  extraSearchDirs: string[] = []
): CandidateSearchResult {
  const checked: string[] = []
  const candidates: string[] = []
  const searchDirs = [...pathDirs(), ...extraSearchDirs]

  if (customPath) {
    candidates.push(...findOne(customPath, searchDirs, checked))
  } else {
    for (const name of candidateNames) {
      candidates.push(...findOne(name, searchDirs, checked))
    }
  }

  return { candidates, checked, pathDirCount: pathDirs().length }
}

/** Resolves a real, working executable: finds every candidate that exists
 *  on disk (see findCandidates), then actually validates each one in
 *  priority order (a real subprocess probe, injected via `validate` so
 *  this stays testable without spawning real processes) and returns the
 *  first one that genuinely works. A candidate that exists but fails
 *  validation is recorded in `rejected` and skipped — never returned.
 *
 *  Priority order end to end: (1) `customPath`, when given, is the only
 *  thing tried — a user-configured override always wins outright; (2) PATH
 *  directories, in PATH's own order; (3) `extraSearchDirs` (see
 *  knownWindowsInstallDirs), tried only once every PATH directory has
 *  already failed — a real install that never touched PATH still gets
 *  found, but never at the expense of a genuine PATH-resolved match. */
export async function resolveExecutable(
  candidateNames: string[],
  customPath: string | null,
  validate: ValidateCandidate,
  extraSearchDirs: string[] = []
): Promise<ResolveResult> {
  const { candidates, checked, pathDirCount } = findCandidates(candidateNames, customPath, extraSearchDirs)
  const rejected: Array<{ path: string; reason: string }> = []
  const pathDirSet = new Set(pathDirs().map((d) => d.toLowerCase()))

  for (const candidate of candidates) {
    if (!hasExecutePermission(candidate)) {
      rejected.push({ path: candidate, reason: 'found but missing execute permission (try: chmod +x)' })
      continue
    }
    const outcome = await validate(candidate)
    if (outcome.ok) {
      const strategy: ResolveResult['strategy'] = customPath
        ? 'custom-path'
        : pathDirSet.has(dirname(candidate).toLowerCase())
          ? 'path-search'
          : 'known-location'
      return { resolvedPath: candidate, checked, pathDirCount, strategy, rejected, output: outcome.output }
    }
    rejected.push({ path: candidate, reason: outcome.reason ?? 'failed to run' })
  }

  return { resolvedPath: null, checked, pathDirCount, strategy: 'not-found', rejected }
}

/** Builds the detailed diagnostic message the task requires on resolution failure. */
export function describeResolutionFailure(params: {
  agentId: string
  candidates: string[]
  customPath: string | null
  workspacePath: string
  result: ResolveResult
}): string {
  const { agentId, candidates, customPath, workspacePath, result } = params
  const lines = [
    `Could not locate a working executable for "${agentId}".`,
    `Candidates checked: ${candidates.join(', ') || '(none)'}`,
    `Configured custom path: ${customPath ?? '(none)'}`,
    `Workspace: ${workspacePath}`,
    `PATH directories searched: ${result.pathDirCount}`,
    ...(result.rejected.length > 0
      ? [
          `Found but failed to run (${result.rejected.length}):`,
          ...result.rejected.map((r) => `  - ${r.path}: ${r.reason}`)
        ]
      : []),
    `Full list of paths checked (${result.checked.length}):`,
    ...result.checked.map((p) => `  - ${p}`)
  ]
  return lines.join('\n')
}
