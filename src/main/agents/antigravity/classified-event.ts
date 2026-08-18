// The old flat, positional event vocabulary — kept alive here, verbatim, as
// the internal output of PTY screen classification. Only Antigravity still
// classifies a terminal screen (Claude and Codex moved to structured JSON
// transports and no longer have a classifier at all — see
// ClaudeEventMapper/CodexEventMapper). AntigravityClassifier,
// TerminalInteractionDetector, TranslationConflictDetector, and
// conflict-integration.ts all produce/consume this type; AntigravityEventMapper
// is the one place that translates it into the shared, turn-scoped
// AgentEvent model the rest of the app (and Claude/Codex) speaks.

export interface AgentChoice {
  id: string
  label: string
  description?: string
}

export type ClassifiedScreenEvent =
  | { type: 'assistant_message'; text: string }
  | { type: 'activity'; label: string; elapsedMs?: number }
  | { type: 'tool_activity'; label: string; status: 'running' | 'done' | 'error' }
  // interactionId correlates the user's eventual answer back to this
  // specific prompt — there is no such id in terminal text itself.
  | { type: 'choice_required'; interactionId: string; prompt: string; options: AgentChoice[] }
  | { type: 'permission_required'; interactionId: string; prompt: string; options: AgentChoice[] }
  | { type: 'authentication_required'; message: string }
  | { type: 'terminal_attention_required'; reason: string }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }
  | { type: 'session_complete'; exitCode: number | null }
  // The screen has genuinely settled into "? for shortcuts" idle-composer
  // chrome — agy's real signal that it's ready for the next prompt. This is
  // the PRIMARY per-turn completion signal (see AntigravityClassifier's
  // module comment): agy's interactive process stays alive across turns, so
  // session_complete (process exit) alone can never resolve a turn while a
  // conversation continues.
  | { type: 'turn_ready' }
