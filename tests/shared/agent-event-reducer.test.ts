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

function envelope(event: AgentEvent, sequence: number, eventId = `e${sequence}`) {
  return { event, sequence, eventId }
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

  it("drops an assistant_message that exactly echoes the user's own submitted prompt", () => {
    let state = createReducerState()
    state = send(state, 'echo test prompt')
    const result = applyEnvelope(state, envelope({ type: 'assistant_message', text: 'echo test prompt' }, 1))
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe('echo')
    expect(result.state.items.filter((i) => i.kind === 'assistant')).toHaveLength(0)
  })

  it('does not suppress a real reply that merely quotes part of the prompt', () => {
    let state = createReducerState()
    state = send(state, 'summarize this file')
    const result = applyEnvelope(state, envelope({ type: 'assistant_message', text: 'Sure — "summarize this file" is a good idea, here it is:' }, 1))
    expect(result.accepted).toBe(true)
    expect(result.state.items.filter((i) => i.kind === 'assistant')).toHaveLength(1)
  })
})

describe('assistant reply appears exactly once', () => {
  it('streams multiple chunks of one response into a single stable assistant item', () => {
    let state = createReducerState()
    state = send(state, 'go')
    let result = applyEnvelope(state, envelope({ type: 'assistant_message', text: 'Hello' }, 1))
    result = applyEnvelope(result.state, envelope({ type: 'assistant_message', text: ' world' }, 2))
    state = result.state

    const assistantItems = state.items.filter((i) => i.kind === 'assistant')
    expect(assistantItems).toHaveLength(1)
    expect(assistantItems[0]).toMatchObject({ text: 'Hello world' })
  })

  it('a final event after streaming does not duplicate the streamed message', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'assistant_message', text: 'Hello' }, 1)).state
    state = applyEnvelope(state, envelope({ type: 'session_complete', exitCode: 0 }, 2)).state

    expect(state.items.filter((i) => i.kind === 'assistant')).toHaveLength(1)
  })

  it('ignores a redelivered envelope with an already-applied sequence number', () => {
    let state = createReducerState()
    state = send(state, 'go')
    const first = applyEnvelope(state, envelope({ type: 'assistant_message', text: 'Hello' }, 1))
    const redelivered = applyEnvelope(first.state, envelope({ type: 'assistant_message', text: 'Hello' }, 1))

    expect(redelivered.accepted).toBe(false)
    expect(redelivered.reason).toBe('duplicate_sequence')
    expect(redelivered.state.items.filter((i) => i.kind === 'assistant')).toHaveLength(1)
    expect(redelivered.state.items.find((i) => i.kind === 'assistant')).toMatchObject({ text: 'Hello' })
  })

  it('ignores a redelivered eventId even under a new sequence number', () => {
    let state = createReducerState()
    state = send(state, 'go')
    const first = applyEnvelope(state, envelope({ type: 'assistant_message', text: 'Hello' }, 1, 'evt-A'))
    const redelivered = applyEnvelope(first.state, envelope({ type: 'assistant_message', text: ' world' }, 2, 'evt-A'))

    expect(redelivered.accepted).toBe(false)
    expect(redelivered.state.items.find((i) => i.kind === 'assistant')).toMatchObject({ text: 'Hello' })
  })

  it('seedFromPersisted (mount/session-switch only) never runs again mid-turn, so there is nothing to duplicate against', () => {
    const persisted: SessionMessage[] = [
      { id: 'm1', sessionId: SESSION_ID, role: 'assistant', content: { kind: 'text', text: 'earlier reply' }, createdAt: new Date(0).toISOString() }
    ]
    let state = seedFromPersisted(persisted)
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'assistant_message', text: 'new reply' }, 1)).state

    const assistantTexts = state.items.filter((i) => i.kind === 'assistant').map((i) => (i.kind === 'assistant' ? i.text : ''))
    expect(assistantTexts).toEqual(['earlier reply', 'new reply'])
  })
})

