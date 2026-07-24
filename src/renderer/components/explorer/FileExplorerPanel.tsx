import type React from 'react'
import { useEffect, useState } from 'react'
import { Eye, EyeOff, Plus, RefreshCw, X } from 'lucide-react'
import { getAgentDock } from '../../lib/agentDockClient'
import type { FileEntry, FilePreview as FilePreviewResult } from '@shared/types'
import { IconButton } from '../ui/IconButton'
import { Spinner } from '../ui/Spinner'
import { FileTreeNode } from './FileTreeNode'
import { FilePreview } from './FilePreview'
import { ImportDialog } from './ImportDialog'
import './FileExplorerPanel.css'

interface FileExplorerPanelProps {
  open: boolean
  onClose: () => void
  workspaceId: string
}

// Disabled by default (per spec) — once the user picks a value, it's
// remembered locally (not tied to any one workspace) so it survives an
// AgentDock restart. A plain renderer-local preference, not app Settings —
// nothing here needs main-process persistence or is workspace-scoped.
const PREVIEW_PREF_KEY = 'agentdock:file-explorer:preview-enabled'

function loadPreviewPref(): boolean {
  try {
    return localStorage.getItem(PREVIEW_PREF_KEY) === 'true'
  } catch {
    return false
  }
}

function savePreviewPref(enabled: boolean): void {
  try {
    localStorage.setItem(PREVIEW_PREF_KEY, String(enabled))
  } catch {
    // Best-effort — a browser/sandbox that blocks localStorage just means
    // the preference resets to disabled next launch instead of persisting.
  }
}

/** A lightweight, toggleable file browser for the active project — lazy
 *  directory listing, text/image preview, and importing external files.
 *  Deliberately not an IDE: no indexing, no language server, no recursive
 *  watching (see FileTreeNode/filesystem-service.ts for the lazy-watch
 *  mechanism this relies on). */
export function FileExplorerPanel({ open, onClose, workspaceId }: FileExplorerPanelProps): React.JSX.Element | null {
  const [rootEntries, setRootEntries] = useState<FileEntry[] | null>(null)
  const [rootLoading, setRootLoading] = useState(false)
  const [rootError, setRootError] = useState<string | null>(null)

  const [selectedRelPath, setSelectedRelPath] = useState<string | null>(null)
  const [preview, setPreview] = useState<FilePreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewEnabled, setPreviewEnabled] = useState(loadPreviewPref)

  const [importOpen, setImportOpen] = useState(false)
  const [importSources, setImportSources] = useState<string[]>([])
  const [importNotice, setImportNotice] = useState<string | null>(null)

  async function loadRoot(): Promise<void> {
    setRootLoading(true)
    setRootError(null)
    try {
      const result = await getAgentDock().filesystem.list(workspaceId, '')
      if (result.error) setRootError(result.error)
      else setRootEntries(result.entries)
    } finally {
      setRootLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setSelectedRelPath(null)
    setPreview(null)
    void loadRoot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId])

  useEffect(() => {
    if (!open) return
    void getAgentDock().filesystem.watch(workspaceId, '')
    return () => {
      void getAgentDock().filesystem.unwatch(workspaceId, '')
    }
  }, [open, workspaceId])

  useEffect(() => {
    if (!open) return
    return getAgentDock().filesystem.onChanged((payload) => {
      if (payload.workspaceId === workspaceId && payload.relPath === '') void loadRoot()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId])

  useEffect(() => {
    // Selecting a file while preview is off must only select it — no
    // background read at all, not even a deferred/cached one. Toggling
    // preview back on for an already-selected file re-runs this (it's a
    // dependency) and loads it then, which is the one place a read happens
    // as a side effect of anything other than a fresh file click.
    if (!selectedRelPath || !previewEnabled) {
      setPreview(null)
      return
    }
    let cancelled = false
    setPreviewLoading(true)
    void getAgentDock()
      .filesystem.read(workspaceId, selectedRelPath)
      .then((result) => {
        if (!cancelled) setPreview(result)
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedRelPath, workspaceId, previewEnabled])

  function togglePreview(): void {
    setPreviewEnabled((prev) => {
      const next = !prev
      savePreviewPref(next)
      return next
    })
  }

  if (!open) return null

  async function startImport(): Promise<void> {
    const sources = await getAgentDock().filesystem.browseImportFiles()
    if (sources.length === 0) return
    setImportSources(sources)
    setImportOpen(true)
  }

  // Imports land in the currently selected directory when one is selected,
  // otherwise the project root — matches "choose which folder receives the
  // files" without needing a separate folder-picker tree.
  const defaultDestRelPath = selectedRelPath ? selectedRelPath.split('/').slice(0, -1).join('/') : ''

  return (
    <div className="ad-file-explorer">
      <div className="ad-file-explorer__header">
        <span>Explorer</span>
        <div className="ad-file-explorer__header-actions">
          <IconButton label="Toggle file preview" size="sm" active={previewEnabled} onClick={togglePreview}>
            {previewEnabled ? <Eye size={13} /> : <EyeOff size={13} />}
          </IconButton>
          <IconButton label="Import files" size="sm" onClick={() => void startImport()}>
            <Plus size={14} />
          </IconButton>
          <IconButton label="Refresh" size="sm" onClick={() => void loadRoot()}>
            <RefreshCw size={13} className={rootLoading ? 'ad-spin' : ''} />
          </IconButton>
          <IconButton label="Close" size="sm" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
      </div>

      {importNotice && (
        <div className="ad-file-explorer__notice">
          <span>{importNotice}</span>
          <button onClick={() => setImportNotice(null)}>Dismiss</button>
        </div>
      )}

      <div className={`ad-file-explorer__tree${previewEnabled ? '' : ' ad-file-explorer__tree--full'}`}>
        {rootLoading && rootEntries === null ? (
          <div className="ad-file-explorer__loading">
            <Spinner size={16} />
          </div>
        ) : rootError ? (
          <div className="ad-file-explorer__error">{rootError}</div>
        ) : rootEntries && rootEntries.length === 0 ? (
          <div className="ad-file-explorer__empty">This project has no files yet.</div>
        ) : (
          rootEntries?.map((entry) => (
            <FileTreeNode
              key={entry.relPath}
              entry={entry}
              workspaceId={workspaceId}
              depth={0}
              selectedRelPath={selectedRelPath}
              onSelectFile={setSelectedRelPath}
            />
          ))
        )}
      </div>

      {previewEnabled && (
        <div className="ad-file-explorer__preview">
          <FilePreview relPath={selectedRelPath} loading={previewLoading} preview={preview} />
        </div>
      )}

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        workspaceId={workspaceId}
        sourcePaths={importSources}
        defaultDestRelPath={defaultDestRelPath}
        onImported={(results, destRelPath) => {
          const okCount = results.filter((r) => r.relPath).length
          if (okCount > 0) {
            setImportNotice(
              okCount === 1 && results[0].relPath
                ? `Imported ${results[0].relPath}`
                : `Imported ${okCount} file${okCount === 1 ? '' : 's'} into ${destRelPath || '/'}`
            )
          }
          if (destRelPath === '') void loadRoot()
        }}
      />
    </div>
  )
}
