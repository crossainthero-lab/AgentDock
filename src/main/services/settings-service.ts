import { app } from 'electron'
import { settingsRepo } from '../db/repositories/settings-repo'
import type { AgentId, Diagnostics, Settings, SettingsPatch } from '@shared/types'
import { AGENT_IDS } from '@shared/types'
import { getDatabasePath } from '../db/database'

function defaultSettings(): Settings {
  const agents = {} as Settings['agents']
  for (const id of AGENT_IDS) {
    agents[id] = { customPath: null, permissionMode: 'default', model: null, reasoningEffort: null }
  }
  return {
    appearance: 'system',
    agents,
    permissions: {
      confirmDestructiveGitActions: true
    },
    advanced: {
      gitExecutablePath: 'git'
    }
  }
}

function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  const merged: Settings = {
    appearance: patch.appearance ?? base.appearance,
    agents: { ...base.agents },
    permissions: { ...base.permissions, ...patch.permissions },
    advanced: { ...base.advanced, ...patch.advanced }
  }
  if (patch.agents) {
    for (const [id, agentPatch] of Object.entries(patch.agents) as [AgentId, Partial<Settings['agents'][AgentId]>][]) {
      merged.agents[id] = { ...merged.agents[id], ...agentPatch }
    }
  }
  return merged
}

export const settingsService = {
  get(): Settings {
    return settingsRepo.get() ?? defaultSettings()
  },

  update(patch: SettingsPatch): Settings {
    const merged = mergeSettings(this.get(), patch)
    settingsRepo.set(merged)
    return merged
  },

  ensureInitialized(): void {
    if (!settingsRepo.get()) {
      settingsRepo.set(defaultSettings())
    }
  },

  getDiagnostics(): Diagnostics {
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      chromeVersion: process.versions.chrome ?? 'unknown',
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      userDataPath: app.getPath('userData'),
      databasePath: getDatabasePath()
    }
  }
}
