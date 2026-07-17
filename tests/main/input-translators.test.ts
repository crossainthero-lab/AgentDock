import { describe, expect, it } from 'vitest'
import { formatArrowMenuSelection } from '../../src/main/agents/shared/terminal-text'
import { AntigravityInputTranslator } from '../../src/main/agents/antigravity/AntigravityInputTranslator'

// Claude and Codex no longer have PTY input translators — their structured
// transports send real typed messages, not synthesized terminal keystrokes.
// Antigravity is the sole remaining PTY-driven agent.

describe('formatArrowMenuSelection', () => {
  it('overshoots up then moves down exactly `index` times, then confirms', () => {
    expect(formatArrowMenuSelection(0)).toBe('\x1b[A'.repeat(20) + '\r')
    expect(formatArrowMenuSelection(2)).toBe('\x1b[A'.repeat(20) + '\x1b[B'.repeat(2) + '\r')
  })
})

describe('AntigravityInputTranslator', () => {
  it('routes arrow:<index> ids through the overshoot-then-confirm encoding', () => {
    expect(AntigravityInputTranslator.formatInteractionResponse('arrow:1')).toBe(formatArrowMenuSelection(1))
  })

  it('digit/letter ids are sent verbatim followed by Enter', () => {
    expect(AntigravityInputTranslator.formatInteractionResponse('n')).toBe('n\r')
  })
})
