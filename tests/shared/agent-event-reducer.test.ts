import { describe, expect, it } from 'vitest'
import {
  applyEnvelope,
  beginRetry,
  beginSend,
  clearPendingInteraction,
  createReducerState,
  forceCompleteStaleTurn,
  markFailed,
  markSent,
  seedFromPersisted,
  type AgentEventReducerState
} from '../../src/shared/events/AgentEventReducer'
import { summarizeActivity } from '../../src/shared/events/AgentActivityTracker'
import type { AgentEvent } from '../../src/shared/events/agent-event'
import type { SessionMessage } from '../../src/shared/types'

const SESSION_ID = 's1'

function send(state: AgentEventReducerState, text: string, turnId = 't1', now = 0): AgentEventReducerState {
  return beginSend(state, { sessionId: SESSION_ID, userMessageId: `u:${turnId}`, turnId, text, agentDisplayName: 'Claude Code' }, now)
}

function envelope(event: Omit<AgentEvent, 'sessionId' | 'turnId'>, sequence: number, turnId = 't1', eventId = `e${sequence}`) {
  return { event: { ...event, sessionId: SESSION_ID, turnId } as AgentEvent, sequence, eventId }
}

describe('immediate user message', () => {
  it('inserts the user message synchronously, before any event ever arrives', () => {
    let state = createReducerState()
    expect(state.items).toHaveLength(0)
    state = send(state, 'do the thing')
    expect(state.items).toEqual([expect.objectContaining({ kind: 'user', text: 'do the thing', deliveryState: 'sending' })])
    expect(state.isBusy).toBe(true)
  })

  it('shows the working label immediately, using the agent display name, before any classified activity', () => {
    let state = createReducerState()
    state = send(state, 'go')
    expect(state.currentPhrase).toBe('Claude Code is working…')
  })

  it('marks the message sent once the write succeeds', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = markSent(state, 'u:t1')
    const user = state.items.find((i) => i.kind === 'user')
    expect(user).toMatchObject({ deliveryState: 'sent' })
  })

  it('keeps the message visible and marks it failed (with retry available) if delivery fails', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = markFailed(state, 'u:t1', 'claude-code is not installed.')
    const user = state.items.find((i) => i.kind === 'user')
    expect(user).toMatchObject({ deliveryState: 'failed', text: 'go' })
    expect(state.error).toBe('claude-code is not installed.')
    expect(state.isBusy).toBe(false)
  })

  it('retrying a failed message reuses the same item id instead of creating a new bubble', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = markFailed(state, 'u:t1', 'boom')
    state = beginRetry(state, { sessionId: SESSION_ID, userMessageId: 'u:t1', text: 'go', turnId: 't2', agentDisplayName: 'Claude Code' })
    expect(state.items.filter((i) => i.kind === 'user')).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ deliveryState: 'sending' })
    expect(state.turn?.id).toBe('t2')
  })

  it("drops an assistant_delta that exactly echoes the user's own submitted prompt", () => {
    let state = createReducerState()
    state = send(state, 'echo test prompt')
    const result = applyEnvelope(state, envelope({ type: 'assistant_delta', messageId: 'm1', textDelta: 'echo test prompt' }, 1))
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe('echo')
    expect(result.state.items.filter((i) => i.kind === 'assistant')).toHaveLength(0)
  })

  it('does not suppress a real reply that merely quotes part of the prompt', () => {
    let state = createReducerState()
    state = send(state, 'summarize this file')
    const result = applyEnvelope(
      state,
      envelope({ type: 'assistant_delta', messageId: 'm1', textDelta: 'Sure — "summarize this file" is a good idea, here it is:' }, 1)
    )
    expect(result.accepted).toBe(true)
    expect(result.state.items.filter((i) => i.kind === 'assistant')).toHaveLength(1)
  })
})

