import type React from 'react'
import { useEffect, useState } from 'react'
import { FileDiff, ListTree, MoreHorizontal, RefreshCw, Square, Terminal, TerminalSquare, UserPlus } from 'lucide-react'
import { AGENT_DISPLAY_NAMES } from '@shared/types'
import type { AgentCapabilities, AgentModelOption, Session, SessionStatus } from '@shared/types'
import { StatusDot } from '../ui/StatusDot'
import { IconButton } from '../ui/IconButton'
import { Menu } from '../ui/Menu'
import { Button } from '../ui/Button'
import './SessionHeader.css'

interface SessionHeaderProps {
  session: Session
  /** The live, corrected status — reflects a pending permission/question
   *  immediately via the reducer (see useSessionConversation's deriveStatus),
   *  unlike `session.status` which is only a locally-mirrored copy of the
   *  persisted value and doesn't update for non-terminal states like
   *  waiting_for_permission/waiting_for_user until the next full refetch. */
  status: SessionStatus
  changedFileCount: number
  capabilities: AgentCapabilities | null
  currentPermissionMode: string
  /** The real model in use, reported by the transport itself (Claude's
   *  system/init) — null until known. Never guessed/hardcoded. */
  currentModel: string | null
  /** The real reasoning effort in use for the current model (Claude and
   *  Codex both) — each model has its own supportedReasoningEfforts list,
   *  so this is a separate control from currentModel, not a mode of it. */
  currentReasoningEffort: string | null
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
  onSetReasoningEffort: (effortId: string) => void
  onSetPermissionMode: (modeId: string) => void
  onRunCommand: (commandId: string) => void
  /** Codex only — re-fetches the live model catalogue from Codex's
   *  app-server (`model/list`), replacing whatever's currently shown. */
  onRefreshModelCatalog?: () => void
  refreshingModelCatalog?: boolean
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

/** Resolves the Model menu's trigger text for a Codex or Antigravity
 *  session. Unlike Claude, neither transport ever echoes the active model
 *  back on its own — what AgentDock knows is exactly what it told the CLI
 *  to use (see CodexAdapter's/AntigravityAdapter's model_info emission), so
 *  this only ever shows a real selected model or the generic placeholder —
 *  never a guess at what the CLI's own config default might be on this
 *  machine. Model ids for both agents are exact-equality matches
 *  (Antigravity's ids are the literal display strings it expects on
 *  `--model`), so one helper serves both. */
function codexModelDisplay(currentModel: string | null, models: AgentModelOption[]): { label: string; selectedId: string | null } {
  if (!currentModel) return { label: 'Model', selectedId: null }
  const match = models.find((m) => m.id === currentModel)
  return { label: match?.label ?? currentModel, selectedId: match?.id ?? currentModel }
}

function capitalize(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/** Resolves the Reasoning menu's trigger text — a real selected level, the
 *  selected model's own default level (labeled as such, never presented as
 *  if the user picked it), or the generic placeholder. Deliberately
 *  ignores a persisted level that isn't valid for the *current* model
 *  (e.g. switching from a reasoning-capable model to one with no
 *  supportedReasoningEfforts at all, like Claude's Haiku) rather than
 *  displaying a stale/invalid selection — this is what "automatically
 *  choose its valid default and update the displayed value" means for a
 *  model that doesn't support reasoning effort at all: there is no valid
 *  level, so nothing is shown as selected (the Menu itself also renders
 *  nothing in that case, since its items list is empty). */
function reasoningEffortDisplay(
  currentReasoningEffort: string | null,
  selectedModel: AgentModelOption | undefined
): { label: string; selectedId: string | null } {
  const options = selectedModel?.supportedReasoningEfforts
  if (!selectedModel || !options || options.length === 0) return { label: 'Reasoning', selectedId: null }
  if (currentReasoningEffort) {
    const match = options.find((e) => e.id === currentReasoningEffort)
    if (match) return { label: match.label, selectedId: match.id }
    // Persisted level doesn't exist for this model — fall through to the
    // model's own default instead of showing a value it doesn't support.
  }
  if (selectedModel.defaultReasoningEffort) {
    const defaultMatch = options.find((e) => e.id === selectedModel.defaultReasoningEffort)
    return {
      label: `${defaultMatch?.label ?? capitalize(selectedModel.defaultReasoningEffort)} (default)`,
      selectedId: selectedModel.defaultReasoningEffort
    }
  }
  return { label: 'Reasoning', selectedId: null }
}

export function SessionHeader({
  session,
  status,
  changedFileCount,
  capabilities,
  currentPermissionMode,
  currentModel,
  currentReasoningEffort,
  effectivePermissionMode,
  showTerminal,
  onOpenChanges,
  onOpenTerminal,
  onOpenHandoff,
  onStop,
  onInterrupt,
  onSetModel,
  onSetReasoningEffort,
  onSetPermissionMode,
  onRunCommand,
  onRefreshModelCatalog,
  refreshingModelCatalog,
  onOpenExternalTerminal,
  onOpenDiagnostics
}: SessionHeaderProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [showLegacyModels, setShowLegacyModels] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menuOpen])
  const isClaude = session.agentId === 'claude-code'
  const isCodex = session.agentId === 'codex'
  const isAntigravity = session.agentId === 'antigravity'
  const modelDisplay = isClaude
    ? claudeModelDisplay(currentModel, capabilities?.models ?? [], status)
    : isCodex || isAntigravity
      ? codexModelDisplay(currentModel, capabilities?.models ?? [])
      : { label: 'Model', selectedId: null }
  const displayedPermissionMode = effectivePermissionMode ?? currentPermissionMode
  const permissionModeOption = capabilities?.permissionModes.find((m) => m.id === displayedPermissionMode)
  const isBusy = status === 'running' || status === 'waiting_for_permission' || status === 'waiting_for_user'

