import type React from 'react'
import { useState } from 'react'
import { Dialog } from '../ui/Dialog'
import { AgentsSettings } from './AgentsSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { PermissionsSettings } from './PermissionsSettings'
import { AdvancedSettings } from './AdvancedSettings'
import './SettingsView.css'

type Tab = 'agents' | 'appearance' | 'permissions' | 'advanced'

const TABS: { id: Tab; label: string }[] = [
  { id: 'agents', label: 'Agents' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'advanced', label: 'Advanced' }
]

export function SettingsView({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const [tab, setTab] = useState<Tab>('agents')

  if (!open) return null

  return (
    <Dialog open={open} onClose={onClose} title="Settings" width={720}>
      <div className="ad-settings">
        <nav className="ad-settings__nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`ad-settings__nav-item${tab === t.id ? ' ad-settings__nav-item--active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="ad-settings__content">
          {tab === 'agents' && <AgentsSettings />}
          {tab === 'appearance' && <AppearanceSettings />}
          {tab === 'permissions' && <PermissionsSettings />}
          {tab === 'advanced' && <AdvancedSettings />}
        </div>
      </div>
    </Dialog>
  )
}
