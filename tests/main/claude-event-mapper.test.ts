import { describe, expect, it } from 'vitest'
import { ClaudeEventMapper, createClaudeMapperState, type ClaudeMapperState } from '../../src/main/agents/claude/ClaudeEventMapper'
import type { AgentEvent } from '../../src/shared/events/agent-event'

const SESSION_ID = 's1'
const TURN_ID = 't1'

function feed(lines: unknown[]): { events: AgentEvent[]; state: ClaudeMapperState; capturedSessionId?: string } {
  let state = createClaudeMapperState()
  const events: AgentEvent[] = []
  let capturedSessionId: string | undefined
  for (const line of lines) {
    const result = ClaudeEventMapper.mapLine(JSON.stringify(line), state, SESSION_ID, TURN_ID)
    state = result.state
    events.push(...result.events)
    if (result.capturedSessionId) capturedSessionId = result.capturedSessionId
  }
  return { events, state, capturedSessionId }
}

const initLine = { type: 'system', subtype: 'init', session_id: 'real-session-id' }
const messageStart = { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } }
const textBlockStart = { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }
function textDelta(text: string) {
  return { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }
}
const messageStop = { type: 'stream_event', event: { type: 'message_stop' } }
const assistantEcho = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }] } }
const resultSuccess = { type: 'result', subtype: 'success', is_error: false, result: 'pong', session_id: 'real-session-id' }

describe('ClaudeEventMapper — one turn produces one message', () => {
  it('a single-delta reply produces exactly one assistant_completed with the full text', () => {
    const { events } = feed([initLine, messageStart, textBlockStart, textDelta('pong'), messageStop, resultSuccess])
    const completed = events.filter((e) => e.type === 'assistant_completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ messageId: 'm1', text: 'pong' })
  })

  it('captures the real session_id from system/init', () => {
    const { capturedSessionId } = feed([initLine])
    expect(capturedSessionId).toBe('real-session-id')
  })
})

describe('ClaudeEventMapper — multi-delta produces one message', () => {
  it('N text_delta lines produce N assistant_delta events sharing one messageId', () => {
    const { events } = feed([initLine, messageStart, textBlockStart, textDelta('p'), textDelta('o'), textDelta('ng'), messageStop])
    const deltas = events.filter((e) => e.type === 'assistant_delta')
    expect(deltas).toHaveLength(3)
    expect(new Set(deltas.map((e) => (e.type === 'assistant_delta' ? e.messageId : null)))).toEqual(new Set(['m1']))
    expect(deltas.map((e) => (e.type === 'assistant_delta' ? e.textDelta : ''))).toEqual(['p', 'o', 'ng'])
  })
})

describe('ClaudeEventMapper — tool events excluded from assistant text', () => {
  it('a tool_use block produces activity_started/activity_completed and zero assistant events', () => {
    const { events } = feed([
      messageStart,
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_1', name: 'Bash' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"c' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'md":"ls"}' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }
    ])
    expect(events).toEqual([
      { type: 'activity_started', sessionId: SESSION_ID, turnId: TURN_ID, activityId: 'tool_1', label: 'Bash', tool: 'Bash' },
      { type: 'activity_completed', sessionId: SESSION_ID, turnId: TURN_ID, activityId: 'tool_1', label: 'Bash', tool: 'Bash', status: 'done' }
    ])
    expect(events.some((e) => e.type === 'assistant_delta' || e.type === 'assistant_completed')).toBe(false)
  })

  it('a thinking block never produces any assistant event', () => {
    const { events } = feed([
      messageStart,
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reasoning...' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }
    ])
    expect(events).toHaveLength(0)
  })
})

