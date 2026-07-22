import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  describeResolutionFailure,
  findCandidates,
  knownWindowsInstallDirs,
  resolveExecutable,
  type ValidationOutcome
} from '../../src/main/services/executable-resolver'

/** Accepts every candidate — used where a test doesn't care about
 *  validation outcomes, only about which candidates were found/tried. */
async function acceptAll(): Promise<ValidationOutcome> {
  return { ok: true, output: 'v1.0.0' }
}

/** Rejects candidates whose path exactly matches one of the given paths,
 *  accepting everything else — lets a test simulate "this file exists but
 *  cannot actually be run" without spawning a real process. Exact match
 *  (not substring) deliberately: "codex" is a string-prefix of
 *  "codex.cmd", so a substring check would wrongly reject both. */
function rejecting(...exactPaths: string[]): (path: string) => Promise<ValidationOutcome> {
  const lowerSet = new Set(exactPaths.map((p) => p.toLowerCase()))
  return async (path) => {
    if (lowerSet.has(path.toLowerCase())) return { ok: false, reason: 'not a valid Windows executable' }
    return { ok: true, output: 'v1.0.0' }
  }
}

describe('executable-resolver', () => {
  let dir: string
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdock-resolver-test-'))
    originalEnv = { ...process.env }
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  describe('findCandidates', () => {
    it('finds a bare candidate name on PATH with a Windows extension', () => {
      writeFileSync(join(dir, 'myagent.exe'), '')
      process.env.PATH = dir
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD'

      const result = findCandidates(['myagent'], null)
      expect(result.candidates.map((c) => c.toLowerCase())).toContain(join(dir, 'myagent.exe').toLowerCase())
    })

    it('never searches inside a node_modules directory on PATH (regression: local SDK dependency shim collision)', () => {
      // Reproduces the real bug: installing @openai/codex-sdk transitively
      // installs @openai/codex, which places `codex`/`codex.cmd` bin shims
      // in this project's own node_modules/.bin — and `npm run dev`
      // prepends that directory onto PATH for the dev process. A
      // standalone CLI like Codex must never resolve to that.
      const nodeModulesBin = join(dir, 'node_modules', '.bin')
      mkdirSync(nodeModulesBin, { recursive: true })
      writeFileSync(join(nodeModulesBin, 'codex'), '#!/bin/sh\necho fake shim\n')
      writeFileSync(join(nodeModulesBin, 'codex.cmd'), '@echo off\n')

      const realInstallDir = join(dir, 'real-install')
      mkdirSync(realInstallDir, { recursive: true })
      writeFileSync(join(realInstallDir, 'codex.exe'), '')

      process.env.PATH = [nodeModulesBin, realInstallDir].join(delimiter)
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD'

      const result = findCandidates(['codex'], null)
      expect(result.candidates.some((c) => c.toLowerCase().includes('node_modules'))).toBe(false)
      expect(result.candidates.map((c) => c.toLowerCase())).toContain(join(realInstallDir, 'codex.exe').toLowerCase())
    })

    it('prefers a real Windows extension over a bare extensionless file in the same directory (regression: POSIX shim picked before the real .cmd)', () => {
      // The exact shape of the real bug's shim directory: a bare POSIX
      // shell script AND a real .cmd shim, same name, same directory.
      writeFileSync(join(dir, 'codex'), '#!/bin/sh\necho fake shim\n')
      writeFileSync(join(dir, 'codex.cmd'), '@echo off\n')
      process.env.PATH = dir
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD'

      const result = findCandidates(['codex'], null)
      const bareIndex = result.candidates.findIndex((c) => c === join(dir, 'codex'))
      const cmdIndex = result.candidates.findIndex((c) => c.toLowerCase() === join(dir, 'codex.cmd').toLowerCase())
      expect(cmdIndex).toBeGreaterThanOrEqual(0)
      expect(bareIndex).toBeGreaterThanOrEqual(0)
      expect(cmdIndex).toBeLessThan(bareIndex)
    })

    it('merges duplicate-cased PATH/Path env keys instead of picking only one', () => {
      const dirA = join(dir, 'a')
      const dirB = join(dir, 'b')
      mkdirSync(dirA)
      mkdirSync(dirB)
      writeFileSync(join(dirB, 'myagent.exe'), '')

      // Simulate the real-world quirk: two differently-cased PATH keys
      // coexisting, each with different (non-overlapping) content.
      delete process.env.PATH
      delete process.env.Path
      process.env.PATH = dirA
      process.env.Path = dirB
      process.env.PATHEXT = '.EXE'

      const result = findCandidates(['myagent'], null)
      expect(result.candidates.map((c) => c.toLowerCase())).toContain(join(dirB, 'myagent.exe').toLowerCase())
    })

    it('CRITICAL (Windows portability): finds a real executable inside a PATH directory whose own path contains spaces and Unicode characters', () => {
      const unicodeDir = join(dir, 'Prográms 日本語', 'My Ägent Tool')
      mkdirSync(unicodeDir, { recursive: true })
      writeFileSync(join(unicodeDir, 'myagent.exe'), '')
      process.env.PATH = unicodeDir
      process.env.PATHEXT = '.EXE'

      const result = findCandidates(['myagent'], null)
      expect(result.candidates.map((c) => c.toLowerCase())).toContain(join(unicodeDir, 'myagent.exe').toLowerCase())
    })

    it('tries candidate names in order, still finding the second name if the first has no match anywhere', () => {
      writeFileSync(join(dir, 'second.exe'), '')
      process.env.PATH = dir
      process.env.PATHEXT = '.EXE'

      const result = findCandidates(['first', 'second'], null)
      expect(result.candidates.map((c) => c.toLowerCase())).toContain(join(dir, 'second.exe').toLowerCase())
    })

    it('an absolute custom path is the only candidate considered — no PATH fallback', () => {
      writeFileSync(join(dir, 'custom.exe'), '')
      const otherDir = join(dir, 'other')
      mkdirSync(otherDir)
      writeFileSync(join(otherDir, 'irrelevant.exe'), '')
      process.env.PATH = otherDir
      process.env.PATHEXT = '.EXE'

      const customPath = join(dir, 'custom.exe')
      const result = findCandidates(['irrelevant'], customPath)
      expect(result.candidates).toEqual([customPath])
    })
  })

  describe('resolveExecutable', () => {
    it('resolves and validates a real candidate', async () => {
      writeFileSync(join(dir, 'myagent.exe'), '')
      process.env.PATH = dir
      process.env.PATHEXT = '.EXE'

      const result = await resolveExecutable(['myagent'], null, acceptAll)
      expect(result.resolvedPath?.toLowerCase()).toBe(join(dir, 'myagent.exe').toLowerCase())
      expect(result.strategy).toBe('path-search')
      expect(result.rejected).toEqual([])
    })

    it('the real .cmd shim is tried (and succeeds) before the broken bare POSIX shim is ever reached (regression: the exact real-world failure)', async () => {
      writeFileSync(join(dir, 'codex'), '#!/bin/sh\necho fake shim\n')
      writeFileSync(join(dir, 'codex.cmd'), '@echo off\n')
      process.env.PATH = dir
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD'

      // Only the bare POSIX shim would fail validation — the real .cmd
      // shim works. Extension-order means .cmd is tried first, so the
      // bare candidate's rejection is never even exercised here.
      const result = await resolveExecutable(
        ['codex'],
        null,
        rejecting(join(dir, 'codex')) // rejects only the exact bare-name path
      )

      expect(result.resolvedPath?.toLowerCase()).toBe(join(dir, 'codex.cmd').toLowerCase())
      expect(result.rejected).toEqual([])
    })

    it('when only the bare POSIX shim exists (no real extension), it is rejected and reported — never silently returned', async () => {
      writeFileSync(join(dir, 'codex'), '#!/bin/sh\necho fake shim\n')
      process.env.PATH = dir
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD'

      const result = await resolveExecutable(['codex'], null, rejecting(join(dir, 'codex')))
      expect(result.resolvedPath).toBeNull()
      expect(result.rejected).toEqual([{ path: join(dir, 'codex'), reason: 'not a valid Windows executable' }])
    })

    it('never returns a candidate that failed its probe, even if it was the only one found', async () => {
      writeFileSync(join(dir, 'codex'), '#!/bin/sh\necho fake shim\n')
      process.env.PATH = dir
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD'

      const result = await resolveExecutable(['codex'], null, async () => ({ ok: false, reason: 'not a valid Windows executable' }))
      expect(result.resolvedPath).toBeNull()
      expect(result.strategy).toBe('not-found')
      expect(result.rejected).toEqual([{ path: join(dir, 'codex'), reason: 'not a valid Windows executable' }])
    })

    it('a custom path that fails validation is reported as a clear error, never silently substituted with a different candidate', async () => {
      writeFileSync(join(dir, 'custom.exe'), '')
      const realDir = join(dir, 'real')
      mkdirSync(realDir)
      writeFileSync(join(realDir, 'irrelevant.exe'), '')
      process.env.PATH = realDir
      process.env.PATHEXT = '.EXE'

      const customPath = join(dir, 'custom.exe')
      const result = await resolveExecutable(['irrelevant'], customPath, async () => ({ ok: false, reason: 'ENOENT: broken override' }))
      expect(result.resolvedPath).toBeNull()
      expect(result.strategy).toBe('not-found')
      expect(result.rejected).toEqual([{ path: customPath, reason: 'ENOENT: broken override' }])
    })

    it('carries the winning candidate probe output forward, avoiding a redundant second spawn', async () => {
      writeFileSync(join(dir, 'myagent.exe'), '')
      process.env.PATH = dir
      process.env.PATHEXT = '.EXE'

      const result = await resolveExecutable(['myagent'], null, async () => ({ ok: true, output: 'myagent-cli 2.0.0' }))
      expect(result.output).toBe('myagent-cli 2.0.0')
    })

    it('returns a detailed checked list when nothing resolves', async () => {
      process.env.PATH = dir
      process.env.PATHEXT = '.EXE'

      const result = await resolveExecutable(['does-not-exist'], null, acceptAll)
      expect(result.resolvedPath).toBeNull()
      expect(result.checked.length).toBeGreaterThan(0)
    })

    it('CRITICAL (Windows portability): falls back to a known install-location directory when PATH search finds nothing there', async () => {
      const emptyPathDir = join(dir, 'empty-path')
      mkdirSync(emptyPathDir)
      process.env.PATH = emptyPathDir
      process.env.PATHEXT = '.EXE'

      const knownDir = join(dir, 'known-install', 'bin')
      mkdirSync(knownDir, { recursive: true })
      writeFileSync(join(knownDir, 'myagent.exe'), '')

      const result = await resolveExecutable(['myagent'], null, acceptAll, [knownDir])
      expect(result.resolvedPath?.toLowerCase()).toBe(join(knownDir, 'myagent.exe').toLowerCase())
      expect(result.strategy).toBe('known-location')
    })

    it('a PATH match always wins over a known-location match, even when both exist', async () => {
      const pathDir = join(dir, 'on-path')
      const knownDir = join(dir, 'known-install')
      mkdirSync(pathDir)
      mkdirSync(knownDir)
      writeFileSync(join(pathDir, 'myagent.exe'), '')
      writeFileSync(join(knownDir, 'myagent.exe'), '')
      process.env.PATH = pathDir
      process.env.PATHEXT = '.EXE'

      const result = await resolveExecutable(['myagent'], null, acceptAll, [knownDir])
      expect(result.resolvedPath?.toLowerCase()).toBe(join(pathDir, 'myagent.exe').toLowerCase())
      expect(result.strategy).toBe('path-search')
    })

    it('reports not-found when neither PATH nor any known-location directory has the executable', async () => {
      const emptyPathDir = join(dir, 'empty-path')
      const emptyKnownDir = join(dir, 'empty-known')
      mkdirSync(emptyPathDir)
      mkdirSync(emptyKnownDir)
      process.env.PATH = emptyPathDir
      process.env.PATHEXT = '.EXE'

      const result = await resolveExecutable(['myagent'], null, acceptAll, [emptyKnownDir])
      expect(result.resolvedPath).toBeNull()
      expect(result.strategy).toBe('not-found')
    })

    it('a configured custom path still wins outright even when a known-location directory also has a match', async () => {
      const knownDir = join(dir, 'known-install')
      mkdirSync(knownDir)
      writeFileSync(join(knownDir, 'myagent.exe'), '')
      const customPath = join(dir, 'custom.exe')
      writeFileSync(customPath, '')
      process.env.PATH = dir
      process.env.PATHEXT = '.EXE'

      const result = await resolveExecutable(['myagent'], customPath, acceptAll, [knownDir])
      expect(result.resolvedPath?.toLowerCase()).toBe(customPath.toLowerCase())
      expect(result.strategy).toBe('custom-path')
    })
  })

  describe('knownWindowsInstallDirs', () => {
    it('returns real per-agent Windows install directories derived from USERPROFILE/LOCALAPPDATA/APPDATA, not hardcoded to any specific machine or username', () => {
      process.env.USERPROFILE = 'Q:\\Users\\someone-else'
      process.env.LOCALAPPDATA = 'Q:\\Users\\someone-else\\AppData\\Local'
      process.env.APPDATA = 'Q:\\Users\\someone-else\\AppData\\Roaming'

      const dirs = knownWindowsInstallDirs()
      expect(dirs.length).toBeGreaterThan(0)
      expect(dirs.every((d) => d.startsWith('Q:\\Users\\someone-else'))).toBe(true)
      expect(dirs.some((d) => d.toLowerCase().includes('.local'))).toBe(true)
      expect(dirs.some((d) => d.toLowerCase().includes('agy'))).toBe(true)
      expect(dirs.some((d) => d.toLowerCase().includes('codex'))).toBe(true)
      // No hardcoded username anywhere in the returned list.
      expect(dirs.every((d) => !d.toLowerCase().includes('billy'))).toBe(true)
    })

    it('degrades gracefully (never throws, never returns a malformed entry) when one of the env vars is missing', () => {
      delete process.env.APPDATA
      process.env.USERPROFILE = 'Q:\\Users\\someone-else'
      process.env.LOCALAPPDATA = 'Q:\\Users\\someone-else\\AppData\\Local'

      expect(() => knownWindowsInstallDirs()).not.toThrow()
      const dirs = knownWindowsInstallDirs()
      expect(dirs.every((d) => typeof d === 'string' && d.length > 0)).toBe(true)
    })
  })

  describe('describeResolutionFailure', () => {
    it('builds a detailed failure message including agent, candidates, custom path, workspace, and rejected candidates', async () => {
      writeFileSync(join(dir, 'ghost'), '')
      process.env.PATH = dir
      process.env.PATHEXT = '.EXE'
      const result = await resolveExecutable(['ghost'], null, async () => ({ ok: false, reason: 'not runnable' }))

      const message = describeResolutionFailure({
        agentId: 'ghost-agent',
        candidates: ['ghost'],
        customPath: null,
        workspacePath: '/some/workspace',
        result
      })

      expect(message).toContain('ghost-agent')
      expect(message).toContain('ghost')
      expect(message).toContain('/some/workspace')
      expect(message).toContain('PATH directories searched')
      expect(message).toContain('not runnable')
    })
  })
})
