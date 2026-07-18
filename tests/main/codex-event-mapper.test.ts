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

describe('CodexEventMapper — command_execution items carry real command + output as structured detail', () => {
  it('a command_execution item.started/item.completed pair produces activity_started then activity_completed, both carrying detail', () => {
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
      {
        type: 'activity_started',
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        activityId: 'item_0',
        label: 'ls',
        tool: 'Bash',
        detail: { kind: 'command', command: 'ls', output: undefined, exitCode: null }
      },
      {
        type: 'activity_completed',
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        activityId: 'item_0',
        label: 'ls',
        tool: 'Bash',
        status: 'done',
        detail: { kind: 'command', command: 'ls', output: 'file.txt', exitCode: 0 }
      }
    ])
  })

  it('a failed command_execution (status: failed) maps to activity_completed with status error', () => {
    const { events } = feed([
      { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: -1, status: 'failed' } }
    ])
    expect(events[0]).toMatchObject({ type: 'activity_completed', status: 'error' })
  })

  it('item.updated produces activity_updated carrying the in-progress detail', () => {
    const { events } = feed([
      { type: 'item.updated', item: { id: 'item_0', type: 'command_execution', command: 'ls', aggregated_output: 'partial…', exit_code: null, status: 'in_progress' } }
    ])
    expect(events).toEqual([
      {
        type: 'activity_updated',
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        activityId: 'item_0',
        label: 'ls',
        detail: { kind: 'command', command: 'ls', output: 'partial…', exitCode: null }
      }
    ])
  })
})

describe('CodexEventMapper — file_change items carry real paths + change kind', () => {
  it('a single-file add produces the file name as the label and the full path in detail', () => {
    const { events } = feed([
      {
        type: 'item.completed',
        item: { id: 'item_1', type: 'file_change', changes: [{ path: 'C:\\ws\\newfile.txt', kind: 'add' }], status: 'completed' }
      }
    ])
    expect(events).toEqual([
      {
        type: 'activity_completed',
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        activityId: 'item_1',
        label: 'newfile.txt',
        tool: 'Edit',
        status: 'done',
        detail: { kind: 'file_change', changes: [{ path: 'C:\\ws\\newfile.txt', kind: 'add' }] }
      }
    ])
  })

  it('a multi-file patch labels the count, not a single path', () => {
    const { events } = feed([
      {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'file_change',
          changes: [
            { path: 'a.ts', kind: 'update' },
            { path: 'b.ts', kind: 'delete' }
          ],
          status: 'completed'
        }
      }
    ])
    expect(events[0]).toMatchObject({ label: '2 files' })
  })

  it('a failed patch maps to activity_completed with status error', () => {
    const { events } = feed([
      { type: 'item.completed', item: { id: 'item_1', type: 'file_change', changes: [{ path: 'a.ts', kind: 'add' }], status: 'failed' } }
    ])
    expect(events[0]).toMatchObject({ type: 'activity_completed', status: 'error' })
  })
})

describe('CodexEventMapper — mcp_tool_call, web_search, todo_list, reasoning items', () => {
  it('an mcp_tool_call item produces an activity labeled server.tool with args/result/error in detail', () => {
    const { events } = feed([
      {
        type: 'item.started',
        item: { id: 'item_3', type: 'mcp_tool_call', server: 'node_repl', tool: 'js_reset', arguments: { x: 1 }, status: 'in_progress' }
      }
    ])
    expect(events).toEqual([
      {
        type: 'activity_started',
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        activityId: 'item_3',
        label: 'node_repl.js_reset',
        tool: 'js_reset',
        detail: { kind: 'mcp_tool_call', server: 'node_repl', tool: 'js_reset', args: { x: 1 }, result: undefined, error: undefined }
      }
    ])
  })

  it('a web_search item is labeled with the real query', () => {
    const { events } = feed([{ type: 'item.started', item: { id: 'item_4', type: 'web_search', query: 'typescript satisfies operator' } }])
    expect(events[0]).toMatchObject({
      type: 'activity_started',
      label: 'typescript satisfies operator',
      tool: 'WebSearch',
      detail: { kind: 'web_search', query: 'typescript satisfies operator' }
    })
  })

  it('a todo_list item summarizes completed/total and carries the full item list', () => {
    const { events } = feed([
      {
        type: 'item.started',
        item: {
          id: 'item_5',
          type: 'todo_list',
          items: [
            { text: 'Read the file', completed: true },
            { text: 'Write the fix', completed: false }
          ]
        }
      }
    ])
    expect(events[0]).toMatchObject({
      label: '1/2 tasks',
      tool: 'TodoList',
      detail: {
        kind: 'todo_list',
        items: [
          { text: 'Read the file', completed: true },
          { text: 'Write the fix', completed: false }
        ]
      }
    })
  })

  it('a reasoning item carries its text as prose detail, not mixed into assistant text', () => {
    const { events } = feed([{ type: 'item.started', item: { id: 'item_6', type: 'reasoning', text: 'Considering two approaches…' } }])
    expect(events[0]).toMatchObject({
      type: 'activity_started',
      tool: 'Reasoning',
      detail: { kind: 'reasoning', text: 'Considering two approaches…' }
    })
    expect(events.some((e) => e.type === 'assistant_delta' || e.type === 'assistant_completed')).toBe(false)
  })

  it('an item-level ErrorItem (non-fatal, item-scoped) maps directly to a failed, completed activity — no separate "started" phase', () => {
    const { events } = feed([{ type: 'item.completed', item: { id: 'item_7', type: 'error', message: 'could not resolve import' } }])
    expect(events).toEqual([
      { type: 'activity_completed', sessionId: SESSION_ID, turnId: TURN_ID, activityId: 'item_7', label: 'could not resolve import', tool: 'Error', status: 'error' }
    ])
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
      { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: 0, status: 'completed' } },
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

  it('an item missing an id is safely ignored rather than throwing', () => {
    const state = createCodexMapperState()
    const result = CodexEventMapper.mapLine(JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } }), state, SESSION_ID, TURN_ID)
    expect(result.events).toEqual([])
  })
})
