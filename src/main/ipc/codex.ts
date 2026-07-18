import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import type { CodexModelCatalogResult } from '@shared/types'
import { codexModelCatalogService } from '../services/codex-model-catalog-service'
import { detectionService } from '../services/detection-service'
import { settingsService } from '../services/settings-service'

function currentCodexModel(): string | null {
  return settingsService.get().agents.codex.model
}

export function registerCodexIpc(): void {
  ipcMain.handle(IpcChannels.codexModelCatalogGet, (): CodexModelCatalogResult => {
    return codexModelCatalogService.getCached(currentCodexModel())
  })

  ipcMain.handle(IpcChannels.codexModelCatalogRefresh, async (): Promise<CodexModelCatalogResult> => {
    const customPath = settingsService.get().agents.codex.customPath
    const detection = await detectionService.detect('codex', customPath)
    if (!detection.installed || !detection.executablePath) {
      return codexModelCatalogService.getCached(currentCodexModel(), detection.error ?? 'Codex is not installed.')
    }
    return codexModelCatalogService.refresh(detection.executablePath, currentCodexModel())
  })
}
