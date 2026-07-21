import { describe, expect, it } from 'vitest'
import {
  deriveTitleFromPrompt,
  isGenericDefaultTitle,
  stripContinuedSuffix,
  withContinuedSuffix
} from '../../src/main/services/title-service'

describe('deriveTitleFromPrompt', () => {
  it('uses a short prompt verbatim (just capitalized)', () => {
    expect(deriveTitleFromPrompt('build project pulse')).toBe('Build project pulse')
  })

  it('strips a leading filler phrase before extracting the topic', () => {
    expect(deriveTitleFromPrompt('Can you please add local persistence to the app')).toBe(
      'Add local persistence to the app'
    )
  })

  it('caps at 7 words', () => {
    const title = deriveTitleFromPrompt('one two three four five six seven eight nine ten')
    expect(title!.split(' ')).toHaveLength(7)
  })

  it('strips trailing punctuation', () => {
    expect(deriveTitleFromPrompt('Add a reset dashboard?')).toBe('Add a reset dashboard')
  })

  it('only looks at the first non-empty line of a multi-line prompt', () => {
    expect(deriveTitleFromPrompt('Add reset dashboard\n\nHere is a lot more detail below.')).toBe('Add reset dashboard')
  })

  it('never contains agent names invented by this function', () => {
    // Nothing in this module ever adds agent identity — it only shortens
    // the user's own words.
    const title = deriveTitleFromPrompt('please help me fix the login bug')
    expect(title).not.toMatch(/claude|codex|antigravity/i)
  })

  it('returns null for pure filler/punctuation with nothing meaningful left', () => {
    expect(deriveTitleFromPrompt('hi')).toBeNull()
    expect(deriveTitleFromPrompt('???')).toBeNull()
    expect(deriveTitleFromPrompt('')).toBeNull()
    expect(deriveTitleFromPrompt('   \n  ')).toBeNull()
  })

  it('caps very long single-word-ish content by character length too', () => {
    const long = 'a'.repeat(200)
    const title = deriveTitleFromPrompt(long)
    expect(title!.length).toBeLessThanOrEqual(60)
    expect(title!.endsWith('…')).toBe(true)
  })
})

describe('withContinuedSuffix / stripContinuedSuffix', () => {
  it('round-trips cleanly', () => {
    expect(withContinuedSuffix('Add local persistence')).toBe('Add local persistence (continued)')
    expect(stripContinuedSuffix('Add local persistence (continued)')).toBe('Add local persistence')
  })

  it('stripContinuedSuffix is a no-op when there is no suffix', () => {
    expect(stripContinuedSuffix('Add local persistence')).toBe('Add local persistence')
  })
})

describe('isGenericDefaultTitle', () => {
  it('matches the exact generic placeholders for each agent', () => {
    expect(isGenericDefaultTitle('New Claude Code session')).toBe(true)
    expect(isGenericDefaultTitle('New Codex session')).toBe(true)
    expect(isGenericDefaultTitle('New Antigravity session')).toBe(true)
  })

  it('does not match a real, topic-based title', () => {
    expect(isGenericDefaultTitle('Build Project Pulse')).toBe(false)
    expect(isGenericDefaultTitle('New feature for the session manager')).toBe(false)
  })
})
