import { app } from 'electron'
import { settingsRepo } from '../db/repositories/settings-repo'
import { codexModelCatalogRepo } from '../db/repositories/codex-model-catalog-repo'
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

  /** Settings → "Reset agent detection" action — clears exactly what can
   *  plausibly go stale or wrong after moving AgentDock's settings to a
   *  different machine (a custom executable path pointing at a file that
   *  only existed on the old one; a Codex model-catalogue cache fetched
   *  there) without touching anything a user would consider "their data"
   *  (model/permission-mode/reasoning-effort preferences, projects,
   *  conversations). The next detect() call re-runs full auto-detection on
   *  THIS machine from scratch. */
  resetAgentDetection(): Settings {
    const current = this.get()
    const clearedAgents = {} as Settings['agents']
    for (const id of AGENT_IDS) {
      clearedAgents[id] = { ...current.agents[id], customPath: null }
    }
    const reset: Settings = { ...current, agents: clearedAgents }
    settingsRepo.set(reset)
    codexModelCatalogRepo.clear()
    return reset
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
