import { describe, expect, it } from 'vitest'
import { formatArrowMenuSelection } from '../../src/main/agents/shared/terminal-text'
import { ClaudeInputTranslator } from '../../src/main/agents/claude/ClaudeInputTranslator'
import { CodexInputTranslator } from '../../src/main/agents/codex/CodexInputTranslator'
import { AntigravityInputTranslator } from '../../src/main/agents/antigravity/AntigravityInputTranslator'

describe('formatArrowMenuSelection', () => {
  it('overshoots up then moves down exactly `index` times, then confirms', () => {
    expect(formatArrowMenuSelection(0)).toBe('\x1b[A'.repeat(20) + '\r')
    expect(formatArrowMenuSelection(2)).toBe('\x1b[A'.repeat(20) + '\x1b[B'.repeat(2) + '\r')
  })
})

describe('per-agent input translators', () => {
  it('all three route arrow:<index> ids through the same overshoot-then-confirm encoding', () => {
    const expected = formatArrowMenuSelection(1)
    expect(ClaudeInputTranslator.formatInteractionResponse('arrow:1')).toBe(expected)
    expect(CodexInputTranslator.formatInteractionResponse('arrow:1')).toBe(expected)
    expect(AntigravityInputTranslator.formatInteractionResponse('arrow:1')).toBe(expected)
  })

  it('digit/letter ids are sent verbatim followed by Enter', () => {
    expect(ClaudeInputTranslator.formatInteractionResponse('2')).toBe('2\r')
    expect(CodexInputTranslator.formatInteractionResponse('y')).toBe('y\r')
    expect(AntigravityInputTranslator.formatInteractionResponse('n')).toBe('n\r')
  })
})
