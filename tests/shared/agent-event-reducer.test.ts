import { describe, expect, it } from 'vitest'
import { applyAgentEvent, beginTurn, clearPendingInteraction, createReducerState } from '../../src/shared/events/AgentEventReducer'
import { summarizeActivity } from '../../src/shared/events/AgentActivityTracker'
import type { AgentEvent } from '../../src/shared/events/agent-event'

describe('AgentEventReducer', () => {
  it('accumulates only assistant_message text as clean text — never raw terminal noise', () => {
    let state = createReducerState()
    state = applyAgentEvent(state, { type: 'assistant_message', text: 'Hello' })
    state = applyAgentEvent(state, { type: 'assistant_message', text: ' world' })
    expect(state.cleanText).toBe('Hello world')
  })

  it('marks busy on activity/tool_activity, and settles on assistant_message', () => {
    let state = createReducerState()
    state = applyAgentEvent(state, { type: 'activity', label: 'Pondering', elapsedMs: 1000 })
    expect(state.isBusy).toBe(true)
    state = applyAgentEvent(state, { type: 'assistant_message', text: 'done' })
    expect(state.isBusy).toBe(false)
  })

  it('keeps at most one pending interaction at a time', () => {
    let state = createReducerState()
    state = applyAgentEvent(state, {
      type: 'permission_required',
      interactionId: 'i1',
      prompt: 'Allow?',
      options: [{ id: 'y', label: 'Yes' }]
    })
    expect(state.pendingInteraction).toEqual({ kind: 'permission', interactionId: 'i1', prompt: 'Allow?', options: [{ id: 'y', label: 'Yes' }] })

    state = applyAgentEvent(state, { type: 'choice_required', interactionId: 'i2', prompt: 'Pick one', options: [] })
    expect(state.pendingInteraction?.kind).toBe('choice')
    if (state.pendingInteraction?.kind === 'choice') {
      expect(state.pendingInteraction.interactionId).toBe('i2')
    }
  })

  it('clears the pending interaction only when explicitly resolved', () => {
    let state = createReducerState()
    state = applyAgentEvent(state, { type: 'terminal_attention_required', reason: 'unknown prompt' })
    expect(state.pendingInteraction).not.toBeNull()
    state = clearPendingInteraction(state)
    expect(state.pendingInteraction).toBeNull()
  })

  it('beginTurn resets scratch state and the activity ticker for a fresh turn', () => {
    let state = createReducerState()
    state = applyAgentEvent(state, { type: 'assistant_message', text: 'first reply' })
    state = beginTurn(state)
    expect(state.cleanText).toBe('')
    expect(state.isBusy).toBe(true)
    expect(state.activity.active).toBe(false)
  })

  it('turns an in-order stream of events into the "Worked for Ns · Read N files · Edited N files" summary', () => {
    let state = createReducerState()
    const events: AgentEvent[] = [
      { type: 'activity', label: 'Pondering', elapsedMs: 12000 },
      { type: 'tool_activity', label: 'Read(a.ts)', status: 'done' },
      { type: 'tool_activity', label: 'Read(b.ts)', status: 'done' },
      { type: 'tool_activity', label: 'Write(c.ts)', status: 'done' }
    ]
    for (const e of events) state = applyAgentEvent(state, e)

    expect(summarizeActivity(state.activity, 0)).toBe('Worked for 12s · Read 2 files · Edited 1 file')
  })
})
