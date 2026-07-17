import { describe, expect, it } from 'vitest'
import { AntigravityEventMapper, createAntigravityMapperState } from '../../src/main/agents/antigravity/AntigravityEventMapper'
import type { ClassifiedScreenEvent } from '../../src/main/agents/antigravity/classified-event'

const SESSION_ID = 's1'
const TURN_ID = 't1'

function map(events: ClassifiedScreenEvent[]) {
  return AntigravityEventMapper.map(events, createAntigravityMapperState(), SESSION_ID, TURN_ID)
}

describe('AntigravityEventMapper — status is never appended to assistant text', () => {
  it('a classified `activity` (thinking/status heartbeat) becomes activity_started/updated, never assistant_delta', () => {
    const { events } = map([{ type: 'activity', label: 'Thinking', elapsedMs: 1000 }])
    expect(events).toEqual([{ type: 'activity_started', sessionId: SESSION_ID, turnId: TURN_ID, activityId: `${TURN_ID}:heartbeat`, label: 'Thinking' }])
    expect(events.some((e) => e.type === 'assistant_delta')).toBe(false)
  })

  it('a second activity in the same turn updates the same activity row instead of creating another', () => {
    const { events } = map([
      { type: 'activity', label: 'Thinking', elapsedMs: 1000 },
      { type: 'activity', label: 'Thinking', elapsedMs: 2000 }
    ])
    const started = events.filter((e) => e.type === 'activity_started')
    const updated = events.filter((e) => e.type === 'activity_updated')
    expect(started).toHaveLength(1)
    expect(updated).toHaveLength(1)
    expect((updated[0] as { activityId: string }).activityId).toBe((started[0] as { activityId: string }).activityId)
  })

  it('a settled tool_activity synthesizes an activity_started+activity_completed pair, never assistant text', () => {
    const { events } = map([{ type: 'tool_activity', label: 'Create(file.txt)', status: 'done' }])
    expect(events).toEqual([
      { type: 'activity_started', sessionId: SESSION_ID, turnId: TURN_ID, activityId: `${TURN_ID}:tool:0`, label: 'Create(file.txt)', tool: 'Create' },
      {
        type: 'activity_completed',
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        activityId: `${TURN_ID}:tool:0`,
        label: 'Create(file.txt)',
        tool: 'Create',
        status: 'done'
      }
    ])
  })
})

describe('AntigravityEventMapper — redraws append as deltas to one stable per-turn message', () => {
  it('multiple classified assistant_message events this turn share one messageId', () => {
    const { events } = map([
      { type: 'assistant_message', text: 'Looking into it.' },
      { type: 'assistant_message', text: 'Found it.' }
    ])
    expect(events).toEqual([
      { type: 'assistant_delta', sessionId: SESSION_ID, turnId: TURN_ID, messageId: `${TURN_ID}:m0`, textDelta: 'Looking into it.' },
      { type: 'assistant_delta', sessionId: SESSION_ID, turnId: TURN_ID, messageId: `${TURN_ID}:m0`, textDelta: 'Found it.' }
    ])
  })
})

describe('AntigravityEventMapper — unrecognized output falls back safely, never corrupts chat', () => {
  it('a generic choice/permission prompt maps to interaction_required, not dropped or misfiled as text', () => {
    const { events } = map([
      { type: 'permission_required', interactionId: 'p1', prompt: 'Allow?', options: [{ id: 'y', label: 'Yes' }] }
    ])
    expect(events).toEqual([
      {
        type: 'interaction_required',
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        interaction: { kind: 'permission', interactionId: 'p1', prompt: 'Allow?', options: [{ id: 'y', label: 'Yes' }] }
      }
    ])
  })

  it('terminal_attention_required (the "screen looks stuck, unrecognized" signal) maps to interaction_required, not silence', () => {
    const { events } = map([{ type: 'terminal_attention_required', reason: 'unrecognized prompt' }])
    expect(events).toEqual([
      {
        type: 'interaction_required',
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        interaction: { kind: 'terminal_attention', interactionId: `${TURN_ID}:attention`, reason: 'unrecognized prompt' }
      }
    ])
  })
})

describe('AntigravityEventMapper — completion is never fabricated from a timeout', () => {
  it('session_complete with exitCode 0 maps to turn_completed', () => {
    const { events } = map([{ type: 'session_complete', exitCode: 0 }])
    expect(events).toEqual([{ type: 'turn_completed', sessionId: SESSION_ID, turnId: TURN_ID }])
  })

  it('session_complete with a non-zero exitCode maps to turn_failed, never turn_completed', () => {
    const { events } = map([{ type: 'session_complete', exitCode: 1 }])
    expect(events).toEqual([{ type: 'turn_failed', sessionId: SESSION_ID, turnId: TURN_ID, reason: 'Antigravity exited with code 1' }])
  })

  it('a classified error maps to turn_failed', () => {
    const { events } = map([{ type: 'error', message: 'process crashed' }])
    expect(events).toEqual([{ type: 'turn_failed', sessionId: SESSION_ID, turnId: TURN_ID, reason: 'process crashed' }])
  })
})