describe('assistant reply appears exactly once', () => {
  it('streams multiple deltas of one response into a single stable assistant item, addressed by messageId', () => {
    let state = createReducerState()
    state = send(state, 'go')
    let result = applyEnvelope(state, envelope({ type: 'assistant_delta', messageId: 'm1', textDelta: 'Hello' }, 1))
    result = applyEnvelope(result.state, envelope({ type: 'assistant_delta', messageId: 'm1', textDelta: ' world' }, 2))
    state = result.state

    const assistantItems = state.items.filter((i) => i.kind === 'assistant')
    expect(assistantItems).toHaveLength(1)
    expect(assistantItems[0]).toMatchObject({ text: 'Hello world' })
  })

  it('a turn can produce more than one assistant message (agentic loop: text, tool call, more text)', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'assistant_delta', messageId: 'm1', textDelta: 'Looking...' }, 1)).state
    state = applyEnvelope(state, envelope({ type: 'assistant_completed', messageId: 'm1', text: 'Looking...' }, 2)).state
    state = applyEnvelope(state, envelope({ type: 'assistant_delta', messageId: 'm2', textDelta: 'Found it.' }, 3)).state

    const assistantItems = state.items.filter((i) => i.kind === 'assistant')
    expect(assistantItems.map((i) => (i.kind === 'assistant' ? i.text : ''))).toEqual(['Looking...', 'Found it.'])
  })

  it('assistant_completed does not duplicate/overwrite text already delivered via deltas', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'assistant_delta', messageId: 'm1', textDelta: 'pong' }, 1)).state
    state = applyEnvelope(state, envelope({ type: 'assistant_completed', messageId: 'm1', text: 'pong' }, 2)).state

    const assistantItems = state.items.filter((i) => i.kind === 'assistant')
    expect(assistantItems).toHaveLength(1)
    expect(assistantItems[0]).toMatchObject({ text: 'pong' })
  })

  it('assistant_completed seeds the message when no delta ever arrived for it (Codex-style non-streaming reply)', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'assistant_completed', messageId: 'm1', text: 'pong' }, 1)).state

    const assistantItems = state.items.filter((i) => i.kind === 'assistant')
    expect(assistantItems).toHaveLength(1)
    expect(assistantItems[0]).toMatchObject({ text: 'pong' })
  })

  it('a final turn_completed event after streaming does not duplicate the streamed message', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'assistant_delta', messageId: 'm1', textDelta: 'Hello' }, 1)).state
    state = applyEnvelope(state, envelope({ type: 'turn_completed' }, 2)).state

    expect(state.items.filter((i) => i.kind === 'assistant')).toHaveLength(1)
  })

  it('ignores a redelivered envelope with an already-applied sequence number', () => {
    let state = createReducerState()
    state = send(state, 'go')
    const first = applyEnvelope(state, envelope({ type: 'assistant_delta', messageId: 'm1', textDelta: 'Hello' }, 1))
    const redelivered = applyEnvelope(first.state, envelope({ type: 'assistant_delta', messageId: 'm1', textDelta: 'Hello' }, 1))

    expect(redelivered.accepted).toBe(false)
    expect(redelivered.reason).toBe('duplicate_sequence')
    expect(redelivered.state.items.filter((i) => i.kind === 'assistant')).toHaveLength(1)
    expect(redelivered.state.items.find((i) => i.kind === 'assistant')).toMatchObject({ text: 'Hello' })
  })

  it('ignores a redelivered eventId even under a new sequence number', () => {
    let state = createReducerState()
    state = send(state, 'go')
    const first = applyEnvelope(state, envelope({ type: 'assistant_delta', messageId: 'm1', textDelta: 'Hello' }, 1, 't1', 'evt-A'))
    const redelivered = applyEnvelope(first.state, envelope({ type: 'assistant_delta', messageId: 'm1', textDelta: ' world' }, 2, 't1', 'evt-A'))

    expect(redelivered.accepted).toBe(false)
    expect(redelivered.state.items.find((i) => i.kind === 'assistant')).toMatchObject({ text: 'Hello' })
  })

  it('seedFromPersisted (mount/session-switch only) never runs again mid-turn, so there is nothing to duplicate against', () => {
    const persisted: SessionMessage[] = [
      { id: 'm1', sessionId: SESSION_ID, role: 'assistant', content: { kind: 'text', text: 'earlier reply' }, createdAt: new Date(0).toISOString() }
    ]
    let state = seedFromPersisted(persisted)
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'assistant_delta', messageId: 'm2', textDelta: 'new reply' }, 1)).state

    const assistantTexts = state.items.filter((i) => i.kind === 'assistant').map((i) => (i.kind === 'assistant' ? i.text : ''))
    expect(assistantTexts).toEqual(['earlier reply', 'new reply'])
  })
})

