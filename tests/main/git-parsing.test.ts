import { describe, expect, it } from 'vitest'
import { parseNumstat, parseStatusLine } from '../../src/main/services/git-service'

describe('parseStatusLine', () => {
  it('parses an untracked file', () => {
    expect(parseStatusLine('?? new-file.ts')).toEqual({ status: 'untracked', path: 'new-file.ts' })
  })

  it('parses a modified file (unstaged)', () => {
    expect(parseStatusLine(' M src/index.ts')).toEqual({ status: 'modified', path: 'src/index.ts' })
  })

  it('parses a staged added file', () => {
    expect(parseStatusLine('A  src/new.ts')).toEqual({ status: 'added', path: 'src/new.ts' })
  })

  it('parses a deleted file', () => {
    expect(parseStatusLine(' D src/old.ts')).toEqual({ status: 'deleted', path: 'src/old.ts' })
  })

  it('parses a renamed file, keeping only the new path', () => {
    expect(parseStatusLine('R  old-name.ts -> new-name.ts')).toEqual({ status: 'renamed', path: 'new-name.ts' })
  })

  it('returns null for a line too short to be valid porcelain output', () => {
    expect(parseStatusLine('M')).toBeNull()
  })
})

describe('parseNumstat', () => {
  it('parses added/deleted counts per path', () => {
    const result = parseNumstat('3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts\n')
    expect(result.get('src/a.ts')).toEqual({ additions: 3, deletions: 1 })
    expect(result.get('src/b.ts')).toEqual({ additions: 10, deletions: 0 })
  })

  it('represents binary files (dash counts) as null', () => {
    const result = parseNumstat('-\t-\timage.png\n')
    expect(result.get('image.png')).toEqual({ additions: null, deletions: null })
  })

  it('ignores blank lines', () => {
    const result = parseNumstat('\n3\t1\tsrc/a.ts\n\n')
    expect(result.size).toBe(1)
  })
})
