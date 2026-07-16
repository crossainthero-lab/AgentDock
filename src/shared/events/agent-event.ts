// Shared event contract emitted by agent adapters (after classification) and
// forwarded to the renderer over the `session:event` IPC channel. Consumers
// never need to understand any agent's terminal formatting — raw PTY bytes
// stay on the separate `terminal:*` channel (see AgentDockApi.terminal) for
// the Terminal drawer fallback.

export interface AgentChoice {
  id: string
  label: string
  description?: string
}

export type AgentEvent =
  | { type: 'assistant_message'; text: string }
  | { type: 'activity'; label: string; elapsedMs?: number }
  | { type: 'tool_activity'; label: string; status: 'running' | 'done' | 'error' }
  // interactionId correlates the user's eventual answer (session.respondToInteraction)
  // back to this specific prompt — there is no such id in terminal text itself.
  | { type: 'choice_required'; interactionId: string; prompt: string; options: AgentChoice[] }
  | { type: 'permission_required'; interactionId: string; prompt: string; options: AgentChoice[] }
  | { type: 'authentication_required'; message: string }
  | { type: 'terminal_attention_required'; reason: string }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }
  | { type: 'session_complete'; exitCode: number | null }

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
