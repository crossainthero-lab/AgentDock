// Shared, transport-agnostic event contract. Every adapter — regardless of
// whether it's driving a structured JSON transport (Claude, Codex) or
// classifying a PTY screen (Antigravity) — maps its own protocol into this
// vocabulary before it ever reaches session-service/the renderer. Consumers
// never need to know which transport produced an event.
//
// Every event is scoped to exactly one session + turn. That's not
// decorative: AgentEventReducer's `isForActiveTurn` guard uses `turnId` to
// reject stray/late content from a turn that isn't the current one — the
// direct fix for the old flat-event model's "no correlation check" bug
// (see AgentEventReducer.ts's module comment).
//
// Assistant text and tool activity are id-addressed (`messageId`/
// `activityId`) rather than positional, so a turn can legitimately produce
// N assistant messages and N activities (a real agentic loop: text → tool
// call → more text) instead of the old one-bubble-per-turn assumption.

export interface AgentChoice {
  id: string
  label: string
  description?: string
}

export type AgentInteraction =
  | { kind: 'choice'; interactionId: string; prompt: string; options: AgentChoice[] }
  | { kind: 'permission'; interactionId: string; prompt: string; options: AgentChoice[] }
  | { kind: 'authentication'; interactionId: string; message: string }
  // PTY/Antigravity-only in practice — Claude/Codex's one-shot processes
  // have no "screen stalled, unclear what's happening" concept.
  | { kind: 'terminal_attention'; interactionId: string; reason: string }

/** Optional, tool-specific structured payload carried alongside an activity
 *  event — additive, no adapter is required to populate it (a bare
 *  label/tool string is still a complete, valid activity on its own). Lets
 *  the renderer show a genuinely useful card (real command + real output,
 *  real changed file paths, real search query, ...) instead of a generic
 *  "ran a tool" line, without inventing a whole new per-tool event type for
 *  each one. First populated by Codex (see CodexEventMapper.ts), but the
 *  shape is agent-neutral — any adapter may use it. */
export type ActivityDetail =
  | { kind: 'command'; command: string; output?: string; exitCode?: number | null }
  | { kind: 'file_change'; changes: Array<{ path: string; kind: 'add' | 'delete' | 'update' }> }
  | { kind: 'mcp_tool_call'; server: string; tool: string; args?: unknown; result?: unknown; error?: string }
  | { kind: 'web_search'; query: string }
  | { kind: 'todo_list'; items: Array<{ text: string; completed: boolean }> }
  | { kind: 'reasoning'; text: string }

interface AgentEventBase {
  sessionId: string
  turnId: string
}

export type AgentEvent =
  | (AgentEventBase & { type: 'turn_started' })
  | (AgentEventBase & { type: 'assistant_delta'; messageId: string; textDelta: string })
  | (AgentEventBase & { type: 'assistant_completed'; messageId: string; text: string })
  | (AgentEventBase & { type: 'activity_started'; activityId: string; label: string; tool?: string; detail?: ActivityDetail })
  | (AgentEventBase & { type: 'activity_updated'; activityId: string; label?: string; elapsedMs?: number; detail?: ActivityDetail })
  // Self-describing like assistant_completed's `text` — carries its own
  // label/tool rather than requiring the consumer to correlate back to the
  // matching activity_started, since session-service only persists on
  // completion and has no reason to track per-turn activity state itself.
  | (AgentEventBase & {
      type: 'activity_completed'
      activityId: string
      label: string
      tool?: string
      status: 'done' | 'error'
      summary?: string
      detail?: ActivityDetail
    })
  | (AgentEventBase & { type: 'interaction_required'; interaction: AgentInteraction })
  | (AgentEventBase & { type: 'turn_completed'; result?: string })
  | (AgentEventBase & { type: 'turn_failed'; reason: string })
  // Turn ended because the user asked it to (Stop/Interrupt), distinct from
  // turn_failed (a genuine error) — see AgentEventReducer's handling.
  | (AgentEventBase & { type: 'turn_cancelled' })
  // The underlying process/query ended unexpectedly with no result and no
  // user-initiated stop/interrupt — a crash, not a cancellation.
  | (AgentEventBase & { type: 'turn_exited'; reason: string })
  // The real model in use for this session, as reported by the Claude Agent
  // SDK's system/init message — never guessed or hardcoded.
  | (AgentEventBase & { type: 'model_info'; model: string; reasoningEffort?: string })
  // The real, effective permission mode reported by the same system/init
  // message (may differ from what AgentDock requested, e.g. a policy override).
  | (AgentEventBase & { type: 'permission_mode_info'; permissionMode: string })
  // Images genuinely produced or referenced by the agent during this turn
  // (Codex only today — see codex-response-image-service.ts's module
  // comment for why this exists as its own event rather than folding into
  // assistant_completed: the built-in image_gen tool call is invisible in
  // Codex's own event stream, discovered only by diffing its generated_images
  // directory after the turn completes, so there's no single item.completed
  // to attach it to). Always emitted before turn_completed for the same
  // turn, never after — isForActiveTurn would otherwise reject it once the
  // turn reaches a terminal status.
  | (AgentEventBase & { type: 'response_artifacts'; messageId: string; images: string[] })

export interface SessionEventEnvelope {
  sessionId: string
  event: AgentEvent
  /** Assigned by a per-session monotonic counter in session-service's
   *  broadcastEvent — lets the renderer store detect and drop a duplicate/
   *  out-of-order redelivery of the same event. A safety net, not a
   *  substitute for having exactly one listener per session (see
   *  ipc/session.ts's `wired` guard and useSessionConversation's effect
   *  cleanup for that). */
  sequence: number
  /** Opaque id for this specific envelope, for tracing/dedup — never derived
   *  from message content. */
  eventId: string
}
