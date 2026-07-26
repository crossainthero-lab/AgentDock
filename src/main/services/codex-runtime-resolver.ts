// Codex-specific executable resolution — the fix for the Windows launch bug
// where AgentDock resolved the global `codex` command to an npm `codex.cmd`
// shim and handed it to @openai/codex-sdk as `codexPathOverride`. The SDK
// calls raw `child_process.spawn(executablePath, ...)` with no shell and no
// `.cmd`/`.bat` awareness of its own (see windows-shim-resolver.ts's module
// comment) — a shim can never be launched that way.
//
// The fix is not "resolve the shim to something spawnable" (that's the old,
// narrower workaround still kept as a last-resort fallback inside
// CodexAgentSdkTransport.ts) but to stop relying on a global `codex` PATH
// install at all by default. `@openai/codex-sdk` already transitively
// depends on a platform-specific native-binary package (confirmed by
// reading its compiled dist/index.js — `findCodexPath()`/
// `PLATFORM_PACKAGE_BY_TARGET` below is a faithful mirror of that exact
// logic) and resolves it automatically whenever `codexPathOverride` is left
// unset. AgentDock ships that dependency as part of its own node_modules —
// a working native codex.exe is always available, with no global npm
// install required at all (see resolveSdkBundledExecutablePath).
//
// Final priority, in order:
//   1. A user-configured custom path — but only if it's a genuine native
//      executable (see validateCodexCustomPath's Windows-specific rules).
//   2. The Codex SDK's own bundled native runtime — resolved here (not by
//      the SDK's own internal findCodexPath(), and verified with a real
//      --version probe the SDK itself never runs). CodexAgentSdkTransport.ts
//      passes this back to the SDK as `codexPathOverride` just like every
//      other tier — an earlier version of this fix instead left
//      `codexPathOverride` unset for this tier, constructing `new
//      Codex({})` so the SDK would resolve its own bundled runtime
//      internally. That was verified against a REAL packaged build and
//      found to be broken: the SDK's own `findCodexPath()` does the exact
//      same require.resolve()-based vendor lookup this file mirrors, and
//      inside a packaged Electron app that lookup returns a path that
//      LOOKS like it exists (Electron's patched fs.existsSync/statSync
//      transparently redirect reads of an asar-unpacked file) but cannot
//      actually be spawned directly — raw child_process.spawn bypasses
//      Electron's patched fs layer entirely and needs the real
//      app.asar.unpacked path (see resolveSdkBundledExecutablePath's own
//      `toRealUnpackedPath` fix for that conversion, which the SDK's own
//      internal resolution has no equivalent of). Always overriding with
//      our own already-corrected path is what actually makes a packaged
//      session launch.
//   3. An official standalone Codex install (the three well-known Windows
//      locations) — tried only if the bundled runtime genuinely can't be
//      found or doesn't respond to --version.
//   4. A clear, actionable error — never a silent fallback to a shim.
import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join } from 'node:path'
import { probeExecutable, type ProbeOutcome } from './executable-probe'
import { expandEnvVars, stripSurroundingQuotes } from './spawn-guard'

export type CodexResolutionSource = 'custom' | 'sdk-bundled' | 'standalone'

export interface CodexRuntimeResolution {
  source: CodexResolutionSource | 'none'
  /** The real native executable path this resolution is based on — set for
   *  every source except 'none'. For 'sdk-bundled' this is reported for
   *  diagnostics/display only; it is never handed to the SDK as an
   *  override (see module comment). */
  nativeExecutablePath: string | null
  executableExists: boolean
  versionProbe: ProbeOutcome | null
  /** Every `.cmd`/`.bat`/`.ps1`/`.js`/`.mjs` path discovered (and rejected)
   *  during resolution — surfaced in diagnostics so a Windows shim showing
   *  up here never again silently blocks a session the way it used to. */
  rejectedShimPaths: string[]
  error: string | null
}

/** Extensions that can never be launched directly via a native spawn API —
 *  matches requirement 2/3's exact list. `.exe` (and, on POSIX, an
 *  extensionless binary) are the only acceptable native executables. */
const SHIM_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1', '.js', '.mjs'])

export function isShimPath(path: string): boolean {
  return SHIM_EXTENSIONS.has(extname(path).toLowerCase())
}

/** A real, spawnable file can never legitimately live inside AgentDock's own
 *  packaged `app.asar` archive — Windows/macOS/Linux process-creation APIs
 *  all require a real file on disk, and an archive member is not one (an
 *  `app.asar.unpacked` sibling directory IS a real file on disk despite the
 *  name, so it's deliberately excluded). */
