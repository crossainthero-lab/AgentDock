import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  isInsideAsarArchive,
  isShimPath,
  resolveCodexRuntime,
  resolveSdkBundledExecutablePath,
  standaloneCodexCandidates,
  validateCodexCustomPath,
  type CodexRuntimeResolverDeps
} from '../../src/main/services/codex-runtime-resolver'
import type { ProbeOutcome } from '../../src/main/services/executable-probe'

/** Same convention as executable-resolver.test.ts: stub process.platform
 *  for the duration of a test so Windows-only logic (extension rules,
 *  standalone fallback paths) is exercised regardless of which OS actually
 *  runs the suite, and non-Windows behavior (requirement 15) is verified
 *  the same way. */
function stubPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}
const realPlatform = process.platform

/** Accepts a probe for any path with the given ok/output/reason — lets a
 *  test simulate "this executable responds to --version" (or doesn't)
 *  without spawning a real process, same spirit as executable-resolver's
 *  acceptAll/rejecting helpers. */
function fakeProbe(outcome: ProbeOutcome | ((path: string) => ProbeOutcome)): (path: string, args: string[]) => Promise<ProbeOutcome> {
  return async (path) => (typeof outcome === 'function' ? outcome(path) : outcome)
}

const OK_PROBE: ProbeOutcome = { ok: true, output: 'codex-cli 0.144.5' }
const FAIL_PROBE: ProbeOutcome = { ok: false, reason: 'not a valid Windows executable' }

