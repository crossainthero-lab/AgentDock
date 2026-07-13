import type { AgentDockApi } from '@shared/preload-api'

/** Accessor kept in one place so a missing bridge fails loudly and early. */
export function getAgentDock(): AgentDockApi {
  if (!window.agentDock) {
    throw new Error(
      'window.agentDock is unavailable. This build must run inside the AgentDock Electron shell (or the dev browser preview, which installs a mock bridge).'
    )
  }
  return window.agentDock
}
