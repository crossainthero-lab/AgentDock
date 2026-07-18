import type React from 'react'
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import './Menu.css'

export interface MenuItem {
  id: string
  label: string
  description?: string
}

interface MenuProps {
  label: string
  items: MenuItem[]
  selectedId?: string | null
  /** When set, shown in the trigger button instead of the static `label` —
   *  e.g. "Sonnet" instead of "Model". Undefined preserves the old
   *  always-static-label behavior for any caller that doesn't pass it. */
  selectedLabel?: string | null
  onSelect: (id: string) => void
  disabled?: boolean
}

/** Shared dropdown-trigger primitive for capability-driven session controls
 *  (Model/Permissions/Commands) — renders nothing when there are no items,
 *  so callers can pass a capability list straight through without an extra
 *  visibility check. */
export function Menu({ label, items, selectedId, selectedLabel, onSelect, disabled }: MenuProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null

  return (
    <div className="ad-menu-wrap">
      <button className="ad-menu-trigger" onClick={() => setOpen((v) => !v)} disabled={disabled}>
        <span>{selectedLabel ?? label}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <>
          <div className="ad-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="ad-menu-list">
            {items.map((item) => (
              <button
                key={item.id}
                className={`ad-menu-item${item.id === selectedId ? ' ad-menu-item--selected' : ''}`}
                title={item.description}
                onClick={() => {
                  setOpen(false)
                  onSelect(item.id)
                }}
              >
                <span>{item.label}</span>
                {item.description && <span className="ad-menu-item__desc">{item.description}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
