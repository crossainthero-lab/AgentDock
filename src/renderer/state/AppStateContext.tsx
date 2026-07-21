import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { getAgentDock } from '../lib/agentDockClient'
import type { AgentDetection, Session, Settings, Workspace } from '@shared/types'
import { forget as forgetConversation } from './conversationStore'

interface AppState {
  /** The most recently active project — `projects[0]` (the list is always
   *  ordered most-recently-opened first), never a separate stateful
   *  pointer. Used as the sensible default when no project/session has
   *  been explicitly picked yet (e.g. right after launch). */
  workspace: Workspace | null
  workspaceLoading: boolean
  openWorkspace: () => Promise<void>
  closeWorkspace: () => Promise<void>

  /** Every known project, shown simultaneously in the sidebar — not just
   *  whichever one was opened last. */
  projects: Workspace[]
  projectsLoading: boolean
  /** Each project's own conversation list, keyed by project id. */
  sessionsByProject: Record<string, Session[]>
  refreshSessions: () => Promise<void>
  renameProject: (id: string, name: string) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  toggleProjectCollapsed: (id: string) => Promise<void>

  selectedSessionId: string | null
  selectSession: (id: string | null) => void
  deleteSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>

  /** Which project the "choose an agent" screen (NewSessionView) is
   *  currently scoped to — set explicitly by a project's own "+ New
   *  session" action in the sidebar, so a new conversation always lands in
   *  the project the user actually clicked, not whichever one happens to
   *  be `workspace`. */
  newSessionProjectId: string | null
  startNewSessionInProject: (projectId: string) => void

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
  const [projects, setProjects] = useState<Workspace[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, Session[]>>({})

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [newSessionProjectId, setNewSessionProjectId] = useState<string | null>(null)

  const [agents, setAgents] = useState<AgentDetection[]>([])
  const [agentsLoading, setAgentsLoading] = useState(true)

  const [settings, setSettings] = useState<Settings | null>(null)
  const [settingsViewOpen, setSettingsViewOpen] = useState(false)

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const workspace = projects[0] ?? null

  const refreshSessions = useCallback(async () => {
    setProjectsLoading(true)
    try {
      const list = await getAgentDock().workspace.list()
      setProjects(list)
      const entries = await Promise.all(list.map(async (p) => [p.id, await getAgentDock().session.list(p.id)] as const))
      setSessionsByProject(Object.fromEntries(entries))
    } finally {
      setProjectsLoading(false)
    }
  }, [])

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
    void refreshSessions()
    void refreshAgents()
    void refreshSettings()
  }, [refreshSessions, refreshAgents, refreshSettings])

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
    if (!opened) return
    await refreshSessions()
    setNewSessionProjectId(opened.id)
    setSelectedSessionId(null)
  }, [refreshSessions])

  const closeWorkspace = useCallback(async () => {
    await getAgentDock().workspace.close()
  }, [])

  const renameProject = useCallback(
    async (id: string, name: string) => {
      await getAgentDock().workspace.rename(id, name)
      await refreshSessions()
    },
    [refreshSessions]
  )

  const deleteProject = useCallback(
    async (id: string) => {
      await getAgentDock().workspace.delete(id)
      setSelectedSessionId((current) => {
        const stillExists = current ? (sessionsByProject[id] ?? []).every((s) => s.id !== current) : true
        return stillExists ? current : null
      })
      if (newSessionProjectId === id) setNewSessionProjectId(null)
      await refreshSessions()
    },
    [refreshSessions, sessionsByProject, newSessionProjectId]
  )

  const toggleProjectCollapsed = useCallback(async (id: string) => {
    const target = projects.find((p) => p.id === id)
    if (!target) return
    const collapsed = !target.collapsed
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, collapsed } : p)))
    await getAgentDock().workspace.setCollapsed(id, collapsed)
  }, [projects])

  const updateSettings = useCallback(async (patch: Parameters<AppState['updateSettings']>[0]) => {
    const updated = await getAgentDock().settings.update(patch)
    setSettings(updated)
  }, [])

  const deleteSession = useCallback(
    async (id: string) => {
      await getAgentDock().session.delete(id)
      forgetConversation(id)
      setSelectedSessionId((current) => (current === id ? null : current))
      await refreshSessions()
    },
    [refreshSessions]
  )

  const renameSession = useCallback(
    async (id: string, title: string) => {
      await getAgentDock().session.rename(id, title)
      await refreshSessions()
    },
    [refreshSessions]
  )

  const startNewSessionInProject = useCallback((projectId: string) => {
    setNewSessionProjectId(projectId)
    setSelectedSessionId(null)
  }, [])

  const selectSession = useCallback((id: string | null) => {
    setSelectedSessionId(id)
    if (id) setNewSessionProjectId(null)
  }, [])

  const value = useMemo<AppState>(
    () => ({
      workspace,
      workspaceLoading: projectsLoading,
      openWorkspace,
      closeWorkspace,
      projects,
      projectsLoading,
      sessionsByProject,
      refreshSessions,
      renameProject,
      deleteProject,
      toggleProjectCollapsed,
      selectedSessionId,
      selectSession,
      deleteSession,
      renameSession,
      newSessionProjectId,
      startNewSessionInProject,
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
      projectsLoading,
      openWorkspace,
      closeWorkspace,
      projects,
      sessionsByProject,
      refreshSessions,
      renameProject,
      deleteProject,
      toggleProjectCollapsed,
      selectedSessionId,
      selectSession,
      deleteSession,
      renameSession,
      newSessionProjectId,
      startNewSessionInProject,
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
