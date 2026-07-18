// Maps the Codex Agent SDK's `ThreadEvent` stream directly into the shared
// AgentEvent vocabulary. No screen reconstruction — every event is a
// self-describing typed object (see `@openai/codex-sdk`'s dist/index.d.ts,
// which is the authoritative source for every shape below — this mapper's
// input type IS the SDK's own `ThreadEvent`, not a hand-guessed shape).
//
// Confirmed live against the installed `codex-cli 0.144.5` (see repo
// session notes):
//   {type:"thread.started", thread_id}                     -- turn 1 only
//   {type:"turn.started"}                                    -- every turn
//   {type:"item.started"|"item.updated"|"item.completed", item}
//   {type:"turn.completed", usage}
//   {type:"turn.failed", error}
//   {type:"error", message}
//
// Confirmed real `item.type` values via live testing: "agent_message"
// (final text, delivered whole at item.completed only — Codex never
// streams text deltas, unlike Claude), "command_execution" (fires both
// item.started with status:"in_progress" and item.completed with the full
// aggregated_output/exit_code), "file_change" (same started/completed
// shape, `changes: [{path, kind}]`). "reasoning", "mcp_tool_call",
// "web_search", "todo_list", and the item-level "error" variant are typed
// by the SDK but were not independently observed live in this session —
// mapped defensively per the SDK's own type contract, not guessed.
//
// A turn can and does contain multiple items interleaved (agent_message,
// command_execution, file_change, ...) — each becomes its own activity/
// message event, same as Claude's multi-item-per-turn handling.
import type { AgentEvent, ActivityDetail } from '@shared/events/agent-event'
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk'

export interface CodexMapperState {
  sawTurnStarted: boolean
  sawCompletion: boolean
}

export function createCodexMapperState(): CodexMapperState {
  return { sawTurnStarted: false, sawCompletion: false }
}

export interface CodexMapResult {
  events: AgentEvent[]
  state: CodexMapperState
  capturedThreadId?: string
}

/** Every item type's failure state is uniformly "failed" per the SDK's own
 *  status unions (CommandExecutionStatus/PatchApplyStatus/McpToolCallStatus
 *  all share this shape) — a single check covers all of them. */
function isFailedItem(item: ThreadItem): boolean {
  return 'status' in item && item.status === 'failed'
}

/** Real, useful label + a canonical `tool` name chosen to match the same
 *  read/write/exec categorization heuristics AgentActivityTracker already
 *  uses for Claude's tool names (Bash/Read/Edit/...), so the activity
 *  ticker ("Running command…", "Reading files…") comes out right for
 *  Codex too without adapter-specific renderer logic. */
function describeItem(item: ThreadItem): { label: string; tool: string; detail?: ActivityDetail } {
  switch (item.type) {
    case 'command_execution': {
      const output = item.aggregated_output || undefined
      return {
        label: item.command,
        tool: 'Bash',
        detail: { kind: 'command', command: item.command, output, exitCode: item.exit_code ?? null }
      }
    }
    case 'file_change': {
      const changes = item.changes.map((c) => ({ path: c.path, kind: c.kind }))
      const label = changes.length === 1 ? fileName(changes[0].path) : `${changes.length} files`
      return { label, tool: 'Edit', detail: { kind: 'file_change', changes } }
    }
    case 'mcp_tool_call': {
      return {
        label: `${item.server}.${item.tool}`,
        tool: item.tool,
        detail: {
          kind: 'mcp_tool_call',
          server: item.server,
          tool: item.tool,
          args: item.arguments,
          result: item.result,
          error: item.error?.message
        }
      }
    }
    case 'web_search':
      return { label: item.query, tool: 'WebSearch', detail: { kind: 'web_search', query: item.query } }
    case 'todo_list': {
      const done = item.items.filter((t) => t.completed).length
      return {
        label: `${done}/${item.items.length} tasks`,
        tool: 'TodoList',
        detail: { kind: 'todo_list', items: item.items.map((t) => ({ text: t.text, completed: t.completed })) }
      }
    }
    case 'reasoning':
      return { label: item.text || 'Reasoning', tool: 'Reasoning', detail: { kind: 'reasoning', text: item.text } }
    case 'error':
      return { label: item.message, tool: 'Error' }
    default:
      return { label: item.type, tool: item.type }
  }
}

