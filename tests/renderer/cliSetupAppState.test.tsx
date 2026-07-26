import React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDockApi } from '../../src/shared/preload-api'
import type { AgentId, CliSetupInfo, Settings, SettingsPatch } from '../../src/shared/types'
import { AppStateProvider, useAppState } from '../../src/renderer/state/AppStateContext'

function makeSettings(overrides: Partial<Settings['cliSetup']> = {}): Settings {
  return {
    appearance: 'system',
    agents: {
      'claude-code': { customPath: null, permissionMode: 'default', model: null, reasoningEffort: null },
      codex: { customPath: null, permissionMode: 'default', model: null, reasoningEffort: null },
      antigravity: { customPath: null, permissionMode: 'default', model: null, reasoningEffort: null }
    },
    permissions: { confirmDestructiveGitActions: true },
    advanced: { gitExecutablePath: 'git' },
    cliSetup: { setupDismissed: false, ...overrides }
  }
}

function makeDetection(agentId: AgentId, installed: boolean) {
  return { agentId, installed, version: installed ? '1.0.0' : null, executablePath: installed ? `/usr/bin/${agentId}` : null, error: installed ? null : 'not found', structuredOutput: true }
}

function makeStatus(agentId: AgentId, status: CliSetupInfo['status']): CliSetupInfo {
  return {
    agentId,
    status,
    detection: makeDetection(agentId, status === 'ready' || status === 'needs-login'),
    authState: status === 'needs-login' ? 'required' : 'unknown',
    installSupported: agentId !== 'antigravity',
    installSummary: 'Installs it.',
    manualInstructions: 'Install it manually.',
    manualUrl: null
  }
}

function mountApi(params: { statuses: CliSetupInfo[]; settings: Settings }): { api: Partial<AgentDockApi>; settingsRef: { current: Settings } } {
  const settingsRef = { current: params.settings }
  const api: Partial<AgentDockApi> = {
    workspace: {
      async open() {
        return null
      },
      async list() {
        return []
      },
      async getCurrent() {
        return null
      },
      async close() {},
      async rename(id, name) {
        return { id, path: '', name, addedAt: '', lastOpenedAt: '', collapsed: false }
      },
      async delete() {},
      async setCollapsed() {},
      async findMissing() {
        return []
      },
      async removeMissing() {
        return []
      }
    } as AgentDockApi['workspace'],
    session: { async list() { return [] } } as unknown as AgentDockApi['session'],
    agents: { async list() { return [] } } as unknown as AgentDockApi['agents'],
    settings: {
      async get() {
        return settingsRef.current
      },
      async update(patch: SettingsPatch) {
        settingsRef.current = {
          ...settingsRef.current,
          ...patch,
          cliSetup: { ...settingsRef.current.cliSetup, ...patch.cliSetup }
        } as Settings
        return settingsRef.current
      },
      async getDiagnostics() {
        throw new Error('not used')
      },
      async resetAgentDetection() {
        return settingsRef.current
      }
    },
    cliSetup: {
      async getStatuses() {
        return params.statuses
      }
    } as unknown as AgentDockApi['cliSetup']
  }
  return { api, settingsRef }
}

