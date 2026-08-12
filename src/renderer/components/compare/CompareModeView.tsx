import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Columns3, Square } from 'lucide-react'
import { AGENT_DISPLAY_NAMES, AGENT_IDS, type AgentCapabilities, type AgentId, type AgentModelOption, type Session, type SessionStatus } from '@shared/types'
import { useAppState } from '../../state/AppStateContext'
import { useSessionConversation } from '../../state/useSessionConversation'
import { sendPrompt as sendConversationPrompt } from '../../state/conversationStore'
import { getAgentDock } from '../../lib/agentDockClient'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import { StatusDot } from '../ui/StatusDot'
import { ConversationView } from '../session/ConversationView'
import { ProviderUsageIndicator } from '../usage/ProviderUsageIndicator'
import './CompareModeView.css'

interface ComparePaneConfig {
  agentId: AgentId
  session: Session
  model: string
}

const SAFE_PERMISSION_MODE: Record<AgentId, string> = {
  'claude-code': 'plan',
  codex: 'read-only',
  antigravity: 'plan'
}

function paneStateLabel(status: SessionStatus, isBusy: boolean): string {
  if (isBusy) return 'Running'
  if (status === 'error') return 'Error'
  if (status === 'cancelled' || status === 'stopped') return 'Cancelled'
  if (status === 'exited') return 'Exited'
  if (status === 'waiting_for_permission') return 'Waiting'
  if (status === 'waiting_for_user') return 'Waiting'
  return 'Ready'
}