describe('turn isolation — the core fix for cross-turn/cross-session corruption', () => {
  it('an event carrying a different turnId than the currently-open turn is rejected, not merged in', () => {
    let state = createReducerState()
    state = send(state, 'go', 't1')
    const result = applyEnvelope(state, envelope({ type: 'assistant_delta', messageId: 'm1', textDelta: 'wrong turn' }, 1, 'stale-turn'))
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe('stale_turn')
    expect(result.state.items.filter((i) => i.kind === 'assistant')).toHaveLength(0)
  })

  it('once a turn completes, a late-arriving delta for that same turnId is rejected, not appended', () => {
    let state = createReducerState()
    state = send(state, 'go', 't1')
    state = applyEnvelope(state, envelope({ type: 'assistant_delta', messageId: 'm1', textDelta: 'Hello' }, 1, 't1')).state
    state = applyEnvelope(state, envelope({ type: 'turn_completed' }, 2, 't1')).state

    const late = applyEnvelope(state, envelope({ type: 'assistant_delta', messageId: 'm1', textDelta: ' world' }, 3, 't1'))
    expect(late.accepted).toBe(false)
    expect(late.reason).toBe('stale_turn')
    expect(late.state.items.find((i) => i.kind === 'assistant')).toMatchObject({ text: 'Hello' })
  })

  it('a new turn never merges with a coincidentally-reused messageId from a prior turn', () => {
    let state = createReducerState()
    state = send(state, 'first', 't1')
    state = applyEnvelope(state, envelope({ type: 'assistant_completed', messageId: 'm1', text: 'first reply' }, 1, 't1')).state
    state = applyEnvelope(state, envelope({ type: 'turn_completed' }, 2, 't1')).state

    state = send(state, 'second', 't2')
    state = applyEnvelope(state, envelope({ type: 'assistant_completed', messageId: 'm1', text: 'second reply' }, 3, 't2')).state

    const assistantTexts = state.items.filter((i) => i.kind === 'assistant').map((i) => (i.kind === 'assistant' ? i.text : ''))
    expect(assistantTexts).toEqual(['first reply', 'second reply'])
  })
})

describe('working / thinking state', () => {
  it('sending a prompt immediately opens a submitted turn', () => {
    let state = createReducerState()
    state = send(state, 'go')
    expect(state.currentPhrase).toBe('Claude Code is working…')
    expect(state.turn).toMatchObject({ status: 'submitted', id: 't1' })
  })

  it('turn_started moves a submitted turn to working', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'turn_started' }, 1)).state
    expect(state.turn?.status).toBe('working')
  })

  it('an activity_started/updated pair updates the phrase rather than adding a second row', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'activity_started', activityId: 'a1', label: 'Read(a.ts)' }, 1)).state
    expect(state.currentPhrase).toBe('Reading files…')
    expect(state.items.filter((i) => i.kind === 'tool-activity')).toHaveLength(1)

    state = applyEnvelope(state, envelope({ type: 'activity_updated', activityId: 'a1', elapsedMs: 500 }, 2)).state
    expect(state.items.filter((i) => i.kind === 'tool-activity')).toHaveLength(1)
  })

  it('tool activity appends one tool-activity item per activityId', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'activity_started', activityId: 'a1', label: 'Read(a.ts)', tool: 'Read' }, 1)).state
    state = applyEnvelope(state, envelope({ type: 'activity_completed', activityId: 'a1', label: 'Read(a.ts)', tool: 'Read', status: 'done' }, 2)).state
    expect(state.items.filter((i) => i.kind === 'tool-activity')).toHaveLength(1)

    state = applyEnvelope(state, envelope({ type: 'activity_started', activityId: 'a2', label: 'Bash(npm test)', tool: 'Bash' }, 3)).state
    expect(state.currentPhrase).toBe('Running command…')
    state = applyEnvelope(state, envelope({ type: 'activity_completed', activityId: 'a2', label: 'Bash(npm test)', tool: 'Bash', status: 'done' }, 4)).state
    expect(state.items.filter((i) => i.kind === 'tool-activity')).toHaveLength(2)
  })

  it('assistant output begins streaming into one assistant message once real text arrives', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'activity_started', activityId: 'a1', label: 'Pondering' }, 1)).state
    state = applyEnvelope(state, envelope({ type: 'assistant_delta', messageId: 'm1', textDelta: 'Done.' }, 2)).state
    expect(state.turn?.status).toBe('streaming')
    expect(state.items.filter((i) => i.kind === 'assistant')).toHaveLength(1)
  })

  it('turn_completed clears the working state', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'activity_started', activityId: 'a1', label: 'Pondering' }, 1)).state
    state = applyEnvelope(state, envelope({ type: 'turn_completed' }, 2)).state
    expect(state.currentPhrase).toBeNull()
    expect(state.isBusy).toBe(false)
    expect(state.turn?.status).toBe('complete')
  })

  it('clears the working state even if the turn completes without ever producing assistant text', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'turn_completed' }, 1)).state
    expect(state.currentPhrase).toBeNull()
    expect(state.isBusy).toBe(false)
  })

  it('turn_failed replaces the working indicator with a visible error item', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'turn_failed', reason: 'process crashed' }, 1)).state
    expect(state.currentPhrase).toBeNull()
    expect(state.isBusy).toBe(false)
    expect(state.turn?.status).toBe('failed')
    expect(state.items.some((i) => i.kind === 'system' && i.role === 'error' && i.text === 'process crashed')).toBe(true)
  })

  it('a stuck turn cannot leave a permanent Working indicator — the fallback timeout force-completes it', () => {
    let state = createReducerState()
    state = send(state, 'go', 't1', 0)
    const stillWithinLimit = forceCompleteStaleTurn(state, 60_000, 30_000)
    expect(stillWithinLimit.isBusy).toBe(true)

    const timedOut = forceCompleteStaleTurn(state, 60_000, 61_000)
    expect(timedOut.isBusy).toBe(false)
    expect(timedOut.turn?.status).toBe('failed')
    expect(timedOut.currentPhrase).toBeNull()
  })

  it('the fallback timeout never fires once a turn has already completed normally', () => {
    let state = createReducerState()
    state = send(state, 'go', 't1', 0)
    state = applyEnvelope(state, envelope({ type: 'turn_completed' }, 1, 't1', 'e1'), 100).state
    const afterTimeout = forceCompleteStaleTurn(state, 60_000, 999_999)
    expect(afterTimeout).toEqual(state)
  })
})

