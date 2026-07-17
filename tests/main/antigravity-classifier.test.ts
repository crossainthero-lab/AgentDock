import { describe, expect, it } from 'vitest'
import { AntigravityClassifier } from '../../src/main/agents/antigravity/AntigravityClassifier'
import type { ScreenSnapshot } from '../../src/main/terminal/TerminalScreenBuffer'

function snapshot(lines: string[]): ScreenSnapshot {
  return { lines, cursorRow: lines.length, cursorCol: 0, atRestingPosition: true, raw: '' }
}

// Real transcripts captured via a real node-pty session driving the exact
// argv AntigravityAdapter builds (-i <prompt>), then resolved through the
// real TerminalScreenBuffer (not hand-typed). Antigravity is the sole
// remaining PTY-classified agent — Claude and Codex moved to structured
// JSON transports (see ClaudeEventMapper/CodexEventMapper) and no longer
// have a classifier at all.

describe('AntigravityClassifier (real captures from agy 1.1.1/1.1.2, -i <prompt>)', () => {
  it('filters the entire startup banner (ascii art, account, model, cwd, echoed prompt) and the "Thought for Ns" status, leaving only the real reply', () => {
    const classifier = new AntigravityClassifier()
    const events = classifier.classify(
      snapshot([
        '',
        '      ▄▀▀▄',
        '     ▀▀▀▀▀▀',
        '  Antigravity CLI 1.1.1',
        'someone@example.com (Google AI Pro)',
        'Gemini 3.1 Pro (High)',
        '~/some/workspace',
        '',
        '────────────────────────────',
        '> Reply with exactly: HELLO CAPTURE TEST. Do not use any tools.',
        '',
        '▸ Thought for 6s, 291 tokens',
        '  Prioritizing Tool Usage',
        '  HELLO CAPTURE TEST.',
        '',
        '────────────────────────────',
        '>',
        '────────────────────────────',
        '? for shortcuts                                            Gemini 3.1 Pro (High)'
      ])
    )
    expect(events).toEqual([
      { type: 'activity', label: 'Thinking', elapsedMs: 6000 },
      { type: 'assistant_message', text: 'HELLO CAPTURE TEST.' }
    ])
  })

  it('turns a real "● Verb(args)" tool line into tool_activity and preserves a real multi-line markdown reply verbatim', () => {
    const classifier = new AntigravityClassifier()
    const events = classifier.classify(
      snapshot([
        '',
        '      ▄▀▀▄',
        '  Antigravity CLI 1.1.2',
        'someone@example.com (Google AI Pro)',
        'Gemini 3.1 Pro (High)',
        '~/some/workspace',
        '',
        '────────────────────────────',
        '> Create a file named capture-test.txt containing the word hi.',
        '',
        '▸ Thought for 1s, 549 tokens',
        '  Prioritizing Tool Usage',
        '',
        '● Create(C:/scratch/capture-test.txt) (ctrl+o to expand)',
        '',
        '▸ Thought for 7s, 273 tokens',
        '  Prioritizing Tool Usage',
        '  I have created the file for you. You can find it at: capture-test.txt.',
        '',
        '  ### Summary of Work Done:',
        '',
        '  • Created the file  capture-test.txt  in the scratch directory.',
        '  • Added the word "hi" to the file as requested.',
        '',
        '────────────────────────────',
        '>',
        '────────────────────────────',
        '? for shortcuts                                            Gemini 3.1 Pro (High)'
      ])
    )
    expect(events).toEqual([
      { type: 'activity', label: 'Thinking', elapsedMs: 1000 },
      { type: 'tool_activity', label: 'Create(C:/scratch/capture-test.txt)', status: 'done' },
      { type: 'activity', label: 'Thinking', elapsedMs: 7000 },
      {
        type: 'assistant_message',
        text:
          'I have created the file for you. You can find it at: capture-test.txt.\n' +
          '### Summary of Work Done:\n' +
          '• Created the file  capture-test.txt  in the scratch directory.\n' +
          '• Added the word "hi" to the file as requested.'
      }
    ])
  })

  it('classifies a generic y/n confirmation as permission_required', () => {
    const classifier = new AntigravityClassifier()
    // A menu can appear before the classifier has ever seen an echoed
    // prompt line in this particular unit test (no banner precedes it here)
    // — feed one first so `sawFirstEcho` flips, matching how a real session
    // always shows its own echo before any prompt can appear.
    classifier.classify(snapshot(['> some earlier prompt']))
    const events = classifier.classify(snapshot(['> some earlier prompt', 'Proceed? (y/n)', 'y. Yes', 'n. No']))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('permission_required')
  })
})
