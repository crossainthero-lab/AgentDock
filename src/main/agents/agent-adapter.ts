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
  send(prompt: string): void
  /** Raw stdin write straight into the live PTY — used by the Terminal
   *  drawer's keyboard input for manual fallback interaction. */
  write(data: string): void
  resize(cols: number, rows: number): void
  interrupt(): void
  stop(): void
  /** Classified, chat-clean events — what the conversation UI consumes. */
  onEvent(cb: (event: AgentEvent) => void): () => void
  /** Raw PTY bytes, unconditionally, for the Terminal drawer only — never
   *  classified, never shown in chat. */
  onRawData(cb: (chunk: string) => void): () => void
  onProcessExit(cb: (info: ProcessExitInfo) => void): () => void
  readonly isRunning: boolean

  /** Answers an open choice_required/permission_required/authentication_required
   *  interaction by translating the chosen option into the right PTY input. */
  respondToInteraction(interactionId: string, optionId: string): void
  /** Live model switch, if `capabilities.supportsLiveModelSwitch` is true. */
  setModel(modelId: string): void
  /** Runs a native agent command (from capabilities.commands) without ever
   *  appearing as an ordinary chat message. */
  runCommand(commandId: string): void
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
