import type React from 'react'
import { useEffect, useState } from 'react'
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import { useAppState } from '../../state/AppStateContext'
import { getAgentDock } from '../../lib/agentDockClient'
import { AGENT_DISPLAY_NAMES, AGENT_IDS, type AgentCapabilities, type AgentId } from '@shared/types'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import './AgentsSettings.css'

export function AgentsSettings(): React.JSX.Element {
  const { agents, agentsLoading, refreshAgents, settings, updateSettings } = useAppState()
  const [pathDrafts, setPathDrafts] = useState<Partial<Record<AgentId, string>>>({})
  const [savingPath, setSavingPath] = useState<AgentId | null>(null)
  const [refreshingOne, setRefreshingOne] = useState<AgentId | null>(null)
  // Each agent has its own native set of permission modes (see
  // capability-registry.ts) — no shared enum applies across all three.
  const [capabilities, setCapabilities] = useState<Partial<Record<AgentId, AgentCapabilities>>>({})

  useEffect(() => {
    let cancelled = false
    void Promise.all(AGENT_IDS.map((id) => getAgentDock().agents.getCapabilities(id))).then((results) => {
      if (cancelled) return
      setCapabilities(Object.fromEntries(results.map((c) => [c.agentId, c])))
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function saveCustomPath(agentId: AgentId): Promise<void> {
    setSavingPath(agentId)
    try {
      const value = pathDrafts[agentId]?.trim() || null
      await getAgentDock().agents.setCustomPath(agentId, value)
      await refreshAgents()
    } finally {
      setSavingPath(null)
    }
  }

  async function refreshOne(agentId: AgentId): Promise<void> {
    setRefreshingOne(agentId)
    try {
      await getAgentDock().agents.detect(agentId)
      await refreshAgents()
    } finally {
      setRefreshingOne(null)
    }
  }

  return (
    <div className="ad-settings-section">
      <div className="ad-settings-row" style={{ paddingTop: 0 }}>
        <h3 className="ad-settings-section__heading">Detected agents</h3>
        <Button variant="ghost" size="sm" onClick={() => void refreshAgents()} disabled={agentsLoading}>
          <RefreshCw size={12} className={agentsLoading ? 'ad-spin' : ''} />
          Refresh all
        </Button>
      </div>

      {AGENT_IDS.map((agentId) => {
        const detection = agents.find((a) => a.agentId === agentId)
        const agentSettings = settings?.agents[agentId]

        return (
          <div key={agentId} className="ad-agent-settings-card">
            <div className="ad-agent-settings-card__top">
              <div className="ad-agent-settings-card__title">
                {detection?.installed ? (
                  <CheckCircle2 size={15} className="ad-agent-settings-card__ok" />
                ) : (
                  <XCircle size={15} className="ad-agent-settings-card__bad" />
                )}
                {AGENT_DISPLAY_NAMES[agentId]}
              </div>
              <Button variant="ghost" size="sm" onClick={() => void refreshOne(agentId)} disabled={refreshingOne === agentId}>
                {refreshingOne === agentId ? <Spinner size={12} /> : <RefreshCw size={12} />}
              </Button>
            </div>

            <div className="ad-agent-settings-card__detail">
              {detection?.installed ? (
                <>
                  <div>Version: {detection.version ?? 'unknown'}</div>
                  <div>Path: {detection.executablePath}</div>
                </>
              ) : (
                <div className="ad-agent-settings-card__error">{detection?.error ?? 'Not detected.'}</div>
              )}
            </div>

            <div className="ad-settings-field">
              <span className="ad-settings-field__label">Custom executable path</span>
              <div className="ad-agent-settings-card__path-row">
                <input
                  type="text"
                  placeholder="Leave empty to search PATH"
                  defaultValue={agentSettings?.customPath ?? ''}
                  onChange={(e) => setPathDrafts((prev) => ({ ...prev, [agentId]: e.target.value }))}
                />
                <Button variant="secondary" size="sm" onClick={() => void saveCustomPath(agentId)} disabled={savingPath === agentId}>
                  {savingPath === agentId ? <Spinner size={12} /> : 'Save'}
                </Button>
              </div>
            </div>

            <label className="ad-settings-field">
              <span className="ad-settings-field__label">Permission mode</span>
              <select
                value={agentSettings?.permissionMode ?? 'default'}
                onChange={(e) => void updateSettings({ agents: { [agentId]: { permissionMode: e.target.value } } })}
              >
                {(capabilities[agentId]?.permissionModes ?? []).map((mode) => (
                  <option key={mode.id} value={mode.id} title={mode.description}>
                    {mode.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )
      })}
    </div>
  )
}
