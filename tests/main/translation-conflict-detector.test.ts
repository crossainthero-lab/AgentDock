import { describe, expect, it } from 'vitest'
import { checkTranslationConflict, createConflictState } from '../../src/main/terminal/TranslationConflictDetector'
import type { ScreenSnapshot } from '../../src/main/terminal/TerminalScreenBuffer'

function snapshot(lines: string[], atRestingPosition: boolean): ScreenSnapshot {
  return { lines, cursorRow: lines.length, cursorCol: atRestingPosition ? 0 : 5, atRestingPosition, raw: '' }
}

describe('TranslationConflictDetector', () => {
  it('does not flag anything while the screen keeps changing', () => {
    let state = createConflictState()
    let now = 0
    for (let i = 0; i < 5; i++) {
      const result = checkTranslationConflict(state, snapshot([`line ${i}`], false), false, now)
      expect(result.attentionNeeded).toBe(false)
      state = result.state
      now += 1000
    }
  })

  it('does not flag anything when the classifier already handled the snapshot', () => {
    let state = createConflictState()
    const stuck = snapshot(['some unrecognized menu'], false)
    state = checkTranslationConflict(state, stuck, true, 0).state
    const result = checkTranslationConflict(state, stuck, true, 10000)
    expect(result.attentionNeeded).toBe(false)
  })

  it('does not flag a screen that is unchanged but resting (prose just finished printing)', () => {
    let state = createConflictState()
    const resting = snapshot(['done.'], true)
    state = checkTranslationConflict(state, resting, false, 0).state
    const result = checkTranslationConflict(state, resting, false, 10000)
    expect(result.attentionNeeded).toBe(false)
  })

  it('flags an unrecognized, unchanged, non-resting screen after the stall threshold', () => {
    let state = createConflictState()
    const stuck = snapshot(['??? some unknown interactive prompt ???'], false)
    state = checkTranslationConflict(state, stuck, false, 0).state // first sighting, establishes baseline
    state = checkTranslationConflict(state, stuck, false, 3000).state // still under threshold
    const result = checkTranslationConflict(state, stuck, false, 7000)
    expect(result.attentionNeeded).toBe(true)
  })

  it('only fires once per stall episode, not on every subsequent idle tick', () => {
    let state = createConflictState()
    const stuck = snapshot(['??? some unknown interactive prompt ???'], false)
    state = checkTranslationConflict(state, stuck, false, 0).state // baseline sighting

    const firstFire = checkTranslationConflict(state, stuck, false, 7000)
    expect(firstFire.attentionNeeded).toBe(true)
    state = firstFire.state

    const secondCheck = checkTranslationConflict(state, stuck, false, 8000)
    expect(secondCheck.attentionNeeded).toBe(false)
  })

  it('resets once the screen changes again', () => {
    let state = createConflictState()
    const stuck = snapshot(['prompt A'], false)
    state = checkTranslationConflict(state, stuck, false, 0).state
    state = checkTranslationConflict(state, stuck, false, 7000).state
    state = checkTranslationConflict(state, stuck, false, 7000).state // notified

    const changed = snapshot(['prompt B'], false)
    const afterChange = checkTranslationConflict(state, changed, false, 7100)
    expect(afterChange.attentionNeeded).toBe(false)
    expect(afterChange.state.notified).toBe(false)
  })
})
