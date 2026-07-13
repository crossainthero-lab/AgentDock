import { describe, expect, it } from 'vitest'
import { detectAuthRequired, detectGenericInteraction } from '../../src/main/terminal/TerminalInteractionDetector'

describe('detectGenericInteraction', () => {
  it('prefers the real numbered options over a generic "press enter to continue" hint', () => {
    // From a real captured `codex` first-run update prompt — collapsing
    // this to a blind "press enter" action would lose the "Skip" choices.
    const guess = detectGenericInteraction([
      '  Update available! 0.144.1 -> 0.144.3',
      '',
      '› 1. Update now',
      '  2. Skip',
      '  3. Skip until next version',
      '',
      '  Press enter to continue'
    ])
    expect(guess?.kind).toBe('choice')
    expect(guess?.options).toEqual([
      { id: '1', label: 'Update now' },
      { id: '2', label: 'Skip' },
      { id: '3', label: 'Skip until next version' }
    ])
  })

  it('falls back to confirm_enter when there really is no menu, just a bare prompt', () => {
    const guess = detectGenericInteraction(['Installed successfully.', '', 'Press enter to continue'])
    expect(guess?.kind).toBe('confirm_enter')
  })

  it('detects a plain numbered choice menu without "press enter"', () => {
    const guess = detectGenericInteraction(['Which target?', '1. staging', '2. production'])
    expect(guess).toEqual({
      kind: 'choice',
      prompt: 'Which target?',
      options: [
        { id: '1', label: 'staging' },
        { id: '2', label: 'production' }
      ]
    })
  })

  it('classifies a numbered menu mentioning "do you want to" as permission-shaped', () => {
    const guess = detectGenericInteraction(['Do you want to delete this file?', '1. Yes', '2. No'])
    expect(guess?.kind).toBe('permission')
  })

  it('detects a y/n confirmation', () => {
    const guess = detectGenericInteraction(['Continue? (y/n)', 'y. Yes', 'n. No'])
    expect(guess).toEqual({
      kind: 'permission',
      prompt: 'Continue? (y/n)',
      options: [
        { id: 'y', label: 'Yes' },
        { id: 'n', label: 'No' }
      ]
    })
  })

  it('returns null for ordinary prose', () => {
    const guess = detectGenericInteraction(['Everything looks good.', 'No further action needed.'])
    expect(guess).toBeNull()
  })

  it('detects a real captured Antigravity-shaped arrow-key menu (no numbering at all)', () => {
    const guess = detectGenericInteraction([
      'Accessing workspace:',
      'C:\\some\\project',
      'Do you trust the contents of this project?',
      'Antigravity CLI requires permission to read, edit, and execute files here.',
      '› Yes, I trust this folder',
      '  No, exit',
      '↑/↓ Navigate · enter Confirm'
    ])
    expect(guess).toEqual({
      kind: 'permission',
      prompt: 'Do you trust the contents of this project?',
      options: [
        { id: 'arrow:0', label: 'Yes, I trust this folder' },
        { id: 'arrow:1', label: 'No, exit' }
      ]
    })
  })

  it('tolerates a real captured blank spacer line between the last option and the footer', () => {
    const guess = detectGenericInteraction([
      'Antigravity CLI requires permission to read, edit, and execute files here.',
      '',
      '> Yes, I trust this folder',
      '  No, exit',
      '',
      '  ↑/↓ Navigate · enter Confirm',
      '                                                                                                   Gemini 3.1 Pro (High)'
    ])
    expect(guess?.options).toEqual([
      { id: 'arrow:0', label: 'Yes, I trust this folder' },
      { id: 'arrow:1', label: 'No, exit' }
    ])
  })

  it('stops collecting arrow-menu options at the explanatory prose above them', () => {
    // "requires permission..." ends in "." and must not be swept in as a
    // third (bogus) option.
    const guess = detectGenericInteraction([
      'Antigravity CLI requires permission to read, edit, and execute files here.',
      '› Yes, I trust this folder',
      '  No, exit',
      '↑/↓ Navigate · enter Confirm'
    ])
    expect(guess?.options).toHaveLength(2)
  })
})

describe('detectAuthRequired', () => {
  it('detects a login URL prompt', () => {
    expect(detectAuthRequired(['Please visit https://example.com/login to authenticate.'])).not.toBeNull()
  })

  it('returns null for unrelated output', () => {
    expect(detectAuthRequired(['Everything looks good.'])).toBeNull()
  })
})
