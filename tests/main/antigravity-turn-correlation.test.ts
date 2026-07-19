// Regression tests for a real, reported turn-misattribution bug: sending
// "Make a simple python script" twice returned an unrelated combined
// greeting both times, and only the THIRD, unrelated message ("Sandwhich!")
// finally triggered the python task's real output — proving the integration
// was not correctly associating prompts, actions, and responses with their
// originating turns.
//
// Root cause (proven via a real captured multi-turn, multi-interaction agy
// session — see AntigravityClassifier.ts's module comment for the full
// account): AntigravityClassifier used a monotonically-advancing line-count
// watermark to decide "what's new since I last looked". agy does not render
// append-only — it redraws its own screen (echoed prompt, tool-call lines,
// reply text, not just decorative chrome) via absolute cursor positioning,
// sometimes into rows the watermark had already marked processed. That let
// real content be silently skipped forever, while a SEPARATE, watermark-
// independent footer check could still mark the turn "complete" — so a turn
// could resolve having classified none of its own real output, and/or with
// its own protective "ignore chrome" gate opening on unrelated content
// (agy's persistent, always-present empty composer-box line also starts
// with ">"), letting leftover/startup content leak through as if it were
// the genuine reply.
//
// Fixed with: turn-scoped, content-verified echo detection
// (looksLikePromptEcho, scanForTurnEcho) instead of a bare ">" match; a
// content-keyed (not index-keyed) dedup set so the whole buffer can be
// safely re-scanned every snapshot without re-emitting already-classified
// lines; a precise interaction-menu boundary (menuStartIndex) instead of a
// blind fixed-size tail exclusion; and a busy-evidence-or-grace-period gate
// before trusting an idle footer as this turn's own completion.
//
// Adapter-level (real process lifecycle) tests for this same bug live in
// antigravity-turn-correlation-adapter.test.ts (needs its own vi.mock setup
// at module scope).
import { describe, expect, it } from 'vitest'
import { AntigravityClassifier } from '../../src/main/agents/antigravity/AntigravityClassifier'
import { AntigravityEventMapper, createAntigravityMapperState } from '../../src/main/agents/antigravity/AntigravityEventMapper'
import type { ScreenSnapshot } from '../../src/main/terminal/TerminalScreenBuffer'

function snapshot(lines: string[]): ScreenSnapshot {
  return { lines, cursorRow: lines.length, cursorCol: 0, atRestingPosition: true, raw: '' }
}

const SESSION_ID = 's1'

