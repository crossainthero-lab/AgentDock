// Dev-only browser fallback for `window.agentDock`.
//
// Only installs when there is no real preload bridge present (i.e. the app
// is open in a plain browser tab for UI iteration, not inside Electron).
// It never fabricates sessions, conversations, or agent activity — agent
// detection always honestly reports "not installed" (a browser tab has no
// access to a real PATH or child processes), git always reports no changes,
// and nothing is pre-seeded. It exists purely so empty states, dialogs, and
// settings can be exercised without launching Electron; every response
// still goes through the same shapes the real IPC bridge returns.
import type { AgentDockApi } from '@shared/preload-api'
import type {
  AgentCapabilities,
  AgentDetection,
  AgentId,
  ChangedFile,
  CreateSessionInput,
  DiffResult,
  FileEntry,
  FileListResult,
  FilePreview,
  HandoffExecuteInput,
  ImportFileResult,
  Session,
  SessionMessage,
  SessionWithMessages,
  Settings,
  SettingsPatch,
  Workspace
} from '@shared/types'
import { AGENT_IDS } from '@shared/types'
import type { AgentEvent } from '@shared/events/agent-event'
import type { SessionEventPayload } from '@shared/preload-api'
import type { TraceEvent } from '@shared/events/trace-event'

if (typeof window !== 'undefined' && !window.agentDock) {
  let workspace: Workspace | null = null
  const sessions = new Map<string, Session>()
  const messages = new Map<string, SessionMessage[]>()
  let settings: Settings = {
    appearance: 'system',
    agents: Object.fromEntries(AGENT_IDS.map((id) => [id, { customPath: null, permissionMode: 'default' }])) as Settings['agents'],
    permissions: { confirmDestructiveGitActions: true },
    advanced: { gitExecutablePath: 'git' }
  }

  const eventListeners = new Map<string, Set<(payload: SessionEventPayload) => void>>()
  const sequenceCounters = new Map<string, number>()

  // A tiny synthetic project tree for exercising the file-explorer panel in
  // this browser preview — not real project data, same spirit as the fake
  // '/preview/sample-project' workspace path above. A 1x1 transparent PNG
  // stands in for a real image preview.
  const TINY_PNG_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  type MockNode =
    | { type: 'dir'; children: Record<string, MockNode> }
    | { type: 'text'; content: string }
    | { type: 'image' }
    | { type: 'binary' }
  const mockTree: MockNode = {
    type: 'dir',
    children: {
      'README.md': { type: 'text', content: '# Sample Project\n\nThis is a synthetic tree shown only in the browser preview.\n' },
      'package.json': { type: 'text', content: '{\n  "name": "sample-project",\n  "version": "0.0.1"\n}\n' },
      src: {
        type: 'dir',
        children: {
          'index.ts': { type: 'text', content: "export function main(): void {\n  console.log('hello from the preview')\n}\n" },
          components: {
            type: 'dir',
            children: {
              'Button.tsx': { type: 'text', content: "export function Button(): null {\n  return null\n}\n" }
            }
          }
        }
      },
      assets: {
        type: 'dir',
        children: {
          'logo.png': { type: 'image' }
        }
      },
      'notes.bin': { type: 'binary' }
    }
  }

  function mockNodeAt(relPath: string): MockNode | null {
    if (!relPath) return mockTree
    const segments = relPath.split('/').filter(Boolean)
    let node: MockNode = mockTree
    for (const segment of segments) {
      if (node.type !== 'dir' || !node.children[segment]) return null
      node = node.children[segment]
    }
    return node
  }

  function addMessage(sessionId: string, message: SessionMessage): void {
    const list = messages.get(sessionId) ?? []
    list.push(message)
    messages.set(sessionId, list)
  }

  function emit(sessionId: string, event: AgentEvent): void {
    const listeners = eventListeners.get(sessionId)
    if (!listeners) return
    const sequence = (sequenceCounters.get(sessionId) ?? 0) + 1
    sequenceCounters.set(sessionId, sequence)
    const payload: SessionEventPayload = { event, sequence, eventId: `mock-${sessionId}-${sequence}` }
    for (const l of listeners) l(payload)
  }

  function detectAgent(agentId: AgentId): AgentDetection {
    return {
      agentId,
      installed: false,
      version: null,
      executablePath: null,
      error: 'Running in a browser preview — no access to a real PATH or child processes.',
      structuredOutput: agentId !== 'antigravity'
    }
  }

  function emptyCapabilities(agentId: AgentId): AgentCapabilities {
    // Honest, not fabricated — a browser preview never has a real agent
    // process to introspect, so nothing is offered rather than guessed.
    return {
      agentId,
      models: [],
      permissionModes: [],
      commands: [],
      supportsLiveModelSwitch: false,
      supportsLivePermissionSwitch: false,
      authState: 'unknown'
    }
  }

  const api: AgentDockApi = {
    // No real Electron preload to ask, so this reflects the actual host OS
    // via the browser itself — lets a developer previewing in a plain
    // browser tab on a Mac still see the mac-specific titlebar treatment.
    platform: navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'win32',
    workspace: {
      async open() {
        // A browser tab cannot show a native OS folder picker (that's an
        // Electron `dialog.showOpenDialog` call — see workspace-service.ts
        // in the real app). This obviously-synthetic path stands in for
        // picking a folder so the rest of the UI can be exercised; it is
        // not real project data.
        const path = '/preview/sample-project'
        const name = path.split(/[/\\]/).filter(Boolean).pop() ?? path
        workspace = {
          id: 'mock-workspace',
          path,
          name,
          addedAt: new Date().toISOString(),
          lastOpenedAt: new Date().toISOString(),
          collapsed: false
        }
        return workspace
      },
      async list() {
        return workspace ? [workspace] : []
      },
      async getCurrent() {
        return workspace
      },
      async close() {
        workspace = null
      },
      async rename(id, name) {
        if (workspace && workspace.id === id) workspace = { ...workspace, name }
        if (!workspace) throw new Error('Project not found.')
        return workspace
      },
      async delete(id) {
        if (workspace && workspace.id === id) workspace = null
      },
      async setCollapsed(id, collapsed) {
        if (workspace && workspace.id === id) workspace = { ...workspace, collapsed }
      },
      async findMissing() {
        return []
      },
      async removeMissing() {
        return []
      }
    },
    agents: {
      async list() {
        return AGENT_IDS.map(detectAgent)
      },
      async detect(agentId) {
        return detectAgent(agentId)
      },
      async setCustomPath(agentId) {
        return detectAgent(agentId)
      },
      async getCapabilities(agentId) {
        return emptyCapabilities(agentId)
      },
      async browseExecutable() {
        return null
      },
      async testExecutable(_agentId, path) {
        return { path, type: 'unknown', ok: false, version: null, output: null, error: 'Not available in browser preview.' }
      }
    },
    codex: {
      async getModelCatalog() {
        return { models: [], source: 'empty' as const, fetchedAt: null, error: 'Not available in browser preview.' }
      },
      async refreshModelCatalog() {
        return { models: [], source: 'empty' as const, fetchedAt: null, error: 'Not available in browser preview.' }
      },
      async browseAttachments() {
        return []
      },
      async saveAttachmentFromPath() {
        return { error: 'Not available in browser preview.' }
      },
      async saveAttachmentFromDataUrl() {
        return { error: 'Not available in browser preview.' }
      },
      async resolveAttachment() {
        return { error: 'Not available in browser preview.' }
      },
      async resolveResponseImage() {
        return { error: 'Not available in browser preview.' }
      },
      async revealResponseImage() {
        return { ok: false, error: 'Not available in the browser preview.' }
      },
      async openResponseImageExternally() {
        return { ok: false, error: 'Not available in the browser preview.' }
      }
    },
    claude: {
      async getModelCatalog() {
        return []
      },
      async refreshModelCatalog() {
        return []
      }
    },
    antigravity: {
      async browseAttachments() {
        return []
      },
      async saveAttachmentFromPath() {
        return { error: 'Not available in browser preview.' }
      },
      async saveAttachmentFromDataUrl() {
        return { error: 'Not available in browser preview.' }
      },
      async resolveAttachment() {
        return { error: 'Not available in browser preview.' }
      },
      async resolveResponseImage() {
        return { error: 'Not available in browser preview.' }
      },
      async revealResponseImage() {
        return { ok: false, error: 'Not available in the browser preview.' }
      },
      async openResponseImageExternally() {
        return { ok: false, error: 'Not available in the browser preview.' }
      }
    },
    session: {
      async create(input: CreateSessionInput) {
        const id = `mock-session-${sessions.size + 1}`
        const now = new Date().toISOString()
        const session: Session = {
          id,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          title: input.title?.trim() || `New session`,
          titleSource: input.titleSource ?? (input.title?.trim() ? 'manual' : 'default'),
          continuedFromSessionId: input.continuedFromSessionId ?? null,
          status: 'idle',
          createdAt: now,
          updatedAt: now
        }
        sessions.set(id, session)
        messages.set(id, [])
        return session
      },
      async list(workspaceId) {
        return [...sessions.values()].filter((s) => s.workspaceId === workspaceId)
      },
      async get(sessionId): Promise<SessionWithMessages | null> {
        const session = sessions.get(sessionId)
        if (!session) return null
        return { ...session, messages: messages.get(sessionId) ?? [] }
      },
      async sendPrompt(sessionId, text, turnId) {
        addMessage(sessionId, { id: `${sessionId}-${Date.now()}`, sessionId, role: 'user', content: { kind: 'text', text }, createdAt: new Date().toISOString() })
        const errorText = `${sessions.get(sessionId)?.agentId ?? 'This agent'} is not installed in this browser preview.`
        addMessage(sessionId, { id: `${sessionId}-${Date.now()}-e`, sessionId, role: 'error', content: { kind: 'text', text: errorText }, createdAt: new Date().toISOString() })
        emit(sessionId, { type: 'turn_failed', sessionId, turnId, reason: errorText })
      },
      async respondToInteraction() {},
      async setModel() {},
      async runCommand() {},
      async openExternalTerminal() {
        return { launched: false, method: null, command: '', error: 'Not available in the browser preview.' }
      },
      async interrupt() {},
      async stop(sessionId) {
        const session = sessions.get(sessionId)
        if (session) session.status = 'stopped'
      },
      async delete(sessionId) {
        sessions.delete(sessionId)
        messages.delete(sessionId)
      },
      async rename(sessionId, title) {
        const session = sessions.get(sessionId)
        if (!session) throw new Error('Session not found.')
        const updated: Session = { ...session, title: title.trim(), titleSource: 'manual' }
        sessions.set(sessionId, updated)
        return updated
      },
      onEvent(sessionId, cb) {
        const set = eventListeners.get(sessionId) ?? new Set()
        set.add(cb)
        eventListeners.set(sessionId, set)
        return () => set.delete(cb)
      },
      onTrace(_sessionId: string, _cb: (trace: TraceEvent) => void) {
        // No main process in a browser preview — nothing to trace.
        return () => {}
      }
    },
    git: {
      async changedFiles(): Promise<ChangedFile[]> {
        return []
      },
      async diff(_workspaceId, path): Promise<DiffResult> {
        return { path, diff: '', isBinary: false }
      },
      async branch() {
        return null
      },
      async revertFile() {}
    },
    media: {
      async resolveImage() {
        return { error: 'Not available in the browser preview.' }
      },
      async revealInFolder() {
        return { ok: false, error: 'Not available in the browser preview.' }
      },
      async openLocalPath() {
        return { ok: false, error: 'Not available in the browser preview.' }
      },
      async openExternalLink(url: string) {
        window.open(url, '_blank', 'noopener,noreferrer')
        return { ok: true }
      }
    },
    approvals: {
      async respond() {},
      onRequest() {
        return () => {}
      }
    },
    settings: {
      async get() {
        return settings
      },
      async update(patch: SettingsPatch) {
        settings = {
          appearance: patch.appearance ?? settings.appearance,
          agents: { ...settings.agents, ...(patch.agents as Settings['agents'] | undefined) },
          permissions: { ...settings.permissions, ...patch.permissions },
          advanced: { ...settings.advanced, ...patch.advanced }
        }
        return settings
      },
      async getDiagnostics() {
        return {
          appVersion: '0.1.1 (browser preview)',
          electronVersion: 'n/a',
          chromeVersion: navigator.userAgent,
          nodeVersion: 'n/a',
          platform: 'browser',
          arch: 'n/a',
          userDataPath: 'n/a (browser preview)',
          databasePath: 'n/a (browser preview)'
        }
      },
      async resetAgentDetection() {
        return settings
      }
    },
    terminal: {
      write() {},
      resize() {},
      interrupt() {},
      onData() {
        return () => {}
      },
      onExit() {
        return () => {}
      }
    },
    handoff: {
      async generateSummary(sessionId) {
        const list = messages.get(sessionId) ?? []
        const asks = list.filter((m) => m.role === 'user')
        return asks.length ? `Requests so far:\n${asks.map((m) => (m.content.kind === 'text' ? `- ${m.content.text}` : '')).join('\n')}` : 'No activity yet in this browser preview session.'
      },
      async execute(input: HandoffExecuteInput) {
        const id = `mock-session-${sessions.size + 1}`
        const now = new Date().toISOString()
        const source = sessions.get(input.sourceSessionId)
        const session: Session = {
          id,
          workspaceId: source?.workspaceId ?? 'mock-workspace',
          agentId: input.destinationAgentId,
          title: `${source?.title ?? 'Session'} (continued)`,
          titleSource: 'handoff',
          continuedFromSessionId: input.sourceSessionId,
          status: 'idle',
          createdAt: now,
          updatedAt: now
        }
        sessions.set(id, session)
        messages.set(id, [])
        const instruction = input.additionalInstruction.trim()
        const prompt = `${instruction || 'Continue the work described below.'}\n\n--- Continuation context ---\n${input.summary.trim()}`
        return { session, prompt }
      }
    },
    windowCtl: {
      minimize() {},
      maximize() {},
      close() {},
      async isMaximized() {
        return false
      },
      onMaximizeChange() {
        return () => {}
      }
    },
    filesystem: {
      async list(_workspaceId, relPath): Promise<FileListResult> {
        const node = mockNodeAt(relPath)
        if (!node || node.type !== 'dir') return { entries: [], error: 'Path not found.' }
        const entries: FileEntry[] = Object.entries(node.children)
          .map(([name, child]) => ({
            name,
            relPath: relPath ? `${relPath}/${name}` : name,
            isDirectory: child.type === 'dir',
            size: child.type === 'text' ? child.content.length : child.type === 'image' ? 1024 : child.type === 'binary' ? 2048 : null,
            mtimeMs: null
          }))
          .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1))
        return { entries }
      },
      async read(_workspaceId, relPath): Promise<FilePreview> {
        const node = mockNodeAt(relPath)
        if (!node) return { kind: 'error', error: 'File not found.' }
        if (node.type === 'dir') return { kind: 'error', error: 'Not a file.' }
        if (node.type === 'image') return { kind: 'image', dataUrl: TINY_PNG_DATA_URL }
        if (node.type === 'binary') return { kind: 'unsupported', reason: 'This file type cannot be previewed.' }
        return { kind: 'text', content: node.content, truncated: false }
      },
      async checkImportConflicts(_workspaceId, destRelPath, fileNames) {
        const node = mockNodeAt(destRelPath)
        if (!node || node.type !== 'dir') return []
        return fileNames.filter((name) => name in node.children)
      },
      async browseImportFiles() {
        return []
      },
      async importFiles(_workspaceId, _destRelPath, files): Promise<ImportFileResult[]> {
        return files.map((f) => ({
          sourceName: f.sourcePath.split(/[/\\]/).pop() ?? f.sourcePath,
          targetName: f.targetName,
          relPath: null,
          error: 'Importing files is not available in this browser preview.'
        }))
      },
      async importFileAutoRename(_workspaceId, _destRelPath, sourcePath): Promise<ImportFileResult> {
        const name = sourcePath.split(/[/\\]/).pop() ?? sourcePath
        return { sourceName: name, targetName: name, relPath: null, error: 'Attaching files is not available in this browser preview.' }
      },
      async importFromDataUrl(_workspaceId, _destRelPath, fileName): Promise<ImportFileResult> {
        return { sourceName: fileName, targetName: fileName, relPath: null, error: 'Attaching files is not available in this browser preview.' }
      },
      async watch() {
        return { ok: true }
      },
      async unwatch() {},
      onChanged() {
        return () => {}
      },
      async showContextMenu() {
        console.info('[AgentDock] The file-explorer context menu is a native Electron menu — not available in this browser preview.')
      }
    }
  }

  window.agentDock = api
  console.info('[AgentDock] Using the browser preview mock bridge — no real agents or git data are available.')
}

export {}