export function isInsideAsarArchive(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  if (normalized.includes('.asar.unpacked/') || normalized.endsWith('.asar.unpacked')) return false
  return /\.asar($|\/)/i.test(normalized)
}

/** Mirrors `@openai/codex-sdk`'s own internal target-triple switch
 *  (confirmed by reading its compiled dist/index.js) — every branch here
 *  corresponds 1:1 to the SDK's `findCodexPath()`. */
function targetTripleFor(platform: NodeJS.Platform, arch: string): string | null {
  switch (platform) {
    case 'linux':
      switch (arch) {
        case 'x64':
          return 'x86_64-unknown-linux-musl'
        case 'arm64':
          return 'aarch64-unknown-linux-musl'
        default:
          return null
      }
    case 'darwin':
      switch (arch) {
        case 'x64':
          return 'x86_64-apple-darwin'
        case 'arm64':
          return 'aarch64-apple-darwin'
        default:
          return null
      }
    case 'win32':
      switch (arch) {
        case 'x64':
          return 'x86_64-pc-windows-msvc'
        case 'arm64':
          return 'aarch64-pc-windows-msvc'
        default:
          return null
      }
    default:
      return null
  }
}

/** Verbatim copy of the SDK's own `PLATFORM_PACKAGE_BY_TARGET` table — the
 *  real, installed optional-dependency package names `@openai/codex`
 *  declares (confirmed against this repo's installed
 *  node_modules/@openai/codex/package.json). Never invented: every one of
 *  these packages is a real npm package the Codex SDK itself depends on. */
const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64'
}

/** Real package resolution (require.resolve, not a hand-guessed path) for
 *  the platform-native vendor directory `@openai/codex`'s optional
 *  dependency ships — the exact same mechanism the SDK's own
 *  `findCodexPath()` uses, so this automatically follows however
 *  npm/electron-builder actually laid the package out (hoisted at the top
 *  of node_modules or nested under `@openai/codex`'s own node_modules —
 *  confirmed both shapes exist between a plain `npm install` and an
 *  electron-builder-packaged app.asar) rather than assuming one fixed
 *  layout. Injectable so tests can simulate "package not installed" or
 *  "installed under a fake vendor root" without touching real node_modules
 *  or requiring this exact package to be present. */