function fileName(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

export const CodexEventMapper = {
  mapEvent(obj: ThreadEvent, prev: CodexMapperState, sessionId: string, turnId: string): CodexMapResult {
    return mapParsed(obj, prev, sessionId, turnId)
  },

  /** Back-compat entry point for anything still feeding raw JSONL text
   *  (e.g. fixtures in tests) — parses then delegates to mapEvent. */
  mapLine(raw: string, prev: CodexMapperState, sessionId: string, turnId: string): CodexMapResult {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      console.warn(`[codex] unparseable JSONL line, ignored: ${raw.slice(0, 200)}`)
      return { events: [], state: prev }
    }
    return mapParsed(parsed as ThreadEvent, prev, sessionId, turnId)
  }
}

function mapParsed(obj: ThreadEvent, prev: CodexMapperState, sessionId: string, turnId: string): CodexMapResult {
  const state = { ...prev }
  const base = { sessionId, turnId }
  const type = obj.type

  if (type === 'thread.started') {
    const capturedThreadId = obj.thread_id
    // thread.started only fires on a fresh (non-resumed) thread; turn.started
    // is the only turn_started source on a resumed thread.
    if (state.sawTurnStarted) return { events: [], state, capturedThreadId }
    state.sawTurnStarted = true
    return { events: [{ ...base, type: 'turn_started' }], state, capturedThreadId }
  }

  if (type === 'turn.started') {
    if (state.sawTurnStarted) return { events: [], state }
    state.sawTurnStarted = true
    return { events: [{ ...base, type: 'turn_started' }], state }
  }

  if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
    const item = obj.item
    if (!item || typeof item.id !== 'string') return { events: [], state }
    const itemId = item.id

    if (item.type === 'agent_message') {
      // Confirmed live: Codex never streams text deltas — the full message
      // only ever arrives on item.completed. item.started/updated for an
      // agent_message (if they ever occur) carry no displayable content yet.
      if (type !== 'item.completed') return { events: [], state }
      return { events: [{ ...base, type: 'assistant_completed', messageId: itemId, text: item.text }], state }
    }

    // The item-level ErrorItem has no "in progress" phase — treat any
    // event carrying one as an immediate, completed, failed activity.
    if (item.type === 'error') {
      const { label, tool } = describeItem(item)
      return { events: [{ ...base, type: 'activity_completed', activityId: itemId, label, tool, status: 'error' }], state }
    }

    const { label, tool, detail } = describeItem(item)
    if (type === 'item.started') {
      return { events: [{ ...base, type: 'activity_started', activityId: itemId, label, tool, detail }], state }
    }
    if (type === 'item.updated') {
      return { events: [{ ...base, type: 'activity_updated', activityId: itemId, label, detail }], state }
    }
    // item.completed, non-agent_message, non-error
    return {
      events: [{ ...base, type: 'activity_completed', activityId: itemId, label, tool, status: isFailedItem(item) ? 'error' : 'done', detail }],
      state
    }
  }

  if (type === 'turn.completed') {
    state.sawCompletion = true
    return { events: [{ ...base, type: 'turn_completed' }], state }
  }

  if (type === 'turn.failed') {
    state.sawCompletion = true
    const reason = obj.error?.message || 'Codex reported this turn as failed.'
    return { events: [{ ...base, type: 'turn_failed', reason }], state }
  }

  if (type === 'error') {
    state.sawCompletion = true
    const message = obj.message || 'Codex reported an error.'
    return { events: [{ ...base, type: 'turn_failed', reason: message }], state }
  }

  return { events: [], state }
}
