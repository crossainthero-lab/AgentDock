import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { getAgentDock } from '../lib/agentDockClient'
import type { AgentDetection, CliSetupInfo, Session, Settings, Workspace } from '@shared/types'
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

  /** Per-agent CLI Setup Assistant status (installed/launchable/
   *  authenticated) — a separate, richer classification from `agents`
   *  above (see cli-setup-service.ts). Checked once at launch and again on
   *  demand (install/sign-in completing, "Check again"). */
  cliSetupStatuses: CliSetupInfo[]
  cliSetupLoading: boolean
  refreshCliSetup: () => Promise<CliSetupInfo[]>
  /** True once at least one status check has completed and at least one
   *  agent isn't 'ready' — drives the small warning indicators shown
   *  outside the full setup screen. */
  hasCliSetupIssues: boolean
  cliSetupScreenOpen: boolean
  openCliSetupScreen: () => void
  closeCliSetupScreen: () => void
  /** "Skip for now" — closes the screen AND persists the dismissal so it
   *  doesn't reappear unprompted on every launch (small indicators still
   *  show; the screen can always be reopened from Settings). */
  dismissCliSetupScreen: () => Promise<void>

  fileExplorerOpen: boolean
  setFileExplorerOpen: (open: boolean) => void

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
  const [fileExplorerOpen, setFileExplorerOpen] = useState(false)

  const [cliSetupStatuses, setCliSetupStatuses] = useState<CliSetupInfo[]>([])
  const [cliSetupLoading, setCliSetupLoading] = useState(true)
  const [cliSetupScreenOpen, setCliSetupScreenOpen] = useState(false)
  // Guards the one-time "auto-show the setup screen at launch" decision —
  // without this, refreshCliSetup() re-running later (e.g. the Settings
  // "Check again" button) would keep re-opening the screen every time it
  // still finds an issue, defeating "Skip for now"/re-closing it.
  const autoPromptedRef = useRef(false)

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
    return current
  }, [])

  const refreshCliSetup = useCallback(async () => {
    setCliSetupLoading(true)
    try {
      const list = await getAgentDock().cliSetup.getStatuses()
      setCliSetupStatuses(list)
      return list
    } finally {
      setCliSetupLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshSessions()
    void refreshAgents()
    void refreshSettings()
    void refreshCliSetup()
  }, [refreshSessions, refreshAgents, refreshSettings, refreshCliSetup])

  // Automatic detection "when AgentDock starts": once both the persisted
  // dismissal flag and the first real status check have arrived, show the
  // full setup screen exactly once if anything isn't ready and the user
  // hasn't previously chosen "Skip for now". Never re-triggers itself later
  // (autoPromptedRef) — a later refreshCliSetup() (Settings "Check again",
  // after an install finishes) only ever updates the small indicators
  // unless the user explicitly reopens the full screen.
  useEffect(() => {
    if (autoPromptedRef.current) return
    if (!settings || cliSetupLoading || cliSetupStatuses.length === 0) return
    autoPromptedRef.current = true
    const hasIssue = cliSetupStatuses.some((s) => s.status !== 'ready')
    if (hasIssue && !settings.cliSetup.setupDismissed) setCliSetupScreenOpen(true)
  }, [settings, cliSetupLoading, cliSetupStatuses])

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

  const openCliSetupScreen = useCallback(() => setCliSetupScreenOpen(true), [])
  const closeCliSetupScreen = useCallback(() => setCliSetupScreenOpen(false), [])
  const dismissCliSetupScreen = useCallback(async () => {
    await updateSettings({ cliSetup: { setupDismissed: true } })
    setCliSetupScreenOpen(false)
  }, [updateSettings])

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
      cliSetupStatuses,
      cliSetupLoading,
      refreshCliSetup,
      hasCliSetupIssues: cliSetupStatuses.length > 0 && cliSetupStatuses.some((s) => s.status !== 'ready'),
      cliSetupScreenOpen,
      openCliSetupScreen,
      closeCliSetupScreen,
      dismissCliSetupScreen,
      fileExplorerOpen,
      setFileExplorerOpen,
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
      cliSetupStatuses,
      cliSetupLoading,
      refreshCliSetup,
      cliSetupScreenOpen,
      openCliSetupScreen,
      closeCliSetupScreen,
      dismissCliSetupScreen,
      fileExplorerOpen,
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
