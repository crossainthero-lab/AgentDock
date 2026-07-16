import { describe, expect, it } from 'vitest'
import { CodexClassifier } from '../../src/main/agents/codex/CodexClassifier'
import { AntigravityClassifier } from '../../src/main/agents/antigravity/AntigravityClassifier'
import type { ScreenSnapshot } from '../../src/main/terminal/TerminalScreenBuffer'

function snapshot(lines: string[]): ScreenSnapshot {
  return { lines, cursorRow: lines.length, cursorCol: 0, atRestingPosition: true, raw: '' }
}

// The two blocks of fixtures below are real transcripts captured via a real
// node-pty session driving the exact argv CodexAdapter/AntigravityAdapter
// build (--no-alt-screen / -i), then resolved through the real
// TerminalScreenBuffer (not hand-typed) — same evidentiary standard as
// claude-classifier.test.ts. Paths are shortened for readability; the
// meaningful markers (│ ╭ ╰ ■ • › box/bullet glyphs, the "<model> · <cwd>"
// footer shape) are verbatim.

describe('CodexClassifier (real captures from codex-cli 0.144.1, --no-alt-screen)', () => {
  it('extracts only the real reply from a full startup+reply screen, filtering the update banner, "OpenAI Codex" banner, system notice, and composer echo/footer chrome', () => {
    const classifier = new CodexClassifier()
    const events = classifier.classify(
      snapshot([
        '',
        '╭─────────────────────────────────────────╮',
        '│ ✨ Update available! 0.144.1 -> 0.144.3  │',
        '│ Run ... to update.                       │',
        '╰─────────────────────────────────────────╯',
        '',
        '■ No active thread is available.',
        '',
        '╭──────────────────────────────╮',
        '│ >_ OpenAI Codex (v0.144.1)   │',
        '│ model:     gpt-5.5 high      │',
        '│ directory: ~\\some\\project    │',
        '╰──────────────────────────────╯',
        '',
        '  Tip: New Use /fast to enable our fastest inference with increased plan usage.',
        '',
        '› Reply with exactly: HELLO CAPTURE TEST. Do not use any tools.',
        '',
        '• You have 4 usage limit resets available. Run /usage to use one.',
        '',
        '• HELLO CAPTURE TEST',
        '',
        '› Write tests for @filename',
        '',
        '  gpt-5.5 high · ~\\some\\project'
      ])
    )
    expect(events).toEqual([{ type: 'assistant_message', text: 'HELLO CAPTURE TEST' }])
  })

  it('turns a real "Added <file> (+N -M)" bullet into tool_activity and swallows its indented diff line, without losing the reply that preceded it', () => {
    const classifier = new CodexClassifier()
    const events = classifier.classify(
      snapshot([
        '› Create a file named capture-test.txt containing the word hi.',
        '',
        '• You have 4 usage limit resets available. Run /usage to use one.',
        '',
        "• I'll create the requested text file in the current workspace.",
        '',
        '• Added capture-test.txt (+1 -0)',
        '    1 +hi',
        ''
      ])
    )
    expect(events).toEqual([
      { type: 'assistant_message', text: "I'll create the requested text file in the current workspace." },
      { type: 'tool_activity', label: 'Added capture-test.txt (+1 -0)', status: 'done' }
    ])
  })

  it('classifies a real sandbox-retry approval as permission_required (real wording is "Would you like to", not "do you want to")', () => {
    const classifier = new CodexClassifier()
    // Simulates the earlier reply/tool-activity lines having already settled
    // and been consumed on a prior snapshot (see TerminalSessionController's
    // idle-debounced snapshotting) — only the menu itself is new here.
    classifier.classify(
      snapshot([
        "• I'll create the requested text file in the current workspace.",
        '',
        '• Added capture-test.txt (+1 -0)',
        '    1 +hi',
        ''
      ])
    )
    const events = classifier.classify(
      snapshot([
        "• I'll create the requested text file in the current workspace.",
        '',
        '• Added capture-test.txt (+1 -0)',
        '    1 +hi',
        '',
        '',
        '  Would you like to make the following edits?',
        '',
        '  Reason: command failed; retry without sandbox?',
        '',
        '› 1. Yes, proceed (y)',
        "  2. Yes, and don't ask again for these files (a)",
        '  3. No, and tell Codex what to do differently (esc)',
        '',
        '  Press enter to confirm or esc to cancel'
      ])
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'permission_required',
      prompt: 'Reason: command failed; retry without sandbox?',
      options: [
        { id: '1', label: 'Yes, proceed (y)' },
        { id: '2', label: "Yes, and don't ask again for these files (a)" },
        { id: '3', label: 'No, and tell Codex what to do differently (esc)' }
      ]
    })
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