export function defaultResolveCodexVendorRoot(platformPackage: string): string | null {
  try {
    const codexPackageJsonPath = require.resolve('@openai/codex/package.json')
    const codexRequire = createRequire(codexPackageJsonPath)
    const platformPackageJsonPath = codexRequire.resolve(`${platformPackage}/package.json`)
    return join(dirname(platformPackageJsonPath), 'vendor')
  } catch {
    return null
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Mirrors the SDK's own `resolveNativePackage()` — checks the current
 *  vendor layout (`vendor/<triple>/bin/codex.exe` + a `codex-package.json`
 *  marker) first, falling back to the legacy shape
 *  (`vendor/<triple>/codex/codex.exe`) it also still supports. */
function resolveNativeBinaryInVendorRoot(vendorRoot: string, targetTriple: string, binaryName: string): string | null {
  const packageRoot = join(vendorRoot, targetTriple)
  const packageBinaryPath = join(packageRoot, 'bin', binaryName)
  if (isFile(packageBinaryPath) && isFile(join(packageRoot, 'codex-package.json'))) return packageBinaryPath

  const legacyBinaryPath = join(packageRoot, 'codex', binaryName)
  if (isFile(legacyBinaryPath)) return legacyBinaryPath

  return null
}

/** Resolves the exact native executable path `@openai/codex-sdk` will
 *  self-resolve to when constructed with no `codexPathOverride` — for
 *  reporting/verification only (see module comment for why this is never
 *  passed back to the SDK as an override). Returns null (never throws) on
 *  an unsupported platform/arch or when the platform package isn't
 *  installed (e.g. optionalDependencies were skipped). */
export function resolveSdkBundledExecutablePath(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  resolveVendorRoot: (platformPackage: string) => string | null = defaultResolveCodexVendorRoot
): string | null {
  const targetTriple = targetTripleFor(platform, arch)
  if (!targetTriple) return null
  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple]
  if (!platformPackage) return null

  const vendorRoot = resolveVendorRoot(platformPackage)
  if (!vendorRoot) return null

  const binaryName = platform === 'win32' ? 'codex.exe' : 'codex'
  const resolved = resolveNativeBinaryInVendorRoot(vendorRoot, targetTriple, binaryName)
  return resolved ? toRealUnpackedPath(resolved) : null
}

/** Electron's asar packaging convention: a file matched by electron-
 *  builder's `asarUnpack` (see the codex vendor glob in electron-
 *  builder.yml) is copied byte-for-byte into a sibling `app.asar.unpacked`
 *  directory at the exact same relative path — but `require.resolve()`
 *  (patched by Electron so plain `require()` transparently works either
 *  way, and so do `fs.existsSync`/`fs.statSync`, which is why the checks
 *  above all "succeed" regardless) still reports the path as if it were
 *  inside `app.asar` itself: a logical path Electron's own patched fs/
 *  require layer understands, but that a real OS process-creation call
 *  (child_process.spawn / CreateProcess) cannot use directly, since
 *  nothing actually exists there on disk — the real bytes live in
 *  app.asar.unpacked. Swapping the `app.asar` path segment for
 *  `app.asar.unpacked` is the standard, documented Electron idiom for
 *  getting the real, directly-spawnable path to an unpacked file
 *  (confirmed live: without this, resolveSdkBundledExecutablePath
 *  returned a path `existsSync` reported as present that nonetheless could
 *  never actually be spawned — exactly the "trapped inside app.asar" bug
 *  requirement 5 describes). A no-op for a path that was never inside
 *  app.asar to begin with (the normal case in development, or a path
 *  that's already inside app.asar.unpacked). */
function toRealUnpackedPath(resolvedPath: string): string {
  if (!/\.asar[\\/]/i.test(resolvedPath) || /\.asar\.unpacked[\\/]/i.test(resolvedPath)) return resolvedPath
  return resolvedPath.replace(/\.asar([\\/])/i, '.asar.unpacked$1')
}

/** The three official standalone Windows install locations, in priority
 *  order, with environment variables expanded against the current process
 *  environment (or an injected one, for tests). Empty on any non-Windows
 *  platform — these are Windows-specific install paths only. */
export function standaloneCodexCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return []
  return [
    '%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin\\codex.exe',
    '%USERPROFILE%\\.codex\\packages\\standalone\\current\\bin\\codex.exe',
    '%USERPROFILE%\\.codex\\packages\\standalone\\current\\codex.exe'
  ].map((template) => expandEnvVars(template))
}

export interface CodexCustomPathValidation {
  ok: boolean
  path?: string
  output?: string
  error?: string
}

/** The full requirement-2 validation pipeline for a user-configured Codex
 *  executable override: trim -> strip accidental wrapping quotes -> expand
 *  env vars -> verify it exists as a real file -> (Windows only) reject any
 *  `.cmd`/`.bat`/`.ps1`/`.js`/`.mjs` shim and require a real `.exe` ->
 *  reject a path trapped inside AgentDock's own app.asar -> verify it
 *  actually responds to `--version`. Every failure returns a specific,
 *  human-readable reason meant to be shown directly in Settings — never a
 *  bare stack trace or a generic "invalid path". */
export async function validateCodexCustomPath(
  raw: string,
  platform: NodeJS.Platform = process.platform,
  probe: (path: string, args: string[]) => Promise<ProbeOutcome> = probeExecutable
): Promise<CodexCustomPathValidation> {
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

  if (platform === 'win32') {
    const ext = extname(expanded).toLowerCase()
    if (SHIM_EXTENSIONS.has(ext)) {
      return {
        ok: false,
        error: `"${expanded}" is a ${ext} script, not a native Windows executable. Codex requires a real codex.exe — AgentDock cannot launch a .cmd/.bat/.ps1/.js/.mjs shim directly. Point this at the real codex.exe (for example under %LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin), or clear the custom path to let AgentDock use its own bundled Codex runtime instead.`
      }
    }
    if (ext !== '.exe') {
      return { ok: false, error: `"${expanded}" must be a native .exe file on Windows (found "${ext || 'no extension'}").` }
    }
  }

  if (isInsideAsarArchive(expanded)) {
    return {
      ok: false,
      error: `"${expanded}" is inside AgentDock's own packaged app.asar archive and cannot be launched directly. Choose a real, standalone Codex executable on disk instead.`
    }
  }

  const outcome = await probe(expanded, ['--version'])
  if (!outcome.ok) {
    return { ok: false, error: `"${expanded}" exists but did not respond to --version: ${outcome.reason ?? 'unknown error'}.` }
  }

  return { ok: true, path: expanded, output: outcome.output }
}

