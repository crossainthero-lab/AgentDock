import type React from 'react'
import { useState } from 'react'
import { FileDiff, ListTree, MoreHorizontal, Square, Terminal, TerminalSquare, UserPlus } from 'lucide-react'
import { AGENT_DISPLAY_NAMES } from '@shared/types'
import type { AgentCapabilities, AgentModelOption, Session, SessionStatus } from '@shared/types'
import { StatusDot } from '../ui/StatusDot'
import { IconButton } from '../ui/IconButton'
import { Menu } from '../ui/Menu'
import './SessionHeader.css'

interface SessionHeaderProps {
  session: Session
  changedFileCount: number
  capabilities: AgentCapabilities | null
  currentPermissionMode: string
  /** The real model in use, reported by the transport itself (Claude's
   *  system/init) — null until known. Never guessed/hardcoded. */
  currentModel: string | null
  /** The real, effective permission mode reported the same way — may
   *  differ from `currentPermissionMode` (what AgentDock requested) if the
   *  CLI applied a policy override. Preferred for display when present. */
  effectivePermissionMode: string | null
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
  /** Only offered for Claude sessions — see NewSessionView/SessionView. */
  onOpenExternalTerminal?: () => void
  /** Opens the trace-only diagnostics view (Testing Mode) — offered for
   *  structured-transport agents that have no raw terminal drawer to show. */
  onOpenDiagnostics?: () => void
}

function statusLabel(status: SessionStatus): string {
  switch (status) {
    case 'running':
      return 'Thinking…'
    case 'waiting_for_permission':
      return 'Waiting for permission'
    case 'waiting_for_user':
      return 'Waiting for your response'
    case 'error':
      return 'Error'
    case 'stopped':
      return 'Cancelled'
    case 'cancelled':
      return 'Cancelled'
    case 'exited':
      return 'Process exited'
    default:
      return 'Ready'
  }
}

/** Resolves the Model menu's trigger text for a Claude session: the real
 *  reported model matched against the known alias list (e.g.
 *  "claude-sonnet-5" -> "Sonnet"), the raw value verbatim if it doesn't
 *  match any known alias, "Detecting model…" while a turn is active and
 *  nothing has been reported yet, or "Claude — Unknown model" once a turn
 *  has finished without ever reporting one. Never invents a model name. */
function claudeModelDisplay(
  currentModel: string | null,
  models: AgentModelOption[],
  sessionStatus: SessionStatus
): { label: string; selectedId: string | null } {
  if (currentModel) {
    const match = models.find((m) => currentModel.includes(m.id))
    return { label: match?.label ?? currentModel, selectedId: match?.id ?? null }
  }
  const turnLikelyActive = sessionStatus === 'running' || sessionStatus === 'waiting_for_permission' || sessionStatus === 'waiting_for_user'
  return turnLikelyActive ? { label: 'Detecting model…', selectedId: null } : { label: 'Claude — Unknown model', selectedId: null }
}

export function SessionHeader({
  session,
  changedFileCount,
  capabilities,
  currentPermissionMode,
  currentModel,
  effectivePermissionMode,
  showTerminal,
  onOpenChanges,
  onOpenTerminal,
  onOpenHandoff,
  onStop,
  onInterrupt,
  onSetModel,
  onSetPermissionMode,
  onRunCommand,
  onOpenExternalTerminal,
  onOpenDiagnostics
}: SessionHeaderProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const isClaude = session.agentId === 'claude-code'
  const modelDisplay = isClaude
    ? claudeModelDisplay(currentModel, capabilities?.models ?? [], session.status)
    : { label: 'Model', selectedId: null }
  const displayedPermissionMode = effectivePermissionMode ?? currentPermissionMode
  const permissionModeOption = capabilities?.permissionModes.find((m) => m.id === displayedPermissionMode)
  const isBusy = session.status === 'running' || session.status === 'waiting_for_permission' || session.status === 'waiting_for_user'

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
          selectedId={modelDisplay.selectedId}
          selectedLabel={isClaude ? modelDisplay.label : undefined}
          onSelect={onSetModel}
          disabled={!capabilities?.supportsLiveModelSwitch}
        />
        <Menu
          label="Permissions"
          items={capabilities?.permissionModes ?? []}
          selectedId={displayedPermissionMode}
          selectedLabel={permissionModeOption ? `Permissions: ${permissionModeOption.label}` : undefined}
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

        {isBusy && (
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
                {isBusy && (
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
                {!showTerminal && onOpenExternalTerminal && (
                  <button
                    onClick={() => {
                      setMenuOpen(false)
                      onOpenExternalTerminal()
                    }}
                  >
                    <TerminalSquare size={13} />
                    Open new {AGENT_DISPLAY_NAMES[session.agentId]} terminal here
                  </button>
                )}
                {!showTerminal && onOpenDiagnostics && (
                  <button
                    onClick={() => {
                      setMenuOpen(false)
                      onOpenDiagnostics()
                    }}
                  >
                    <ListTree size={13} />
                    Session diagnostics
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
