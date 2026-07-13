import type React from 'react'
import { useAppState } from '../../state/AppStateContext'

export function PermissionsSettings(): React.JSX.Element {
  const { settings, updateSettings } = useAppState()

  return (
    <div className="ad-settings-section">
      <h3 className="ad-settings-section__heading">Permissions</h3>

      <div className="ad-settings-row">
        <div>
          <div className="ad-settings-row__label">Confirm destructive git actions</div>
          <div className="ad-settings-row__description">Ask before reverting a file's changes in the Changes drawer.</div>
        </div>
        <input
          type="checkbox"
          checked={settings?.permissions.confirmDestructiveGitActions ?? true}
          onChange={(e) => void updateSettings({ permissions: { confirmDestructiveGitActions: e.target.checked } })}
        />
      </div>

      <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
        Per-agent permission mode (how each CLI handles tool-use approval) lives under Settings → Agents, since it's
        configured per agent rather than globally.
      </p>
    </div>
  )
}
