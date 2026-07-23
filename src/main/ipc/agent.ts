import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import type { AgentDetection, AgentId } from '@shared/types'
import { detectionService } from '../services/detection-service'
import { settingsService } from '../services/settings-service'
import { getAdapter } from '../agents/adapter-registry'
import { AGENT_IDS, AGENT_DISPLAY_NAMES } from '@shared/types'
import { normalizeExecutableOverride } from '../services/spawn-guard'

export function registerAgentIpc(window: BrowserWindow): void {
  ipcMain.handle(IpcChannels.agentsList, async () => {
    const settings = settingsService.get()
    return detectionService.detectAll(
      Object.fromEntries(AGENT_IDS.map((id) => [id, settings.agents[id].customPath]))
    )
  })

  ipcMain.handle(IpcChannels.agentsDetect, (_event, agentId: AgentId) => {
    const customPath = settingsService.get().agents[agentId].customPath
    return detectionService.detect(agentId, customPath)
  })

  // Never trusts a raw typed/pasted string as though it were already a
  // valid path — trims it, strips accidental wrapping quotes (the exact
  // shape Windows Explorer's "Copy as path" produces), expands %ENV%/$ENV
  // references, and verifies it's a real file on THIS machine before ever
  // saving it. A value that fails any of that is rejected with a specific
  // reason instead of being written to settings and only failing later,
  // silently, deep inside a spawn call — and never carried over from a
  // different machine's settings as though paths were portable configuration.
  ipcMain.handle(IpcChannels.agentsSetCustomPath, async (_event, agentId: AgentId, customPath: string | null): Promise<AgentDetection> => {
    if (customPath === null) {
      settingsService.update({ agents: { [agentId]: { customPath: null } } })
      return detectionService.detect(agentId, null)
    }

    const normalized = normalizeExecutableOverride(customPath)
    if (!normalized.ok) {
      return {
        agentId,
        installed: false,
        version: null,
        executablePath: null,
        error: normalized.error ?? 'Invalid custom path.',
        structuredOutput: detectionService.structuredOutputFor(agentId)
      }
    }

    settingsService.update({ agents: { [agentId]: { customPath: normalized.path } } })
    return detectionService.detect(agentId, normalized.path as string)
  })

  ipcMain.handle(IpcChannels.agentsGetCapabilities, (_event, agentId: AgentId) => {
    return getAdapter(agentId).getCapabilities()
  })

  ipcMain.handle(IpcChannels.agentsBrowseExecutable, async (_event, agentId: AgentId) => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      title: `Choose the ${AGENT_DISPLAY_NAMES[agentId]} executable`,
      filters:
        process.platform === 'win32'
          ? [
              { name: 'Executable', extensions: ['exe', 'cmd', 'bat', 'com'] },
              { name: 'All files', extensions: ['*'] }
            ]
          : [{ name: 'All files', extensions: ['*'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IpcChannels.agentsTestExecutable, (_event, agentId: AgentId, path: string) => {
    return detectionService.testExecutable(agentId, path)
  })
}
