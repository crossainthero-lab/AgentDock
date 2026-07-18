import type React from 'react'
import { useState } from 'react'
import { ExternalLink, File, FolderOpen } from 'lucide-react'
import { getAgentDock } from '../../lib/agentDockClient'
import './MarkdownLink.css'

interface MarkdownLinkProps {
  href?: string
  children?: React.ReactNode
  workspaceId: string | null
}

type HrefKind = 'safe-external' | 'local' | 'unsafe'

/** Deny-by-default: only http(s)/mailto are ever opened. Everything else —
 *  javascript:, data:, vbscript:, an explicit file: URL, any other scheme —
 *  is treated as unsafe and rendered inert, never clicked, never handed to
 *  the OS. A bare relative/absolute filesystem-looking path (no scheme at
 *  all) is its own "local" case with its own safe, workspace-scoped actions. */
function classifyHref(href: string): HrefKind {
  const trimmed = href.trim()
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:')) return 'safe-external'
  // Any other "scheme:" prefix (javascript:, data:, vbscript:, file:, a
  // custom app scheme, ...) — never allowed.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return 'unsafe'
  return 'local'
}

export function MarkdownLink({ href, children, workspaceId }: MarkdownLinkProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const url = href ?? ''
  const kind = classifyHref(url)

  if (kind === 'safe-external') {
    return (
      <a
        href={url}
        className="ad-md-link"
        title={url}
        onClick={(e) => {
          e.preventDefault()
          setError(null)
          getAgentDock()
            .media.openExternalLink(url)
            .then((result) => {
              if (!result.ok) setError(result.error ?? 'Could not open this link.')
            })
            .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        }}
      >
        {children}
        <ExternalLink size={11} className="ad-md-link__icon" />
        {error && <span className="ad-md-link__error"> — {error}</span>}
      </a>
    )
  }

  if (kind === 'local' && workspaceId) {
    return <LocalPathChip path={url} workspaceId={workspaceId}>{children}</LocalPathChip>
  }

  // 'unsafe', or 'local' with no workspace context to safely resolve
  // against — render as plain, inert text. Never a clickable element.
  return <span className="ad-md-link ad-md-link--inert">{children}</span>
}

function LocalPathChip({ path, workspaceId, children }: { path: string; workspaceId: string; children?: React.ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<string | null>(null)

  async function run(action: 'open' | 'reveal'): Promise<void> {
    setStatus(null)
    const api = getAgentDock().media
    const result = action === 'open' ? await api.openLocalPath(workspaceId, path) : await api.revealInFolder(workspaceId, path)
    if (!result.ok) setStatus(result.error ?? 'Action failed.')
  }

  return (
    <span className="ad-md-link ad-md-link--local" title={path}>
      <File size={11} className="ad-md-link__icon" />
      {children}
      <button type="button" className="ad-md-link__action" onClick={() => void run('open')}>
        Open
      </button>
      <button type="button" className="ad-md-link__action" onClick={() => void run('reveal')}>
        <FolderOpen size={11} />
      </button>
      {status && <span className="ad-md-link__error"> — {status}</span>}
    </span>
  )
}
