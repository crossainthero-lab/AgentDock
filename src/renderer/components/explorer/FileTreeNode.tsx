import type React from 'react'
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, File, FileImage, Folder } from 'lucide-react'
import { getAgentDock } from '../../lib/agentDockClient'
import type { FileEntry } from '@shared/types'
import { extensionOf } from './fileIcons'
import { Spinner } from '../ui/Spinner'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'])

interface FileTreeNodeProps {
  entry: FileEntry
  workspaceId: string
  depth: number
  selectedRelPath: string | null
  onSelectFile: (relPath: string) => void
}

/** One row in the tree. Directories load their children lazily (only on
 *  first expand) and watch themselves for changes only while expanded —
 *  never the whole tree upfront, per the panel's "no heavy scanning"
 *  requirement. */
export function FileTreeNode({ entry, workspaceId, depth, selectedRelPath, onSelectFile }: FileTreeNodeProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function loadChildren(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const result = await getAgentDock().filesystem.list(workspaceId, entry.relPath)
      if (result.error) setError(result.error)
      else setChildren(result.entries)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!entry.isDirectory || !expanded) return
    void getAgentDock().filesystem.watch(workspaceId, entry.relPath)
    return () => {
      void getAgentDock().filesystem.unwatch(workspaceId, entry.relPath)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, workspaceId, entry.relPath, entry.isDirectory])

  useEffect(() => {
    if (!entry.isDirectory) return
    return getAgentDock().filesystem.onChanged((payload) => {
      if (payload.workspaceId === workspaceId && payload.relPath === entry.relPath && expanded) void loadChildren()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, workspaceId, entry.relPath, entry.isDirectory])

  function toggle(): void {
    if (!entry.isDirectory) {
      onSelectFile(entry.relPath)
      return
    }
    const next = !expanded
    setExpanded(next)
    if (next && children === null) void loadChildren()
  }

  const isSelected = !entry.isDirectory && selectedRelPath === entry.relPath
  const isImage = IMAGE_EXTS.has(extensionOf(entry.name))

  return (
    <div className="ad-file-tree__node">
      <button
        className={`ad-file-tree__row${isSelected ? ' ad-file-tree__row--selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={toggle}
        onContextMenu={(e) => {
          e.preventDefault()
          void getAgentDock().filesystem.showContextMenu(workspaceId, entry.relPath, entry.isDirectory)
        }}
        title={entry.relPath}
      >
        {entry.isDirectory ? (
          expanded ? <ChevronDown size={13} className="ad-file-tree__chevron" /> : <ChevronRight size={13} className="ad-file-tree__chevron" />
        ) : (
          <span className="ad-file-tree__chevron-spacer" />
        )}
        {entry.isDirectory ? (
          <Folder size={14} className="ad-file-tree__icon" />
        ) : isImage ? (
          <FileImage size={14} className="ad-file-tree__icon" />
        ) : (
          <File size={14} className="ad-file-tree__icon" />
        )}
        <span className="ad-file-tree__name">{entry.name}</span>
      </button>

      {entry.isDirectory && expanded && (
        <div className="ad-file-tree__children">
          {loading && children === null && (
            <div className="ad-file-tree__loading" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              <Spinner size={12} />
            </div>
          )}
          {error && (
            <div className="ad-file-tree__error" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              {error}
            </div>
          )}
          {children && children.length === 0 && (
            <div className="ad-file-tree__empty" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              Empty folder
            </div>
          )}
          {children?.map((child) => (
            <FileTreeNode
              key={child.relPath}
              entry={child}
              workspaceId={workspaceId}
              depth={depth + 1}
              selectedRelPath={selectedRelPath}
              onSelectFile={onSelectFile}
            />
          ))}
        </div>
      )}
    </div>
  )
}
