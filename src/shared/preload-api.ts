import type {
  AgentCapabilities,
  AgentDetection,
  AgentId,
  AgentModelOption,
  ApprovalDecision,
  ApprovalRequest,
  AttachmentResolveResult,
  AttachmentSaveResult,
  ChangedFile,
  CodexModelCatalogResult,
  CreateSessionInput,
  Diagnostics,
  DiffResult,
  ExecutableTestResult,
  HandoffExecuteInput,
  HandoffExecuteResult,
  LaunchTerminalResult,
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
  /** The host OS, exposed so the renderer can make small, deliberate
   *  platform-specific UI adjustments (e.g. hiding the custom titlebar's
   *  window-control buttons on macOS in favor of the native traffic
   *  lights) without an IPC round trip — this is a plain, static value
   *  bridged directly from the main process's own `process.platform`,
   *  never something the renderer could spoof to affect anything
   *  security-relevant. Typed as a plain string union (not `NodeJS.Platform`)
   *  since this file is shared into the renderer's web build, which has no
   *  `@types/node` namespace available. */
  platform: 'darwin' | 'win32' | 'linux' | 'freebsd' | 'openbsd' | 'sunos' | 'aix' | (string & {})
  workspace: {
    open(): Promise<Workspace | null>
    list(): Promise<Workspace[]>
    getCurrent(): Promise<Workspace | null>
    close(): Promise<void>
    /** Renames the project — its own display name, never the underlying
     *  folder path. */
    rename(id: string, name: string): Promise<Workspace>
    /** Deletes the project and every conversation/message under it. Stops
     *  any live agent processes first. Irreversible. */
    delete(id: string): Promise<void>
    setCollapsed(id: string, collapsed: boolean): Promise<void>
  }
  agents: {
    list(): Promise<AgentDetection[]>
    detect(agentId: AgentId): Promise<AgentDetection>
    setCustomPath(agentId: AgentId, customPath: string | null): Promise<AgentDetection>
    getCapabilities(agentId: AgentId): Promise<AgentCapabilities>
    /** Opens a native file picker for choosing an executable override.
     *  Returns null if the user cancels. */
    browseExecutable(agentId: AgentId): Promise<string | null>
    /** Validates one specific path directly — used by the Settings "Test"
     *  button, independent of whatever is currently saved as the custom
     *  path or auto-detected. */
    testExecutable(agentId: AgentId, path: string): Promise<ExecutableTestResult>
  }
  codex: {
    /** Fast, non-blocking — returns the cached catalogue (or a
     *  currently-configured-model fallback) without spawning anything.
     *  Safe to call on every render. */
    getModelCatalog(): Promise<CodexModelCatalogResult>
    /** Does a real live fetch against Codex's app-server `model/list` and
     *  updates the cache — used at app start, on the Settings "Refresh"
     *  action, and the Model menu's own refresh button. */
    refreshModelCatalog(): Promise<CodexModelCatalogResult>
    /** Opens a native multi-select image picker. Returns the user's real
     *  file paths, not yet saved into persistent storage — pass each to
     *  saveAttachmentFromPath() to actually keep it. Empty if cancelled. */
    browseAttachments(): Promise<string[]>
    /** Copies a file already on disk (from the picker or a drag-and-drop
     *  event that exposed a real path) into this session's persistent
     *  attachment storage. */
    saveAttachmentFromPath(sessionId: string, sourcePath: string): Promise<AttachmentSaveResult>
    /** Saves a pasted/dropped image delivered as a data URL (clipboard and
     *  drag-and-drop content arrives as blobs in the DOM) into this
     *  session's persistent attachment storage. */
    saveAttachmentFromDataUrl(sessionId: string, dataUrl: string): Promise<AttachmentSaveResult>
    /** Reads a previously-saved attachment back as a data URL for display
     *  — used for both the composer's pending thumbnails and images
     *  already sent in the conversation. */
    resolveAttachment(sessionId: string, attachmentPath: string): Promise<AttachmentResolveResult>
    /** Reads a genuine Codex-response image artifact back as a data URL —
     *  restricted main-process-side to the active workspace, this session's
     *  own attachment storage, or this session's own thread's
     *  generated_images directory (see codex-response-image-service.ts).
     *  Never arbitrary filesystem access; a path outside all three returns
     *  an error rather than being read. */
    resolveResponseImage(sessionId: string, path: string): Promise<AttachmentResolveResult>
    /** Reveals a generated/referenced response image in the OS file
     *  explorer — same containment restriction as resolveResponseImage. */
    revealResponseImage(sessionId: string, path: string): Promise<{ ok: boolean; error?: string }>
    /** Opens a generated/referenced response image with the OS default
     *  application — same containment restriction as resolveResponseImage. */
    openResponseImageExternally(sessionId: string, path: string): Promise<{ ok: boolean; error?: string }>
  }
  claude: {
    /** Fast, non-blocking — returns the cached (or plain static,
     *  reasoning-effort-unenriched) model list without spawning anything. */
    getModelCatalog(): Promise<AgentModelOption[]>
    /** Does a real live fetch against Claude Agent SDK's
     *  Query.supportedModels() and updates the cache. */
    refreshModelCatalog(): Promise<AgentModelOption[]>
  }
  antigravity: {
    /** Opens a native multi-select image picker. Returns the user's real
     *  file paths, not yet saved into persistent storage — pass each to
     *  saveAttachmentFromPath() to actually keep it. Empty if cancelled. */
    browseAttachments(): Promise<string[]>
    /** Copies a file already on disk into this session's persistent
     *  attachment storage — later re-read at send time and written onto the
     *  OS clipboard for a real Ctrl+V paste into the live agy PTY (agy's
     *  genuine native image-input mechanism; confirmed live, see
     *  AntigravityAdapter.ts). */
    saveAttachmentFromPath(sessionId: string, sourcePath: string): Promise<AttachmentSaveResult>
    /** Saves a pasted/dropped image delivered as a data URL into this
     *  session's persistent attachment storage. */
    saveAttachmentFromDataUrl(sessionId: string, dataUrl: string): Promise<AttachmentSaveResult>
    /** Reads a previously-saved attachment back as a data URL for display. */
    resolveAttachment(sessionId: string, attachmentPath: string): Promise<AttachmentResolveResult>
    /** Reads a genuine Antigravity-response image artifact back as a data
     *  URL — restricted to the active workspace or this session's own
     *  attachment storage (see antigravity-response-image-service.ts). */
    resolveResponseImage(sessionId: string, path: string): Promise<AttachmentResolveResult>
    /** Reveals a generated/referenced response image in the OS file
     *  explorer — same containment restriction as resolveResponseImage. */
    revealResponseImage(sessionId: string, path: string): Promise<{ ok: boolean; error?: string }>
    /** Opens a generated/referenced response image with the OS default
     *  application — same containment restriction as resolveResponseImage. */
    openResponseImageExternally(sessionId: string, path: string): Promise<{ ok: boolean; error?: string }>
  }
  session: {
    create(input: CreateSessionInput): Promise<Session>
    list(workspaceId: string): Promise<Session[]>
    get(sessionId: string): Promise<SessionWithMessages | null>
    /** `turnId` is generated by the renderer (crypto.randomUUID()) and
     *  becomes the id every AgentEvent for this turn carries — it's what
     *  lets the shared reducer scope events to the right turn (see
     *  AgentEventReducer's `isForActiveTurn`). `images` is a Codex-only
     *  concept — absolute paths already saved into this session's
     *  attachment storage (see codex.saveAttachmentFrom*) — silently
     *  ignored by every other agent. `displayText`, when given, is what
     *  gets persisted/rendered as the user bubble instead of `text` — see
     *  MessageContent's own doc comment; `text` is still exactly what's
     *  delivered to the agent. */
    sendPrompt(sessionId: string, text: string, turnId: string, images?: string[], displayText?: string): Promise<void>
    interrupt(sessionId: string): Promise<void>
    stop(sessionId: string): Promise<void>
    delete(sessionId: string): Promise<void>
    /** Sets titleSource to 'manual' — permanently protected from any future
     *  automatic title generation. */
    rename(sessionId: string, title: string): Promise<Session>
    onEvent(sessionId: string, cb: (payload: SessionEventPayload) => void): Unsubscribe
    /** Debug instrumentation only (Testing Mode) — never carries prompt/reply
     *  text, see TraceEvent. */
    onTrace(sessionId: string, cb: (trace: TraceEvent) => void): Unsubscribe
    /** Answers an interaction_required prompt — never appears as an ordinary
     *  chat message. */
    respondToInteraction(sessionId: string, interactionId: string, optionId: string): Promise<void>
    /** Live model switch (only meaningful if the agent's capabilities report
     *  supportsLiveModelSwitch). */
    setModel(sessionId: string, modelId: string): Promise<void>
    /** Runs a native agent command (from capabilities.commands) — never
     *  appears as an ordinary chat message. */
    runCommand(sessionId: string, commandId: string): Promise<void>
    /** Opens a brand-new, independent interactive terminal in the session's
     *  workspace — never a reattachment to this session's own live process
     *  (no such reattachment exists). Surfaces failure via the returned
     *  result rather than failing silently. */
    openExternalTerminal(sessionId: string): Promise<LaunchTerminalResult>
  }
  git: {
    changedFiles(workspaceId: string): Promise<ChangedFile[]>
    diff(workspaceId: string, path: string): Promise<DiffResult>
    branch(workspaceId: string): Promise<string | null>
    revertFile(workspaceId: string, path: string): Promise<void>
  }
  /** Backs the rich Markdown renderer's link/image affordances — every
   *  method is workspace-scoped and path-validated main-process-side (see
   *  media-service.ts); the renderer never gets unrestricted filesystem
   *  access. */
  media: {
    resolveImage(workspaceId: string, path: string): Promise<{ dataUrl?: string; error?: string }>
    revealInFolder(workspaceId: string, path: string): Promise<{ ok: boolean; error?: string }>
    openLocalPath(workspaceId: string, path: string): Promise<{ ok: boolean; error?: string }>
    /** Opens in the OS default browser — never inside the Electron window.
     *  Only http/https are honored; see media-service.ts. */
    openExternalLink(url: string): Promise<{ ok: boolean; error?: string }>
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
    /** Only ever creates the new session — never sends its first prompt
     *  itself (see handoff-service.ts's module comment). The caller sends
     *  the returned `prompt` through the new session's own conversation
     *  once it's tracked, the same way any other message is sent. */
    execute(input: HandoffExecuteInput): Promise<HandoffExecuteResult>
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
