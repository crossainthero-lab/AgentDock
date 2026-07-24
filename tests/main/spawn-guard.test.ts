import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SpawnValidationError,
  expandEnvVars,
  normalizeExecutableOverride,
  stripSurroundingQuotes,
  validateSpawnPlan
} from '../../src/main/services/spawn-guard'

// Every fixture path here is generated under the OS temp directory — never
// the real developer home directory — so these tests exercise genuinely
// portable path shapes (spaces, non-ASCII characters) without depending on
// anything specific to this machine.

describe('spawn-guard', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'agentdock-spawn-guard-'))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  describe('stripSurroundingQuotes', () => {
    it('removes a matched pair of double quotes (Windows Explorer "Copy as path" shape)', () => {
      expect(stripSurroundingQuotes('"C:\\Program Files\\Thing\\thing.exe"')).toBe('C:\\Program Files\\Thing\\thing.exe')
    })

    it('removes a matched pair of single quotes', () => {
      expect(stripSurroundingQuotes("'/usr/local/bin/thing'")).toBe('/usr/local/bin/thing')
    })

    it('trims whitespace even when there are no quotes', () => {
      expect(stripSurroundingQuotes('  /usr/local/bin/thing  ')).toBe('/usr/local/bin/thing')
    })

    it('leaves an interior quote alone (not a wrapping pair)', () => {
      expect(stripSurroundingQuotes('/path/with"quote/inside')).toBe('/path/with"quote/inside')
    })

    it('is a no-op for an already-clean path', () => {
      expect(stripSurroundingQuotes('/usr/local/bin/thing')).toBe('/usr/local/bin/thing')
    })
  })

  describe('expandEnvVars', () => {
    it('expands a Windows %VAR% reference', () => {
      process.env.AGENTDOCK_TEST_VAR = 'C:\\Somewhere'
      try {
        expect(expandEnvVars('%AGENTDOCK_TEST_VAR%\\bin\\thing.exe')).toBe('C:\\Somewhere\\bin\\thing.exe')
      } finally {
        delete process.env.AGENTDOCK_TEST_VAR
      }
    })

    it('expands a POSIX $VAR and ${VAR} reference', () => {
      process.env.AGENTDOCK_TEST_VAR = '/somewhere'
      try {
        expect(expandEnvVars('$AGENTDOCK_TEST_VAR/bin/thing')).toBe('/somewhere/bin/thing')
        expect(expandEnvVars('${AGENTDOCK_TEST_VAR}/bin/thing')).toBe('/somewhere/bin/thing')
      } finally {
        delete process.env.AGENTDOCK_TEST_VAR
      }
    })

    it('leaves an unknown variable reference untouched rather than deleting it', () => {
      expect(expandEnvVars('%AGENTDOCK_DEFINITELY_UNSET%\\bin')).toBe('%AGENTDOCK_DEFINITELY_UNSET%\\bin')
    })
  })

  describe('normalizeExecutableOverride', () => {
    it('rejects an empty override', () => {
      const result = normalizeExecutableOverride('   ')
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/empty/i)
    })

    it('rejects a value wrapped in quotes that points nowhere real', () => {
      const result = normalizeExecutableOverride('"C:\\definitely\\does\\not\\exist.exe"')
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/no file exists/i)
    })

    it('accepts a quoted path to a real file — a config value literally copied via "Copy as path" — trimming and dequoting it', () => {
      const realFile = join(tempRoot, 'tool.exe')
      writeFileSync(realFile, '')
      const result = normalizeExecutableOverride(`  "${realFile}"  `)
      expect(result.ok).toBe(true)
      expect(result.path).toBe(realFile)
    })

    it('expands an environment variable reference before checking existence', () => {
      const realFile = join(tempRoot, 'tool.exe')
      writeFileSync(realFile, '')
      process.env.AGENTDOCK_TEST_DIR = tempRoot
      try {
        const withEnvVar = join('%AGENTDOCK_TEST_DIR%', 'tool.exe')
        const result = normalizeExecutableOverride(withEnvVar)
        expect(result.ok).toBe(true)
        expect(result.path).toBe(realFile)
      } finally {
        delete process.env.AGENTDOCK_TEST_DIR
      }
    })

    it('rejects a path that is a directory, not a file', () => {
      const result = normalizeExecutableOverride(tempRoot)
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/directory, not an executable file/i)
    })

    it('rejects a path that does not exist on this machine', () => {
      const result = normalizeExecutableOverride(join(tempRoot, 'nope.exe'))
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/no file exists/i)
    })

    it('accepts a real file under a directory whose name has spaces and non-ASCII characters', () => {
      const unicodeDir = join(tempRoot, 'Test Über 日本語 Dir')
      mkdirSync(unicodeDir, { recursive: true })
      const realFile = join(unicodeDir, 'tool.exe')
      writeFileSync(realFile, '')
      const result = normalizeExecutableOverride(realFile)
      expect(result.ok).toBe(true)
      expect(result.path).toBe(realFile)
    })
  })

  describe('validateSpawnPlan', () => {
    it('throws for an empty command', () => {
      expect(() => validateSpawnPlan({ command: '', args: [] })).toThrow(SpawnValidationError)
    })

    it('throws for a command still wrapped in quotes', () => {
      expect(() => validateSpawnPlan({ command: '"C:\\thing.exe"', args: [] })).toThrow(/wrapped in quotes/i)
    })

    it('throws for a command containing an embedded NUL character', () => {
      expect(() => validateSpawnPlan({ command: 'thing\0.exe', args: [] })).toThrow(/null character/i)
    })

    it('throws when an argument is null', () => {
      expect(() => validateSpawnPlan({ command: 'git', args: [null as unknown as string] })).toThrow(/is null/i)
    })

    it('throws when an argument is undefined', () => {
      expect(() => validateSpawnPlan({ command: 'git', args: [undefined as unknown as string] })).toThrow(/is undefined/i)
    })

    it('throws when an argument is an object', () => {
      expect(() => validateSpawnPlan({ command: 'git', args: [{ oops: true } as unknown as string] })).toThrow(/not a string/i)
    })

    it('throws when an argument contains an embedded NUL character', () => {
      expect(() => validateSpawnPlan({ command: 'git', args: ['status', 'bad\0arg'] })).toThrow(/null character/i)
    })

    it('accepts a plain bare command name with no cwd/env at all', () => {
      expect(() => validateSpawnPlan({ command: 'git', args: ['status'] })).not.toThrow()
    })

    it('throws for an empty cwd', () => {
      expect(() => validateSpawnPlan({ command: 'git', args: [], cwd: '' })).toThrow(/empty or invalid/i)
    })

    it('throws for a non-absolute cwd', () => {
      expect(() => validateSpawnPlan({ command: 'git', args: [], cwd: 'relative/path' })).toThrow(/absolute/i)
    })

    it('throws for a cwd that does not exist', () => {
      const missing = join(tempRoot, 'this-does-not-exist')
      expect(() => validateSpawnPlan({ command: 'git', args: [], cwd: missing })).toThrow(/does not exist/i)
    })

    it('throws for a cwd that is a file, not a directory', () => {
      const file = join(tempRoot, 'not-a-dir.txt')
      writeFileSync(file, '')
      expect(() => validateSpawnPlan({ command: 'git', args: [], cwd: file })).toThrow(/not a directory/i)
    })

    it('accepts a real cwd, including one with spaces and non-ASCII characters', () => {
      const dir = join(tempRoot, 'Real Project — 日本語')
      mkdirSync(dir, { recursive: true })
      expect(() => validateSpawnPlan({ command: 'git', args: [], cwd: dir })).not.toThrow()
    })

    it('does not throw for an undefined environment value (Node itself just omits it)', () => {
      expect(() => validateSpawnPlan({ command: 'git', args: [], env: { FOO: undefined, PATH: process.env.PATH } })).not.toThrow()
    })

    it('throws for a non-string environment value', () => {
      expect(() =>
        validateSpawnPlan({ command: 'git', args: [], env: { FOO: 123 as unknown as string } })
      ).toThrow(/not a string/i)
    })

    it('throws when an absolute executable path does not exist on disk', () => {
      const missing = join(tempRoot, 'nope.exe')
      expect(() => validateSpawnPlan({ command: missing, args: [] })).toThrow(/does not exist/i)
    })

    it('accepts an absolute executable path that does exist', () => {
      const real = join(tempRoot, 'tool.exe')
      writeFileSync(real, '')
      expect(() => validateSpawnPlan({ command: real, args: [] })).not.toThrow()
    })
  })
})
