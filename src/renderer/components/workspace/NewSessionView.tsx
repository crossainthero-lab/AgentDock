import type React from 'react'
import { useState } from 'react'
import { AlertCircle, ArrowRight, RefreshCw } from 'lucide-react'
import { useAppState } from '../../state/AppStateContext'
import { AGENT_DISPLAY_NAMES, AGENT_IDS, type AgentId } from '@shared/types'
import { getAgentDock } from '../../lib/agentDockClient'
import { Spinner } from '../ui/Spinner'
import { Button } from '../ui/Button'
import './NewSessionView.css'

const AGENT_DESCRIPTIONS: Record<AgentId, string> = {
  'claude-code': "Anthropic's coding agent, run from its CLI in this project.",
  codex: "OpenAI's coding agent, run from its CLI in this project.",
  antigravity: "Google's Antigravity coding agent, run from its CLI in this project."
}

export function NewSessionView(): React.JSX.Element {
  const { workspace, agents, agentsLoading, refreshAgents, refreshSessions, selectSession, setSettingsViewOpen } =
    useAppState()
  const [startingAgent, setStartingAgent] = useState<AgentId | null>(null)

  async function startWith(agentId: AgentId): Promise<void> {
    if (!workspace) return
    setStartingAgent(agentId)
    try {
      const session = await getAgentDock().session.create({ workspaceId: workspace.id, agentId })
      await refreshSessions()
      selectSession(session.id)
    } finally {
      setStartingAgent(null)
    }
  }

  return (
    <div className="ad-new-session">
      <div className="ad-new-session__inner">
        <div className="ad-new-session__heading">
          <h1>{workspace?.name}</h1>
          <p>Choose an agent to start a session in this project.</p>
        </div>

        <div className="ad-new-session__agents">
          {AGENT_IDS.map((agentId) => {
            const detection = agents.find((a) => a.agentId === agentId)
            const installed = detection?.installed ?? false
            const busy = startingAgent === agentId

            return (
              <div key={agentId} className={`ad-agent-card${installed ? '' : ' ad-agent-card--unavailable'}`}>
                <div className="ad-agent-card__body">
                  <div className="ad-agent-card__name">{AGENT_DISPLAY_NAMES[agentId]}</div>
                  <div className="ad-agent-card__description">{AGENT_DESCRIPTIONS[agentId]}</div>
                  {detection && !installed && (
                    <div className="ad-agent-card__unavailable">
                      <AlertCircle size={13} />
                      Not detected
                    </div>
                  )}
                  {detection?.installed && detection.version && (
                    <div className="ad-agent-card__version">{detection.version}</div>
                  )}
                </div>

                {installed ? (
                  <Button
                    variant="primary"
                    className="ad-agent-card__action"
                    onClick={() => void startWith(agentId)}
                    disabled={busy}
                  >
                    {busy ? <Spinner size={13} /> : <ArrowRight size={14} />}
                    Start with {AGENT_DISPLAY_NAMES[agentId]}
                  </Button>
                ) : (
                  <Button variant="ghost" className="ad-agent-card__action" onClick={() => setSettingsViewOpen(true)}>
                    Open Agent Settings
                  </Button>
                )}
              </div>
            )
          })}
        </div>

        <button className="ad-new-session__refresh" onClick={() => void refreshAgents()} disabled={agentsLoading}>
          <RefreshCw size={12} className={agentsLoading ? 'ad-spin' : ''} />
          Refresh detection
        </button>
      </div>
    </div>
  )
}
