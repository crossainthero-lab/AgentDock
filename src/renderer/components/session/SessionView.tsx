import type React from 'react'
import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppStateContext'
import { useSessionConversation } from '../../state/useSessionConversation'
import { getAgentDock } from '../../lib/agentDockClient'
import { AGENT_DISPLAY_NAMES } from '@shared/types'
import type { AgentCapabilities, Session } from '@shared/types'
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

  if (!workspace || !conversation.session) return null

  const session: Session = conversation.session
  const detection = agents.find((a) => a.agentId === session.agentId)
  const agentInstalled = detection?.installed ?? false
  const composerDisabled = !agentInstalled
  const composerDisabledReason = !agentInstalled ? `${AGENT_DISPLAY_NAMES[session.agentId]} is not installed. Open Settings → Agents.` : null
  const openTerminal = (): void => {
    setChangesOpen(false)
    setTerminalOpen(true)
  }

  return (
    <div className="ad-session-view">
      <div className="ad-session-view__main">
        <SessionHeader
          session={session}
          changedFileCount={changedCount}
          capabilities={capabilities}
          currentPermissionMode={settings?.agents[session.agentId]?.permissionMode ?? 'default'}
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
            conversation.setModel(modelId).catch((err) => reportActionError('Set model', err))
          }}
          onSetPermissionMode={(modeId) => {
            void updateSettings({ agents: { [session.agentId]: { permissionMode: modeId } } })
          }}
          onRunCommand={(commandId) => {
            conversation.runCommand(commandId).catch((err) => reportActionError('Run command', err))
          }}
        />

        {actionError && (
          <div className="ad-session-view__error-banner">
            <span>{actionError}</span>
            <button onClick={() => setActionError(null)}>Dismiss</button>
          </div>
        )}

        <ConversationView
          messages={conversation.messages}
          pendingText={conversation.pendingText}
          activityLabel={conversation.activityLabel}
          pendingInteraction={conversation.pendingInteraction}
          agentLabel={AGENT_DISPLAY_NAMES[session.agentId]}
          onRespondInteraction={(interactionId, optionId) => {
            conversation.respondToInteraction(interactionId, optionId).catch((err) => reportActionError('Respond', err))
          }}
          onOpenTerminal={openTerminal}
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
            inputSupported
            isRunning={conversation.isBusy}
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
