import { describe, expect, it } from 'vitest'
import { CodexClassifier } from '../../src/main/agents/codex/CodexClassifier'
import { AntigravityClassifier } from '../../src/main/agents/antigravity/AntigravityClassifier'
import type { ScreenSnapshot } from '../../src/main/terminal/TerminalScreenBuffer'

function snapshot(lines: string[]): ScreenSnapshot {
  return { lines, cursorRow: lines.length, cursorCol: 0, atRestingPosition: true, raw: '' }
}

describe('CodexClassifier (shared generic pipeline, lower confidence than Claude)', () => {
  it('classifies the real captured update/policy numbered menu as choice_required', () => {
    const classifier = new CodexClassifier()
    const events = classifier.classify(
      snapshot(['› 1. Update now', '  2. Skip', '  3. Skip until next version', 'Press enter to continue'])
    )
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('choice_required')
  })

  it('ignores known chrome (status footer, banner) and treats the rest as prose', () => {
    const classifier = new CodexClassifier()
    const events = classifier.classify(
      snapshot(['Here is the answer to your question.', 'gpt-5.5 high · C:\\some\\project'])
    )
    expect(events).toEqual([{ type: 'assistant_message', text: 'Here is the answer to your question.' }])
  })

  it('detects a login prompt as authentication_required', () => {
    const classifier = new CodexClassifier()
    const events = classifier.classify(snapshot(['You are not logged in. Run `codex login` to continue.']))
    expect(events[0].type).toBe('authentication_required')
  })
})

describe('AntigravityClassifier (shared generic pipeline, no verified transcript format)', () => {
  it('classifies a generic y/n confirmation as permission_required', () => {
    const classifier = new AntigravityClassifier()
    const events = classifier.classify(snapshot(['Proceed? (y/n)', 'y. Yes', 'n. No']))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('permission_required')
  })

  it('treats unrecognized new output as prose by default', () => {
    const classifier = new AntigravityClassifier()
    const events = classifier.classify(snapshot(['All done.']))
    expect(events).toEqual([{ type: 'assistant_message', text: 'All done.' }])
  })
})
