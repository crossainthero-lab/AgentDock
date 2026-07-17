// Maps `codex exec --json`'s newline-delimited JSON directly into the
// shared AgentEvent vocabulary. No screen reconstruction — every line is a
// self-describing typed object.
//
// Shapes below are grounded in real output captured against the installed
// `codex-cli 0.144.1` (see repo session notes), not guessed:
//   {"type":"thread.started","thread_id":"..."}      -- turn 1 only
//   {"type":"turn.started"}                            -- every turn, incl. resume
//   {"type":"item.started","item":{"id":..,"type":..,"status":"in_progress",...}}
//   {"type":"item.updated","item":{...}}               -- not observed live, mapped defensively per spec
//   {"type":"item.completed","item":{"id":..,"type":..,"status":"completed"|"failed",...}}
//   {"type":"turn.completed","usage":{...}}
//   {"type":"turn.failed", ...}
//   {"type":"error", ...}
//
// Confirmed real item.type values: "agent_message" (final text, delivered
// whole — Codex does not stream text deltas), "command_execution"
// (command/aggregated_output/exit_code/status), "mcp_tool_call"
// (server/tool/arguments/result/error/status). A turn can and does contain
// multiple agent_message items interleaved with tool calls — each becomes
// its own assistant_completed, same as Claude's multi-message-per-turn case.
import type { AgentEvent } from '@shared/events/agent-event'

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

function labelForItem(item: Record<string, unknown>): { label: string; tool: string } {
  const type = item.type as string
  switch (type) {
    case 'command_execution': {
      const command = typeof item.command === 'string' ? item.command : 'command'
      return { label: command, tool: 'Bash' }
    }
    case 'mcp_tool_call': {
      const server = typeof item.server === 'string' ? item.server : 'mcp'
      const tool = typeof item.tool === 'string' ? item.tool : 'tool'
      return { label: `${server}.${tool}`, tool }
    }
    default:
      return { label: type, tool: type }
  }
}

function isFailedItem(item: Record<string, unknown>): boolean {
  if (item.status === 'failed') return true
  const exitCode = item.exit_code
  return typeof exitCode === 'number' && exitCode !== 0
}

export const CodexEventMapper = {
  mapLine(raw: string, prev: CodexMapperState, sessionId: string, turnId: string): CodexMapResult {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      console.warn(`[codex] unparseable JSONL line, ignored: ${raw.slice(0, 200)}`)
      return { events: [], state: prev }
    }
    return mapParsed(parsed as Record<string, unknown>, prev, sessionId, turnId)
  }
}

function mapParsed(obj: Record<string, unknown>, prev: CodexMapperState, sessionId: string, turnId: string): CodexMapResult {
  const state = { ...prev }
  const base = { sessionId, turnId }
  const type = obj.type as string | undefined

  if (type === 'thread.started') {
    const capturedThreadId = typeof obj.thread_id === 'string' ? obj.thread_id : undefined
    // thread.started only fires on a fresh (non-resumed) thread; turn.started
    // is the only turn_started source on `codex exec resume`.
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
    const item = obj.item as Record<string, unknown> | undefined
    if (!item || typeof item.id !== 'string') return { events: [], state }
    const itemId = item.id

    if (item.type === 'agent_message') {
      if (type !== 'item.completed') return { events: [], state }
      const text = typeof item.text === 'string' ? item.text : ''
      return { events: [{ ...base, type: 'assistant_completed', messageId: itemId, text }], state }
    }

    const { label, tool } = labelForItem(item)
    if (type === 'item.started') {
      return { events: [{ ...base, type: 'activity_started', activityId: itemId, label, tool }], state }
    }
    if (type === 'item.updated') {
      return { events: [{ ...base, type: 'activity_updated', activityId: itemId, label }], state }
    }
    // item.completed, non-agent_message
    return {
      events: [{ ...base, type: 'activity_completed', activityId: itemId, label, tool, status: isFailedItem(item) ? 'error' : 'done' }],
      state
    }
  }

  if (type === 'turn.completed') {
    state.sawCompletion = true
    return { events: [{ ...base, type: 'turn_completed' }], state }
  }

  if (type === 'turn.failed') {
    state.sawCompletion = true
    const error = obj.error as Record<string, unknown> | string | undefined
    const reason =
      typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : 'Codex reported this turn as failed.'
    return { events: [{ ...base, type: 'turn_failed', reason }], state }
  }

  if (type === 'error') {
    state.sawCompletion = true
    const message = typeof obj.message === 'string' ? obj.message : 'Codex reported an error.'
    return { events: [{ ...base, type: 'turn_failed', reason: message }], state }
  }

  return { events: [], state }
}
