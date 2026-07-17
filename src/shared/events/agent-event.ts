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

interface AgentEventBase {
  sessionId: string
  turnId: string
}

export type AgentEvent =
  | (AgentEventBase & { type: 'turn_started' })
  | (AgentEventBase & { type: 'assistant_delta'; messageId: string; textDelta: string })
  | (AgentEventBase & { type: 'assistant_completed'; messageId: string; text: string })
  | (AgentEventBase & { type: 'activity_started'; activityId: string; label: string; tool?: string })
  | (AgentEventBase & { type: 'activity_updated'; activityId: string; label?: string; elapsedMs?: number })
  // Self-describing like assistant_completed's `text` — carries its own
  // label/tool rather than requiring the consumer to correlate back to the
  // matching activity_started, since session-service only persists on
  // completion and has no reason to track per-turn activity state itself.
  | (AgentEventBase & { type: 'activity_completed'; activityId: string; label: string; tool?: string; status: 'done' | 'error'; summary?: string })
  | (AgentEventBase & { type: 'interaction_required'; interaction: AgentInteraction })
  | (AgentEventBase & { type: 'turn_completed'; result?: string })
  | (AgentEventBase & { type: 'turn_failed'; reason: string })

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
