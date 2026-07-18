import type React from 'react'
import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppStateContext'
import { useSessionConversation } from '../../state/useSessionConversation'
import { getAgentDock } from '../../lib/agentDockClient'
import { AGENT_DISPLAY_NAMES } from '@shared/types'
import type { AgentCapabilities, AgentModelOption, Session } from '@shared/types'
import { SessionHeader } from './SessionHeader'
import { ConversationView } from './ConversationView'
import { PromptComposer } from './PromptComposer'
import { HandoffDialog } from './HandoffDialog'
import { ChangesDrawer } from '../drawers/ChangesDrawer'
import { TerminalDrawer } from '../drawers/TerminalDrawer'
import './SessionView.css'

export function SessionView({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { workspace, agents, settings, updateSettings, selectSession } = useAppState()
  const conversation = useSessionConversation(sessionId)
  const [changesOpen, setChangesOpen] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [changedCount, setChangedCount] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null)
  // Codex's model list isn't part of the static capability declaration —
  // it's fetched live from Codex's own account-scoped catalogue (see
  // codex-model-catalog-service.ts) and merged into `capabilities.models`
  // at render time below, kept separate here so a slow/failed catalogue
  // fetch never blocks or clobbers the rest of capabilities.
  const [codexModels, setCodexModels] = useState<AgentModelOption[]>([])
  const [codexCatalogRefreshing, setCodexCatalogRefreshing] = useState(false)

  useEffect(() => {
    setChangesOpen(false)
    setTerminalOpen(false)
    setHandoffOpen(false)
    setActionError(null)
  }, [sessionId])

  function reportActionError(action: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[session-view] ${action} failed:`, err)
    setActionError(`${action} failed: ${message}`)
  }

  useEffect(() => {
    if (!workspace || conversation.isBusy) return
    let cancelled = false
    void getAgentDock()
      .git.changedFiles(workspace.id)
      .then((files) => {
        if (!cancelled) setChangedCount(files.length)
      })
    return () => {
      cancelled = true
    }
  }, [workspace, conversation.isBusy])

  useEffect(() => {
    const agentId = conversation.session?.agentId
    if (!agentId) return
    let cancelled = false
    void getAgentDock()
      .agents.getCapabilities(agentId)
      .then((caps) => {
        if (!cancelled) setCapabilities(caps)
      })
    return () => {
      cancelled = true
    }
  }, [conversation.session?.agentId])

  // Fast, non-blocking load of whatever's cached — never spawns a process.
  // A real live fetch also happens once at app startup (main/index.ts) and
  // whenever the user presses the header's refresh button below, per "when
  // AgentDock starts... and when the user presses a refresh button."
  useEffect(() => {
    if (conversation.session?.agentId !== 'codex') return
    let cancelled = false
    void getAgentDock()
      .codex.getModelCatalog()
      .then((result) => {
        if (!cancelled) setCodexModels(result.models)
      })
    return () => {
      cancelled = true
    }
  }, [conversation.session?.agentId])

  function refreshCodexModelCatalog(): void {
    setCodexCatalogRefreshing(true)
    getAgentDock()
      .codex.refreshModelCatalog()
      .then((result) => {
        setCodexModels(result.models)
        if (result.error && result.source !== 'live') reportActionError('Refresh model list', new Error(result.error))
      })
      .catch((err) => reportActionError('Refresh model list', err))
      .finally(() => setCodexCatalogRefreshing(false))
  }

  if (!workspace || !conversation.session) return null

  const session: Session = conversation.session
  const detection = agents.find((a) => a.agentId === session.agentId)
  const agentInstalled = detection?.installed ?? false
  const composerDisabled = !agentInstalled
  const composerDisabledReason = !agentInstalled ? `${AGENT_DISPLAY_NAMES[session.agentId]} is not installed. Open Settings → Agents.` : null
  // Claude/Codex's structured JSON transports have no PTY/raw screen — the
  // Terminal drawer only has something to show for Antigravity.
  const showTerminal = detection?.structuredOutput === false
  const openTerminal = (): void => {
    if (showTerminal) {
      setChangesOpen(false)
      setTerminalOpen(true)
      return
    }
    // No in-app drawer to show for this agent — open a real, independent
    // terminal instead (a genuinely new process, not a reattachment).
    conversation
      .openExternalTerminal()
      .then((result) => {
        if (!result.launched) reportActionError('Open terminal', new Error(result.error ?? 'Unknown error'))
      })
      .catch((err) => reportActionError('Open terminal', err))
  }

  // Codex's live catalogue is fetched separately from the static
  // capability declaration (see the effects above) — merged in here at
  // render time rather than into `capabilities` state directly, so a
  // slow/failed catalogue fetch can never clobber permissionModes/commands.
  const effectiveCapabilities: AgentCapabilities | null =
    session.agentId === 'codex' && capabilities ? { ...capabilities, models: codexModels } : capabilities

  return (
    <div className="ad-session-view">
      <div className="ad-session-view__main">
        <SessionHeader
          session={session}
          changedFileCount={changedCount}
          capabilities={effectiveCapabilities}
          currentPermissionMode={settings?.agents[session.agentId]?.permissionMode ?? 'default'}
          currentModel={conversation.currentModel}
          currentReasoningEffort={conversation.currentReasoningEffort}
          effectivePermissionMode={conversation.effectivePermissionMode}
          showTerminal={showTerminal}
          onOpenChanges={() => {
            setTerminalOpen(false)
            setChangesOpen(true)
          }}
          onOpenTerminal={openTerminal}
          onOpenHandoff={() => setHandoffOpen(true)}
          onStop={() => {
            conversation.stop().catch((err) => reportActionError('Stop', err))
          }}
          onInterrupt={() => {
            conversation.interrupt().catch((err) => reportActionError('Interrupt', err))
          }}
          onSetModel={(modelId) => {
            // Codex spawns a brand-new process/thread every turn (see
            // session-service.sendPrompt) rather than keeping one live the
            // way Claude does, so there's no in-flight query to redirect —
            // persisting the choice (same mechanism as permission mode
            // just above) is what makes it apply to the next turn and to
            // future sessions.
            if (session.agentId === 'codex') {
              void updateSettings({ agents: { codex: { model: modelId } } })
              return
            }
            conversation.setModel(modelId).catch((err) => reportActionError('Set model', err))
          }}
          onSetReasoningEffort={(effortId) => {
            // Same persistence-based mechanism as onSetModel above — Codex
            // is the only agent this applies to today (Menu renders
            // nothing for agents with no supportedReasoningEfforts data).
            void updateSettings({ agents: { codex: { reasoningEffort: effortId } } })
          }}
          onRefreshModelCatalog={session.agentId === 'codex' ? refreshCodexModelCatalog : undefined}
          refreshingModelCatalog={codexCatalogRefreshing}
          onSetPermissionMode={(modeId) => {
            void updateSettings({ agents: { [session.agentId]: { permissionMode: modeId } } })
          }}
          onRunCommand={(commandId) => {
            conversation.runCommand(commandId).catch((err) => reportActionError('Run command', err))
          }}
          onOpenExternalTerminal={
            // Any structured-transport agent (Claude, Codex) has no in-app
            // terminal drawer to fall back to — Antigravity already has a
            // real, working one (showTerminal), so this button is only
            // offered where it's the sole way to get a terminal at all.
            !showTerminal
              ? () => {
                  conversation
                    .openExternalTerminal()
                    .then((result) => {
                      if (!result.launched) reportActionError('Open terminal', new Error(result.error ?? 'Unknown error'))
                    })
                    .catch((err) => reportActionError('Open terminal', err))
                }
              : undefined
          }
          onOpenDiagnostics={() => {
            setChangesOpen(false)
            setTerminalOpen(true)
          }}
        />

        {actionError && (
          <div className="ad-session-view__error-banner">
            <span>{actionError}</span>
            <button onClick={() => setActionError(null)}>Dismiss</button>
          </div>
        )}

        <ConversationView
          items={conversation.items}
          activityLabel={conversation.activityLabel}
          pendingInteraction={conversation.pendingInteraction}
          agentLabel={AGENT_DISPLAY_NAMES[session.agentId]}
          onRespondInteraction={(interactionId, optionId) => {
            conversation.respondToInteraction(interactionId, optionId).catch((err) => reportActionError('Respond', err))
          }}
          onRetryMessage={(userMessageId) => {
            conversation.retryMessage(userMessageId).catch((err) => reportActionError('Retry', err))
          }}
          onOpenTerminal={openTerminal}
          workspaceId={workspace.id}
        />

        <PromptComposer
          disabled={composerDisabled}
          disabledReason={composerDisabledReason}
          isRunning={conversation.isBusy}
          onSend={(text) => {
            setActionError(null)
            conversation.sendPrompt(text).catch((err) => reportActionError('Send', err))
          }}
          onInterrupt={() => {
            conversation.interrupt().catch((err) => reportActionError('Interrupt', err))
          }}
        />

        {terminalOpen && (
          <TerminalDrawer
            open={terminalOpen}
            onClose={() => setTerminalOpen(false)}
            sessionId={sessionId}
            inputSupported={showTerminal}
            isRunning={conversation.isBusy}
            traces={conversation.traces}
          />
        )}
      </div>

      {changesOpen && (
        <ChangesDrawer
          open={changesOpen}
          onClose={() => setChangesOpen(false)}
          workspaceId={workspace.id}
          onChanged={() => {
            void getAgentDock()
              .git.changedFiles(workspace.id)
              .then((files) => setChangedCount(files.length))
          }}
        />
      )}

      <HandoffDialog
        open={handoffOpen}
        onClose={() => setHandoffOpen(false)}
        sourceSession={session}
        onCompleted={(newSession) => selectSession(newSession.id)}
      />
    </div>
  )
}
