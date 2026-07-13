import type React from 'react'
import { useEffect, useState } from 'react'
import { FileMinus, FilePlus, FilePen, RefreshCw, RotateCcw, X } from 'lucide-react'
import { getAgentDock } from '../../lib/agentDockClient'
import type { ChangedFile, ChangedFileStatus, DiffResult } from '@shared/types'
import { IconButton } from '../ui/IconButton'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Spinner } from '../ui/Spinner'
import './ChangesDrawer.css'

interface ChangesDrawerProps {
  open: boolean
  onClose: () => void
  workspaceId: string
  onChanged?: () => void
}

function statusIcon(status: ChangedFileStatus): React.JSX.Element {
  if (status === 'added' || status === 'untracked') return <FilePlus size={13} className="ad-diff-icon--add" />
  if (status === 'deleted') return <FileMinus size={13} className="ad-diff-icon--del" />
  return <FilePen size={13} className="ad-diff-icon--mod" />
}

export function ChangesDrawer({ open, onClose, workspaceId, onChanged }: ChangesDrawerProps): React.JSX.Element | null {
  const [files, setFiles] = useState<ChangedFile[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [reverting, setReverting] = useState(false)

  async function load(): Promise<void> {
    setLoading(true)
    try {
      const list = await getAgentDock().git.changedFiles(workspaceId)
      setFiles(list)
      if (selected && !list.some((f) => f.path === selected)) setSelected(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId])

  useEffect(() => {
    if (!selected) {
      setDiff(null)
      return
    }
    let cancelled = false
    setDiffLoading(true)
    void getAgentDock()
      .git.diff(workspaceId, selected)
      .then((result) => {
        if (!cancelled) setDiff(result)
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selected, workspaceId])

  if (!open) return null

  const selectedFile = files.find((f) => f.path === selected)

  async function revert(): Promise<void> {
    if (!selected) return
    if (!window.confirm(`Revert changes to "${selected}"? This cannot be undone.`)) return
    setReverting(true)
    try {
      await getAgentDock().git.revertFile(workspaceId, selected)
      await load()
      onChanged?.()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to revert file.')
    } finally {
      setReverting(false)
    }
  }

  return (
    <div className="ad-changes-drawer">
      <div className="ad-changes-drawer__header">
        <span>Changed Files</span>
        <div className="ad-changes-drawer__header-actions">
          <IconButton label="Refresh" size="sm" onClick={() => void load()}>
            <RefreshCw size={13} className={loading ? 'ad-spin' : ''} />
          </IconButton>
          <IconButton label="Close" size="sm" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
      </div>

      <div className="ad-changes-drawer__body">
        <div className="ad-changes-drawer__list">
          {loading && files.length === 0 ? (
            <div className="ad-changes-drawer__loading">
              <Spinner size={16} />
            </div>
          ) : files.length === 0 ? (
            <EmptyState title="No files have been changed" description="Changes will show up here once the agent edits files." />
          ) : (
            <ul>
              {files.map((file) => (
                <li key={file.path}>
                  <button
                    className={`ad-changes-drawer__file${file.path === selected ? ' ad-changes-drawer__file--selected' : ''}`}
                    onClick={() => setSelected(file.path)}
                  >
                    {statusIcon(file.status)}
                    <span className="ad-changes-drawer__file-path">{file.path}</span>
                    {(file.additions != null || file.deletions != null) && (
                      <span className="ad-changes-drawer__counts">
                        {file.additions != null && <span className="ad-diff-icon--add">+{file.additions}</span>}
                        {file.deletions != null && <span className="ad-diff-icon--del">-{file.deletions}</span>}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {selected && (
          <div className="ad-changes-drawer__diff">
            <div className="ad-changes-drawer__diff-header">
              <span className="ad-changes-drawer__diff-path">{selected}</span>
              {selectedFile && selectedFile.status !== 'untracked' && (
                <Button variant="danger" size="sm" onClick={() => void revert()} disabled={reverting}>
                  <RotateCcw size={12} />
                  Revert
                </Button>
              )}
            </div>
            <div className="ad-changes-drawer__diff-body">
              {diffLoading ? (
                <Spinner size={16} />
              ) : diff?.isBinary ? (
                <div className="ad-changes-drawer__diff-empty">Binary file — no preview available.</div>
              ) : diff?.diff ? (
                <DiffText diff={diff.diff} />
              ) : (
                <div className="ad-changes-drawer__diff-empty">No diff to show.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function DiffText({ diff }: { diff: string }): React.JSX.Element {
  const lines = diff.split('\n')
  return (
    <pre className="ad-diff-text">
      {lines.map((line, i) => {
        const cls = line.startsWith('+') && !line.startsWith('+++') ? 'ad-diff-line--add' : line.startsWith('-') && !line.startsWith('---') ? 'ad-diff-line--del' : ''
        return (
          <div key={i} className={`ad-diff-line ${cls}`}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}
