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
import type { AgentEvent, ActivityDetail } from '@shared/events/agent-event'

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
  /** content_block index -> the tool_use block's `input` JSON, accumulated
   *  one `input_json_delta.partial_json` fragment at a time (the streaming
   *  API never sends the full input in one shot — see mapStreamEvent's
   *  content_block_delta case). Parsed into the real command/file_path/etc.
   *  at content_block_stop, which is what makes an expanded activity show
   *  the actual tool arguments instead of just its name. */
  inputJsonByIndex: Map<number, string>
  /** tool_use id -> tool name, kept for the whole turn (not reset per
   *  message like the maps above) so a later `user` message carrying that
   *  tool's `tool_result` — which arrives as its own top-level SDKMessage,
   *  well after the message_start/stop pair that opened the tool_use block
   *  — can still be attributed to the right tool when building its output
   *  detail. */
  toolNameById: Map<string, string>
  /** tool_use id -> its parsed input, same lifetime/reason as toolNameById —
   *  needed again when the matching tool_result arrives so the completed
   *  detail can be rebuilt with real output attached. */
  toolInputById: Map<string, unknown>
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
    inputJsonByIndex: new Map(),
    toolNameById: new Map(),
    toolInputById: new Map(),
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
    inputJsonByIndex: new Map(state.inputJsonByIndex),
    toolNameById: new Map(state.toolNameById),
    toolInputById: new Map(state.toolInputById),
    textByMessageId: new Map(state.textByMessageId),
    sawResult: state.sawResult
  }
}

/** Real, useful `ActivityDetail` for a Claude Code tool call, built from its
 *  actual parsed input (and, once the matching tool_result arrives, its
 *  actual output) — never a guessed/hardcoded command or fabricated status.
 *  MCP tools (`mcp__server__tool`) get the same structured card Codex's MCP
 *  calls use; everything else Claude-specific with a well-known input shape
 *  gets its own card; anything else falls back to 'generic', which still
 *  shows the real input/output rather than nothing. */
function describeClaudeTool(tool: string, input: unknown, output?: string, isError?: boolean): ActivityDetail {
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__')
    const server = parts[1] ?? tool
    const toolName = parts.slice(2).join('__') || tool
    return { kind: 'mcp_tool_call', server, tool: toolName, args: input, result: output, error: isError ? output : undefined }
  }

  const inputObj = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined

  switch (tool) {
    case 'Bash':
      return { kind: 'command', command: typeof inputObj?.command === 'string' ? inputObj.command : '', output }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const path =
        typeof inputObj?.file_path === 'string'
          ? inputObj.file_path
          : typeof inputObj?.notebook_path === 'string'
            ? inputObj.notebook_path
            : undefined
      if (path) return { kind: 'file_change', changes: [{ path, kind: 'update' }] }
      break
    }
    case 'TodoWrite': {
      const todos = Array.isArray(inputObj?.todos) ? (inputObj.todos as Array<{ content?: string; status?: string }>) : []
      return { kind: 'todo_list', items: todos.map((t) => ({ text: t.content ?? '', completed: t.status === 'completed' })) }
    }
    case 'WebSearch':
      if (typeof inputObj?.query === 'string') return { kind: 'web_search', query: inputObj.query }
      break
  }

  return { kind: 'generic', input, output, error: isError ? output : undefined }
}

/** Best-effort parse of the accumulated `input_json_delta` fragments for one
 *  tool_use block. A real, complete tool call always parses cleanly; if it
 *  somehow doesn't (never observed live, but a malformed/truncated stream is
 *  not impossible), the raw accumulated text is kept as the detail's `input`
 *  rather than silently dropped — still real data, just unparsed. */
function parseToolInput(raw: string): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Extracts the real text Claude's tool_result actually carried — the exact
 *  content the model itself saw, not a paraphrase. `content` is either a
 *  plain string or an array of blocks (per the SDK's ToolResultBlockParam);
 *  only `text` blocks contribute (images/other block kinds have no text to
 *  show here). */
function extractToolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content || undefined
  if (Array.isArray(content)) {
    const parts = content
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
    return parts.length > 0 ? parts.join('\n') : undefined
  }
  return undefined
}

/** Handles a top-level `type: 'user'` SDKMessage — the SDK's echo of the
 *  tool_result(s) it just sent back to the model. This is the only place the
 *  real command output/error ever arrives (content_block_stop fires before
 *  the tool has even finished running), so each matching tool_result is
 *  turned into an `activity_updated` that re-attaches a richer detail (same
 *  activityId as the original activity_started/completed — tool_use_id is
 *  stable across both). Tools whose activity was never surfaced in the first
 *  place (SILENT_TOOL_NAMES) are skipped the same way. */
function mapUserMessage(obj: Record<string, unknown>, state: ClaudeMapperState, base: { sessionId: string; turnId: string }): ClaudeMapResult {
  const message = obj.message as Record<string, unknown> | undefined
  const content = message?.content
  if (!Array.isArray(content)) return { events: [], state }

  const events: AgentEvent[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type !== 'tool_result') continue
    const toolUseId = typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined
    if (!toolUseId) continue
    const name = state.toolNameById.get(toolUseId)
    if (!name || SILENT_TOOL_NAMES.has(name)) continue

    const input = state.toolInputById.get(toolUseId)
    const isError = b.is_error === true
    const output = extractToolResultText(b.content)
    const detail = describeClaudeTool(name, input, output, isError)
    events.push({ ...base, type: 'activity_updated', activityId: toolUseId, detail })
  }
  return { events, state }
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

  if (type === 'user') {
    return mapUserMessage(obj, state, base)
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
      state.inputJsonByIndex = new Map()
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
        state.inputJsonByIndex.set(index, '')
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
      // The tool call's real arguments stream in as fragments of a single
      // JSON string (Bash's `command`, Edit's `file_path`/`old_string`/...) —
      // accumulated here so content_block_stop can parse the complete input
      // and attach a real ActivityDetail instead of a bare tool name.
      if (blockType === 'tool_use' && delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const prevJson = state.inputJsonByIndex.get(index) ?? ''
        state.inputJsonByIndex.set(index, prevJson + delta.partial_json)
        return { events: [], state }
      }
      // thinking_delta, signature_delta — never surfaced.
      return { events: [], state }
    }

    case 'content_block_stop': {
      const index = event.index as number
      const blockType = state.blockTypeByIndex.get(index)
      if (blockType === 'tool_use') {
        const id = state.blockIdByIndex.get(index)
        const name = state.blockNameByIndex.get(index)
        const rawInput = state.inputJsonByIndex.get(index) ?? ''
        state.inputJsonByIndex.delete(index)
        if (!id || !name) return { events: [], state }
        if (SILENT_TOOL_NAMES.has(name)) return { events: [], state }
        const input = parseToolInput(rawInput)
        // Kept for the whole turn (see toolNameById/toolInputById's doc
        // comment) so the later tool_result — which carries the real
        // output/error — can still be attributed to this call.
        state.toolNameById.set(id, name)
        state.toolInputById.set(id, input)
        const detail = describeClaudeTool(name, input)
        // No verified per-tool success/failure signal at this event level
        // (see plan Risk 3) — always 'done'; a genuine failure still
        // surfaces correctly at the turn level via a non-success `result`,
        // and once the matching tool_result arrives (see mapUserMessage)
        // its real output/error is attached via activity_updated.
        return { events: [{ ...base, type: 'activity_completed', activityId: id, label: name, tool: name, status: 'done', detail }], state }
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
