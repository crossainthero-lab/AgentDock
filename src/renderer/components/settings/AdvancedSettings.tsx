import type React from 'react'
import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppStateContext'
import { getAgentDock } from '../../lib/agentDockClient'
import type { Diagnostics } from '@shared/types'
import { Spinner } from '../ui/Spinner'
import './AdvancedSettings.css'

export function AdvancedSettings(): React.JSX.Element {
  const { settings, updateSettings } = useAppState()
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)

  useEffect(() => {
    void getAgentDock().settings.getDiagnostics().then(setDiagnostics)
  }, [])

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
    </div>
  )
}