describe('working / thinking state', () => {
  it('sending a prompt immediately creates one Working activity', () => {
    let state = createReducerState()
    state = send(state, 'go')
    expect(state.currentPhrase).toBe('Claude Code is working…')
    expect(state.turn).toMatchObject({ status: 'submitted', activityId: `activity:${SESSION_ID}:t1` })
  })

  it('a generic thinking/spinner event updates the same activity rather than adding another', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'activity', label: 'Pondering', elapsedMs: 1000 }, 1)).state
    expect(state.currentPhrase).toBe('Thinking…')
    expect(state.turn?.status).toBe('working')
  })

  it('tool activity updates the phrase and appends one tool-activity item per completed call', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'tool_activity', label: 'Read(a.ts)', status: 'done' }, 1)).state
    expect(state.currentPhrase).toBe('Reading files…')
    expect(state.items.filter((i) => i.kind === 'tool-activity')).toHaveLength(1)

    state = applyEnvelope(state, envelope({ type: 'tool_activity', label: 'Bash(npm test)', status: 'done' }, 2)).state
    expect(state.currentPhrase).toBe('Running command…')
    expect(state.items.filter((i) => i.kind === 'tool-activity')).toHaveLength(2)
  })

  it('assistant output begins streaming into one assistant message once real text arrives', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'activity', label: 'Pondering' }, 1)).state
    state = applyEnvelope(state, envelope({ type: 'assistant_message', text: 'Done.' }, 2)).state
    expect(state.turn?.status).toBe('streaming')
    expect(state.items.filter((i) => i.kind === 'assistant')).toHaveLength(1)
  })

  it('completion clears the working state', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'activity', label: 'Pondering' }, 1)).state
    state = applyEnvelope(state, envelope({ type: 'session_complete', exitCode: 0 }, 2)).state
    expect(state.currentPhrase).toBeNull()
    expect(state.isBusy).toBe(false)
    expect(state.turn?.status).toBe('complete')
  })

  it('clears the working state even if the CLI returns to input-ready without ever producing assistant text', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'session_complete', exitCode: 0 }, 1)).state
    expect(state.currentPhrase).toBeNull()
    expect(state.isBusy).toBe(false)
  })

  it('an error replaces the working indicator with a visible error item', () => {
    let state = createReducerState()
    state = send(state, 'go')
    state = applyEnvelope(state, envelope({ type: 'error', message: 'process crashed' }, 1)).state
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
    state = applyEnvelope(state, envelope({ type: 'session_complete', exitCode: 0 }, 1, 'e1'), 100).state
    const afterTimeout = forceCompleteStaleTurn(state, 60_000, 999_999)
    expect(afterTimeout).toEqual(state)
  })
})

describe('pending interactions (unchanged behavior)', () => {
  it('keeps at most one pending interaction at a time', () => {
    let state = createReducerState()
    state = applyEnvelope(
      state,
      envelope({ type: 'permission_required', interactionId: 'i1', prompt: 'Allow?', options: [{ id: 'y', label: 'Yes' }] }, 1)
    ).state
    expect(state.pendingInteraction).toEqual({ kind: 'permission', interactionId: 'i1', prompt: 'Allow?', options: [{ id: 'y', label: 'Yes' }] })

    state = applyEnvelope(state, envelope({ type: 'choice_required', interactionId: 'i2', prompt: 'Pick one', options: [] }, 2)).state
    expect(state.pendingInteraction?.kind).toBe('choice')
  })

  it('clears the pending interaction only when explicitly resolved', () => {
    let state = createReducerState()
    state = applyEnvelope(state, envelope({ type: 'terminal_attention_required', reason: 'unknown prompt' }, 1)).state
    expect(state.pendingInteraction).not.toBeNull()
    state = clearPendingInteraction(state)
    expect(state.pendingInteraction).toBeNull()
  })
})

describe('activity aggregate summary (AgentActivityTracker, reused as-is)', () => {
  it('turns an in-order stream of tool_activity events into the "Worked for Ns · Read N files · Edited N files" summary', () => {
    let state = createReducerState()
    state = send(state, 'go', 't1', 0)
    const events: AgentEvent[] = [
      { type: 'activity', label: 'Pondering', elapsedMs: 12000 },
      { type: 'tool_activity', label: 'Read(a.ts)', status: 'done' },
      { type: 'tool_activity', label: 'Read(b.ts)', status: 'done' },
      { type: 'tool_activity', label: 'Write(c.ts)', status: 'done' }
    ]
    let seq = 1
    for (const e of events) state = applyEnvelope(state, envelope(e, seq++)).state

    expect(summarizeActivity(state.activity, 0)).toBe('Worked for 12s · Read 2 files · Edited 1 file')
  })
})
