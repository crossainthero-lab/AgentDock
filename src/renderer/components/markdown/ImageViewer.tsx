import type React from 'react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, FolderOpen, X } from 'lucide-react'
import { getAgentDock } from '../../lib/agentDockClient'
import './ImageViewer.css'

interface ImageViewerProps {
  src: string
  alt?: string
  onClose: () => void
  /** Present only for a local workspace image (not a remote/data URL) —
   *  enables "Reveal in Explorer". */
  localPath?: string
  workspaceId?: string | null
  /** Overrides the built-in workspace-scoped reveal/open-externally calls
   *  below — for a local image that lives outside the workspace but is
   *  still genuinely resolvable (a Codex response artifact; see
   *  codex-response-image-service.ts). When provided, takes priority over
   *  the `localPath`/`workspaceId` built-in behavior; when absent, existing
   *  call sites (Markdown images, user attachments) are unaffected. */
  onReveal?: () => void
  onOpenExternal?: () => void
}

/** Full-bleed click-to-enlarge lightbox — deliberately its own component
 *  rather than the general-purpose Dialog (which is chrome-heavy/padded;
 *  an image viewer wants the image itself to be the whole surface). */
export function ImageViewer({ src, alt, onClose, localPath, workspaceId, onReveal, onOpenExternal }: ImageViewerProps): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return createPortal(
    <div
      className="ad-image-viewer-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="ad-image-viewer__toolbar">
        {(onReveal || (localPath && workspaceId)) && (
          <button
            type="button"
            className="ad-image-viewer__action"
            onClick={onReveal ?? (() => void getAgentDock().media.revealInFolder(workspaceId as string, localPath as string))}
          >
            <FolderOpen size={13} />
            Reveal in Explorer
          </button>
        )}
        {(onOpenExternal || !localPath) && (
          <button
            type="button"
            className="ad-image-viewer__action"
            onClick={onOpenExternal ?? (() => void getAgentDock().media.openExternalLink(src))}
          >
            <ExternalLink size={13} />
            Open externally
          </button>
        )}
        <button type="button" className="ad-image-viewer__action" onClick={onClose} aria-label="Close">
          <X size={15} />
        </button>
      </div>
      <img src={src} alt={alt ?? ''} className="ad-image-viewer__img" onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body
  )
}
