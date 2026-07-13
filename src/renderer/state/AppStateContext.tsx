import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { getAgentDock } from '../lib/agentDockClient'
import type { AgentDetection, Session, Settings, Workspace } from '@shared/types'

interface AppState {
  workspace: Workspace | null
  workspaceLoading: boolean
  openWorkspace: () => Promise<void>
  closeWorkspace: () => Promise<void>

  sessions: Session[]
  sessionsLoading: boolean
  refreshSessions: () => Promise<void>

  selectedSessionId: string | null
  selectSession: (id: string | null) => void

  agents: AgentDetection[]
  agentsLoading: boolean
  refreshAgents: () => Promise<void>

  settings: Settings | null
  updateSettings: (patch: Parameters<ReturnType<typeof getAgentDock>['settings']['update']>[0]) => Promise<void>

  settingsViewOpen: boolean
  setSettingsViewOpen: (open: boolean) => void

  sidebarCollapsed: boolean
  toggleSidebar: () => void
}

const AppStateCtx = createContext<AppState | null>(null)

export function AppStateProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [workspaceLoading, setWorkspaceLoading] = useState(true)

  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)

  const [agents, setAgents] = useState<AgentDetection[]>([])
  const [agentsLoading, setAgentsLoading] = useState(true)

  const [settings, setSettings] = useState<Settings | null>(null)
  const [settingsViewOpen, setSettingsViewOpen] = useState(false)

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const refreshSessions = useCallback(async () => {
    if (!workspace) {
      setSessions([])
      return
    }
    setSessionsLoading(true)
    try {
      const list = await getAgentDock().session.list(workspace.id)
      setSessions(list)
    } finally {
      setSessionsLoading(false)
    }
  }, [workspace])

  const refreshAgents = useCallback(async () => {
    setAgentsLoading(true)
    try {
      const list = await getAgentDock().agents.list()
      setAgents(list)
    } finally {
      setAgentsLoading(false)
    }
  }, [])

  const refreshSettings = useCallback(async () => {
    const current = await getAgentDock().settings.get()
    setSettings(current)
  }, [])

  useEffect(() => {
    void (async () => {
      setWorkspaceLoading(true)
      try {
        const current = await getAgentDock().workspace.getCurrent()
        setWorkspace(current)
      } finally {
        setWorkspaceLoading(false)
      }
    })()
    void refreshAgents()
    void refreshSettings()
  }, [refreshAgents, refreshSettings])

  useEffect(() => {
    void refreshSessions()
    setSelectedSessionId(null)
  }, [workspace, refreshSessions])

  useEffect(() => {
    if (!settings) return
    const root = document.documentElement
    if (settings.appearance === 'system') {
      root.removeAttribute('data-theme')
    } else {
      root.setAttribute('data-theme', settings.appearance)
    }
  }, [settings])

  const openWorkspace = useCallback(async () => {
    const opened = await getAgentDock().workspace.open()
    if (opened) setWorkspace(opened)
  }, [])

  const closeWorkspace = useCallback(async () => {
    await getAgentDock().workspace.close()
    setWorkspace(null)
  }, [])

  const updateSettings = useCallback(async (patch: Parameters<AppState['updateSettings']>[0]) => {
    const updated = await getAgentDock().settings.update(patch)
    setSettings(updated)
  }, [])

  const value = useMemo<AppState>(
    () => ({
      workspace,
      workspaceLoading,
      openWorkspace,
      closeWorkspace,
      sessions,
      sessionsLoading,
      refreshSessions,
      selectedSessionId,
      selectSession: setSelectedSessionId,
      agents,
      agentsLoading,
      refreshAgents,
      settings,
      updateSettings,
      settingsViewOpen,
      setSettingsViewOpen,
      sidebarCollapsed,
      toggleSidebar: () => setSidebarCollapsed((v) => !v)
    }),
    [
      workspace,
      workspaceLoading,
      openWorkspace,
      closeWorkspace,
      sessions,
      sessionsLoading,
      refreshSessions,
      selectedSessionId,
      agents,
      agentsLoading,
      refreshAgents,
      settings,
      updateSettings,
      settingsViewOpen,
      sidebarCollapsed
    ]
  )

  return <AppStateCtx.Provider value={value}>{children}</AppStateCtx.Provider>
}

export function useAppState(): AppState {
  const ctx = useContext(AppStateCtx)
  if (!ctx) throw new Error('useAppState must be used within AppStateProvider')
  return ctx
}
