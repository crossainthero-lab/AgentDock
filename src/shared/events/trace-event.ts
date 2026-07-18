// Debug instrumentation for the chat lifecycle — surfaced in the Terminal
// drawer's "Event Trace" section. Exists so it's possible to see, for a
// given session/turn, exactly where a message or event originated: PTY,
// classifier, IPC, or the renderer store. Never carries raw prompt/reply
// text, secrets, or auth codes — only ids, kinds, and counts.

export type TraceEventKind =
  | 'USER_MESSAGE_CREATED'
  | 'TURN_CREATED'
  | 'PTY_WRITE_REQUESTED'
  | 'PTY_WRITE_SUCCEEDED'
  | 'PTY_OUTPUT_RECEIVED'
  | 'TRANSLATED_EVENT_EMITTED'
  | 'EVENT_ACCEPTED'
  | 'EVENT_DROPPED_AS_DUPLICATE'
  | 'ASSISTANT_MESSAGE_CREATED'
  | 'ASSISTANT_MESSAGE_UPDATED'
  | 'ACTIVITY_CREATED'
  | 'ACTIVITY_UPDATED'
  | 'TURN_COMPLETED'
  | 'LISTENER_ATTACHED'
  | 'LISTENER_REMOVED'
  /** A canUseTool-driven interaction was raised — `detail` is the
   *  interaction kind ('permission' | 'choice' | ...), never the prompt
   *  text or tool input itself. */
  | 'INTERACTION_REQUIRED'
  /** The user's decision was successfully delivered back to the live
   *  handle (respondToInteraction didn't throw) — `detail` is the chosen
   *  option id ('allow'/'deny'/a question's option id), never free text. */
  | 'INTERACTION_RESPONDED'
  /** respondToInteraction was called but nothing was pending for that id —
   *  a stale/duplicate submission, correctly dropped rather than
   *  re-delivered (see session-service.ts's respondToInteraction guard). */
  | 'INTERACTION_STALE_OR_DUPLICATE'

export interface TraceEvent {
  kind: TraceEventKind
  sessionId: string
  timestamp: number
  turnId?: string
  eventId?: string
  sequence?: number
  /** Short, non-secret descriptor — e.g. an AgentEvent's `type`, a listener
   *  name, a byte count. Never message/prompt content. */
  detail?: string
}

export interface TraceEventEnvelope {
  sessionId: string
  trace: TraceEvent
}
