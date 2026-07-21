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
  /** Sidebar project-group expand/collapse state — persisted so it survives
   *  a restart, same as everything else about a project. */
  collapsed: boolean
}

/** How a session's `title` got its current value — governs whether
 *  automatic title generation is still allowed to touch it. 'default' is
 *  the only state eligible for one-time auto-generation from the first real
 *  prompt (see title-service.ts); every other state is permanently
 *  protected from being overwritten by anything automatic. */
export type TitleSource = 'default' | 'generated' | 'handoff' | 'manual'

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
  titleSource: TitleSource
  /** The session this one was created from via "Continue with another
   *  agent", if any — never mutated after creation. */
  continuedFromSessionId: string | null
  status: SessionStatus
  createdAt: string
  updatedAt: string
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'error' | 'approval'

export type MessageContent =
  | {
      kind: 'text'
      text: string
      /** Absolute paths into this session's own persistent attachment
       *  directory (see codex-attachment-service.ts) — Codex sessions
       *  only. Never a workspace-relative path, never base64 embedded
       *  here; resolved to a data URL for display via a dedicated
       *  session-scoped IPC call, the same pattern media.resolveImage
       *  uses for workspace-scoped Markdown images. */
      images?: string[]
      /** Images genuinely produced or referenced by Codex during this
       *  message's turn (assistant role only) — the built-in image_gen
       *  tool's output, discovered by diffing Codex's own generated_images
       *  directory (see codex-response-image-service.ts), never guessed
       *  from Markdown text. A separate field from `images` above because
       *  the two have different resolution semantics/allowed roots (user
       *  attachment storage vs. workspace/attachment-storage/
       *  generated_images) even though both end up as a path list. */
      responseImages?: string[]
    }
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
  /** Defaults to 'default' (the generic placeholder title, eligible for
   *  one-time auto-generation) when omitted. Callers that already computed
   *  a real title up front — namely handoff-service — pass 'handoff' so it
   *  is never regenerated or overwritten. */
  titleSource?: TitleSource
  continuedFromSessionId?: string | null
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
  /** One of that agent's own AgentCapabilities.models ids, or null to use
   *  the agent's own configured default (never guessed/hardcoded — see
   *  capability-registry.ts for how each agent's list was verified). */
  model: string | null
  /** One of the selected model's own supportedReasoningEfforts ids (Codex
   *  only today), or null to use that model's defaultReasoningEffort. A
   *  separate control from `model` — different models support different
   *  effort levels. */
  reasoningEffort: string | null
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

/** Result of saving a picked/pasted/dropped image into a Codex session's
 *  persistent attachment storage. */
export interface AttachmentSaveResult {
  path?: string
  error?: string
}

/** Result of reading a previously-saved attachment back for display. */
export interface AttachmentResolveResult {
  dataUrl?: string
  error?: string
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

export interface AgentReasoningEffortOption {
  id: string
  label: string
  description?: string
}

export interface AgentModelOption {
  id: string
  label: string
  description?: string
  /** Present only for agents whose model list comes from a live,
   *  per-account catalogue (Codex's app-server `model/list`) rather than a
   *  fixed static list — undefined for Claude/Antigravity. `hidden` marks a
   *  legacy/lesser-used model Codex excludes from its own default picker;
   *  `supportedReasoningEfforts` is in the exact order the catalogue
   *  returned it. */
  hidden?: boolean
  isDefault?: boolean
  supportedReasoningEfforts?: AgentReasoningEffortOption[]
  defaultReasoningEffort?: string
}

/** Result of fetching Codex's live model catalogue (app-server `model/list`).
 *  `source` tells the renderer/caller how trustworthy `models` is: a live
 *  fetch just succeeded, a previously-cached fetch is being reused (e.g.
 *  offline), or nothing at all is available yet. */
export interface CodexModelCatalogResult {
  models: AgentModelOption[]
  source: 'live' | 'cache' | 'empty'
  fetchedAt: string | null
  error?: string
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
