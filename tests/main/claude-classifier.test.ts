import { describe, expect, it } from 'vitest'
import { ClaudeClassifier } from '../../src/main/agents/claude/ClaudeClassifier'
import type { ScreenSnapshot } from '../../src/main/terminal/TerminalScreenBuffer'

function snapshot(lines: string[], overrides: Partial<ScreenSnapshot> = {}): ScreenSnapshot {
  return { lines, cursorRow: lines.length, cursorCol: 0, atRestingPosition: true, raw: '', ...overrides }
}

// All fixtures below are lifted verbatim from real captured `claude`
// (v2.1.207, --ax-screen-reader) sessions — see the plan/commit notes.

describe('ClaudeClassifier', () => {
  it('turns a settled "claude: <reply>" line into one assistant_message', () => {
    const classifier = new ClaudeClassifier()
    const events = classifier.classify(
      snapshot(['you: Run the shell command "echo hello-from-claude"', 'claude: Output: hello-from-claude', 'Brewed for 4s', ''])
    )
    expect(events).toEqual([{ type: 'assistant_message', text: 'Output: hello-from-claude' }])
  })

  it('joins wrapped continuation lines into the same assistant_message', () => {
    const classifier = new ClaudeClassifier()
    const events = classifier.classify(
      snapshot(['claude: Created notes.txt with "hello world" in the testproj', 'folder, as requested.', 'Brewed for 7s', ''])
    )
    expect(events).toEqual([
      { type: 'assistant_message', text: 'Created notes.txt with "hello world" in the testproj\nfolder, as requested.' }
    ])
  })

  it('preserves a code block\'s indentation in a multi-line reply instead of flattening every continuation line', () => {
    const classifier = new ClaudeClassifier()
    const events = classifier.classify(
      snapshot([
        'claude: Here is the function:',
        'def foo():',
        '    return 1',
        'Brewed for 3s',
        ''
      ])
    )
    expect(events).toEqual([
      { type: 'assistant_message', text: 'Here is the function:\ndef foo():\n    return 1' }
    ])
  })

  it('turns a "tool: <Name> (<args>)" line into a tool_activity event, plus the "Running…" status as activity', () => {
    const classifier = new ClaudeClassifier()
    const events = classifier.classify(snapshot(['tool: Bash (echo hello-from-claude)', 'Running…', '']))
    expect(events).toEqual([
      { type: 'tool_activity', label: 'Bash (echo hello-from-claude)', status: 'done' },
      { type: 'activity', label: 'Running', elapsedMs: undefined }
    ])
  })

  it('turns the live spinner line into an activity event with elapsed time', () => {
    const classifier = new ClaudeClassifier()
    const events = classifier.classify(snapshot(['Pondering…   ( 2s  ·  86 tokens )']))
    expect(events).toEqual([{ type: 'activity', label: 'Pondering', elapsedMs: 2000 }])
  })

  it('does not re-emit the same unchanged spinner line twice', () => {
    const classifier = new ClaudeClassifier()
    const line = 'Pondering…   ( 2s  ·  86 tokens )'
    classifier.classify(snapshot([line]))
    const events = classifier.classify(snapshot([line]))
    expect(events).toEqual([])
  })

  it('classifies a real tool-permission block into permission_required with numbered options', () => {
    const classifier = new ClaudeClassifier()
    const events = classifier.classify(
      snapshot([
        'Permission Required: Create file',
        '..\\..\\notes.txt',
        ' 1 hello world',
        'Do you want to create notes.txt?',
        '1. Yes',
        "2. Yes, allow all edits in billy/ during this session (shift+tab)",
        '3. No',
        'Enter selection [1-3], or Escape to cancel:',
        'Esc to cancel · Tab to amend'
      ])
    )
    expect(events).toHaveLength(1)
    const event = events[0]
    expect(event.type).toBe('permission_required')
    if (event.type === 'permission_required') {
      expect(event.prompt).toBe('Do you want to create notes.txt?')
      expect(event.options.map((o) => o.id)).toEqual(['1', '2', '3'])
      expect(event.options[0].label).toBe('Yes')
    }
  })

  it('classifies the real workspace-trust y/n block into permission_required', () => {
    const classifier = new ClaudeClassifier()
    const events = classifier.classify(
      snapshot([
        'Permission Required: Accessing workspace:',
        'C:\\some\\project',
        'Quick safety check: Is this a project you created or one you trust?',
        'y. Yes, I trust this folder',
        'n. No, exit',
        'Enter y/n:',
        'Enter to confirm · Esc to cancel'
      ])
    )
    expect(events).toHaveLength(1)
    const event = events[0]
    expect(event.type).toBe('permission_required')
    if (event.type === 'permission_required') {
      expect(event.options).toEqual([
        { id: 'y', label: 'Yes, I trust this folder' },
        { id: 'n', label: 'No, exit' }
      ])
    }
  })

  it('classifies the real /model picker into choice_required (no "Permission Required" prefix)', () => {
    const classifier = new ClaudeClassifier()
    const events = classifier.classify(
      snapshot([
        'Select model',
        'Switch between Claude models.',
        '1. (selected) Default (recommended) — Sonnet 5',
        '2. Sonnet — Sonnet 5',
        '3. Fable — Fable 5',
        '4. Opus — Opus 4.8',
        '5. Haiku — Haiku 4.5',
        'Enter selection [1-5], or Escape to cancel:'
      ])
    )
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('choice_required')
    if (events[0].type === 'choice_required') {
      expect(events[0].options).toHaveLength(5)
      expect(events[0].options[4]).toEqual({ id: '5', label: 'Haiku — Haiku 4.5' })
    }
  })

  it('does not re-emit an identical unresolved prompt block on the next snapshot', () => {
    const classifier = new ClaudeClassifier()
    const lines = [
      'Permission Required: Create file',
      'notes.txt',
      'Do you want to create notes.txt?',
      '1. Yes',
      '2. No',
      'Enter selection [1-2], or Escape to cancel:'
    ]
    const first = classifier.classify(snapshot(lines))
    const second = classifier.classify(snapshot(lines))
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })

  it('falls back to a generic authentication_required for login-shaped output', () => {
    const classifier = new ClaudeClassifier()
    const events = classifier.classify(snapshot(['Please log in to continue using Claude Code.']))
    expect(events).toEqual([{ type: 'authentication_required', message: 'Please log in to continue using Claude Code.' }])
  })
})
