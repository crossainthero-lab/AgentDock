import type React from 'react'
import { useAppState } from '../../state/AppStateContext'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import appIcon from '../../assets/icon.png'
import './EmptyWorkspace.css'

export function EmptyWorkspace(): React.JSX.Element {
  const { openWorkspace } = useAppState()

  return (
    <div className="ad-empty-workspace">
      <EmptyState
        icon={<img src={appIcon} alt="" width={48} height={48} style={{ borderRadius: 10 }} />}
        title="AgentDock"
        description="Open a project to start using Claude Code, Codex, or Antigravity on it."
        action={
          <>
            <Button variant="primary" onClick={() => void openWorkspace()}>
              Open Project
            </Button>
          </>
        }
      />
      <div className="ad-empty-workspace__hint">
        <kbd>Ctrl</kbd> + <kbd>O</kbd> to open a project
      </div>
    </div>
  )
}
