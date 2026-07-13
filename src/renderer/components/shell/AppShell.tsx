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
  const { workspace, workspaceLoading, selectedSessionId, settingsViewOpen, setSettingsViewOpen, openWorkspace } =
    useAppState()

  useEffect(() => {
    if (workspace) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void openWorkspace()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [workspace, openWorkspace])

  return (
    <div className="ad-app-shell">
      <TitleBar />
      <div className="ad-app-shell__body">
        <SessionSidebar />
        <main className="ad-app-shell__main">
          {workspaceLoading ? null : !workspace ? (
            <EmptyWorkspace />
          ) : !selectedSessionId ? (
            <NewSessionView />
          ) : (
            <SessionView sessionId={selectedSessionId} />
          )}
        </main>
      </div>
      <SettingsView open={settingsViewOpen} onClose={() => setSettingsViewOpen(false)} />
      <ApprovalDialog />
    </div>
  )
}