describe('AppStateContext — CLI Setup Assistant', () => {
  afterEach(() => {
    delete (window as unknown as { agentDock?: AgentDockApi }).agentDock
  })

  it('auto-opens the setup screen at launch when an agent is not ready and setup was never dismissed', async () => {
    const { api } = mountApi({
      statuses: [makeStatus('claude-code', 'ready'), makeStatus('codex', 'not-installed'), makeStatus('antigravity', 'not-installed')],
      settings: makeSettings({ setupDismissed: false })
    })
    ;(window as unknown as { agentDock: AgentDockApi }).agentDock = api as AgentDockApi

    const { result } = renderHook(() => useAppState(), { wrapper: ({ children }) => <AppStateProvider>{children}</AppStateProvider> })

    await waitFor(() => expect(result.current.cliSetupScreenOpen).toBe(true))
    expect(result.current.hasCliSetupIssues).toBe(true)
  })

  it('does not auto-open the setup screen when the user previously chose "Skip for now"', async () => {
    const { api } = mountApi({
      statuses: [makeStatus('claude-code', 'ready'), makeStatus('codex', 'not-installed'), makeStatus('antigravity', 'not-installed')],
      settings: makeSettings({ setupDismissed: true })
    })
    ;(window as unknown as { agentDock: AgentDockApi }).agentDock = api as AgentDockApi

    const { result } = renderHook(() => useAppState(), { wrapper: ({ children }) => <AppStateProvider>{children}</AppStateProvider> })

    await waitFor(() => expect(result.current.cliSetupLoading).toBe(false))
    // Give the auto-open effect a tick to (not) fire.
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.cliSetupScreenOpen).toBe(false)
    // The small warning indicator still reflects the real issue even though
    // the full screen stays closed — "Skip for now" only suppresses the
    // screen, never the indicator.
    expect(result.current.hasCliSetupIssues).toBe(true)
  })

  it('does not auto-open when every agent is already ready', async () => {
    const { api } = mountApi({
      statuses: [makeStatus('claude-code', 'ready'), makeStatus('codex', 'ready'), makeStatus('antigravity', 'ready')],
      settings: makeSettings()
    })
    ;(window as unknown as { agentDock: AgentDockApi }).agentDock = api as AgentDockApi

    const { result } = renderHook(() => useAppState(), { wrapper: ({ children }) => <AppStateProvider>{children}</AppStateProvider> })

    await waitFor(() => expect(result.current.cliSetupLoading).toBe(false))
    expect(result.current.cliSetupScreenOpen).toBe(false)
    expect(result.current.hasCliSetupIssues).toBe(false)
  })

  it('"Skip for now" persists the dismissal and closes the screen — AgentDock keeps working normally', async () => {
    const { api, settingsRef } = mountApi({
      statuses: [makeStatus('claude-code', 'not-installed')],
      settings: makeSettings({ setupDismissed: false })
    })
    ;(window as unknown as { agentDock: AgentDockApi }).agentDock = api as AgentDockApi

    const { result } = renderHook(() => useAppState(), { wrapper: ({ children }) => <AppStateProvider>{children}</AppStateProvider> })

    await waitFor(() => expect(result.current.cliSetupScreenOpen).toBe(true))

    await act(async () => {
      await result.current.dismissCliSetupScreen()
    })

    expect(result.current.cliSetupScreenOpen).toBe(false)
    expect(settingsRef.current.cliSetup.setupDismissed).toBe(true)
  })

  it('refreshCliSetup() re-checks and reflects a newly-ready agent after an install completes ("Check again")', async () => {
    let statuses: CliSetupInfo[] = [makeStatus('claude-code', 'not-installed')]
    const settings = makeSettings()
    const api: Partial<AgentDockApi> = {
      workspace: { async list() { return [] } } as unknown as AgentDockApi['workspace'],
      session: { async list() { return [] } } as unknown as AgentDockApi['session'],
      agents: { async list() { return [] } } as unknown as AgentDockApi['agents'],
      settings: {
        async get() {
          return settings
        },
        async update(patch) {
          return { ...settings, ...patch, cliSetup: { ...settings.cliSetup, ...patch.cliSetup } } as Settings
        },
        async getDiagnostics() {
          throw new Error('not used')
        },
        async resetAgentDetection() {
          return settings
        }
      },
      cliSetup: {
        async getStatuses() {
          return statuses
        }
      } as unknown as AgentDockApi['cliSetup']
    }
    ;(window as unknown as { agentDock: AgentDockApi }).agentDock = api as AgentDockApi

    const { result } = renderHook(() => useAppState(), { wrapper: ({ children }) => <AppStateProvider>{children}</AppStateProvider> })

    await waitFor(() => expect(result.current.cliSetupStatuses[0]?.status).toBe('not-installed'))

    // Simulate a successful install having happened, then the "Check again" recheck.
    statuses = [makeStatus('claude-code', 'ready')]
    await act(async () => {
      await result.current.refreshCliSetup()
    })

    expect(result.current.cliSetupStatuses[0]?.status).toBe('ready')
    expect(result.current.hasCliSetupIssues).toBe(false)
  })
})
