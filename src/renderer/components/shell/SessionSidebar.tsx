import type React from 'react'
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, FolderOpen, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useAppState } from '../../state/AppStateContext'
import { AGENT_DISPLAY_NAMES } from '@shared/types'
import { StatusDot } from '../ui/StatusDot'
import { IconButton } from '../ui/IconButton'
import { relativeTime } from '../../lib/format'
import './SessionSidebar.css'

function agentInitial(agentId: keyof typeof AGENT_DISPLAY_NAMES): string {
  return AGENT_DISPLAY_NAMES[agentId].charAt(0)
}

/** Blurs (committing via onBlur) on Enter, discards on Escape — the shared
 *  behavior both the project-rename and conversation-rename inline inputs
 *  need. */
function handleRenameKeyDown(e: React.KeyboardEvent<HTMLInputElement>, onCancel: () => void): void {
  if (e.key === 'Enter') e.currentTarget.blur()
  if (e.key === 'Escape') {
    onCancel()
    e.currentTarget.blur()
  }
}

export function SessionSidebar(): React.JSX.Element {
  const {
    projects,
    projectsLoading,
    sessionsByProject,
    selectedSessionId,
    selectSession,
    deleteSession,
    renameSession,
    renameProject,
    deleteProject,
    toggleProjectCollapsed,
    startNewSessionInProject,
    openWorkspace,
    sidebarCollapsed,
    toggleSidebar
  } = useAppState()
  const [query, setQuery] = useState('')
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null)

  function handleDeleteSession(e: React.MouseEvent, id: string, title: string): void {
    e.stopPropagation()
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return
    void deleteSession(id)
  }

  function handleDeleteProject(e: React.MouseEvent, id: string, name: string): void {
    e.stopPropagation()
    if (!window.confirm(`Delete project "${name}" and all of its conversations? This cannot be undone.`)) return
    void deleteProject(id)
  }

  const q = query.trim().toLowerCase()
  const groups = useMemo(
    () =>
      projects.map((project) => {
        const all = sessionsByProject[project.id] ?? []
        const filtered = q ? all.filter((s) => s.title.toLowerCase().includes(q)) : all
        return { project, sessions: filtered, totalCount: all.length }
      }),
    [projects, sessionsByProject, q]
  )

  if (sidebarCollapsed) {
    return (
      <div className="ad-sidebar ad-sidebar--collapsed">
        <IconButton label="Expand sidebar" onClick={toggleSidebar}>
          <ChevronsRight size={16} />
        </IconButton>
        <IconButton label="Open project" onClick={() => void openWorkspace()}>
          <FolderOpen size={16} />
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

      {projects.length > 0 && (
        <div className="ad-sidebar__search">
          <Search size={13} className="ad-sidebar__search-icon" />
          <input
            placeholder="Search conversations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search conversations"
          />
        </div>
      )}

      <div className="ad-sidebar__sessions">
        {projectsLoading ? (
          <div className="ad-sidebar__hint">Loading projects…</div>
        ) : projects.length === 0 ? (
          <div className="ad-sidebar__hint">Open a project to see conversations here.</div>
        ) : (
          groups.map(({ project, sessions, totalCount }) => (
            <div key={project.id} className="ad-project-group">
              <div className="ad-project-group__header">
                <button className="ad-project-group__toggle" onClick={() => void toggleProjectCollapsed(project.id)}>
                  {project.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  {renamingProjectId === project.id ? (
                    <input
                      className="ad-project-group__rename-input"
                      autoFocus
                      defaultValue={project.name}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const value = e.target.value.trim()
                        if (value && value !== project.name) void renameProject(project.id, value)
                        setRenamingProjectId(null)
                      }}
                      onKeyDown={(e) => handleRenameKeyDown(e, () => setRenamingProjectId(null))}
                    />
                  ) : (
                    <span className="ad-project-group__name" title={project.path}>
                      {project.name}
                    </span>
                  )}
                  <span className="ad-project-group__count">{totalCount}</span>
                </button>
                <div className="ad-project-group__actions">
                  <IconButton
                    label="New conversation in this project"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      startNewSessionInProject(project.id)
                    }}
                  >
                    <Plus size={13} />
                  </IconButton>
                  <IconButton
                    label="Rename project"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      setRenamingProjectId(project.id)
                    }}
                  >
                    <Pencil size={12} />
                  </IconButton>
                  <IconButton label="Delete project" size="sm" onClick={(e) => handleDeleteProject(e, project.id, project.name)}>
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              </div>

              {!project.collapsed && (
                <ul className="ad-session-list">
                  {sessions.length === 0 ? (
                    <li className="ad-sidebar__hint ad-sidebar__hint--nested">
                      {q ? 'No matching conversations.' : 'No conversations yet.'}
                    </li>
                  ) : (
                    sessions.map((session) => (
                      <li
                        key={session.id}
                        className={`ad-session-row${session.id === selectedSessionId ? ' ad-session-row--selected' : ''}`}
                      >
                        {renamingSessionId === session.id ? (
                          <input
                            className="ad-session-row__rename-input"
                            autoFocus
                            defaultValue={session.title}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={(e) => {
                              const value = e.target.value.trim()
                              if (value && value !== session.title) void renameSession(session.id, value)
                              setRenamingSessionId(null)
                            }}
                            onKeyDown={(e) => handleRenameKeyDown(e, () => setRenamingSessionId(null))}
                          />
                        ) : (
                          <button className="ad-session-row__select" onClick={() => selectSession(session.id)}>
                            <span className={`ad-session-row__monogram ad-session-row__monogram--${session.agentId}`}>
                              {agentInitial(session.agentId)}
                            </span>
                            <span className="ad-session-row__body">
                              <span className="ad-session-row__title">{session.title}</span>
                              <span className="ad-session-row__meta">
                                {AGENT_DISPLAY_NAMES[session.agentId]} · {relativeTime(session.updatedAt)}
                              </span>
                            </span>
                          </button>
                        )}
                        <StatusDot status={session.status} />
                        {renamingSessionId !== session.id && (
                          <>
                            <IconButton
                              label="Rename conversation"
                              size="sm"
                              className="ad-session-row__rename"
                              onClick={(e) => {
                                e.stopPropagation()
                                setRenamingSessionId(session.id)
                              }}
                            >
                              <Pencil size={12} />
                            </IconButton>
                            <IconButton
                              label="Delete conversation"
                              size="sm"
                              className="ad-session-row__delete"
                              onClick={(e) => handleDeleteSession(e, session.id, session.title)}
                            >
                              <Trash2 size={13} />
                            </IconButton>
                          </>
                        )}
                      </li>
                    ))
                  )}
                </ul>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
