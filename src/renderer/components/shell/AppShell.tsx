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
import './AppShell.css'

export function AppShell(): React.JSX.Element {
  const {
    projects,
    projectsLoading,
    selectedSessionId,
    newSessionProjectId,
    workspace,
    settingsViewOpen,
    setSettingsViewOpen,
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
      </div>
      <SettingsView open={settingsViewOpen} onClose={() => setSettingsViewOpen(false)} />
      <ApprovalDialog />
    </div>
  )
}
