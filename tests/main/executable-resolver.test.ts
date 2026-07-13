import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeResolutionFailure, resolveExecutable } from '../../src/main/services/executable-resolver'

describe('resolveExecutable', () => {
  let dir: string
  let originalPath: string | undefined
  let originalPathExt: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdock-resolver-test-'))
    originalPath = process.env.PATH
    originalPathExt = process.env.PATHEXT
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (originalPath !== undefined) process.env.PATH = originalPath
    if (originalPathExt !== undefined) process.env.PATHEXT = originalPathExt
  })

  it('resolves a bare candidate name found on PATH with a Windows extension', () => {
    writeFileSync(join(dir, 'myagent.exe'), '')
    process.env.PATH = dir
    process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD'

    const result = resolveExecutable(['myagent'], null)
    expect(result.resolvedPath?.toLowerCase()).toBe(join(dir, 'myagent.exe').toLowerCase())
  })

  it('tries candidates in order and returns the first that resolves', () => {
    writeFileSync(join(dir, 'second.exe'), '')
    process.env.PATH = dir
    process.env.PATHEXT = '.EXE'

    const result = resolveExecutable(['first', 'second'], null)
    expect(result.resolvedPath?.toLowerCase()).toBe(join(dir, 'second.exe').toLowerCase())
    expect(result.checked.length).toBeGreaterThan(0)
  })

  it('prefers a custom path over all candidates when provided', () => {
    writeFileSync(join(dir, 'custom.exe'), '')
    process.env.PATH = dir
    process.env.PATHEXT = '.EXE'

    const customPath = join(dir, 'custom.exe')
    const result = resolveExecutable(['irrelevant'], customPath)
    expect(result.resolvedPath).toBe(customPath)
  })

  it('returns null and a detailed checked list when nothing resolves', () => {
    process.env.PATH = dir
    process.env.PATHEXT = '.EXE'

    const result = resolveExecutable(['does-not-exist'], null)
    expect(result.resolvedPath).toBeNull()
    expect(result.checked.length).toBeGreaterThan(0)
  })

  it('builds a detailed failure message including agent, candidates, custom path, and workspace', () => {
    process.env.PATH = dir
    process.env.PATHEXT = '.EXE'
    const result = resolveExecutable(['ghost'], null)

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
  })
})