describe('pending interactions', () => {
  it('keeps at most one pending interaction at a time', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(
      state,
      envelope({ type: 'interaction_required', interaction: { kind: 'permission', interactionId: 'i1', prompt: 'Allow?', options: [{ id: 'y', label: 'Yes' }] } }, 1)
    ).state
    expect(state.pendingInteraction).toEqual({ kind: 'permission', interactionId: 'i1', prompt: 'Allow?', options: [{ id: 'y', label: 'Yes' }] })

    state = applyEnvelope(
      state,
      envelope({ type: 'interaction_required', interaction: { kind: 'choice', interactionId: 'i2', prompt: 'Pick one', options: [] } }, 2)
    ).state
    expect(state.pendingInteraction?.kind).toBe('choice')
    expect(state.turn?.status).toBe('awaiting_interaction')
  })

  it('clears the pending interaction only when explicitly resolved', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(
      state,
      envelope({ type: 'interaction_required', interaction: { kind: 'terminal_attention', interactionId: 'i1', reason: 'unknown prompt' } }, 1)
    ).state
    expect(state.pendingInteraction).not.toBeNull()
    state = clearPendingInteraction(state)
    expect(state.pendingInteraction).toBeNull()
  })
})

describe('activity aggregate summary (AgentActivityTracker, reused as-is)', () => {
  it('turns an in-order stream of activity events into the "Worked for Ns · Read N files · Edited N files" summary', () => {
    let state = createReducerState()
    state = send(state, 'go', 't1', 0)
    const events: Omit<AgentEvent, 'sessionId' | 'turnId'>[] = [
      { type: 'activity_started', activityId: 'a0', label: 'Pondering' },
      { type: 'activity_updated', activityId: 'a0', elapsedMs: 12000 },
      { type: 'activity_started', activityId: 'a1', label: 'Read(a.ts)', tool: 'Read' },
      { type: 'activity_completed', activityId: 'a1', label: 'Read(a.ts)', tool: 'Read', status: 'done' },
      { type: 'activity_started', activityId: 'a2', label: 'Read(b.ts)', tool: 'Read' },
      { type: 'activity_completed', activityId: 'a2', label: 'Read(b.ts)', tool: 'Read', status: 'done' },
      { type: 'activity_started', activityId: 'a3', label: 'Write(c.ts)', tool: 'Write' },
      { type: 'activity_completed', activityId: 'a3', label: 'Write(c.ts)', tool: 'Write', status: 'done' }
    ]
    let seq = 1
    for (const e of events) state = applyEnvelope(state, envelope(e, seq++)).state

    expect(summarizeActivity(state.activity, 0)).toBe('Worked for 12s · Read 2 files · Edited 1 file')
  })
})
