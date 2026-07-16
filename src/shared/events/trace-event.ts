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
