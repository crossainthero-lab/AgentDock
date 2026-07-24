// Channel name constants shared by main (registration), preload (bridging),
// and renderer (never used directly — only through window.agentDock).

export const IpcChannels = {
  workspaceOpen: 'workspace:open',
  workspaceList: 'workspace:list',
  workspaceGetCurrent: 'workspace:getCurrent',
  workspaceClose: 'workspace:close',
  workspaceRename: 'workspace:rename',
  workspaceDelete: 'workspace:delete',
  workspaceSetCollapsed: 'workspace:setCollapsed',
  workspaceFindMissing: 'workspace:findMissing',
  workspaceRemoveMissing: 'workspace:removeMissing',

  agentsList: 'agents:list',
  agentsDetect: 'agents:detect',
  agentsSetCustomPath: 'agents:setCustomPath',
  agentsGetCapabilities: 'agents:getCapabilities',
  agentsBrowseExecutable: 'agents:browseExecutable',
  agentsTestExecutable: 'agents:testExecutable',

  codexModelCatalogGet: 'codex:modelCatalog:get',
  codexModelCatalogRefresh: 'codex:modelCatalog:refresh',

  claudeModelCatalogGet: 'claude:modelCatalog:get',
  claudeModelCatalogRefresh: 'claude:modelCatalog:refresh',

  codexAttachmentsBrowse: 'codex:attachments:browse',
  codexAttachmentsSaveFromPath: 'codex:attachments:saveFromPath',
  codexAttachmentsSaveFromDataUrl: 'codex:attachments:saveFromDataUrl',
  codexAttachmentsResolve: 'codex:attachments:resolve',

  codexResponseImageResolve: 'codex:responseImage:resolve',
  codexResponseImageReveal: 'codex:responseImage:reveal',
  codexResponseImageOpenExternally: 'codex:responseImage:openExternally',

  antigravityAttachmentsBrowse: 'antigravity:attachments:browse',
  antigravityAttachmentsSaveFromPath: 'antigravity:attachments:saveFromPath',
  antigravityAttachmentsSaveFromDataUrl: 'antigravity:attachments:saveFromDataUrl',
  antigravityAttachmentsResolve: 'antigravity:attachments:resolve',

  antigravityResponseImageResolve: 'antigravity:responseImage:resolve',
  antigravityResponseImageReveal: 'antigravity:responseImage:reveal',
  antigravityResponseImageOpenExternally: 'antigravity:responseImage:openExternally',

  sessionCreate: 'session:create',
  sessionList: 'session:list',
  sessionGet: 'session:get',
  sessionSendPrompt: 'session:sendPrompt',
  sessionInterrupt: 'session:interrupt',
  sessionStop: 'session:stop',
  sessionDelete: 'session:delete',
  sessionRename: 'session:rename',
  sessionEvent: 'session:event',
  sessionTrace: 'session:trace',
  sessionRespondInteraction: 'session:respondInteraction',
  sessionSetModel: 'session:setModel',
  sessionRunCommand: 'session:runCommand',
  sessionOpenExternalTerminal: 'session:openExternalTerminal',

  mediaResolveImage: 'media:resolveImage',
  mediaRevealInFolder: 'media:revealInFolder',
  mediaOpenLocalPath: 'media:openLocalPath',
  mediaOpenExternalLink: 'media:openExternalLink',

  gitChangedFiles: 'git:changedFiles',
  gitDiff: 'git:diff',
  gitBranch: 'git:branch',
  gitRevertFile: 'git:revertFile',

  approvalsRespond: 'approvals:respond',
  approvalsRequest: 'approvals:request',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsDiagnostics: 'settings:diagnostics',
  settingsResetAgentDetection: 'settings:resetAgentDetection',

  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalInterrupt: 'terminal:interrupt',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',

  handoffGenerateSummary: 'handoff:generateSummary',
  handoffExecute: 'handoff:execute',

  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:isMaximized',
  windowMaximizeChange: 'window:maximizeChange',

  fsList: 'fs:list',
  fsRead: 'fs:read',
  fsCheckImportConflicts: 'fs:checkImportConflicts',
  fsBrowseImportFiles: 'fs:browseImportFiles',
  fsImportFiles: 'fs:importFiles',
  fsImportFileAutoRename: 'fs:importFileAutoRename',
  fsImportFromDataUrl: 'fs:importFromDataUrl',
  fsWatch: 'fs:watch',
  fsUnwatch: 'fs:unwatch',
  fsChanged: 'fs:changed',
  fsShowContextMenu: 'fs:showContextMenu'
} as const