describe('codex-runtime-resolver', () => {
  let dir: string
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdock-codex-resolver-test-'))
    originalEnv = { ...process.env }
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
    stubPlatform(realPlatform)
  })

  describe('isShimPath', () => {
    it.each(['.cmd', '.bat', '.ps1', '.js', '.mjs'])('treats a %s file as a shim', (ext) => {
      expect(isShimPath(`C:\\somewhere\\codex${ext}`)).toBe(true)
    })
    it('does not treat a native .exe as a shim', () => {
      expect(isShimPath('C:\\somewhere\\codex.exe')).toBe(false)
    })
  })

  describe('isInsideAsarArchive', () => {
    it('is true for a path inside a real app.asar archive', () => {
      expect(isInsideAsarArchive('C:\\Program Files\\AgentDock\\resources\\app.asar\\node_modules\\codex.exe')).toBe(true)
    })
    it('is true for the app.asar file itself', () => {
      expect(isInsideAsarArchive('C:\\Program Files\\AgentDock\\resources\\app.asar')).toBe(true)
    })
    it('is false for a path inside the unpacked sibling directory (a real file on disk despite the name)', () => {
      expect(isInsideAsarArchive('C:\\Program Files\\AgentDock\\resources\\app.asar.unpacked\\node_modules\\codex.exe')).toBe(false)
    })
    it('is false for an ordinary path with no asar segment at all', () => {
      expect(isInsideAsarArchive('C:\\Program Files\\OpenAI\\Codex\\bin\\codex.exe')).toBe(false)
    })
  })

  // --- Requirement 3: standalone fallback discovery -------------------
  describe('standaloneCodexCandidates', () => {
    it('is empty on macOS and Linux — the three official standalone locations are Windows-only', () => {
      expect(standaloneCodexCandidates('darwin')).toEqual([])
      expect(standaloneCodexCandidates('linux')).toEqual([])
    })

    it('expands %LOCALAPPDATA%/%USERPROFILE% against the current environment, in the documented priority order', () => {
      process.env.LOCALAPPDATA = join(dir, 'local-app-data')
      process.env.USERPROFILE = join(dir, 'user-profile')

      const candidates = standaloneCodexCandidates('win32')
      expect(candidates).toEqual([
        join(dir, 'local-app-data', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
        join(dir, 'user-profile', '.codex', 'packages', 'standalone', 'current', 'bin', 'codex.exe'),
        join(dir, 'user-profile', '.codex', 'packages', 'standalone', 'current', 'codex.exe')
      ])
    })
  })

  // --- Requirement 2: custom-path validation ---------------------------
  describe('validateCodexCustomPath', () => {
    it('accepts a valid, existing native .exe that responds to --version', async () => {
      const exePath = join(dir, 'codex.exe')
      writeFileSync(exePath, '')

      const result = await validateCodexCustomPath(exePath, 'win32', fakeProbe(OK_PROBE))
      expect(result).toEqual({ ok: true, path: exePath, output: OK_PROBE.output })
    })

    it('accepts an uppercase .EXE extension — the check is case-insensitive', async () => {
      const exePath = join(dir, 'CODEX.EXE')
      writeFileSync(exePath, '')

      const result = await validateCodexCustomPath(exePath, 'win32', fakeProbe(OK_PROBE))
      expect(result.ok).toBe(true)
    })

    it.each(['.cmd', '.bat', '.ps1', '.js', '.mjs'])(
      'rejects a %s shim with a clear, actionable Settings message — never silently accepted',
      async (ext) => {
        const shimPath = join(dir, `codex${ext}`)
        writeFileSync(shimPath, '')

        const result = await validateCodexCustomPath(shimPath, 'win32', fakeProbe(OK_PROBE))
        expect(result.ok).toBe(false)
        expect(result.error).toMatch(new RegExp(`\\${ext}`))
        expect(result.error).toMatch(/native/i)
      }
    )

    it('handles a custom path containing spaces correctly', async () => {
      const spacedDir = join(dir, 'Program Files (x86)', 'OpenAI Codex')
      mkdirSync(spacedDir, { recursive: true })
      const exePath = join(spacedDir, 'codex.exe')
      writeFileSync(exePath, '')

      const result = await validateCodexCustomPath(exePath, 'win32', fakeProbe(OK_PROBE))
      expect(result).toEqual({ ok: true, path: exePath, output: OK_PROBE.output })
    })

    it('rejects a path that does not exist on disk', async () => {
      const missing = join(dir, 'nope.exe')
      const result = await validateCodexCustomPath(missing, 'win32', fakeProbe(OK_PROBE))
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/no file exists/i)
    })

    it('rejects a path that exists but fails the --version probe', async () => {
      const exePath = join(dir, 'codex.exe')
      writeFileSync(exePath, '')

      const result = await validateCodexCustomPath(exePath, 'win32', fakeProbe(FAIL_PROBE))
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/did not respond to --version/i)
      expect(result.error).toMatch(/not a valid Windows executable/)
    })

    it('rejects a directory, not just a missing path', async () => {
      const result = await validateCodexCustomPath(dir, 'win32', fakeProbe(OK_PROBE))
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/directory/i)
    })

    it('rejects a real .exe that is trapped inside an app.asar archive', async () => {
      const asarDir = join(dir, 'resources', 'app.asar', 'node_modules', 'vendor')
      mkdirSync(asarDir, { recursive: true })
      const exePath = join(asarDir, 'codex.exe')
      writeFileSync(exePath, '')

      const result = await validateCodexCustomPath(exePath, 'win32', fakeProbe(OK_PROBE))
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/app\.asar/i)
    })

    it('expands environment variables in the raw path before validating', async () => {
      const exePath = join(dir, 'codex.exe')
      writeFileSync(exePath, '')
      process.env.AGENTDOCK_TEST_CODEX_DIR = dir

      const result = await validateCodexCustomPath('%AGENTDOCK_TEST_CODEX_DIR%\\codex.exe', 'win32', fakeProbe(OK_PROBE))
      expect(result).toEqual({ ok: true, path: exePath, output: OK_PROBE.output })
    })

    it('does not apply the .exe-only rule on macOS/Linux — a real, working extensionless binary is accepted', async () => {
      const binPath = join(dir, 'codex')
      writeFileSync(binPath, '')

      const result = await validateCodexCustomPath(binPath, 'darwin', fakeProbe(OK_PROBE))
      expect(result.ok).toBe(true)
    })
  })

  // --- Requirement 1: SDK-bundled runtime resolution (mirrors the SDK's
  // own findCodexPath(), no PATH search, no shim ever accepted) ---------
  describe('resolveSdkBundledExecutablePath', () => {
    it('resolves win32/x64 to the @openai/codex-win32-x64 vendor bin/codex.exe path', () => {
      const vendorRoot = join(dir, 'vendor-root')
      const packageRoot = join(vendorRoot, 'x86_64-pc-windows-msvc')
      mkdirSync(join(packageRoot, 'bin'), { recursive: true })
      writeFileSync(join(packageRoot, 'bin', 'codex.exe'), '')
      writeFileSync(join(packageRoot, 'codex-package.json'), '{}')

      const resolveVendorRoot = (platformPackage: string): string | null => {
        expect(platformPackage).toBe('@openai/codex-win32-x64')
        return vendorRoot
      }

      const result = resolveSdkBundledExecutablePath('win32', 'x64', resolveVendorRoot)
      expect(result).toBe(join(packageRoot, 'bin', 'codex.exe'))
    })

    it('falls back to the legacy vendor/<triple>/codex/codex.exe shape the SDK also supports', () => {
      const vendorRoot = join(dir, 'vendor-root')
      const legacyPath = join(vendorRoot, 'x86_64-pc-windows-msvc', 'codex', 'codex.exe')
      mkdirSync(join(vendorRoot, 'x86_64-pc-windows-msvc', 'codex'), { recursive: true })
      writeFileSync(legacyPath, '')

      const result = resolveSdkBundledExecutablePath('win32', 'x64', () => vendorRoot)
      expect(result).toBe(legacyPath)
    })

    it('returns null when the platform package cannot be resolved (optionalDependencies skipped)', () => {
      const result = resolveSdkBundledExecutablePath('win32', 'x64', () => null)
      expect(result).toBeNull()
    })

    it('returns null on an unsupported architecture', () => {
      const result = resolveSdkBundledExecutablePath('win32', 'ia32', () => dir)
      expect(result).toBeNull()
    })

    // Regression test for a real bug caught during packaged-build
    // verification: require.resolve() inside a packaged Electron app
    // reports a vendor path as if it lived inside app.asar (a logical path
    // Electron's patched fs/require layer understands, which is why
    // existsSync/statSync on it "succeed") even when electron-builder's
    // asarUnpack config has copied the real file out to a sibling
    // app.asar.unpacked directory — a real OS process-creation call can
    // only spawn the latter. Confirmed live: without this conversion, a
    // packaged AgentDock reported the SDK-bundled runtime as unusable
    // (insideAsar: true) and silently fell back to the standalone tier
    // every time, even on a machine where the bundled runtime was
    // perfectly fine.
    it('converts an in-asar vendor root path to its real app.asar.unpacked equivalent before returning it', () => {
      // Electron's asar patch makes existsSync/statSync report "exists"
      // for a file matched by asarUnpack even at its IN-ARCHIVE logical
      // path (transparently redirecting reads to app.asar.unpacked under
      // the hood) — this plain-Node test environment has no such patch, so
      // a placeholder is created at BOTH locations: the in-archive-style
      // path (so the initial existence checks succeed, mirroring
      // Electron's real behavior) and the real app.asar.unpacked path
      // (whose CONTENT is what actually matters — a real, spawnable file).
      const asarStyleVendorRoot = join(dir, 'resources', 'app.asar', 'node_modules', '@openai', 'codex-win32-x64', 'vendor')
      const asarStylePackageRoot = join(asarStyleVendorRoot, 'x86_64-pc-windows-msvc')
      mkdirSync(join(asarStylePackageRoot, 'bin'), { recursive: true })
      writeFileSync(join(asarStylePackageRoot, 'bin', 'codex.exe'), '')
      writeFileSync(join(asarStylePackageRoot, 'codex-package.json'), '{}')

      const realUnpackedRoot = join(dir, 'resources', 'app.asar.unpacked', 'node_modules', '@openai', 'codex-win32-x64', 'vendor')
      const realPackageRoot = join(realUnpackedRoot, 'x86_64-pc-windows-msvc')
      mkdirSync(join(realPackageRoot, 'bin'), { recursive: true })
      writeFileSync(join(realPackageRoot, 'bin', 'codex.exe'), 'real native binary content')
      writeFileSync(join(realPackageRoot, 'codex-package.json'), '{}')

      const result = resolveSdkBundledExecutablePath('win32', 'x64', () => asarStyleVendorRoot)
      expect(result).toBe(join(realPackageRoot, 'bin', 'codex.exe'))
      expect(result).not.toContain(`${sep}app.asar${sep}`)
      expect(result).toContain(`app.asar.unpacked${sep}`)
    })

    it('leaves an already-development (non-asar) path untouched', () => {
      const vendorRoot = join(dir, 'vendor-root')
      const packageRoot = join(vendorRoot, 'x86_64-pc-windows-msvc')
      mkdirSync(join(packageRoot, 'bin'), { recursive: true })
      writeFileSync(join(packageRoot, 'bin', 'codex.exe'), '')
      writeFileSync(join(packageRoot, 'codex-package.json'), '{}')

      const result = resolveSdkBundledExecutablePath('win32', 'x64', () => vendorRoot)
      expect(result).toBe(join(packageRoot, 'bin', 'codex.exe'))
    })

    it('resolves darwin/arm64 to a binary named "codex" (no .exe suffix) — non-Windows target triples stay valid', () => {
      const vendorRoot = join(dir, 'vendor-root')
      const packageRoot = join(vendorRoot, 'aarch64-apple-darwin')
      mkdirSync(join(packageRoot, 'bin'), { recursive: true })
      writeFileSync(join(packageRoot, 'bin', 'codex'), '')
      writeFileSync(join(packageRoot, 'codex-package.json'), '{}')

      const resolveVendorRoot = (platformPackage: string): string | null => {
        expect(platformPackage).toBe('@openai/codex-darwin-arm64')
        return vendorRoot
      }

      const result = resolveSdkBundledExecutablePath('darwin', 'arm64', resolveVendorRoot)
      expect(result).toBe(join(packageRoot, 'bin', 'codex'))
    })

    it('resolves linux/x64 to the musl target triple\'s vendor path (matching the SDK\'s own PLATFORM_PACKAGE_BY_TARGET table)', () => {
      const vendorRoot = join(dir, 'vendor-root')
      const packageRoot = join(vendorRoot, 'x86_64-unknown-linux-musl')
      mkdirSync(join(packageRoot, 'bin'), { recursive: true })
      writeFileSync(join(packageRoot, 'bin', 'codex'), '')
      writeFileSync(join(packageRoot, 'codex-package.json'), '{}')

      const resolveVendorRoot = (platformPackage: string): string | null => {
        expect(platformPackage).toBe('@openai/codex-linux-x64')
        return vendorRoot
      }

      const result = resolveSdkBundledExecutablePath('linux', 'x64', resolveVendorRoot)
      expect(result).toBe(join(packageRoot, 'bin', 'codex'))
    })

    // Requirement/test 13: proves the fix actually works against the real,
    // installed dependency tree in this repository — not a mock. If
    // @openai/codex-win32-x64's real vendor binary ever moved or the SDK
    // upgraded its resolution shape incompatibly, this is the test that
    // would catch it (deliberately unskipped on any platform: on
    // non-Windows CI this just proves the *current host's* real package is
    // still resolvable the same way, which is exactly what "remains
    // spawnable after Electron packaging" needs verified everywhere).
    it('resolves the REAL, installed @openai/codex-sdk optional dependency for the current host platform/arch (no mocking)', () => {
      const result = resolveSdkBundledExecutablePath()
      // A platform/arch this repo's optionalDependencies don't cover
      // (uncommon CI runners) legitimately resolves to null — only assert
      // the file exists when a path was actually found.
      if (result) {
        expect(existsSync(result)).toBe(true)
      }
    })
  })

  // --- The 4-tier priority end to end -----------------------------------
  describe('resolveCodexRuntime', () => {
    function deps(overrides: Partial<CodexRuntimeResolverDeps>): Partial<CodexRuntimeResolverDeps> {
      return { platform: 'win32', resolveBundled: () => null, standaloneCandidates: () => [], probe: fakeProbe(FAIL_PROBE), ...overrides }
    }

    it('test 1: PATH resolving only codex.cmd never surfaces as a usable result — resolution never consults PATH at all', async () => {
      const cmdPath = join(dir, 'codex.cmd')
      writeFileSync(cmdPath, '@echo off\r\n')
      process.env.PATH = dir
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD'

      const result = await resolveCodexRuntime(null, deps({}))
      expect(result.source).toBe('none')
      expect(result.nativeExecutablePath).toBeNull()
      expect(result.error).toMatch(/could not locate/i)
    })

    it('test 2: PATH has codex.cmd, but the SDK-bundled runtime exists and responds — bundled wins, PATH is irrelevant', async () => {
      process.env.PATH = dir // only codex.cmd is "on PATH", never consulted
      writeFileSync(join(dir, 'codex.cmd'), '@echo off\r\n')
      const bundledExe = join(dir, 'vendor', 'codex.exe')
      mkdirSync(join(dir, 'vendor'), { recursive: true })
      writeFileSync(bundledExe, '')

      const result = await resolveCodexRuntime(
        null,
        deps({ resolveBundled: () => bundledExe, probe: fakeProbe((p) => (p === bundledExe ? OK_PROBE : FAIL_PROBE)) })
      )
      expect(result.source).toBe('sdk-bundled')
      expect(result.nativeExecutablePath).toBe(bundledExe)
      expect(result.executableExists).toBe(true)
      expect(result.versionProbe?.ok).toBe(true)
    })

    it('test 3: PATH has codex.cmd, bundled runtime is unavailable, but the official standalone codex.exe exists — standalone wins', async () => {
      process.env.PATH = dir
      writeFileSync(join(dir, 'codex.cmd'), '@echo off\r\n')
      const standaloneExe = join(dir, 'standalone', 'codex.exe')
      mkdirSync(join(dir, 'standalone'), { recursive: true })
      writeFileSync(standaloneExe, '')

      const result = await resolveCodexRuntime(
        null,
        deps({
          resolveBundled: () => null,
          standaloneCandidates: () => [standaloneExe],
          probe: fakeProbe((p) => (p === standaloneExe ? OK_PROBE : FAIL_PROBE))
        })
      )
      expect(result.source).toBe('standalone')
      expect(result.nativeExecutablePath).toBe(standaloneExe)
    })

    it('test 6/7/8: a shim in the standalone candidate list is rejected and recorded, never accepted', async () => {
      const shimCandidate = join(dir, 'codex.bat')
      writeFileSync(shimCandidate, '')

      const result = await resolveCodexRuntime(null, deps({ standaloneCandidates: () => [shimCandidate] }))
      expect(result.source).toBe('none')
      expect(result.rejectedShimPaths).toContain(shimCandidate)
    })

    it('test 4: a valid custom .exe wins outright, even when a working bundled runtime also exists', async () => {
      const customExe = join(dir, 'custom', 'codex.exe')
      mkdirSync(join(dir, 'custom'), { recursive: true })
      writeFileSync(customExe, '')

      const result = await resolveCodexRuntime(
        customExe,
        deps({ resolveBundled: () => join(dir, 'ignored-bundled.exe'), probe: fakeProbe(OK_PROBE) })
      )
      expect(result.source).toBe('custom')
      expect(result.nativeExecutablePath).toBe(customExe)
    })

    it('test 10/11: an explicitly configured but broken custom path is reported as a failure, never silently replaced by auto-detection', async () => {
      const missingCustom = join(dir, 'does-not-exist.exe')
      const bundledExe = join(dir, 'vendor', 'codex.exe')
      mkdirSync(join(dir, 'vendor'), { recursive: true })
      writeFileSync(bundledExe, '')

      const result = await resolveCodexRuntime(missingCustom, deps({ resolveBundled: () => bundledExe, probe: fakeProbe(OK_PROBE) }))
      expect(result.source).toBe('none')
      expect(result.error).toMatch(/no file exists/i)
    })

    it('test 12: no global Codex installation on PATH at all — the bundled runtime is still found and used', async () => {
      delete process.env.PATH
      delete process.env.Path
      const bundledExe = join(dir, 'vendor', 'codex.exe')
      mkdirSync(join(dir, 'vendor'), { recursive: true })
      writeFileSync(bundledExe, '')

      const result = await resolveCodexRuntime(null, deps({ resolveBundled: () => bundledExe, probe: fakeProbe(OK_PROBE) }))
      expect(result.source).toBe('sdk-bundled')
    })

    it('test 14: a bundled path resolved inside app.asar is never accepted — falls through to the standalone tier instead', async () => {
      const trappedExe = join(dir, 'resources', 'app.asar', 'node_modules', 'vendor', 'codex.exe')
      mkdirSync(join(dir, 'resources', 'app.asar', 'node_modules', 'vendor'), { recursive: true })
      writeFileSync(trappedExe, '')
      const standaloneExe = join(dir, 'standalone', 'codex.exe')
      mkdirSync(join(dir, 'standalone'), { recursive: true })
      writeFileSync(standaloneExe, '')

      const result = await resolveCodexRuntime(
        null,
        deps({
          resolveBundled: () => trappedExe,
          standaloneCandidates: () => [standaloneExe],
          probe: fakeProbe((p) => (p === standaloneExe ? OK_PROBE : OK_PROBE))
        })
      )
      expect(result.source).toBe('standalone')
      expect(result.nativeExecutablePath).toBe(standaloneExe)
    })

    it('returns a clear, actionable error (tier 4) when nothing at all resolves', async () => {
      const result = await resolveCodexRuntime(null, deps({}))
      expect(result.source).toBe('none')
      expect(result.nativeExecutablePath).toBeNull()
      expect(result.error).toMatch(/reinstall agentdock|install codex/i)
    })

    // Requirement/test 15: the exact same priority logic (not a
    // Windows-only code path) is exercised under darwin/linux — the
    // standalone tier is legitimately empty there (see
    // standaloneCodexCandidates), but custom-path and bundled-runtime
    // resolution still work identically.
    it('test 15: macOS — custom path still wins outright, bundled runtime still resolves when no custom path is set', async () => {
      const customBin = join(dir, 'codex')
      writeFileSync(customBin, '')

      const customResult = await resolveCodexRuntime(customBin, deps({ platform: 'darwin', probe: fakeProbe(OK_PROBE) }))
      expect(customResult.source).toBe('custom')

      const bundledBin = join(dir, 'vendor', 'codex')
      mkdirSync(join(dir, 'vendor'), { recursive: true })
      writeFileSync(bundledBin, '')
      const bundledResult = await resolveCodexRuntime(
        null,
        deps({ platform: 'darwin', resolveBundled: () => bundledBin, probe: fakeProbe(OK_PROBE) })
      )
      expect(bundledResult.source).toBe('sdk-bundled')
    })

    it('test 15: Linux — same 4-tier priority, no standalone fallback (none defined for Linux)', async () => {
      const bundledBin = join(dir, 'vendor', 'codex')
      mkdirSync(join(dir, 'vendor'), { recursive: true })
      writeFileSync(bundledBin, '')

      const result = await resolveCodexRuntime(null, deps({ platform: 'linux', resolveBundled: () => bundledBin, probe: fakeProbe(OK_PROBE) }))
      expect(result.source).toBe('sdk-bundled')
      expect(standaloneCodexCandidates('linux')).toEqual([])
    })
  })
})
