import type React from 'react'
import { useState } from 'react'
import { FileDiff, MoreHorizontal, Square, Terminal, UserPlus } from 'lucide-react'
import { AGENT_DISPLAY_NAMES } from '@shared/types'
import type { AgentCapabilities, Session, SessionStatus } from '@shared/types'
import { StatusDot } from '../ui/StatusDot'
import { IconButton } from '../ui/IconButton'
import { Menu } from '../ui/Menu'
import './SessionHeader.css'

interface SessionHeaderProps {
  session: Session
  changedFileCount: number
  capabilities: AgentCapabilities | null
  currentPermissionMode: string
  /** False for structured-transport agents (Claude, Codex) — they have no
   *  PTY/raw screen for the Terminal drawer to show. */
  showTerminal: boolean
  onOpenChanges: () => void
  onOpenTerminal: () => void
  onOpenHandoff: () => void
  onStop: () => void
  onInterrupt: () => void
  onSetModel: (modelId: string) => void
  onSetPermissionMode: (modeId: string) => void
  onRunCommand: (commandId: string) => void
}

function statusLabel(status: SessionStatus): string {
  switch (status) {
    case 'running':
      return 'Running'
    case 'error':
      return 'Error'
    case 'stopped':
      return 'Stopped'
    default:
      return 'Idle'
  }
}

export function SessionHeader({
  session,
  changedFileCount,
  capabilities,
  currentPermissionMode,
  showTerminal,
  onOpenChanges,
  onOpenTerminal,
  onOpenHandoff,
  onStop,
  onInterrupt,
  onSetModel,
  onSetPermissionMode,
  onRunCommand
}: SessionHeaderProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="ad-session-header">
      <div className="ad-session-header__left">
        <span className="ad-session-header__title">{session.title}</span>
        <span className="ad-session-header__agent">{AGENT_DISPLAY_NAMES[session.agentId]}</span>
        <span className="ad-session-header__status">
          <StatusDot status={session.status} />
          {statusLabel(session.status)}
        </span>
      </div>

      <div className="ad-session-header__right">
        {/* Native agent controls — only the ones this agent's capabilities
         *  actually report are rendered at all (Menu returns null when its
         *  item list is empty). */}
        <Menu
          label="Model"
          items={capabilities?.models ?? []}
          onSelect={onSetModel}
          disabled={!capabilities?.supportsLiveModelSwitch}
        />
        <Menu
          label="Permissions"
          items={capabilities?.permissionModes ?? []}
          selectedId={currentPermissionMode}
          onSelect={onSetPermissionMode}
        />
        <Menu label="Commands" items={capabilities?.commands ?? []} onSelect={onRunCommand} />

        {showTerminal && (
          <IconButton label="Terminal" size="sm" onClick={onOpenTerminal}>
            <Terminal size={14} />
          </IconButton>
        )}

        {changedFileCount > 0 && (
          <button className="ad-session-header__changes-btn" onClick={onOpenChanges}>
            <FileDiff size={13} />
            {changedFileCount} file{changedFileCount === 1 ? '' : 's'} changed
          </button>
        )}

        {session.status === 'running' && (
          <IconButton label="Interrupt" size="sm" onClick={onInterrupt}>
            <Square size={13} />
          </IconButton>
        )}

        <div className="ad-session-header__menu-wrap">
          <IconButton label="More" size="sm" onClick={() => setMenuOpen((v) => !v)}>
            <MoreHorizontal size={15} />
          </IconButton>
          {menuOpen && (
            <>
              <div className="ad-session-header__menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="ad-session-header__menu">
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    onOpenHandoff()
                  }}
                >
                  <UserPlus size={13} />
                  Continue with another agent
                </button>
                {session.status === 'running' && (
                  <button
                    onClick={() => {
                      setMenuOpen(false)
                      onStop()
                    }}
                  >
                    <Square size={13} />
                    Stop session
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
