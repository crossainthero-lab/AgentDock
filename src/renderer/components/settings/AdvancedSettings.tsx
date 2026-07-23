import type React from 'react'
import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppStateContext'
import { getAgentDock } from '../../lib/agentDockClient'
import type { Diagnostics } from '@shared/types'
import { Spinner } from '../ui/Spinner'
import { Button } from '../ui/Button'
import './AdvancedSettings.css'

export function AdvancedSettings(): React.JSX.Element {
  const { settings, updateSettings, refreshAgents, refreshSessions } = useAppState()
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)
  const [resettingAgents, setResettingAgents] = useState(false)
  const [resetNotice, setResetNotice] = useState<string | null>(null)
  const [checkingMissing, setCheckingMissing] = useState(false)

  useEffect(() => {
    void getAgentDock().settings.getDiagnostics().then(setDiagnostics)
  }, [])

  async function resetAgentDetection(): Promise<void> {
    setResettingAgents(true)
    setResetNotice(null)
    try {
      await getAgentDock().settings.resetAgentDetection()
      await refreshAgents()
      setResetNotice('Cleared every custom executable path and the cached Codex model list. Re-detecting installed agents…')
    } finally {
      setResettingAgents(false)
    }
  }

  async function removeMissingProjects(): Promise<void> {
    setCheckingMissing(true)
    setResetNotice(null)
    try {
      const missing = await getAgentDock().workspace.findMissing()
      if (missing.length === 0) {
        setResetNotice('No projects are missing — every saved project folder still exists on this machine.')
        return
      }
      const names = missing.map((w) => w.name).join(', ')
      if (!window.confirm(`Remove ${missing.length} project${missing.length === 1 ? '' : 's'} whose folder no longer exists (${names})? This only removes AgentDock's own record and that project's conversation history — nothing on disk is touched.`)) {
        return
      }
      await getAgentDock().workspace.removeMissing()
      await refreshSessions()
      setResetNotice(`Removed ${missing.length} project${missing.length === 1 ? '' : 's'} with a missing folder.`)
    } finally {
      setCheckingMissing(false)
    }
  }

  return (
    <div className="ad-settings-section">
      <h3 className="ad-settings-section__heading">Advanced</h3>

      <label className="ad-settings-field">
        <span className="ad-settings-field__label">Git executable path</span>
        <input
          type="text"
          defaultValue={settings?.advanced.gitExecutablePath ?? 'git'}
          onBlur={(e) => void updateSettings({ advanced: { gitExecutablePath: e.target.value.trim() || 'git' } })}
        />
      </label>
      <p className="ad-advanced-note">
        Used for every git operation in the Changes drawer and the title bar's branch indicator.
      </p>

      <div className="ad-advanced-diagnostics">
        <div className="ad-settings-field__label">Diagnostics</div>
        {!diagnostics ? (
          <Spinner size={14} />
        ) : (
          <dl className="ad-diagnostics-grid">
            <dt>AgentDock</dt>
            <dd>{diagnostics.appVersion}</dd>
            <dt>Electron</dt>
            <dd>{diagnostics.electronVersion}</dd>
            <dt>Chromium</dt>
            <dd>{diagnostics.chromeVersion}</dd>
            <dt>Node.js</dt>
            <dd>{diagnostics.nodeVersion}</dd>
            <dt>Platform</dt>
            <dd>
              {diagnostics.platform} / {diagnostics.arch}
            </dd>
            <dt>Storage (userData)</dt>
            <dd className="ad-diagnostics-grid__path">{diagnostics.userDataPath}</dd>
            <dt>Database file</dt>
            <dd className="ad-diagnostics-grid__path">{diagnostics.databasePath}</dd>
          </dl>
        )}
      </div>

      <div className="ad-advanced-diagnostics">
        <div className="ad-settings-field__label">Reset stale configuration</div>
        <p className="ad-advanced-note">
          If AgentDock's settings were copied from another computer (or an agent that used to work now fails to launch), these
          clear exactly the machine-specific pieces — never your projects or conversations.
        </p>
        <div className="ad-advanced-actions">
          <Button variant="secondary" size="sm" onClick={() => void resetAgentDetection()} disabled={resettingAgents}>
            {resettingAgents ? <Spinner size={13} /> : null}
            Reset agent detection &amp; custom paths
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void removeMissingProjects()} disabled={checkingMissing}>
            {checkingMissing ? <Spinner size={13} /> : null}
            Remove projects with a missing folder
          </Button>
        </div>
        {resetNotice && <p className="ad-advanced-note">{resetNotice}</p>}
      </div>
    </div>
  )
}
