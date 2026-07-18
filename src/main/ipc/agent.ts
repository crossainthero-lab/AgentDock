import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import type { AgentId } from '@shared/types'
import { detectionService } from '../services/detection-service'
import { settingsService } from '../services/settings-service'
import { getAdapter } from '../agents/adapter-registry'
import { AGENT_IDS, AGENT_DISPLAY_NAMES } from '@shared/types'

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

  ipcMain.handle(IpcChannels.agentsSetCustomPath, async (_event, agentId: AgentId, customPath: string | null) => {
    settingsService.update({ agents: { [agentId]: { customPath } } })
    return detectionService.detect(agentId, customPath)
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
