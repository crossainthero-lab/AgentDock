import type React from 'react'
import { useState } from 'react'
import { FilePlus, FileMinus, FilePen, Search, ListChecks, Brain, FolderOpen } from 'lucide-react'
import type { ActivityDetail } from '@shared/events/agent-event'
import { getAgentDock } from '../../lib/agentDockClient'
import { stripAnsi } from '../markdown/ansi'
import { CopyButton } from '../markdown/CopyButton'
import { MarkdownMessage } from '../markdown/MarkdownMessage'
import './ActivityDetailCard.css'

interface ActivityDetailCardProps {
  detail: ActivityDetail
  workspaceId: string | null
}

/** Renders the real, structured payload of a Codex (or future agent)
 *  activity as a specialized card instead of a generic JSON/text dump —
 *  command output gets a terminal-style block distinct from source-code
 *  blocks, file changes get add/update/delete badges with real file
 *  actions, reasoning renders as prose, etc. */
export function ActivityDetailCard({ detail, workspaceId }: ActivityDetailCardProps): React.JSX.Element {
  switch (detail.kind) {
    case 'command':
      return <CommandDetail detail={detail} />
    case 'file_change':
      return <FileChangeDetail detail={detail} workspaceId={workspaceId} />
    case 'mcp_tool_call':
      return <McpToolCallDetail detail={detail} />
    case 'web_search':
      return (
        <div className="ad-activity-detail ad-activity-detail--inline">
          <Search size={13} />
          <span>{detail.query}</span>
        </div>
      )
    case 'todo_list':
      return <TodoListDetail detail={detail} />
    case 'reasoning':
      return (
        <div className="ad-activity-detail ad-activity-detail--reasoning">
          <div className="ad-activity-detail__reasoning-header">
            <Brain size={13} />
            <span>Reasoning</span>
          </div>
          <MarkdownMessage text={detail.text} workspaceId={workspaceId} />
        </div>
      )
  }
}

function CommandDetail({ detail }: { detail: Extract<ActivityDetail, { kind: 'command' }> }): React.JSX.Element {
  const cleanOutput = detail.output ? stripAnsi(detail.output) : ''
  return (
    <div className="ad-activity-detail ad-activity-detail--command">
      <div className="ad-terminal-block">
        <div className="ad-terminal-block__header">
          <span className="ad-terminal-block__label">Command</span>
          {typeof detail.exitCode === 'number' && (
            <span className={`ad-terminal-block__exit${detail.exitCode !== 0 ? ' ad-terminal-block__exit--error' : ''}`}>
              exit {detail.exitCode}
            </span>
          )}
          <CopyButton text={detail.command} label="Copy" />
        </div>
        <pre className="ad-terminal-block__body ad-terminal-block__body--command">{detail.command}</pre>
      </div>
      {cleanOutput && (
        <div className="ad-terminal-block">
          <div className="ad-terminal-block__header">
            <span className="ad-terminal-block__label">Output</span>
            <CopyButton text={cleanOutput} label="Copy" />
          </div>
          <pre className="ad-terminal-block__body">{cleanOutput}</pre>
        </div>
      )}
    </div>
  )
}

const CHANGE_BADGE: Record<string, { icon: React.ElementType; className: string; label: string }> = {
  add: { icon: FilePlus, className: 'ad-file-badge--add', label: 'Added' },
  update: { icon: FilePen, className: 'ad-file-badge--update', label: 'Updated' },
  delete: { icon: FileMinus, className: 'ad-file-badge--delete', label: 'Deleted' }
}

function FileChangeDetail({
  detail,
  workspaceId
}: {
  detail: Extract<ActivityDetail, { kind: 'file_change' }>
  workspaceId: string | null
}): React.JSX.Element {
  return (
    <div className="ad-activity-detail ad-activity-detail--files">
      {detail.changes.map((change, i) => {
        const badge = CHANGE_BADGE[change.kind] ?? CHANGE_BADGE.update
        const Icon = badge.icon
        return (
          <div key={i} className="ad-file-change-row">
            <span className={`ad-file-badge ${badge.className}`}>
              <Icon size={11} />
              {badge.label}
            </span>
            <span className="ad-file-change-row__path" title={change.path}>
              {change.path}
            </span>
            {workspaceId && (
              <button
                type="button"
                className="ad-file-change-row__action"
                title="Reveal in Explorer"
                onClick={() => void getAgentDock().media.revealInFolder(workspaceId, change.path)}
              >
                <FolderOpen size={12} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

function McpToolCallDetail({ detail }: { detail: Extract<ActivityDetail, { kind: 'mcp_tool_call' }> }): React.JSX.Element {
  const [showArgs, setShowArgs] = useState(false)
  return (
    <div className="ad-activity-detail ad-activity-detail--mcp">
      <div className="ad-activity-detail__mcp-header">
        <span className="ad-activity-detail__mcp-name">
          {detail.server}.{detail.tool}
        </span>
        <button type="button" className="ad-activity-detail__mcp-toggle" onClick={() => setShowArgs((v) => !v)}>
          {showArgs ? 'Hide details' : 'Show details'}
        </button>
      </div>
      {detail.error && <div className="ad-activity-detail__mcp-error">{detail.error}</div>}
      {showArgs && (
        <pre className="ad-terminal-block__body">{safeJson({ arguments: detail.args, result: detail.result })}</pre>
      )}
    </div>
  )
}

function TodoListDetail({ detail }: { detail: Extract<ActivityDetail, { kind: 'todo_list' }> }): React.JSX.Element {
  return (
    <div className="ad-activity-detail ad-activity-detail--todos">
      <div className="ad-activity-detail__todos-header">
        <ListChecks size={13} />
        <span>Plan</span>
      </div>
      <ul className="ad-todo-list">
        {detail.items.map((item, i) => (
          <li key={i} className={item.completed ? 'ad-todo-list__item ad-todo-list__item--done' : 'ad-todo-list__item'}>
            <input type="checkbox" checked={item.completed} disabled readOnly />
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
