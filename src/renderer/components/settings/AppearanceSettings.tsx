import type React from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useAppState } from '../../state/AppStateContext'
import type { AppearanceMode } from '@shared/types'
import './AppearanceSettings.css'

const OPTIONS: { value: AppearanceMode; label: string; icon: React.ReactNode }[] = [
  { value: 'system', label: 'System', icon: <Monitor size={16} /> },
  { value: 'light', label: 'Light', icon: <Sun size={16} /> },
  { value: 'dark', label: 'Dark', icon: <Moon size={16} /> }
]

export function AppearanceSettings(): React.JSX.Element {
  const { settings, updateSettings } = useAppState()

  return (
    <div className="ad-settings-section">
      <h3 className="ad-settings-section__heading">Appearance</h3>
      <div className="ad-appearance-options">
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            className={`ad-appearance-option${settings?.appearance === opt.value ? ' ad-appearance-option--active' : ''}`}
            onClick={() => void updateSettings({ appearance: opt.value })}
          >
            {opt.icon}
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}
