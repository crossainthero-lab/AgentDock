import type React from 'react'
import { useEffect } from 'react'
import { TitleBar } from './TitleBar'
import { SessionSidebar } from './SessionSidebar'
import { useAppState } from '../../state/AppStateContext'
import { EmptyWorkspace } from '../workspace/EmptyWorkspace'
import { NewSessionView } from '../workspace/NewSessionView'
import { SessionView } from '../session/SessionView'
import { SettingsView } from '../settings/SettingsView'
import { ApprovalDialog } from '../session/ApprovalDialog'
import { FileExplorerPanel } from '../explorer/FileExplorerPanel'
import './AppShell.css'

export function AppShell(): React.JSX.Element {
  const {
    projects,
    projectsLoading,
    sessionsByProject,
    selectedSessionId,
    newSessionProjectId,
    workspace,
    settingsViewOpen,
    setSettingsViewOpen,
    fileExplorerOpen,
    setFileExplorerOpen,
    openWorkspace
  } = useAppState()

  useEffect(() => {
    if (projects.length > 0) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void openWorkspace()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [projects.length, openWorkspace])

  // Falls back to the most recently active project's agent picker when
  // nothing else has been explicitly chosen yet (e.g. right after launch)
  // — the same default single-project behavior this app always had, now
  // just one of several projects rather than the only one.
  const effectiveNewSessionProjectId = newSessionProjectId ?? workspace?.id ?? null

  // Same "what project is actually being looked at" resolution TitleBar
  // uses for its branch/project label — the file explorer shows that
  // project's files regardless of which view (session/new-session/empty)
  // is currently active.
  const selectedSessionProjectId = selectedSessionId
    ? Object.entries(sessionsByProject).find(([, sessions]) => sessions.some((s) => s.id === selectedSessionId))?.[0]
    : undefined
  const activeProjectId = selectedSessionProjectId ?? effectiveNewSessionProjectId ?? null

  return (
    <div className="ad-app-shell">
      <TitleBar />
      <div className="ad-app-shell__body">
        <SessionSidebar />
        <main className="ad-app-shell__main">
          {projectsLoading ? null : projects.length === 0 ? (
            <EmptyWorkspace />
          ) : selectedSessionId ? (
            <SessionView sessionId={selectedSessionId} />
          ) : effectiveNewSessionProjectId ? (
            <NewSessionView projectId={effectiveNewSessionProjectId} />
          ) : (
            <EmptyWorkspace />
          )}
        </main>
        {fileExplorerOpen && activeProjectId && (
          <FileExplorerPanel open workspaceId={activeProjectId} onClose={() => setFileExplorerOpen(false)} />
        )}
      </div>
      <SettingsView open={settingsViewOpen} onClose={() => setSettingsViewOpen(false)} />
      <ApprovalDialog />
    </div>
  )
}
