import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import type { AgentId } from '@shared/types'
import { detectionService } from '../services/detection-service'
import { settingsService } from '../services/settings-service'
import { getAdapter } from '../agents/adapter-registry'
import { AGENT_IDS } from '@shared/types'

export function registerAgentIpc(): void {
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
}
