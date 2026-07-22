import type React from 'react'
import { useEffect, useState } from 'react'
import { GitBranch, Minus, Settings as SettingsIcon, Square, X } from 'lucide-react'
import { getAgentDock } from '../../lib/agentDockClient'
import { useAppState } from '../../state/AppStateContext'
import { IconButton } from '../ui/IconButton'
import './TitleBar.css'

// macOS gets its own native traffic-light controls (see main/index.ts's
// titleBarStyle: 'hiddenInset') — rendering these Windows-style custom
// min/max/close buttons on top would just be a confusing duplicate set.
const isMac = getAgentDock().platform === 'darwin'

export function TitleBar(): React.JSX.Element {
  const { workspace, projects, sessionsByProject, selectedSessionId, newSessionProjectId, setSettingsViewOpen } =
    useAppState()
  const [isMaximized, setIsMaximized] = useState(false)
  const [branch, setBranch] = useState<string | null>(null)

  // The project actually being looked at right now — the selected
  // conversation's own project when one is open, otherwise whichever
  // project's "choose an agent" screen is showing, otherwise the most
  // recently active one. Never assumes the selected conversation belongs
  // to `workspace` (the most-recent project), since with multiple projects
  // visible at once it frequently won't.
  const selectedSessionProjectId = selectedSessionId
    ? Object.entries(sessionsByProject).find(([, sessions]) => sessions.some((s) => s.id === selectedSessionId))?.[0]
    : undefined
  const activeProjectId = selectedSessionProjectId ?? newSessionProjectId ?? workspace?.id ?? null
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null

  useEffect(() => {
    void getAgentDock().windowCtl.isMaximized().then(setIsMaximized)
    return getAgentDock().windowCtl.onMaximizeChange(setIsMaximized)
  }, [])

  useEffect(() => {
    if (!activeProject) {
      setBranch(null)
      return
    }
    let cancelled = false
    void getAgentDock()
      .git.branch(activeProject.id)
      .then((b) => {
        if (!cancelled) setBranch(b)
      })
    return () => {
      cancelled = true
    }
  }, [activeProject])

  return (
    <div className={`ad-titlebar drag${isMac ? ' ad-titlebar--mac' : ''}`}>
      <div className="ad-titlebar__left">
        <span className="ad-titlebar__logo">AgentDock</span>
        {activeProject && (
          <>
            <span className="ad-titlebar__sep">/</span>
            <span className="ad-titlebar__project">{activeProject.name}</span>
            {branch && (
              <span className="ad-titlebar__branch">
                <GitBranch size={11} />
                {branch}
              </span>
            )}
          </>
        )}
      </div>

      <div className="ad-titlebar__right no-drag">
        <IconButton label="Settings" size="sm" onClick={() => setSettingsViewOpen(true)}>
          <SettingsIcon size={15} />
        </IconButton>
        {!isMac && (
          <div className="ad-titlebar__window-controls">
            <button
              className="ad-titlebar__control"
              aria-label="Minimize"
              onClick={() => getAgentDock().windowCtl.minimize()}
            >
              <Minus size={14} />
            </button>
            <button
              className="ad-titlebar__control"
              aria-label={isMaximized ? 'Restore' : 'Maximize'}
              onClick={() => getAgentDock().windowCtl.maximize()}
            >
              <Square size={11} />
            </button>
            <button
              className="ad-titlebar__control ad-titlebar__control--close"
              aria-label="Close"
              onClick={() => getAgentDock().windowCtl.close()}
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
