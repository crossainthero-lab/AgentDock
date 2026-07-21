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
//
// Every test below calls beginTurn(prompt) with the exact prompt text
// before classify() — this mirrors exactly how AntigravityAdapter.send()
// drives the real classifier (see the CRITICAL fix in AntigravityClassifier
// itself: a turn's own echoed prompt must genuinely match what was sent,
// not just be any line starting with ">", which is also how agy's
// always-present empty composer box renders).

describe('AntigravityClassifier (real captures from agy 1.1.1/1.1.2, -i <prompt>)', () => {
  it('filters the entire startup banner (ascii art, account, model, cwd, echoed prompt) and the "Thought for Ns" status, leaving only the real reply', () => {
    const classifier = new AntigravityClassifier()
    classifier.beginTurn('Reply with exactly: HELLO CAPTURE TEST. Do not use any tools.')
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
      // No turn_ready here — the idle footer appears in the very same
      // snapshot as the reply, with no prior busy-footer evidence and no
      // real elapsed time (a synchronous unit test), so the grace-period
      // guard correctly withholds it; see the dedicated turn_ready tests
      // below for that behavior in isolation.
    ])
  })

  it('turns a real "● Verb(args)" tool line into tool_activity and preserves a real multi-line markdown reply verbatim', () => {
    const classifier = new AntigravityClassifier()
    classifier.beginTurn('Create a file named capture-test.txt containing the word hi.')
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

  it('does not emit turn_ready while the busy footer ("esc to cancel") is showing, only once idle AND real busy evidence has been observed', () => {
    const classifier = new AntigravityClassifier()
    classifier.beginTurn('go')
    classifier.classify(snapshot(['> go']))
    const busy = classifier.classify(snapshot(['> go', '', 'esc to cancel                    Gemini 3.1 Pro (High)']))
    expect(busy.some((e) => e.type === 'turn_ready')).toBe(false)

    const idle = classifier.classify(snapshot(['> go', '', 'reply text', '? for shortcuts    Gemini 3.1 Pro (High)']))
    expect(idle).toContainEqual({ type: 'turn_ready' })
  })

  it('CRITICAL (real bug fix): does not emit turn_ready from an idle footer left over from before this turn began — requires genuine evidence (busy observed, or the grace period) since beginTurn()', () => {
    const classifier = new AntigravityClassifier()
    classifier.beginTurn('go')
    // The screen already shows an idle-shaped footer (e.g. leftover from
    // right after a fresh spawn reached its ready state, or right after an
    // interaction was answered) in the very same snapshot as the prompt's
    // own echo, with no busy footer ever observed and no real time having
    // passed — this must NOT be treated as this turn's completion.
    const premature = classifier.classify(snapshot(['> go', '', '? for shortcuts    Gemini 3.1 Pro (High)']))
    expect(premature.some((e) => e.type === 'turn_ready')).toBe(false)

    // Once real busy evidence arrives, then genuinely settles idle, it's trusted.
    classifier.classify(snapshot(['> go', '', 'esc to cancel    Gemini 3.1 Pro (High)']))
    const genuinelyDone = classifier.classify(snapshot(['> go', '', 'a real reply', '? for shortcuts    Gemini 3.1 Pro (High)']))
    expect(genuinelyDone).toContainEqual({ type: 'turn_ready' })
  })

  it('CRITICAL (real bug fix, proven via a real live --conversation resume capture): a stale-looking idle footer with ZERO real content classified is never trusted, even once the elapsed-time grace period alone has passed', async () => {
    // Real capture: `agy --conversation <id> -i <prompt>` (resuming a
    // conversation on a fresh process — exactly what AgentDock spawns for
    // every turn after the first, once the native conversation id is known)
    // redraws its idle composer shell — a footer indistinguishable from
    // IDLE_READY_FOOTER — before it has genuinely started processing the
    // queued prompt. With only the elapsed-time-since-beginTurn() fallback,
    // once real wall-clock time crossed MIN_TURN_GRACE_MS this false-idle
    // screen was trusted as real completion (zero content classified, no
    // echo, no busy evidence) — which then permanently blocked
    // (turnReadySignaled latches true) the turn's real, later completion.
    // Reproduced here with a genuine wait (not a synchronous call, which the
    // grace period alone would already reject for the wrong reason) so
    // elapsed time actually crosses the 800ms grace window while sawTurnEcho
    // and sawBusyThisTurn both remain false, exactly like the real capture.
    const classifier = new AntigravityClassifier()
    classifier.beginTurn('Sandwhich!')
    await new Promise((resolve) => setTimeout(resolve, 900))
    const stillNothingReal = classifier.classify(snapshot(['', '> ', '────', '? for shortcuts    Gemini 3.1 Pro (High)']))
    expect(stillNothingReal.some((e) => e.type === 'turn_ready')).toBe(false)

    // The real echo and reply eventually arrive — now genuine completion is trusted.
    const genuinelyDone = classifier.classify(
      snapshot(['> Sandwhich!', 'esc to cancel    Gemini 3.1 Pro (High)', '', 'a real reply', '? for shortcuts    Gemini 3.1 Pro (High)'])
    )
    expect(genuinelyDone).toContainEqual({ type: 'turn_ready' })
    expect(genuinelyDone).toContainEqual({ type: 'assistant_message', text: 'a real reply' })
  }, 10000)

  it('emits turn_ready only once per turn even across repeated idle snapshots, and again after beginTurn() for a new turn', () => {
    // Lines genuinely accumulate (a real terminal scrollback only grows
    // between snapshots, matching processedLineCount's append-only
    // assumption) — each step below appends strictly new lines rather than
    // rewriting earlier ones, exactly like the other tests' real captures.
    // The busy footer line must have scrolled out of the trailing 3-line
    // window (lines.slice(-3), a fixed-position check) by the time the idle
    // footer is checked, or the tail join still contains "esc to cancel"
    // and the idle check correctly refuses to fire — a blank spacer line
    // pushes it out, matching how real replies always have blank padding
    // around them (see the other tests' real captures).
    const classifier = new AntigravityClassifier()
    classifier.beginTurn('go')
    classifier.classify(snapshot(['> go']))
    classifier.classify(snapshot(['> go', 'esc to cancel    Gemini 3.1 Pro (High)']))
    const first = classifier.classify(
      snapshot(['> go', 'esc to cancel    Gemini 3.1 Pro (High)', '', 'reply', '? for shortcuts    Gemini 3.1 Pro (High)'])
    )
    expect(first).toContainEqual({ type: 'turn_ready' })

    // Screen stays idle (nothing new to send) — must not re-fire.
    const stillIdle = classifier.classify(
      snapshot(['> go', 'esc to cancel    Gemini 3.1 Pro (High)', '', 'reply', '? for shortcuts    Gemini 3.1 Pro (High)'])
    )
    expect(stillIdle.some((e) => e.type === 'turn_ready')).toBe(false)

    classifier.beginTurn('second prompt')
    const base = ['> go', 'esc to cancel    Gemini 3.1 Pro (High)', '', 'reply', '? for shortcuts    Gemini 3.1 Pro (High)']
    classifier.classify(snapshot([...base, '> second prompt']))
    classifier.classify(snapshot([...base, '> second prompt', 'esc to cancel    Gemini 3.1 Pro (High)']))
    const second = classifier.classify(
      snapshot([...base, '> second prompt', 'esc to cancel    Gemini 3.1 Pro (High)', '', 'reply2', '? for shortcuts    Gemini 3.1 Pro (High)'])
    )
    expect(second).toContainEqual({ type: 'turn_ready' })
  })

  it('CRITICAL (real bug fix): a bare "> " composer-box chrome line is never mistaken for this turn\'s own echoed prompt', () => {
    const classifier = new AntigravityClassifier()
    classifier.beginTurn('Make a simple python script')
    // The bare ">" (agy's persistent empty composer box, always present on
    // its main screen) appears BEFORE the real echoed prompt — real
    // captured shape (see AntigravityAdapter's module comment / this
    // investigation's captures). Content in between must stay suppressed as
    // chrome, not leak through as a fabricated assistant reply.
    const chrome = [
      '      ▄▀▀▄        Antigravity CLI 1.1.4',
      '     ▀▀▀▀▀▀       someone@example.com',
      '    ▀▀▀▀▀▀▀▀      Gemini 3.5 Flash (Low)',
      '   ▄▀▀    ▀▀▄     ~/some/workspace',
      '  ▄▀▀      ▀▀▄',
      'Generating...',
      '────────────────────────────',
      '>',
      '────────────────────────────',
      'esc to cancel                                               Gemini 3.5 Flash (Low)'
    ]
    const events = classifier.classify(snapshot(chrome))
    expect(events.some((e) => e.type === 'assistant_message')).toBe(false)

    // The real echo now appears, genuinely appended below the bare-box
    // chrome already in scrollback (a real terminal only grows between
    // snapshots) — from this point on, genuine reply text must be
    // classified normally.
    const afterRealEcho = classifier.classify(
      snapshot([
        ...chrome,
        '> Make a simple python script',
        '',
        '  Here you go.',
        '────────────────────────────',
        '>',
        '────────────────────────────',
        'esc to cancel                                               Gemini 3.5 Flash (Low)'
      ])
    )
    expect(afterRealEcho).toContainEqual({ type: 'assistant_message', text: 'Here you go.' })
  })

  it('suppresses the real captured CSAT survey toast instead of leaking it into the chat as prose', () => {
    const classifier = new AntigravityClassifier()
    classifier.beginTurn('go')
    classifier.classify(snapshot(['> go']))
    const events = classifier.classify(
      snapshot([
        '> go',
        '',
        "How's the CLI experience so far? Help us improve:",
        '[1] Good  [2] Fine  [3] Bad  [0] Skip'
      ])
    )
    expect(events.some((e) => e.type === 'assistant_message')).toBe(false)
  })

  it('suppresses the busy-state footer line ("esc to cancel ... <model>") instead of leaking it into the reply', () => {
    const classifier = new AntigravityClassifier()
    classifier.beginTurn('go')
    classifier.classify(snapshot(['> go']))
    const events = classifier.classify(
      snapshot(['> go', 'a real reply', 'esc to cancel                                               Gemini 3.1 Pro (High)'])
    )
    expect(events).toContainEqual({ type: 'assistant_message', text: 'a real reply' })
  })

  it('detects the real captured Antigravity "not signed in" auth message, not the transient spinner line after it', () => {
    const classifier = new AntigravityClassifier()
    const events = classifier.classify(
      snapshot(['Welcome to the Antigravity CLI. You are currently not signed in.', '', '⣾  Signing in...'])
    )
    expect(events).toEqual([
      { type: 'authentication_required', message: 'Welcome to the Antigravity CLI. You are currently not signed in.' }
    ])
  })

  it('classifies a generic y/n confirmation as permission_required', () => {
    const classifier = new AntigravityClassifier()
    classifier.beginTurn('some earlier prompt')
    // A menu can appear before the classifier has ever seen an echoed
    // prompt line in this particular unit test (no banner precedes it here)
    // — feed one first so sawTurnEcho flips, matching how a real session
    // always shows its own echo before any prompt can appear.
    classifier.classify(snapshot(['> some earlier prompt']))
    const events = classifier.classify(snapshot(['> some earlier prompt', 'Proceed? (y/n)', 'y. Yes', 'n. No']))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('permission_required')
  })

  it('CRITICAL (real bug fix, found via a real captured process-exit sequence): never classifies agy\'s own "Resume with -c" shutdown chrome as part of the reply', () => {
    // Real captured shape: TerminalSessionController emits one final
    // snapshot when the PTY exits (see its own module comment), and if the
    // process had already printed its graceful-shutdown banner by then,
    // that banner is present in the buffer alongside the turn's real,
    // already-displayed reply. Confirmed live: without this filter, the
    // banner got appended straight onto the accumulated assistant text.
    const classifier = new AntigravityClassifier()
    classifier.beginTurn('Create a file named hello.txt containing the word hello')
    const events = classifier.classify(
      snapshot([
        '> Create a file named hello.txt containing the word hello',
        '',
        '▸ Thought for 5s, 275 tokens',
        '  Prioritizing Tool Usage',
        '  I have successfully created the file hello.txt containing the word "hello".',
        '',
        ' How\'s the CLI experience so far? Help us improve:',
        ' [1] Good  [2] Fine  [3] Bad  [0] Skip',
        '',
        '? for shortcuts                                            Gemini 3.1 Pro · low',
        '',
        'Resume with -c (or command below):',
        'agy --conversation=ac1ba0b0-c67a-4813-8bd0-1b86f8e1634d'
      ])
    )
    const proseEvents = events.filter((e) => e.type === 'assistant_message')
    expect(proseEvents).toEqual([
      { type: 'assistant_message', text: 'I have successfully created the file hello.txt containing the word "hello".' }
    ])
    for (const e of proseEvents) {
      if (e.type === 'assistant_message') {
        expect(e.text).not.toContain('Resume with -c')
        expect(e.text).not.toContain('agy --conversation=')
      }
    }
  })
})
