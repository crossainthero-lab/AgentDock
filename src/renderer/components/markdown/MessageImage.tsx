import type React from 'react'
import { useEffect, useState } from 'react'
import { ImageOff, Loader2 } from 'lucide-react'
import { getAgentDock } from '../../lib/agentDockClient'
import { ImageViewer } from './ImageViewer'
import './MessageImage.css'

interface MessageImageProps {
  src?: string
  alt?: string
  workspaceId: string | null
}

type LoadState = 'resolving' | 'loading' | 'loaded' | 'error'

function isRemoteHttpsUrl(src: string): boolean {
  try {
    return new URL(src).protocol === 'https:'
  } catch {
    return false
  }
}

function isDataUrl(src: string): boolean {
  return src.startsWith('data:image/')
}

/** Renders an inline Markdown image (`![alt](src)`). Remote https:// and
 *  already-resolved data: URLs load directly; anything else is treated as a
 *  local workspace-relative path and resolved through media-service.ts's
 *  IPC (base64 data URL) — never a raw filesystem access from the renderer,
 *  never a relaxed CSP/webSecurity setting. */
export function MessageImage({ src, alt, workspaceId }: MessageImageProps): React.JSX.Element {
  const raw = src ?? ''
  const directlyLoadable = isRemoteHttpsUrl(raw) || isDataUrl(raw)

  const [resolvedSrc, setResolvedSrc] = useState<string | null>(directlyLoadable ? raw : null)
  const [state, setState] = useState<LoadState>(directlyLoadable ? 'loading' : 'resolving')
  const [error, setError] = useState<string | null>(null)
  const [viewerOpen, setViewerOpen] = useState(false)

  useEffect(() => {
    if (directlyLoadable) {
      setResolvedSrc(raw)
      setState('loading')
      setError(null)
      return
    }
    if (!raw) {
      setState('error')
      setError('No image source.')
      return
    }
    if (!workspaceId) {
      setState('error')
      setError('No workspace open — cannot resolve a local image path.')
      return
    }

    let cancelled = false
    setState('resolving')
    getAgentDock()
      .media.resolveImage(workspaceId, raw)
      .then((result) => {
        if (cancelled) return
        if (result.dataUrl) {
          setResolvedSrc(result.dataUrl)
          setState('loading')
        } else {
          setState('error')
          setError(result.error ?? 'Could not load this image.')
        }
      })
      .catch((err) => {
        if (cancelled) return
        setState('error')
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, workspaceId])

  if (state === 'error') {
    return (
      <span className="ad-md-image-status ad-md-image-status--error" title={error ?? undefined}>
        <ImageOff size={14} />
        {alt || 'Image'} could not be displayed{error ? ` — ${error}` : ''}
      </span>
    )
  }

  if (state === 'resolving' || !resolvedSrc) {
    return (
      <span className="ad-md-image-status">
        <Loader2 size={13} className="ad-md-image-status__spinner" />
        Loading image…
      </span>
    )
  }

  return (
    <>
      <img
        src={resolvedSrc}
        alt={alt ?? ''}
        className="ad-md-image"
        loading="lazy"
        onLoad={() => setState('loaded')}
        onError={() => {
          setState('error')
          setError('The image data could not be rendered.')
        }}
        onClick={() => setViewerOpen(true)}
      />
      {viewerOpen && (
        <ImageViewer
          src={resolvedSrc}
          alt={alt}
          onClose={() => setViewerOpen(false)}
          localPath={directlyLoadable ? undefined : raw}
          workspaceId={workspaceId}
        />
      )}
    </>
  )
}
