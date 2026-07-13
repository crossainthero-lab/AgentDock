import { describe, expect, it } from 'vitest'
import { summarizeActivityGroup } from '../../src/renderer/components/session/activity'
import type { ActivityItem } from '../../src/renderer/components/session/activity'

function item(overrides: Partial<ActivityItem>): ActivityItem {
  return { id: '1', tool: 'Read', input: null, detail: null, isError: false, status: 'done', ...overrides }
}

describe('summarizeActivityGroup', () => {
  it('summarizes a single read as "Read a file"', () => {
    expect(summarizeActivityGroup([item({ tool: 'Read' })])).toContain('Read')
  })

  it('groups multiple reads as "Inspected N files"', () => {
    const items = [item({ id: '1', tool: 'Read' }), item({ id: '2', tool: 'Glob' }), item({ id: '3', tool: 'Grep' })]
    expect(summarizeActivityGroup(items)).toBe('Inspected 3 files')
  })

  it('groups multiple writes/edits as "Modified N files"', () => {
    const items = [item({ id: '1', tool: 'Write' }), item({ id: '2', tool: 'Edit' })]
    expect(summarizeActivityGroup(items)).toBe('Modified 2 files')
  })

  it('groups multiple bash calls as "Ran N commands"', () => {
    const items = [item({ id: '1', tool: 'Bash' }), item({ id: '2', tool: 'Bash' }), item({ id: '3', tool: 'Bash' })]
    expect(summarizeActivityGroup(items)).toBe('Ran 3 commands')
  })

  it('falls back to "Performed N actions" for mixed categories', () => {
    const items = [item({ id: '1', tool: 'Read' }), item({ id: '2', tool: 'Bash' })]
    expect(summarizeActivityGroup(items)).toBe('Performed 2 actions')
  })

  it('appends a failure count when some items errored', () => {
    const items = [item({ id: '1', tool: 'Bash' }), item({ id: '2', tool: 'Bash', isError: true })]
    expect(summarizeActivityGroup(items)).toBe('Ran 2 commands (1 failed)')
  })
})
