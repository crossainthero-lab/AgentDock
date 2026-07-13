import type React from 'react'
import { useMemo, useState } from 'react'
import { ChevronsLeft, ChevronsRight, FolderOpen, Plus, Search } from 'lucide-react'
import { useAppState } from '../../state/AppStateContext'
import { AGENT_DISPLAY_NAMES } from '@shared/types'
import { StatusDot } from '../ui/StatusDot'
import { IconButton } from '../ui/IconButton'
import { relativeTime } from '../../lib/format'
import './SessionSidebar.css'

function agentInitial(agentId: keyof typeof AGENT_DISPLAY_NAMES): string {
  return AGENT_DISPLAY_NAMES[agentId].charAt(0)
}

export function SessionSidebar(): React.JSX.Element {
  const { workspace, sessions, sessionsLoading, selectedSessionId, selectSession, openWorkspace, sidebarCollapsed, toggleSidebar } =
    useAppState()
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    if (!query.trim()) return sessions
    const q = query.trim().toLowerCase()
    return sessions.filter((s) => s.title.toLowerCase().includes(q))
  }, [sessions, query])

  if (sidebarCollapsed) {
    return (
      <div className="ad-sidebar ad-sidebar--collapsed">
        <IconButton label="Expand sidebar" onClick={toggleSidebar}>
          <ChevronsRight size={16} />
        </IconButton>
        <IconButton label="New session" onClick={() => selectSession(null)} disabled={!workspace}>
          <Plus size={16} />
        </IconButton>
      </div>
    )
  }

  return (
    <div className="ad-sidebar">
      <div className="ad-sidebar__top">
        <button className="ad-sidebar__primary-action" onClick={() => void openWorkspace()}>
          <FolderOpen size={15} />
          Open Project
        </button>
        <IconButton label="Collapse sidebar" size="sm" onClick={toggleSidebar}>
          <ChevronsLeft size={15} />
        </IconButton>
      </div>

      <button className="ad-sidebar__new-session" onClick={() => selectSession(null)} disabled={!workspace}>
        <Plus size={14} />
        New Session
      </button>

      {workspace && (
        <div className="ad-sidebar__search">
          <Search size={13} className="ad-sidebar__search-icon" />
          <input
            placeholder="Search sessions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search sessions"
          />
        </div>
      )}

      <div className="ad-sidebar__sessions">
        {!workspace ? (
          <div className="ad-sidebar__hint">Open a project to see sessions here.</div>
        ) : sessionsLoading ? (
          <div className="ad-sidebar__hint">Loading sessions…</div>
        ) : filtered.length === 0 ? (
          <div className="ad-sidebar__hint">{query ? 'No matching sessions.' : 'No sessions yet.'}</div>
        ) : (
          <ul className="ad-session-list">
            {filtered.map((session) => (
              <li key={session.id}>
                <button
                  className={`ad-session-row${session.id === selectedSessionId ? ' ad-session-row--selected' : ''}`}
                  onClick={() => selectSession(session.id)}
                >
                  <span className={`ad-session-row__monogram ad-session-row__monogram--${session.agentId}`}>
                    {agentInitial(session.agentId)}
                  </span>
                  <span className="ad-session-row__body">
                    <span className="ad-session-row__title">{session.title}</span>
                    <span className="ad-session-row__meta">{relativeTime(session.updatedAt)}</span>
                  </span>
                  <StatusDot status={session.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