describe('Antigravity turn correlation — regression tests for the reported misattribution bug', () => {
  // Test 1: first prompt works.
  it('a fresh session\'s first real prompt is submitted exactly once and its own real work is correctly classified — no second message required, no startup greeting substituted', () => {
    const classifier = new AntigravityClassifier()
    classifier.beginTurn('Make a simple python script')

    // Real captured shape: banner + "not signed in" + spinner, all BEFORE
    // this turn's own echo — must never be treated as this turn's reply.
    const preEcho = classifier.classify(
      snapshot([
        '      ▄▀▀▄        Antigravity CLI 1.1.4',
        'Welcome to the Antigravity CLI. You are currently not signed in.',
        '⣷  Signing in...'
      ])
    )
    // detectAuthRequired fires here (real behavior) — never assistant content.
    expect(preEcho.every((e) => e.type !== 'assistant_message')).toBe(true)

    // Trust prompt, answered.
    const trust = classifier.classify(
      snapshot([
        'Accessing workspace:',
        '~/project',
        'Do you trust the contents of this project?',
        '› Yes, I trust this folder',
        '  No, exit',
        '↑/↓ Navigate · enter Confirm'
      ])
    )
    expect(trust).toHaveLength(1)
    expect(trust[0].type).toBe('permission_required')

    // Real work happens — echo, thinking, tool calls, busy footer. Events
    // accumulate across snapshots exactly like the real pipeline (each
    // classify() call's output is forwarded to listeners as it arrives, not
    // just the very last call's) — so assertions check the full sequence,
    // not only whichever snapshot happened to settle last.
    const allEvents = [...preEcho, ...trust]
    allEvents.push(
      ...classifier.classify(
        snapshot([
          '      ▄▀▀▄        Antigravity CLI 1.1.4',
          '> Make a simple python script',
          '',
          '▸ Thought for 3s, 100 tokens',
          '  Prioritizing Tool Usage',
          '',
          '● Create(hello.py) (ctrl+o to expand)',
          '',
          'esc to cancel                                               Gemini 3.1 Pro (High)'
        ])
      )
    )

    // Settles idle with the real reply.
    allEvents.push(
      ...classifier.classify(
        snapshot([
          '      ▄▀▀▄        Antigravity CLI 1.1.4',
          '> Make a simple python script',
          '',
          '▸ Thought for 3s, 100 tokens',
          '  Prioritizing Tool Usage',
          '',
          '● Create(hello.py) (ctrl+o to expand)',
          '',
          '  I created hello.py for you.',
          '',
          '────────────',
          '>',
          '────────────',
          '? for shortcuts                                             Gemini 3.1 Pro (High)'
        ])
      )
    )

    expect(allEvents).toContainEqual({ type: 'tool_activity', label: 'Create(hello.py)', status: 'done' })
    expect(allEvents).toContainEqual({ type: 'assistant_message', text: 'I created hello.py for you.' })
    expect(allEvents).toContainEqual({ type: 'turn_ready' })
    // No startup/greeting substitution anywhere in the whole sequence.
    expect(
      allEvents.some((e) => e.type === 'assistant_message' && /how can i help|what's on your mind/i.test((e as { text: string }).text))
    ).toBe(false)
  })

  // Test 2: prompts are not delayed — a later, unrelated message must never
  // receive an earlier turn's output, and vice versa.
  it('CRITICAL: the python task\'s output belongs to message 1, and "Sandwhich!"\'s reply belongs to message 2 — no output shifts forward by one turn', () => {
    const classifier = new AntigravityClassifier()

    // Turn 1: real python-script work, ending idle.
    classifier.beginTurn('Make a simple python script')
    classifier.classify(snapshot(['> Make a simple python script', 'esc to cancel   Gemini 3.1 Pro (High)']))
    const turn1 = classifier.classify(
      snapshot([
        '> Make a simple python script',
        'esc to cancel   Gemini 3.1 Pro (High)',
        '',
        '● Create(hello.py) (ctrl+o to expand)',
        '',
        '  Done — created hello.py.',
        '',
        '? for shortcuts   Gemini 3.1 Pro (High)'
      ])
    )
    const turn1Mapped = AntigravityEventMapper.map(turn1, createAntigravityMapperState(), SESSION_ID, 't1')
    expect(turn1Mapped.events).toContainEqual({
      sessionId: SESSION_ID,
      turnId: 't1',
      type: 'assistant_delta',
      messageId: 't1:m0',
      textDelta: 'Done — created hello.py.'
    })

    // Turn 2: a completely unrelated message, textually distinct from turn 1.
    classifier.beginTurn('Sandwhich!')
    const base = [
      '> Make a simple python script',
      'esc to cancel   Gemini 3.1 Pro (High)',
      '',
      '● Create(hello.py) (ctrl+o to expand)',
      '',
      '  Done — created hello.py.',
      '',
      '? for shortcuts   Gemini 3.1 Pro (High)'
    ]
    classifier.classify(snapshot([...base, '> Sandwhich!', 'esc to cancel   Gemini 3.1 Pro (High)']))
    const turn2 = classifier.classify(
      snapshot([...base, '> Sandwhich!', 'esc to cancel   Gemini 3.1 Pro (High)', '', '  Ha! Good one.', '', '? for shortcuts   Gemini 3.1 Pro (High)'])
    )
    const turn2Mapped = AntigravityEventMapper.map(turn2, createAntigravityMapperState(), SESSION_ID, 't2')

    // Turn 2 must NOT contain turn 1's content re-emitted...
    expect(turn2Mapped.events.some((e) => e.type === 'assistant_delta' && (e as { textDelta: string }).textDelta.includes('hello.py'))).toBe(
      false
    )
    // ...and must contain its own, correct, distinct reply.
    expect(turn2Mapped.events).toContainEqual({
      sessionId: SESSION_ID,
      turnId: 't2',
      type: 'assistant_delta',
      messageId: 't2:m0',
      textDelta: 'Ha! Good one.'
    })
  })

  // Test 3: duplicate events must not produce duplicate visible content.
  it('a repeated/cumulative snapshot of the same content is deduplicated — visible text appears once', () => {
    const classifier = new AntigravityClassifier()
    classifier.beginTurn('go')
    classifier.classify(snapshot(['> go', 'esc to cancel   Gemini 3.1 Pro (High)']))
    const first = classifier.classify(snapshot(['> go', 'esc to cancel   Gemini 3.1 Pro (High)', '', '  Working on it.']))
    // Exact same buffer content re-observed (a real captured redraw
    // re-painting the identical row) — must not re-emit "Working on it."
    const second = classifier.classify(snapshot(['> go', 'esc to cancel   Gemini 3.1 Pro (High)', '', '  Working on it.']))

    expect(first).toContainEqual({ type: 'assistant_message', text: 'Working on it.' })
    expect(second.some((e) => e.type === 'assistant_message')).toBe(false)

    // Confirms at the mapper level too — the final assembled text contains
    // "Working on it." exactly once, not twice.
    const mapped1 = AntigravityEventMapper.map(first, createAntigravityMapperState(), SESSION_ID, 't1')
    const mapped2 = AntigravityEventMapper.map(second, mapped1.state, SESSION_ID, 't1')
    expect(mapped2.state.accumulatedText.match(/Working on it\./g)).toHaveLength(1)
  })

  // Test 4: an intermediate assistant message followed by the canonical
  // final response must not duplicate or garble the final text.
  it('an intermediate partial reply followed by the settled final reply produces one clean final message, not a duplicated/garbled concatenation', () => {
    const classifier = new AntigravityClassifier()
    classifier.beginTurn('summarize')
    classifier.classify(snapshot(['> summarize', 'esc to cancel   Gemini 3.1 Pro (High)']))

    // Intermediate: only the first sentence has streamed in so far.
    const intermediate = classifier.classify(
      snapshot(['> summarize', 'esc to cancel   Gemini 3.1 Pro (High)', '', '  Here is the summary:'])
    )
    // Final: the complete reply has settled (the intermediate line is
    // extended in place, a real captured behavior).
    const final = classifier.classify(
      snapshot([
        '> summarize',
        'esc to cancel   Gemini 3.1 Pro (High)',
        '',
        '  Here is the summary: the project builds and all tests pass.',
        '',
        '? for shortcuts   Gemini 3.1 Pro (High)'
      ])
    )

    const state0 = createAntigravityMapperState()
    const m1 = AntigravityEventMapper.map(intermediate, state0, SESSION_ID, 't1')
    const m2 = AntigravityEventMapper.map(final, m1.state, SESSION_ID, 't1')
    const completed = m2.events.find((e) => e.type === 'assistant_completed')
    expect(completed).toBeDefined()
    expect((completed as { text: string }).text).toBe('Here is the summary: the project builds and all tests pass.')
    // The stale intermediate fragment is not duplicated into the final text.
    expect((completed as { text: string }).text.match(/Here is the summary/g)).toHaveLength(1)
  })

  // Test 5: startup chatter before this turn's echo must never be treated
  // as the answer to the real prompt — but a genuine greeting AFTER a real
  // echo, in response to an actual greeting, is still shown normally.
  it('startup/session chatter before this turn\'s echo is never substituted for the real reply, but a genuine post-echo greeting is displayed normally', () => {
    const classifier = new AntigravityClassifier()
    classifier.beginTurn('Make a simple python script')

    // Real captured shape: agy's persistent EMPTY composer box (bare ">")
    // appears before the real prompt's own echo — must not be mistaken for
    // it, and nothing between them may leak through as prose.
    const preEcho = classifier.classify(
      snapshot([
        '      ▄▀▀▄        Antigravity CLI 1.1.4',
        'Generating...',
        '────────────',
        '>',
        '────────────',
        'esc to cancel                                               Gemini 3.1 Pro (High)'
      ])
    )
    expect(preEcho.some((e) => e.type === 'assistant_message')).toBe(false)

    const afterRealEcho = classifier.classify(
      snapshot([
        '      ▄▀▀▄        Antigravity CLI 1.1.4',
        'Generating...',
        '────────────',
        '>',
        '────────────',
        'esc to cancel                                               Gemini 3.1 Pro (High)',
        '> Make a simple python script',
        '',
        '  Here is a simple script.'
      ])
    )
    expect(afterRealEcho).toContainEqual({ type: 'assistant_message', text: 'Here is a simple script.' })

    // A genuine greeting IS still shown normally when the user's turn
    // actually was a greeting.
    const classifier2 = new AntigravityClassifier()
    classifier2.beginTurn('Hi there!')
    const greetingReply = classifier2.classify(snapshot(['> Hi there!', '', '  Hello! How can I help you today?']))
    expect(greetingReply).toContainEqual({ type: 'assistant_message', text: 'Hello! How can I help you today?' })
  })

  // Test 6: action/tool events must stay attached to the turn that actually
  // produced them, even while a later turn exists or is queued.
  it('tool/action events for turn A remain attached to turn A, even after turn B has begun', () => {
    const classifier = new AntigravityClassifier()
    classifier.beginTurn('turn A prompt')
    classifier.classify(snapshot(['> turn A prompt', 'esc to cancel   Gemini 3.1 Pro (High)']))
    const turnAEvents = classifier.classify(
      snapshot(['> turn A prompt', 'esc to cancel   Gemini 3.1 Pro (High)', '', '● Create(fileA.txt) (ctrl+o to expand)'])
    )
    const turnAMapped = AntigravityEventMapper.map(turnAEvents, createAntigravityMapperState(), SESSION_ID, 'turnA')
    expect(turnAMapped.events).toContainEqual({
      sessionId: SESSION_ID,
      turnId: 'turnA',
      type: 'activity_completed',
      activityId: 'turnA:tool:0',
      label: 'Create(fileA.txt)',
      tool: 'Create',
      status: 'done'
    })

    // Turn B begins — its own events must carry turnB, never turnA.
    classifier.beginTurn('turn B prompt')
    const base = ['> turn A prompt', 'esc to cancel   Gemini 3.1 Pro (High)', '', '● Create(fileA.txt) (ctrl+o to expand)']
    classifier.classify(snapshot([...base, '> turn B prompt', 'esc to cancel   Gemini 3.1 Pro (High)']))
    const turnBEvents = classifier.classify(
      snapshot([...base, '> turn B prompt', 'esc to cancel   Gemini 3.1 Pro (High)', '', '● Create(fileB.txt) (ctrl+o to expand)'])
    )
    const turnBMapped = AntigravityEventMapper.map(turnBEvents, createAntigravityMapperState(), SESSION_ID, 'turnB')
    // Turn B's own new tool call is correctly attributed.
    expect(turnBMapped.events).toContainEqual({
      sessionId: SESSION_ID,
      turnId: 'turnB',
      type: 'activity_completed',
      activityId: 'turnB:tool:0',
      label: 'Create(fileB.txt)',
      tool: 'Create',
      status: 'done'
    })
    // Turn A's already-classified tool call is not re-emitted under turn B.
    expect(turnBMapped.events.some((e) => 'label' in e && e.label === 'Create(fileA.txt)')).toBe(false)
  })
})
