import type {
  AgentCapabilities,
  AgentDetection,
  AgentId,
  ApprovalDecision,
  ApprovalRequest,
  ChangedFile,
  CreateSessionInput,
  Diagnostics,
  DiffResult,
  HandoffExecuteInput,
  Session,
  SessionWithMessages,
  Settings,
  SettingsPatch,
  TerminalExitInfo,
  Workspace
} from './types'
import type { AgentEvent } from './events/agent-event'
import type { TraceEvent } from './events/trace-event'

export type Unsubscribe = () => void

/** What onEvent delivers — the event plus the envelope's dedup/tracing
 *  metadata (see SessionEventEnvelope). */
export interface SessionEventPayload {
  event: AgentEvent
  sequence: number
  eventId: string
}

/**
 * The full surface exposed on `window.agentDock` by the preload script.
 * The renderer never talks to Electron/Node directly — this is the only
 * contract it depends on.
 */
export interface AgentDockApi {
  workspace: {
    open(): Promise<Workspace | null>
    list(): Promise<Workspace[]>
    getCurrent(): Promise<Workspace | null>
    close(): Promise<void>
  }
  agents: {
    list(): Promise<AgentDetection[]>
    detect(agentId: AgentId): Promise<AgentDetection>
    setCustomPath(agentId: AgentId, customPath: string | null): Promise<AgentDetection>
    getCapabilities(agentId: AgentId): Promise<AgentCapabilities>
  }
  session: {
    create(input: CreateSessionInput): Promise<Session>
    list(workspaceId: string): Promise<Session[]>
    get(sessionId: string): Promise<SessionWithMessages | null>
    sendPrompt(sessionId: string, text: string): Promise<void>
    interrupt(sessionId: string): Promise<void>
    stop(sessionId: string): Promise<void>
    delete(sessionId: string): Promise<void>
    onEvent(sessionId: string, cb: (payload: SessionEventPayload) => void): Unsubscribe
    /** Debug instrumentation only (Testing Mode) — never carries prompt/reply
     *  text, see TraceEvent. */
    onTrace(sessionId: string, cb: (trace: TraceEvent) => void): Unsubscribe
    /** Answers a choice_required/permission_required/authentication_required
     *  interaction — never appears as an ordinary chat message. */
    respondToInteraction(sessionId: string, interactionId: string, optionId: string): Promise<void>
    /** Live model switch (only meaningful if the agent's capabilities report
     *  supportsLiveModelSwitch). */
    setModel(sessionId: string, modelId: string): Promise<void>
    /** Runs a native agent command (from capabilities.commands) — never
     *  appears as an ordinary chat message. */
    runCommand(sessionId: string, commandId: string): Promise<void>
  }
  git: {
    changedFiles(workspaceId: string): Promise<ChangedFile[]>
    diff(workspaceId: string, path: string): Promise<DiffResult>
    branch(workspaceId: string): Promise<string | null>
    revertFile(workspaceId: string, path: string): Promise<void>
  }
  approvals: {
    respond(approvalId: string, decision: ApprovalDecision): Promise<void>
    onRequest(cb: (request: ApprovalRequest) => void): Unsubscribe
  }
  settings: {
    get(): Promise<Settings>
    update(patch: SettingsPatch): Promise<Settings>
    getDiagnostics(): Promise<Diagnostics>
  }
  terminal: {
    write(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    interrupt(sessionId: string): void
    onData(sessionId: string, cb: (data: string) => void): Unsubscribe
    onExit(sessionId: string, cb: (info: TerminalExitInfo) => void): Unsubscribe
  }
  handoff: {
    generateSummary(sessionId: string): Promise<string>
    execute(input: HandoffExecuteInput): Promise<Session>
  }
  windowCtl: {
    minimize(): void
    maximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    onMaximizeChange(cb: (isMaximized: boolean) => void): Unsubscribe
  }
}

declare global {
  interface Window {
    agentDock: AgentDockApi
  }
}
