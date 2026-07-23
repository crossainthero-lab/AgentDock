import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import type { SettingsPatch } from '@shared/types'
import { settingsService } from '../services/settings-service'

export function registerSettingsIpc(): void {
  ipcMain.handle(IpcChannels.settingsGet, () => settingsService.get())
  ipcMain.handle(IpcChannels.settingsUpdate, (_event, patch: SettingsPatch) => settingsService.update(patch))
  ipcMain.handle(IpcChannels.settingsDiagnostics, () => settingsService.getDiagnostics())
  ipcMain.handle(IpcChannels.settingsResetAgentDetection, () => settingsService.resetAgentDetection())
}