describe('ClaudeEventMapper — no duplicate final result', () => {
  it('the full delta sequence plus the echoed assistant line plus result produces the text exactly once', () => {
    const { events } = feed([initLine, messageStart, textBlockStart, textDelta('p'), textDelta('ong'), assistantEcho, messageStop, resultSuccess])

    const deltaText = events
      .filter((e) => e.type === 'assistant_delta')
      .map((e) => (e.type === 'assistant_delta' ? e.textDelta : ''))
      .join('')
    expect(deltaText).toBe('pong')

    const completed = events.filter((e) => e.type === 'assistant_completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ text: 'pong' })

    // The echoed "assistant" full-message line itself must never become an event.
    expect(events.filter((e) => e.type === 'assistant_completed' || e.type === 'assistant_delta')).toHaveLength(3)
  })
})

describe('ClaudeEventMapper — turn completion', () => {
  it('a success result maps to turn_completed', () => {
    const { events } = feed([resultSuccess])
    expect(events).toEqual([{ type: 'turn_completed', sessionId: SESSION_ID, turnId: TURN_ID, result: 'pong' }])
  })

  it('an is_error result maps to turn_failed with the reported reason', () => {
    const { events } = feed([{ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'stopped early' }])
    expect(events).toEqual([{ type: 'turn_failed', sessionId: SESSION_ID, turnId: TURN_ID, reason: 'stopped early' }])
  })

  it('sawResult flips true once a result line arrives, for the adapter to use as its exit-race guard', () => {
    const { state } = feed([resultSuccess])
    expect(state.sawResult).toBe(true)
  })

  it('an unparseable line is swallowed, not thrown, and produces no events', () => {
    const state = createClaudeMapperState()
    const result = ClaudeEventMapper.mapLine('not json at all {{{', state, SESSION_ID, TURN_ID)
    expect(result.events).toEqual([])
  })
})

describe('ClaudeEventMapper — model and permission-mode capture from system/init', () => {
  it('emits model_info and permission_mode_info when system/init reports them', () => {
    const { events } = feed([{ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-4-8', permissionMode: 'plan' }])
    expect(events).toContainEqual({ type: 'model_info', sessionId: SESSION_ID, turnId: TURN_ID, model: 'claude-opus-4-8' })
    expect(events).toContainEqual({ type: 'permission_mode_info', sessionId: SESSION_ID, turnId: TURN_ID, permissionMode: 'plan' })
  })

  it('emits neither event when system/init omits them (never fabricated)', () => {
    const { events } = feed([initLine])
    expect(events.some((e) => e.type === 'model_info' || e.type === 'permission_mode_info')).toBe(false)
  })

  it('mapMessage (already-parsed object, the SDK\'s normal delivery shape) is equivalent to mapLine', () => {
    const state = createClaudeMapperState()
    const result = ClaudeEventMapper.mapMessage(
      { type: 'system', subtype: 'init', session_id: 'sid', model: 'claude-sonnet-5' },
      state,
      SESSION_ID,
      TURN_ID
    )
    expect(result.events).toContainEqual({ type: 'model_info', sessionId: SESSION_ID, turnId: TURN_ID, model: 'claude-sonnet-5' })
    expect(result.capturedSessionId).toBe('sid')
  })
})

describe('ClaudeEventMapper — silent/meta tool suppression', () => {
  it('AskUserQuestion never produces activity_started/activity_completed (handled as an interaction instead, see ClaudeAdapter)', () => {
    const { events } = feed([
      messageStart,
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'AskUserQuestion' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }
    ])
    expect(events).toEqual([])
  })

  it('ExitPlanMode is likewise suppressed from ordinary tool activity', () => {
    const { events } = feed([
      messageStart,
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu2', name: 'ExitPlanMode' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }
    ])
    expect(events).toEqual([])
  })

  it('an ordinary tool (Bash) is unaffected by the suppression list', () => {
    const { events } = feed([
      messageStart,
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu3', name: 'Bash' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }
    ])
    expect(events).toEqual([
      { type: 'activity_started', sessionId: SESSION_ID, turnId: TURN_ID, activityId: 'tu3', label: 'Bash', tool: 'Bash' },
      { type: 'activity_completed', sessionId: SESSION_ID, turnId: TURN_ID, activityId: 'tu3', label: 'Bash', tool: 'Bash', status: 'done' }
    ])
  })
})

describe('ClaudeEventMapper — SDKResultError uses errors[], not result', () => {
  it('reads the reason from `errors` (joined) when `result` is absent, matching the real SDKResultError shape', () => {
    const { events } = feed([{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['first problem', 'second problem'] }])
    expect(events).toEqual([{ type: 'turn_failed', sessionId: SESSION_ID, turnId: TURN_ID, reason: 'first problem; second problem' }])
  })
})

describe('ClaudeEventMapper — one process can carry multiple internal API turns (tool-using prompts)', () => {
  it('two message_start/message_stop cycles in one process produce two independent assistant_completed events', () => {
    const { events } = feed([
      initLine,
      messageStart,
      textBlockStart,
      textDelta('Looking...'),
      messageStop,
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'm2' } } },
      textBlockStart,
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Found it.' } } },
      messageStop,
      resultSuccess
    ])
    const completed = events.filter((e) => e.type === 'assistant_completed')
    expect(completed.map((e) => (e.type === 'assistant_completed' ? [e.messageId, e.text] : []))).toEqual([
      ['m1', 'Looking...'],
      ['m2', 'Found it.']
    ])
  })
})
