import { app, type BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import type { AgentId, CliInstallProgressEvent } from '@shared/types'
import { safeHandle, safeOn } from './ipc-utils'
import { cliSetupService } from '../services/cli-setup-service'
import { cliInstallationService } from '../services/cli-installation-service'
import { cliAuthenticationService } from '../services/cli-authentication-service'
import { detectionService } from '../services/detection-service'
import { settingsService } from '../services/settings-service'
import { launchExternalTerminalWithCommand } from '../services/external-terminal-service'

export function registerCliSetupIpc(window: BrowserWindow): void {
  safeHandle(IpcChannels.cliSetupGetStatuses, () => cliSetupService.getAllStatuses())

  safeHandle(IpcChannels.cliSetupGetPlan, (_event, agentId: AgentId) => cliInstallationService.buildPlan(agentId))

  safeHandle(IpcChannels.cliSetupInstall, (_event, agentId: AgentId, installId: string) =>
    cliInstallationService.install(agentId, installId, (progress: CliInstallProgressEvent) => {
      if (!window.isDestroyed()) window.webContents.send(IpcChannels.cliSetupInstallProgress, progress)
    })
  )

  safeOn(IpcChannels.cliSetupCancelInstall, (_event, installId: string) => {
    cliInstallationService.cancelInstall(installId)
  })

  safeHandle(IpcChannels.cliSetupSignIn, async (_event, agentId: AgentId) => {
    const customPath = settingsService.get().agents[agentId].customPath
    const detection = await detectionService.detect(agentId, customPath)
    if (!detection.installed || !detection.executablePath) {
      return { ok: false, ptyId: null, executablePath: null, error: `${agentId} is not installed — install it first.` }
    }
    const result = cliAuthenticationService.signIn(agentId, detection.executablePath)
    if (result.ok && result.ptyId) {
      const ptyId = result.ptyId
      const proc = cliAuthenticationService.getPty(ptyId)
      proc?.onData((chunk) => {
        if (!window.isDestroyed()) window.webContents.send(IpcChannels.cliSetupPtyData, { ptyId, data: chunk })
      })
      proc?.onExit((info) => {
        if (!window.isDestroyed()) window.webContents.send(IpcChannels.cliSetupPtyExit, { ptyId, info })
      })
    }
    return result
  })

  safeOn(IpcChannels.cliSetupPtyWrite, (_event, ptyId: string, data: string) => {
    cliAuthenticationService.getPty(ptyId)?.write(data)
  })
  safeOn(IpcChannels.cliSetupPtyResize, (_event, ptyId: string, cols: number, rows: number) => {
    cliAuthenticationService.getPty(ptyId)?.resize(cols, rows)
  })
  safeOn(IpcChannels.cliSetupPtyInterrupt, (_event, ptyId: string) => {
    cliAuthenticationService.getPty(ptyId)?.interrupt()
  })
  safeOn(IpcChannels.cliSetupPtyKill, (_event, ptyId: string) => {
    cliAuthenticationService.killPty(ptyId)
  })

  safeHandle(IpcChannels.cliSetupOpenTerminal, async (_event, agentId: AgentId, purpose: 'install' | 'signIn') => {
    const cwd = app.getPath('home')
    if (purpose === 'install') {
      const resolved = await cliInstallationService.resolveCommandForTerminal(agentId)
      if (!resolved) {
        return { launched: false, method: null, command: '', error: 'Automatic installation is not available for this CLI on this machine.' }
      }
      return launchExternalTerminalWithCommand({ executablePath: resolved.executablePath, args: resolved.args, cwd })
    }

    const customPath = settingsService.get().agents[agentId].customPath
    const detection = await detectionService.detect(agentId, customPath)
    if (!detection.installed || !detection.executablePath) {
      return { launched: false, method: null, command: '', error: `${agentId} is not installed yet.` }
    }
    return launchExternalTerminalWithCommand({ executablePath: detection.executablePath, args: [], cwd })
  })

  safeHandle(IpcChannels.cliSetupOpenInstallLogs, () => cliInstallationService.openLogsFolder())
}
