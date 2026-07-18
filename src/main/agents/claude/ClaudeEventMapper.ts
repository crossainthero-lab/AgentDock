// Maps messages from the Claude Agent SDK's `query()` (a thin, typed
// wrapper over the same stream-json protocol `claude -p --output-format
// stream-json` speaks) into the shared AgentEvent vocabulary. No screen
// reconstruction, no line-index bookkeeping, no reflow — every message is a
// self-describing typed object.
//
// Shapes below are grounded in the SDK's own type declarations
// (`@anthropic-ai/claude-agent-sdk/sdk.d.ts`) and in real output captured
// against the installed `claude 2.1.211` (see repo session notes):
//   {type:'system', subtype:'init', session_id, model, permissionMode, ...}
//   {type:'stream_event', event:{type:'message_start', message:{id:...}}}
//   {type:'stream_event', event:{type:'content_block_start', index:N,
//      content_block:{type:'text'|'tool_use'|'thinking', ...}}}
//   {type:'stream_event', event:{type:'content_block_delta', index:N,
//      delta:{type:'text_delta'|'input_json_delta'|'thinking_delta'|'signature_delta', ...}}}
//   {type:'stream_event', event:{type:'content_block_stop', index:N}}
//   {type:'stream_event', event:{type:'message_stop'}}
//   {type:'assistant', message:{...}}          -- full-message echo, cross-check only
//   {type:'result', subtype:'success'|..., is_error:bool, result:'...', session_id:...}
//
// One AgentDock turn can contain multiple internal Claude API turns when
// tools are used (confirmed live: a single tool-use prompt produced
// "num_turns":2 with two separate message_start/message_stop cycles) — so a
// turn legitimately produces multiple assistant_completed events, one per
// message_id. This mapper doesn't collapse them; the reducer already
// supports N assistant messages per turn.
//
// `thinking`/`input_json_delta` content is intentionally never mapped to an
// assistant event — thinking is Claude's private reasoning (never appended
// to chat text), and tool-argument JSON tokens streaming in would flood the
// UI for no visible benefit. An ordinary `tool_use` block becomes one
// activity_started (on content_block_start) + one activity_completed (on
// content_block_stop). The small set of "meta" tools that exist purely to
// drive a native AgentDock interaction (AskUserQuestion, ExitPlanMode) are
// suppressed from that ordinary activity feed entirely — ClaudeAdapter's
// `canUseTool` bridge (see ClaudeAdapter.ts) is what turns those into a
// real interaction_required event instead, so surfacing them here too would
// just be a redundant, confusing "Running AskUserQuestion…" ticker line
// next to the actual question card.
import type { AgentEvent } from '@shared/events/agent-event'

/** Tool calls that exist purely to drive a native interaction (handled via
 *  ClaudeAdapter's canUseTool bridge) rather than doing real work — never
 *  shown as ordinary tool activity. */
const SILENT_TOOL_NAMES = new Set(['AskUserQuestion', 'ExitPlanMode'])

export interface ClaudeMapperState {
  /** `message.id` of the currently-open message (between message_start and
   *  message_stop), or null if none is open. */
  openMessageId: string | null
  /** content_block index -> its type, for this message only. */
  blockTypeByIndex: Map<number, string>
  /** content_block index -> its real id (tool_use blocks only). */
  blockIdByIndex: Map<number, string>
  /** content_block index -> its tool name (tool_use blocks only) — carried
   *  through to activity_completed so it's self-describing, same as
   *  assistant_completed carries its own full text. */
  blockNameByIndex: Map<number, string>
  /** Accumulated text per messageId, used only to emit assistant_completed
   *  with the right final text at message_stop — the reducer itself never
   *  re-appends this, it already accumulated the same deltas independently. */
  textByMessageId: Map<string, string>
  sawResult: boolean
}

export function createClaudeMapperState(): ClaudeMapperState {
  return {
    openMessageId: null,
    blockTypeByIndex: new Map(),
    blockIdByIndex: new Map(),
    blockNameByIndex: new Map(),
    textByMessageId: new Map(),
    sawResult: false
  }
}

export interface ClaudeMapResult {
  events: AgentEvent[]
  state: ClaudeMapperState
  capturedSessionId?: string
}

function cloneState(state: ClaudeMapperState): ClaudeMapperState {
  return {
    openMessageId: state.openMessageId,
    blockTypeByIndex: new Map(state.blockTypeByIndex),
    blockIdByIndex: new Map(state.blockIdByIndex),
    blockNameByIndex: new Map(state.blockNameByIndex),
    textByMessageId: new Map(state.textByMessageId),
    sawResult: state.sawResult
  }
}

export const ClaudeEventMapper = {
  /** For a raw newline-delimited JSON line (only still used by tests that
   *  exercise the mapper against captured raw-CLI fixtures). */
  mapLine(raw: string, prev: ClaudeMapperState, sessionId: string, turnId: string): ClaudeMapResult {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      console.warn(`[claude] unparseable stream-json line, ignored: ${raw.slice(0, 200)}`)
      return { events: [], state: prev }
    }
    return mapParsed(parsed as Record<string, unknown>, prev, sessionId, turnId)
  },

  /** For an already-parsed SDK message object (the normal path — the
   *  Claude Agent SDK hands back typed objects, not raw JSON text). */
  mapMessage(obj: Record<string, unknown>, prev: ClaudeMapperState, sessionId: string, turnId: string): ClaudeMapResult {
    return mapParsed(obj, prev, sessionId, turnId)
  }
}