export interface CodexRuntimeResolverDeps {
  platform: NodeJS.Platform
  resolveBundled: () => string | null
  standaloneCandidates: () => string[]
  probe: (path: string, args: string[]) => Promise<ProbeOutcome>
}

/** The single entry point implementing the exact 4-tier priority the
 *  Windows launch bug requires. `customPath` is exactly what's saved in
 *  Settings → Agents → Codex (`agents.codex.customPath`), already validated
 *  at save time by validateCodexCustomPath — but re-validated here too
 *  (settings can be copied from another machine, or a file can be deleted
 *  after being configured), so a stale/broken saved path is never silently
 *  trusted. */
export async function resolveCodexRuntime(
  customPath: string | null,
  deps: Partial<CodexRuntimeResolverDeps> = {}
): Promise<CodexRuntimeResolution> {
  const platform = deps.platform ?? process.platform
  const resolveBundled = deps.resolveBundled ?? (() => resolveSdkBundledExecutablePath(platform))
  const standaloneCandidates = deps.standaloneCandidates ?? (() => standaloneCodexCandidates(platform))
  const probe = deps.probe ?? probeExecutable

  const rejectedShimPaths: string[] = []

  // Tier 1: an explicit, user-configured custom path always wins outright
  // — but only if it's genuinely valid. An explicitly-configured path that
  // fails validation is never silently ignored in favor of auto-detection
  // (that would hide a real misconfiguration); it's reported as the reason
  // resolution failed.
  if (customPath) {
    const result = await validateCodexCustomPath(customPath, platform, probe)
    if (isShimPath(customPath)) rejectedShimPaths.push(customPath)
    if (result.ok && result.path) {
      return {
        source: 'custom',
        nativeExecutablePath: result.path,
        executableExists: true,
        versionProbe: { ok: true, output: result.output },
        rejectedShimPaths,
        error: null
      }
    }
    return {
      source: 'none',
      nativeExecutablePath: null,
      executableExists: false,
      versionProbe: null,
      rejectedShimPaths,
      error: result.error ?? 'Invalid custom Codex path.'
    }
  }

  // Tier 2: the Codex SDK's own bundled native runtime — no PATH search,
  // no global `codex` command resolved at all (see module comment).
  const bundled = resolveBundled()
  if (bundled) {
    if (isShimPath(bundled)) {
      rejectedShimPaths.push(bundled)
    } else if (existsSync(bundled) && !isInsideAsarArchive(bundled)) {
      // The asar check is defense-in-depth: resolveSdkBundledExecutablePath
      // already converts an in-archive path to its real
      // app.asar.unpacked equivalent (see toRealUnpackedPath's doc
      // comment) before ever returning it, so this should never actually
      // trigger in a correctly packaged build — but a bundled path
      // somehow still trapped inside app.asar is just as unlaunchable as
      // a missing one, so falling through to the standalone fallback here
      // is strictly safer than accepting a path that would fail the
      // moment a session actually tried to spawn it.
      const versionProbe = await probe(bundled, ['--version'])
      if (versionProbe.ok) {
        return { source: 'sdk-bundled', nativeExecutablePath: bundled, executableExists: true, versionProbe, rejectedShimPaths, error: null }
      }
    }
  }

  // Tier 3: an official standalone Codex install — only reached if the
  // bundled runtime genuinely couldn't be found or didn't respond.
  for (const candidate of standaloneCandidates()) {
    if (isShimPath(candidate)) {
      rejectedShimPaths.push(candidate)
      continue
    }
    if (!existsSync(candidate) || !isFile(candidate)) continue
    if (extname(candidate).toLowerCase() !== '.exe') {
      rejectedShimPaths.push(candidate)
      continue
    }
    const versionProbe = await probe(candidate, ['--version'])
    if (versionProbe.ok) {
      return { source: 'standalone', nativeExecutablePath: candidate, executableExists: true, versionProbe, rejectedShimPaths, error: null }
    }
  }

  // Tier 4: a clear, actionable error — never a silent fallback to
  // whatever `.cmd`/`.bat` shim happened to be on PATH.
  return {
    source: 'none',
    nativeExecutablePath: null,
    executableExists: false,
    versionProbe: null,
    rejectedShimPaths,
    error:
      "Could not locate a working Codex executable. AgentDock's bundled Codex runtime was not found or did not respond, and no standalone Codex installation was found. Reinstall AgentDock, or install Codex from https://github.com/openai/codex and set its executable as a custom path in Settings → Agents."
  }
}
