import type React from 'react'
import { useEffect, useState } from 'react'
import { GitBranch, Minus, Settings as SettingsIcon, Square, X } from 'lucide-react'
import { getAgentDock } from '../../lib/agentDockClient'
import { useAppState } from '../../state/AppStateContext'
import { IconButton } from '../ui/IconButton'
import './TitleBar.css'

export function TitleBar(): React.JSX.Element {
  const { workspace, setSettingsViewOpen } = useAppState()
  const [isMaximized, setIsMaximized] = useState(false)
  const [branch, setBranch] = useState<string | null>(null)

  useEffect(() => {
    void getAgentDock().windowCtl.isMaximized().then(setIsMaximized)
    return getAgentDock().windowCtl.onMaximizeChange(setIsMaximized)
  }, [])

  useEffect(() => {
    if (!workspace) {
      setBranch(null)
      return
    }
    let cancelled = false
    void getAgentDock()
      .git.branch(workspace.id)
      .then((b) => {
        if (!cancelled) setBranch(b)
      })
    return () => {
      cancelled = true
    }
  }, [workspace])

  return (
    <div className="ad-titlebar drag">
      <div className="ad-titlebar__left">
        <span className="ad-titlebar__logo">AgentDock</span>
        {workspace && (
          <>
            <span className="ad-titlebar__sep">/</span>
            <span className="ad-titlebar__project">{workspace.name}</span>
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
      </div>
    </div>
  )
}
