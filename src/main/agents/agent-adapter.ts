import type { AgentCapabilities, AgentDetection, AgentId, Session } from '@shared/types'
import type { AgentEvent } from '@shared/events/agent-event'
import type { ProcessExitInfo } from '../services/pty-service'

export interface AgentRunContext {
  session: Session
  workspacePath: string
  /** Resolved native session id from a previous turn, if the adapter supports continuation. */
  nativeSessionId: string | null
  /** From Settings → Agents — one of this agent's own AgentCapabilities.permissionModes ids. */
  permissionMode: string
  executablePath: string
}

export interface AgentRunHandle {
  /** `turnId` is the AgentDock-assigned id for this specific turn — every
   *  AgentEvent the handle emits in response must carry it, so the shared
   *  reducer can scope the event to the right turn (see AgentEventReducer's
   *  `isForActiveTurn`). */
  send(prompt: string, turnId: string): void
  /** Raw stdin write straight into the live PTY — used by the Terminal
   *  drawer's keyboard input for manual fallback interaction. A no-op for
   *  structured-transport agents (Claude, Codex), which have no PTY and
   *  whose Terminal drawer is hidden in the renderer (gated on
   *  AgentDetection.structuredOutput). */
  write(data: string): void
  resize(cols: number, rows: number): void
  /** For a PTY agent, delivers a real Ctrl+C. For a structured-transport
   *  agent (no TTY, no interactive Ctrl+C semantics), this kills the
   *  in-flight process — the only way to interrupt a one-shot invocation. */
  interrupt(): void
  stop(): void
  /** Classified, chat-clean events — what the conversation UI consumes. */
  onEvent(cb: (event: AgentEvent) => void): () => void
  /** Raw PTY bytes, unconditionally, for the Terminal drawer only — never
   *  classified, never shown in chat. Never fires for structured-transport
   *  agents (no PTY to relay). */
  onRawData(cb: (chunk: string) => void): () => void
  onProcessExit(cb: (info: ProcessExitInfo) => void): () => void
  readonly isRunning: boolean

  /** Answers an open choice_required/permission_required/authentication_required
   *  interaction by translating the chosen option into the right PTY input.
   *  A documented no-op for Claude/Codex today — their one-shot processes
   *  have not been observed to produce a genuine mid-turn interactive
   *  pause; see ClaudeAdapter/CodexAdapter for the caveat. */
  respondToInteraction(interactionId: string, optionId: string): void
  /** Live model switch, if `capabilities.supportsLiveModelSwitch` is true.
   *  For process-per-turn agents this can only mean "applies starting next
   *  turn," not mid-turn — there's no live process to redirect. */
  setModel(modelId: string): void
  /** Runs a native agent command (from capabilities.commands) without ever
   *  appearing as an ordinary chat message. */
  runCommand(commandId: string): void
  /** The transport's own real conversation/session id, if it has one —
   *  Claude's `session_id`, Codex's `thread_id`, or null (Antigravity, no
   *  verified resume mechanism). Read after a turn completes and persisted
   *  by session-service so the next turn can resume the same native
   *  conversation. Replaces the old Claude-only sentinel-based marker. */
  getNativeSessionId(): string | null
}

export interface AgentAdapter {
  readonly id: AgentId
  readonly displayName: string
  detect(customPath: string | null): Promise<AgentDetection>
  /** Starts (or attaches to) the process backing a session. Call `send()` on the handle to submit the first prompt. */
  start(ctx: AgentRunContext): AgentRunHandle
  /** Static description of what this agent supports — the renderer only
   *  shows a control when the relevant list here is non-empty. */
  getCapabilities(): AgentCapabilities
}