function mapParsed(obj: Record<string, unknown>, prev: ClaudeMapperState, sessionId: string, turnId: string): ClaudeMapResult {
  const state = cloneState(prev)
  const base = { sessionId, turnId }
  const type = obj.type as string | undefined

  if (type === 'system' && obj.subtype === 'init') {
    const capturedSessionId = typeof obj.session_id === 'string' ? obj.session_id : undefined
    const events: AgentEvent[] = [{ ...base, type: 'turn_started' }]
    if (typeof obj.model === 'string' && obj.model) events.push({ ...base, type: 'model_info', model: obj.model })
    if (typeof obj.permissionMode === 'string' && obj.permissionMode) {
      events.push({ ...base, type: 'permission_mode_info', permissionMode: obj.permissionMode })
    }
    return { events, state, capturedSessionId }
  }

  if (type === 'stream_event') {
    return mapStreamEvent(obj.event as Record<string, unknown>, state, base)
  }

  if (type === 'result') {
    state.sawResult = true
    const isError = obj.is_error === true || obj.subtype !== 'success'
    if (isError) {
      // SDKResultSuccess carries `result: string`; SDKResultError carries
      // `errors: string[]` instead — there is no `result` field on it.
      const reason = Array.isArray(obj.errors) && obj.errors.length > 0
        ? obj.errors.join('; ')
        : typeof obj.result === 'string' && obj.result
          ? obj.result
          : 'Claude reported an error for this turn.'
      return { events: [{ ...base, type: 'turn_failed', reason }], state }
    }
    const result = typeof obj.result === 'string' ? obj.result : undefined
    return { events: [{ ...base, type: 'turn_completed', result }], state }
  }

  // system/status, system/post_turn_summary, the full "assistant"
  // message echo, and anything else unrecognized — no chat-facing event.
  return { events: [], state }
}

function mapStreamEvent(
  event: Record<string, unknown> | undefined,
  state: ClaudeMapperState,
  base: { sessionId: string; turnId: string }
): ClaudeMapResult {
  if (!event) return { events: [], state }
  const eventType = event.type as string | undefined

  switch (eventType) {
    case 'message_start': {
      const message = event.message as Record<string, unknown> | undefined
      const messageId = typeof message?.id === 'string' ? message.id : `msg:${Date.now()}`
      state.openMessageId = messageId
      state.blockTypeByIndex = new Map()
      state.blockIdByIndex = new Map()
      state.blockNameByIndex = new Map()
      state.textByMessageId.set(messageId, state.textByMessageId.get(messageId) ?? '')
      return { events: [], state }
    }

    case 'content_block_start': {
      const index = event.index as number
      const block = event.content_block as Record<string, unknown> | undefined
      const blockType = typeof block?.type === 'string' ? block.type : 'unknown'
      state.blockTypeByIndex.set(index, blockType)
      if (blockType === 'tool_use') {
        const id = typeof block?.id === 'string' ? block.id : `tool:${index}`
        const name = typeof block?.name === 'string' ? block.name : 'Tool'
        state.blockIdByIndex.set(index, id)
        state.blockNameByIndex.set(index, name)
        if (SILENT_TOOL_NAMES.has(name)) return { events: [], state }
        return { events: [{ ...base, type: 'activity_started', activityId: id, label: name, tool: name }], state }
      }
      return { events: [], state }
    }

    case 'content_block_delta': {
      const index = event.index as number
      const blockType = state.blockTypeByIndex.get(index)
      const delta = event.delta as Record<string, unknown> | undefined
      if (blockType === 'text' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
        const messageId = state.openMessageId
        if (!messageId) return { events: [], state }
        state.textByMessageId.set(messageId, (state.textByMessageId.get(messageId) ?? '') + delta.text)
        return { events: [{ ...base, type: 'assistant_delta', messageId, textDelta: delta.text }], state }
      }
      // thinking_delta, signature_delta, input_json_delta — never surfaced.
      return { events: [], state }
    }

    case 'content_block_stop': {
      const index = event.index as number
      const blockType = state.blockTypeByIndex.get(index)
      if (blockType === 'tool_use') {
        const id = state.blockIdByIndex.get(index)
        const name = state.blockNameByIndex.get(index)
        if (!id || !name) return { events: [], state }
        if (SILENT_TOOL_NAMES.has(name)) return { events: [], state }
        // No verified per-tool success/failure signal at this event level
        // (see plan Risk 3) — always 'done'; a genuine failure still
        // surfaces correctly at the turn level via a non-success `result`.
        return { events: [{ ...base, type: 'activity_completed', activityId: id, label: name, tool: name, status: 'done' }], state }
      }
      return { events: [], state }
    }

    case 'message_stop': {
      const messageId = state.openMessageId
      state.openMessageId = null
      if (!messageId) return { events: [], state }
      const text = state.textByMessageId.get(messageId) ?? ''
      return { events: [{ ...base, type: 'assistant_completed', messageId, text }], state }
    }

    default:
      return { events: [], state }
  }
}
