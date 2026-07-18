// Shared TypeScript contracts used by main, preload, and renderer.
// Keep this file free of Node/Electron/DOM-specific types so it can be
// imported from any of the three processes without pulling in the wrong lib.
import type { ActivityDetail } from './events/agent-event'

export type AgentId = 'claude-code' | 'codex' | 'antigravity'

export const AGENT_IDS: AgentId[] = ['claude-code', 'codex', 'antigravity']

export const AGENT_DISPLAY_NAMES: Record<AgentId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity'
}

export interface AgentDetection {
  agentId: AgentId
  installed: boolean
  version: string | null
  executablePath: string | null
  error: string | null
  /** Whether this adapter can parse structured events, or only forwards raw terminal output. */
  structuredOutput: boolean
}

/** Result of the Settings "Test" action — validates one specific candidate
 *  path directly (not a PATH search) so a user can confirm a custom
 *  executable override genuinely works before relying on it. */
export interface ExecutableTestResult {
  path: string
  /** e.g. "exe", "cmd (npm shim)", "bat" — helps explain how it was launched. */
  type: string
  ok: boolean
  version: string | null
  output: string | null
  error: string | null
}

export interface Workspace {
  id: string
  path: string
  name: string
  addedAt: string
  lastOpenedAt: string
}

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'error'
  | 'stopped'
  | 'waiting_for_permission'
  | 'waiting_for_user'
  | 'cancelled'
  | 'exited'

export interface Session {
  id: string
  workspaceId: string
  agentId: AgentId
  title: string
  status: SessionStatus
  createdAt: string
  updatedAt: string
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'error' | 'approval'

export type MessageContent =
  | { kind: 'text'; text: string }
  | {
      kind: 'activity'
      tool: string
      summary: string
      detail: string
      isError: boolean
      /** Structured payload for a rich activity card (command output, changed
       *  files, etc.) — see ActivityDetail in agent-event.ts. Optional/absent
       *  for agents that only report a plain label (e.g. Claude, Antigravity). */
      richDetail?: ActivityDetail
    }
  | { kind: 'approval-record'; command: string; decision: ApprovalDecision }
  /** A resolved native interaction card (choice/permission/auth), so answers
   *  render as a compact inline note instead of an ordinary chat bubble. */
  | { kind: 'interaction-record'; prompt: string; choiceLabel: string }

export interface SessionMessage {
  id: string
  sessionId: string
  role: MessageRole
  content: MessageContent
  createdAt: string
}

export interface SessionWithMessages extends Session {
  messages: SessionMessage[]
}

export interface CreateSessionInput {
  workspaceId: string
  agentId: AgentId
  title?: string
}

export type ChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

export interface ChangedFile {
  path: string
  status: ChangedFileStatus
  additions: number | null
  deletions: number | null
}

export interface DiffResult {
  path: string
  diff: string
  isBinary: boolean
}

export type RiskLevel = 'low' | 'medium' | 'high'

export interface ApprovalRequest {
  id: string
  sessionId: string
  agentId: AgentId
  command: string
  cwd: string
  explanation: string
  riskLevel: RiskLevel
}

export type ApprovalDecision = 'allow-once' | 'allow-session' | 'deny'

export type AppearanceMode = 'dark' | 'light' | 'system'

export interface AgentSettings {
  customPath: string | null
  /** One of that agent's own AgentCapabilities.permissionModes ids — each
   *  agent has a different native set (see capability-registry.ts), so this
   *  is intentionally a plain string rather than a shared enum. */
  permissionMode: string
}

export interface Settings {
  appearance: AppearanceMode
  agents: Record<AgentId, AgentSettings>
  permissions: {
    confirmDestructiveGitActions: boolean
  }
  advanced: {
    gitExecutablePath: string
  }
}

export type SettingsPatch = {
  appearance?: AppearanceMode
  agents?: Partial<Record<AgentId, Partial<AgentSettings>>>
  permissions?: Partial<Settings['permissions']>
  advanced?: Partial<Settings['advanced']>
}

export interface HandoffExecuteInput {
  sourceSessionId: string
  destinationAgentId: AgentId
  summary: string
  additionalInstruction: string
}

export interface Diagnostics {
  appVersion: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  platform: string
  arch: string
  userDataPath: string
  databasePath: string
}

export interface TerminalExitInfo {
  exitCode: number | null
  signal: string | null
}

export interface LaunchTerminalResult {
  launched: boolean
  method: 'wt' | 'cmd' | null
  /** The reconstructed command line, shown to the user for transparency —
   *  this is always a NEW interactive session, never a reattachment to the
   *  session's live process. */
  command: string
  error?: string
}

// --- Agent capability contract -------------------------------------------
// What each running agent (session) natively supports, reported by its
// adapter. The renderer only shows a control (Model/Permissions/Commands)
// when the relevant list here is non-empty — it never assumes parity across
// agents.

export interface AgentModelOption {
  id: string
  label: string
  description?: string
}

export interface AgentPermissionModeOption {
  id: string
  label: string
  description?: string
}

export interface AgentCommandOption {
  id: string
  label: string
  description?: string
}

export type AgentAuthState = 'unknown' | 'authenticated' | 'required'

export interface AgentCapabilities {
  agentId: AgentId
  models: AgentModelOption[]
  permissionModes: AgentPermissionModeOption[]
  commands: AgentCommandOption[]
  /** If false, changing the permission/model mid-session only takes effect
   *  the next time the session's process (re)starts. */
  supportsLiveModelSwitch: boolean
  supportsLivePermissionSwitch: boolean
  authState: AgentAuthState
}
