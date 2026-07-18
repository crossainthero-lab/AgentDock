import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import type { AgentDockApi } from '@shared/preload-api'
import type { SessionEventEnvelope } from '@shared/events/agent-event'
import type { TraceEventEnvelope } from '@shared/events/trace-event'

// Curated bridge only — no generic ipcRenderer, fs, shell, or Node globals
// are exposed to the renderer. Every method here maps 1:1 to a specific
// main-process capability.
const api: AgentDockApi = {
  workspace: {
    open: () => ipcRenderer.invoke(IpcChannels.workspaceOpen),
    list: () => ipcRenderer.invoke(IpcChannels.workspaceList),
    getCurrent: () => ipcRenderer.invoke(IpcChannels.workspaceGetCurrent),
    close: () => ipcRenderer.invoke(IpcChannels.workspaceClose)
  },

  agents: {
    list: () => ipcRenderer.invoke(IpcChannels.agentsList),
    detect: (agentId) => ipcRenderer.invoke(IpcChannels.agentsDetect, agentId),
    setCustomPath: (agentId, customPath) => ipcRenderer.invoke(IpcChannels.agentsSetCustomPath, agentId, customPath),
    getCapabilities: (agentId) => ipcRenderer.invoke(IpcChannels.agentsGetCapabilities, agentId),
    browseExecutable: (agentId) => ipcRenderer.invoke(IpcChannels.agentsBrowseExecutable, agentId),
    testExecutable: (agentId, path) => ipcRenderer.invoke(IpcChannels.agentsTestExecutable, agentId, path)
  },

  codex: {
    getModelCatalog: () => ipcRenderer.invoke(IpcChannels.codexModelCatalogGet),
    refreshModelCatalog: () => ipcRenderer.invoke(IpcChannels.codexModelCatalogRefresh)
  },

  claude: {
    getModelCatalog: () => ipcRenderer.invoke(IpcChannels.claudeModelCatalogGet),
    refreshModelCatalog: () => ipcRenderer.invoke(IpcChannels.claudeModelCatalogRefresh)
  },

  session: {
    create: (input) => ipcRenderer.invoke(IpcChannels.sessionCreate, input),
    list: (workspaceId) => ipcRenderer.invoke(IpcChannels.sessionList, workspaceId),
    get: (sessionId) => ipcRenderer.invoke(IpcChannels.sessionGet, sessionId),
    sendPrompt: (sessionId, text, turnId) => ipcRenderer.invoke(IpcChannels.sessionSendPrompt, sessionId, text, turnId),
    interrupt: (sessionId) => ipcRenderer.invoke(IpcChannels.sessionInterrupt, sessionId),
    stop: (sessionId) => ipcRenderer.invoke(IpcChannels.sessionStop, sessionId),
    delete: (sessionId) => ipcRenderer.invoke(IpcChannels.sessionDelete, sessionId),
    onEvent: (sessionId, cb) => {
      const listener = (_event: Electron.IpcRendererEvent, envelope: SessionEventEnvelope): void => {
        if (envelope.sessionId === sessionId) cb({ event: envelope.event, sequence: envelope.sequence, eventId: envelope.eventId })
      }
      ipcRenderer.on(IpcChannels.sessionEvent, listener)
      return () => ipcRenderer.removeListener(IpcChannels.sessionEvent, listener)
    },
    onTrace: (sessionId, cb) => {
      const listener = (_event: Electron.IpcRendererEvent, envelope: TraceEventEnvelope): void => {
        if (envelope.sessionId === sessionId) cb(envelope.trace)
      }
      ipcRenderer.on(IpcChannels.sessionTrace, listener)
      return () => ipcRenderer.removeListener(IpcChannels.sessionTrace, listener)
    },
    respondToInteraction: (sessionId, interactionId, optionId) =>
      ipcRenderer.invoke(IpcChannels.sessionRespondInteraction, sessionId, interactionId, optionId),
    setModel: (sessionId, modelId) => ipcRenderer.invoke(IpcChannels.sessionSetModel, sessionId, modelId),
    runCommand: (sessionId, commandId) => ipcRenderer.invoke(IpcChannels.sessionRunCommand, sessionId, commandId),
    openExternalTerminal: (sessionId) => ipcRenderer.invoke(IpcChannels.sessionOpenExternalTerminal, sessionId)
  },

  git: {
    changedFiles: (workspaceId) => ipcRenderer.invoke(IpcChannels.gitChangedFiles, workspaceId),
    diff: (workspaceId, path) => ipcRenderer.invoke(IpcChannels.gitDiff, workspaceId, path),
    branch: (workspaceId) => ipcRenderer.invoke(IpcChannels.gitBranch, workspaceId),
    revertFile: (workspaceId, path) => ipcRenderer.invoke(IpcChannels.gitRevertFile, workspaceId, path)
  },

  media: {
    resolveImage: (workspaceId, path) => ipcRenderer.invoke(IpcChannels.mediaResolveImage, workspaceId, path),
    revealInFolder: (workspaceId, path) => ipcRenderer.invoke(IpcChannels.mediaRevealInFolder, workspaceId, path),
    openLocalPath: (workspaceId, path) => ipcRenderer.invoke(IpcChannels.mediaOpenLocalPath, workspaceId, path),
    openExternalLink: (url) => ipcRenderer.invoke(IpcChannels.mediaOpenExternalLink, url)
  },

  approvals: {
    respond: (approvalId, decision) => ipcRenderer.invoke(IpcChannels.approvalsRespond, approvalId, decision),
    onRequest: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, request: Parameters<typeof cb>[0]): void => cb(request)
      ipcRenderer.on(IpcChannels.approvalsRequest, listener)
      return () => ipcRenderer.removeListener(IpcChannels.approvalsRequest, listener)
    }
  },

  settings: {
    get: () => ipcRenderer.invoke(IpcChannels.settingsGet),
    update: (patch) => ipcRenderer.invoke(IpcChannels.settingsUpdate, patch),
    getDiagnostics: () => ipcRenderer.invoke(IpcChannels.settingsDiagnostics)
  },

  terminal: {
    write: (sessionId, data) => ipcRenderer.send(IpcChannels.terminalWrite, sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send(IpcChannels.terminalResize, sessionId, cols, rows),
    interrupt: (sessionId) => ipcRenderer.send(IpcChannels.terminalInterrupt, sessionId),
    onData: (sessionId, cb) => {
      const listener = (_event: Electron.IpcRendererEvent, envelope: { sessionId: string; data: string }): void => {
        if (envelope.sessionId === sessionId) cb(envelope.data)
      }
      ipcRenderer.on(IpcChannels.terminalData, listener)
      return () => ipcRenderer.removeListener(IpcChannels.terminalData, listener)
    },
    onExit: (sessionId, cb) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        envelope: { sessionId: string; info: Parameters<typeof cb>[0] }
      ): void => {
        if (envelope.sessionId === sessionId) cb(envelope.info)
      }
      ipcRenderer.on(IpcChannels.terminalExit, listener)
      return () => ipcRenderer.removeListener(IpcChannels.terminalExit, listener)
    }
  },

  handoff: {
    generateSummary: (sessionId) => ipcRenderer.invoke(IpcChannels.handoffGenerateSummary, sessionId),
    execute: (input) => ipcRenderer.invoke(IpcChannels.handoffExecute, input)
  },

  windowCtl: {
    minimize: () => ipcRenderer.send(IpcChannels.windowMinimize),
    maximize: () => ipcRenderer.send(IpcChannels.windowMaximize),
    close: () => ipcRenderer.send(IpcChannels.windowClose),
    isMaximized: () => ipcRenderer.invoke(IpcChannels.windowIsMaximized),
    onMaximizeChange: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, isMaximized: boolean): void => cb(isMaximized)
      ipcRenderer.on(IpcChannels.windowMaximizeChange, listener)
      return () => ipcRenderer.removeListener(IpcChannels.windowMaximizeChange, listener)
    }
  }
}

contextBridge.exposeInMainWorld('agentDock', api)
