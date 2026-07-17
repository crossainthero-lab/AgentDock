import { describe, expect, it } from 'vitest'
import { CodexEventMapper, createCodexMapperState, type CodexMapperState } from '../../src/main/agents/codex/CodexEventMapper'
import type { AgentEvent } from '../../src/shared/events/agent-event'

const SESSION_ID = 's1'
const TURN_ID = 't1'

function feed(lines: unknown[]): { events: AgentEvent[]; state: CodexMapperState; capturedThreadId?: string } {
  let state = createCodexMapperState()
  const events: AgentEvent[] = []
  let capturedThreadId: string | undefined
  for (const line of lines) {
    const result = CodexEventMapper.mapLine(JSON.stringify(line), state, SESSION_ID, TURN_ID)
    state = result.state
    events.push(...result.events)
    if (result.capturedThreadId) capturedThreadId = result.capturedThreadId
  }
  return { events, state, capturedThreadId }
}

const threadStarted = { type: 'thread.started', thread_id: 'real-thread-id' }
const turnStarted = { type: 'turn.started' }
const turnCompleted = { type: 'turn.completed', usage: {} }

describe('CodexEventMapper — turn.started produces the Working signal', () => {
  it('a fresh turn (thread.started + turn.started) emits exactly one turn_started', () => {
    const { events } = feed([threadStarted, turnStarted])
    expect(events.filter((e) => e.type === 'turn_started')).toHaveLength(1)
  })

  it('captures the real thread_id from thread.started', () => {
    const { capturedThreadId } = feed([threadStarted])
    expect(capturedThreadId).toBe('real-thread-id')
  })

  it('a resumed turn (no thread.started, just turn.started) still emits turn_started', () => {
    const { events } = feed([turnStarted])
    expect(events).toEqual([{ type: 'turn_started', sessionId: SESSION_ID, turnId: TURN_ID }])
  })
})

describe('CodexEventMapper — item lifecycle produces activity events', () => {
  it('a command_execution item.started/item.completed pair produces activity_started then activity_completed', () => {
    const { events } = feed([
      {
        type: 'item.started',
        item: { id: 'item_0', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: null, status: 'in_progress' }
      },
      {
        type: 'item.completed',
        item: { id: 'item_0', type: 'command_execution', command: 'ls', aggregated_output: 'file.txt', exit_code: 0, status: 'completed' }
      }
    ])
    expect(events).toEqual([
      { type: 'activity_started', sessionId: SESSION_ID, turnId: TURN_ID, activityId: 'item_0', label: 'ls', tool: 'Bash' },
      { type: 'activity_completed', sessionId: SESSION_ID, turnId: TURN_ID, activityId: 'item_0', label: 'ls', tool: 'Bash', status: 'done' }
    ])
  })

  it('a failed command_execution (status: failed) maps to activity_completed with status error', () => {
    const { events } = feed([
      {
        type: 'item.completed',
        item: { id: 'item_0', type: 'command_execution', command: 'ls', exit_code: -1, status: 'failed' }
      }
    ])
    expect(events).toEqual([
      { type: 'activity_completed', sessionId: SESSION_ID, turnId: TURN_ID, activityId: 'item_0', label: 'ls', tool: 'Bash', status: 'error' }
    ])
  })

  it('a non-zero exit_code maps to activity_completed with status error even if status says completed', () => {
    const { events } = feed([
      { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'ls', exit_code: 1, status: 'completed' } }
    ])
    expect(events).toEqual([
      { type: 'activity_completed', sessionId: SESSION_ID, turnId: TURN_ID, activityId: 'item_0', label: 'ls', tool: 'Bash', status: 'error' }
    ])
  })

  it('an mcp_tool_call item produces an activity labeled server.tool', () => {
    const { events } = feed([
      {
        type: 'item.started',
        item: { id: 'item_3', type: 'mcp_tool_call', server: 'node_repl', tool: 'js_reset', arguments: {}, result: null, error: null, status: 'in_progress' }
      }
    ])
    expect(events).toEqual([
      { type: 'activity_started', sessionId: SESSION_ID, turnId: TURN_ID, activityId: 'item_3', label: 'node_repl.js_reset', tool: 'js_reset' }
    ])
  })

  it('item.updated produces activity_updated', () => {
    const { events } = feed([{ type: 'item.updated', item: { id: 'item_0', type: 'command_execution', command: 'ls' } }])
    expect(events).toEqual([{ type: 'activity_updated', sessionId: SESSION_ID, turnId: TURN_ID, activityId: 'item_0', label: 'ls' }])
  })
})

describe('CodexEventMapper — agent_message item produces exactly one assistant message', () => {
  it('item.completed with type agent_message produces one assistant_completed, no deltas', () => {
    const { events } = feed([{ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'files listed' } }])
    expect(events).toEqual([{ type: 'assistant_completed', sessionId: SESSION_ID, turnId: TURN_ID, messageId: 'item_1', text: 'files listed' }])
  })

  it('item.started for agent_message produces no event (only item.completed carries the real text)', () => {
    const { events } = feed([{ type: 'item.started', item: { id: 'item_1', type: 'agent_message', text: '' } }])
    expect(events).toEqual([])
  })

  it('a turn with multiple agent_message items produces multiple independent assistant messages', () => {
    const { events } = feed([
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Looking into it.' } },
      { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'ls', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Done.' } }
    ])
    const completed = events.filter((e) => e.type === 'assistant_completed')
    expect(completed.map((e) => (e.type === 'assistant_completed' ? e.text : ''))).toEqual(['Looking into it.', 'Done.'])
  })
})

describe('CodexEventMapper — turn completion', () => {
  it('turn.completed completes the turn this mapper instance was constructed for', () => {
    const { events } = feed([turnCompleted])
    expect(events).toEqual([{ type: 'turn_completed', sessionId: SESSION_ID, turnId: TURN_ID }])
  })

  it('turn.failed maps to turn_failed with the reported error message', () => {
    const { events } = feed([{ type: 'turn.failed', error: { message: 'model overloaded' } }])
    expect(events).toEqual([{ type: 'turn_failed', sessionId: SESSION_ID, turnId: TURN_ID, reason: 'model overloaded' }])
  })

  it('a top-level error event maps to turn_failed', () => {
    const { events } = feed([{ type: 'error', message: 'stream disconnected' }])
    expect(events).toEqual([{ type: 'turn_failed', sessionId: SESSION_ID, turnId: TURN_ID, reason: 'stream disconnected' }])
  })

  it('sawCompletion flips true once a terminal event arrives, for the adapter to use as its exit-race guard', () => {
    const { state } = feed([turnCompleted])
    expect(state.sawCompletion).toBe(true)
  })

  it('an unparseable line is swallowed, not thrown, and produces no events', () => {
    const state = createCodexMapperState()
    const result = CodexEventMapper.mapLine('not json {{{', state, SESSION_ID, TURN_ID)
    expect(result.events).toEqual([])
  })
})
