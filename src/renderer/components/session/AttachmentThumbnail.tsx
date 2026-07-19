import type React from 'react'
import { useEffect, useState } from 'react'
import { ImageOff, Loader2, X } from 'lucide-react'
import { getAgentDock } from '../../lib/agentDockClient'
import { ImageViewer } from '../markdown/ImageViewer'
import './AttachmentThumbnail.css'

interface AttachmentThumbnailProps {
  sessionId: string
  /** Absolute path — into this session's persistent attachment storage for
   *  `kind:'attachment'` (see codex-attachment-service.ts /
   *  antigravity-attachment-service.ts), or a genuine response artifact
   *  path for `kind:'response'` (workspace, attachment storage, or —
   *  Codex only — this session's own generated_images directory). Resolved
   *  to a data URL through IPC either way; the renderer never touches the
   *  filesystem directly. */
  path: string
  /** Present only for a not-yet-sent pending attachment in the composer —
   *  omitted for attachments already sent in the conversation. */
  onRemove?: () => void
  /** 'attachment' (default) = a user-sent input image. 'response' = a
   *  genuine agent-produced/referenced image in an assistant reply — a
   *  different resolve/reveal/open-externally backend and, unlike
   *  attachments, offers "Reveal in Explorer"/"Open externally" in the
   *  lightbox (an attachment's own storage dir is AgentDock-internal and
   *  not meaningful to reveal; a response artifact is a real, user-relevant
   *  file). */
  kind?: 'attachment' | 'response'
  /** Which agent's IPC namespace to resolve/reveal/open through — defaults
   *  to 'codex' so every existing call site (Codex attachments and
   *  response images) is completely unaffected by this prop's addition. */
  backend?: 'codex' | 'antigravity'
}

/** Small bounded preview of one image (a user attachment or a genuine
 *  agent-response artifact), resolved from disk through IPC — never a raw
 *  filesystem access from the renderer. Reused for the composer's
 *  pending-attachment row, sent-message attachment display, and inline
 *  response-image display; click opens the shared ImageViewer lightbox. */
export function AttachmentThumbnail({
  sessionId,
  path,
  onRemove,
  kind = 'attachment',
  backend = 'codex'
}: AttachmentThumbnailProps): React.JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewerOpen, setViewerOpen] = useState(false)

  const api = backend === 'antigravity' ? getAgentDock().antigravity : getAgentDock().codex

  useEffect(() => {
    let cancelled = false
    setDataUrl(null)
    setError(null)
    const resolve = kind === 'response' ? api.resolveResponseImage(sessionId, path) : api.resolveAttachment(sessionId, path)
    resolve
      .then((result) => {
        if (cancelled) return
        if (result.dataUrl) setDataUrl(result.dataUrl)
        else setError(result.error ?? 'Could not load this image.')
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, path, kind, backend])

  if (error) {
    return (
      <span className="ad-attachment-thumb ad-attachment-thumb--error" title={error}>
        <ImageOff size={14} />
      </span>
    )
  }

  return (
    <div className="ad-attachment-thumb">
      {dataUrl ? (
        <img src={dataUrl} alt="" className="ad-attachment-thumb__img" onClick={() => setViewerOpen(true)} />
      ) : (
        <Loader2 size={14} className="ad-attachment-thumb__spinner" />
      )}
      {onRemove && (
        <button type="button" className="ad-attachment-thumb__remove" onClick={onRemove} aria-label="Remove attachment">
          <X size={11} />
        </button>
      )}
      {viewerOpen && dataUrl && (
        <ImageViewer
          src={dataUrl}
          onClose={() => setViewerOpen(false)}
          localPath={path}
          workspaceId={null}
          onReveal={kind === 'response' ? () => void api.revealResponseImage(sessionId, path) : undefined}
          onOpenExternal={kind === 'response' ? () => void api.openResponseImageExternally(sessionId, path) : undefined}
        />
      )}
    </div>
  )
}