function ComparePane({
  pane,
  capabilities,
  onModelChange
}: {
  pane: ComparePaneConfig
  capabilities: AgentCapabilities | null
  onModelChange: (model: string) => void
}): React.JSX.Element {
  const { providerUsages, providerUsageLoading, refreshProviderUsage } = useAppState()
  const conversation = useSessionConversation(pane.session.id)
  const wasBusyRef = useRef(false)
  const modelOptions = capabilities?.models ?? []
  const modelLabel = pane.model ? (modelOptions.find((m) => m.id === pane.model)?.label ?? pane.model) : 'Adapter default'

  useEffect(() => {
    if (wasBusyRef.current && !conversation.isBusy) {
      void refreshProviderUsage(pane.agentId)
    }
    wasBusyRef.current = conversation.isBusy
  }, [conversation.isBusy, pane.agentId, refreshProviderUsage])

  return (
    <section className="ad-compare-pane" aria-label={`${AGENT_DISPLAY_NAMES[pane.agentId]} compare pane`}>
      <header className="ad-compare-pane__header">
        <div className="ad-compare-pane__title">
          <span>{AGENT_DISPLAY_NAMES[pane.agentId]}</span>
          <small>{modelLabel}</small>
        </div>
        <div className="ad-compare-pane__state">
          <StatusDot status={conversation.status} />
          <span>{paneStateLabel(conversation.status, conversation.isBusy)}</span>
        </div>
      </header>

      <div className="ad-compare-pane__controls">
        <label>
          Model
          <select value={pane.model} onChange={(e) => onModelChange(e.target.value)} disabled={conversation.isBusy}>
            <option value="">Adapter default</option>
            {modelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
        <ProviderUsageIndicator
          usage={providerUsages[pane.agentId]}
          loading={providerUsageLoading[pane.agentId]}
          compact
          onRefresh={() => void refreshProviderUsage(pane.agentId)}
        />
        {conversation.isBusy && (
          <Button variant="secondary" size="sm" onClick={() => void conversation.stop()}>
            <Square size={13} />
            Stop
          </Button>
        )}
      </div>

      <ConversationView
        items={conversation.items}
        activityLabel={conversation.activityLabel}
        pendingInteraction={conversation.pendingInteraction}
        agentLabel={AGENT_DISPLAY_NAMES[pane.agentId]}
        onRespondInteraction={(interactionId, optionId) => {
          void conversation.respondToInteraction(interactionId, optionId)
        }}
        onRetryMessage={() => {}}
        onOpenTerminal={() => {}}
        workspaceId={pane.session.workspaceId}
        sessionId={pane.session.id}
        attachmentBackend={pane.agentId === 'antigravity' ? 'antigravity' : 'codex'}
      />
    </section>
  )
}

export function CompareModeView({ projectId }: { projectId: string }): React.JSX.Element {
  const { projects, agents, settings, refreshSessions, providerUsages, providerUsageLoading, refreshProviderUsage } = useAppState()
  const project = projects.find((p) => p.id === projectId) ?? null
  const installedAgents = useMemo(() => AGENT_IDS.filter((id) => agents.some((a) => a.agentId === id && a.installed)), [agents])
  const [selectedAgents, setSelectedAgents] = useState<AgentId[]>(() => installedAgents.slice(0, 2))
  const [panes, setPanes] = useState<ComparePaneConfig[]>([])
  const [capabilities, setCapabilities] = useState<Partial<Record<AgentId, AgentCapabilities>>>({})
  const [prompt, setPrompt] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (panes.length > 0) return
    setSelectedAgents((current) => {
      const stillInstalled = current.filter((id) => installedAgents.includes(id))
      return stillInstalled.length >= 2 ? stillInstalled : installedAgents.slice(0, Math.min(3, installedAgents.length))
    })
  }, [installedAgents, panes.length])

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      const entries = await Promise.all(
        AGENT_IDS.map(async (agentId) => {
          const caps = await getAgentDock().agents.getCapabilities(agentId)
          if (agentId === 'codex') {
            const catalog = await getAgentDock().codex.getModelCatalog()
            return [agentId, { ...caps, models: catalog.models }] as const
          }
          if (agentId === 'claude-code') {
            const models = await getAgentDock().claude.getModelCatalog()
            return [agentId, { ...caps, models }] as const
          }
          return [agentId, caps] as const
        })
      )
      if (!cancelled) setCapabilities(Object.fromEntries(entries))
    }
    void load().catch((err) => setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [])

  function toggleAgent(agentId: AgentId): void {
    if (panes.length > 0) return
    setSelectedAgents((current) => {
      if (current.includes(agentId)) return current.filter((id) => id !== agentId)
      if (current.length >= 3) return current
      return [...current, agentId]
    })
  }

  async function startCompare(): Promise<void> {
    if (selectedAgents.length < 2) return
    setStarting(true)
    setError(null)
    try {
      const created = await Promise.all(
        selectedAgents.map((agentId) =>
          getAgentDock().session.create({
            workspaceId: projectId,
            agentId,
            title: `Compare: ${AGENT_DISPLAY_NAMES[agentId]}`,
            titleSource: 'manual'
          })
        )
      )
      setPanes(
        created.map((session) => ({
          agentId: session.agentId,
          session,
          model: settings?.agents[session.agentId]?.model ?? ''
        }))
      )
      await refreshSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  async function sendToAll(): Promise<void> {
    const text = prompt.trim()
    if (!text || panes.length < 2) return
    setPrompt('')
    await Promise.allSettled(
      panes.map((pane) =>
        sendConversationPrompt(pane.session.id, pane.agentId, text, undefined, undefined, {
          permissionMode: SAFE_PERMISSION_MODE[pane.agentId],
          model: pane.model || null,
          reasoningEffort: settings?.agents[pane.agentId]?.reasoningEffort ?? null
        })
      )
    )
    await Promise.allSettled(panes.map((pane) => refreshProviderUsage(pane.agentId)))
  }

  const readyToStart = selectedAgents.length >= 2 && selectedAgents.length <= 3

  return (
    <div className="ad-compare">
      <header className="ad-compare__top">
        <div>
          <h1>
            <Columns3 size={18} />
            Compare Mode
          </h1>
          <p>{project?.name ?? 'Project'} - read-only comparison across independent normal sessions.</p>
        </div>
      </header>

      {panes.length === 0 ? (
        <div className="ad-compare__setup">
          <div className="ad-compare__safety">
            <AlertTriangle size={15} />
            Compare Mode forces read-only/plan permissions for every pane so multiple agents cannot write to the same workspace concurrently.
          </div>
          <div className="ad-compare__agent-picker">
            {AGENT_IDS.map((agentId) => {
              const installed = installedAgents.includes(agentId)
              const selected = selectedAgents.includes(agentId)
              return (
                <button
                  key={agentId}
                  className={`ad-compare__agent-choice${selected ? ' ad-compare__agent-choice--selected' : ''}`}
                  disabled={!installed}
                  onClick={() => toggleAgent(agentId)}
                >
                  <span>{AGENT_DISPLAY_NAMES[agentId]}</span>
                  <small>{installed ? (selected ? 'Selected' : 'Available') : 'Not detected'}</small>
                  <ProviderUsageIndicator
                    usage={providerUsages[agentId]}
                    loading={providerUsageLoading[agentId]}
                    compact
                  />
                </button>
              )
            })}
          </div>
          {error && <div className="ad-compare__error">{error}</div>}
          <Button variant="primary" onClick={() => void startCompare()} disabled={!readyToStart || starting}>
            {starting && <Spinner size={13} />}
            Start Compare
          </Button>
        </div>
      ) : (
        <>
          <div className={`ad-compare__panes ad-compare__panes--${panes.length}`}>
            {panes.map((pane) => (
              <ComparePane
                key={pane.session.id}
                pane={pane}
                capabilities={capabilities[pane.agentId] ?? null}
                onModelChange={(model) => {
                  setPanes((current) => current.map((p) => (p.session.id === pane.session.id ? { ...p, model } : p)))
                }}
              />
            ))}
          </div>
          <div className="ad-compare__composer">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Send the same prompt to every selected agent..."
              rows={3}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void sendToAll()
                }
              }}
            />
            <Button variant="primary" onClick={() => void sendToAll()} disabled={!prompt.trim()}>
              Send to all
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
