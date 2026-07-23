import { safeHandle } from './ipc-utils'
import { IpcChannels } from '@shared/ipc-channels'
import type { SettingsPatch } from '@shared/types'
import { settingsService } from '../services/settings-service'

export function registerSettingsIpc(): void {
  safeHandle(IpcChannels.settingsGet, () => settingsService.get())
  safeHandle(IpcChannels.settingsUpdate, (_event, patch: SettingsPatch) => settingsService.update(patch))
  safeHandle(IpcChannels.settingsDiagnostics, () => settingsService.getDiagnostics())
}
