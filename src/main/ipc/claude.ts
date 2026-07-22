import { app, ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import type { AgentModelOption } from '@shared/types'
import { claudeModelCatalogService } from '../services/claude-model-catalog-service'
import { detectionService } from '../services/detection-service'
import { settingsService } from '../services/settings-service'
import { workspaceService } from '../services/workspace-service'

/** The reasoning-effort catalogue isn't tied to any specific session or
 *  workspace (it's account/plan-scoped), but Query() still requires a
 *  cwd — the currently open workspace if there is one, otherwise the
 *  user's own home directory as a harmless fallback. CRITICAL (portability
 *  fix): this used to fall back to `process.cwd()`, which for a packaged
 *  app launched from the Start Menu/a shortcut is unpredictable — often the
 *  install directory itself (e.g. under `Program Files`), which a
 *  non-elevated per-user install may not even be able to read/write inside.
 *  `app.getPath('home')` is always a real, resolvable, per-user directory
 *  regardless of where AgentDock is installed or how it was launched. */
function catalogCwd(): string {
  return workspaceService.getCurrent()?.path ?? app.getPath('home')
}

export function registerClaudeIpc(): void {
  ipcMain.handle(IpcChannels.claudeModelCatalogGet, (): AgentModelOption[] => {
    return claudeModelCatalogService.getCached()
  })

  ipcMain.handle(IpcChannels.claudeModelCatalogRefresh, async (): Promise<AgentModelOption[]> => {
    const customPath = settingsService.get().agents['claude-code'].customPath
    const detection = await detectionService.detect('claude-code', customPath)
    if (!detection.installed || !detection.executablePath) {
      return claudeModelCatalogService.getCached()
    }
    return claudeModelCatalogService.refresh(detection.executablePath, catalogCwd())
  })
}