  // Codex's live catalogue mixes visible and legacy/hidden models together
  // (see codex-model-catalog-service.ts) — split them so legacy ones are
  // opt-in and clearly marked, never mixed in silently.
  const allCodexModels = capabilities?.models ?? []
  const visibleCodexModels = isCodex ? allCodexModels.filter((m) => !m.hidden) : allCodexModels
  const legacyCodexModels = isCodex ? allCodexModels.filter((m) => m.hidden) : []
  const codexModelMenuItems = showLegacyModels
    ? [...visibleCodexModels, ...legacyCodexModels.map((m) => ({ ...m, label: `Legacy: ${m.label}`, description: `${m.description ?? ''} (legacy)`.trim() }))]
    : visibleCodexModels

  const selectedCodexModel = isCodex ? allCodexModels.find((m) => m.id === modelDisplay.selectedId) : undefined
  // Claude's model list is capabilities.models directly (no legacy/hidden
  // split — that's a Codex-only concept, since Codex's live catalogue
  // genuinely returns account-hidden models and Claude's static list
  // doesn't have an equivalent).
  const selectedClaudeModel = isClaude ? (capabilities?.models ?? []).find((m) => m.id === modelDisplay.selectedId) : undefined
  const selectedModelForReasoning = isCodex ? selectedCodexModel : selectedClaudeModel
  const reasoningDisplay = reasoningEffortDisplay(currentReasoningEffort, selectedModelForReasoning)

  return (
    <div className="ad-session-header">
      <div className="ad-session-header__left">
        <span className="ad-session-header__title">{session.title}</span>
        <span className="ad-session-header__agent">{AGENT_DISPLAY_NAMES[session.agentId]}</span>
        <span className="ad-session-header__status">
          <StatusDot status={status} />
          {statusLabel(status)}
        </span>
      </div>

      <div className="ad-session-header__right">
        {/* Native agent controls — only the ones this agent's capabilities
         *  actually report are rendered at all (Menu returns null when its
         *  item list is empty). */}
        <Menu
          label="Model"
          items={isCodex ? codexModelMenuItems : (capabilities?.models ?? [])}
          selectedId={modelDisplay.selectedId}
          selectedLabel={isClaude || isCodex || isAntigravity ? modelDisplay.label : undefined}
          onSelect={onSetModel}
          disabled={!capabilities?.supportsLiveModelSwitch}
        />
        {(isClaude || isCodex) && (
          <Menu
            label="Reasoning"
            items={selectedModelForReasoning?.supportedReasoningEfforts ?? []}
            selectedId={reasoningDisplay.selectedId}
            selectedLabel={`Reasoning: ${reasoningDisplay.label}`}
            onSelect={onSetReasoningEffort}
          />
        )}
        {isCodex && legacyCodexModels.length > 0 && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowLegacyModels((v) => !v)}
            title={showLegacyModels ? 'Hide legacy Codex models' : `Show ${legacyCodexModels.length} legacy Codex model(s)`}
          >
            {showLegacyModels ? 'Hide legacy' : 'Show legacy'}
          </Button>
        )}
        {isCodex && onRefreshModelCatalog && (
          <IconButton label="Refresh Codex model list" size="sm" onClick={onRefreshModelCatalog} disabled={refreshingModelCatalog}>
            <RefreshCw size={13} className={refreshingModelCatalog ? 'ad-session-header__refresh-spin' : undefined} />
          </IconButton>
        )}
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
          <Button variant="secondary" size="sm" onClick={onOpenChanges}>
            <FileDiff size={13} />
            {changedFileCount} file{changedFileCount === 1 ? '' : 's'} changed
          </Button>
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
