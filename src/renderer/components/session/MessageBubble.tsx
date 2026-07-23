import type React from 'react'
import { AlertTriangle } from 'lucide-react'
import type { MessageRole } from '@shared/types'
import type { DeliveryState } from '@shared/events/AgentEventReducer'
import { MarkdownMessage } from '../markdown/MarkdownMessage'
import { CopyButton } from '../markdown/CopyButton'
import { AttachmentThumbnail } from './AttachmentThumbnail'
import './MessageBubble.css'

interface MessageBubbleProps {
  role: MessageRole
  text: string
  /** Only meaningful for role === 'user' — reflects whether this message has
   *  actually reached the live CLI yet (see AgentEventReducer.beginSend). */
  deliveryState?: DeliveryState
  onRetry?: () => void
  /** Needed to resolve local (non-http, no-scheme) image/link paths in
   *  assistant Markdown — null when there's no open workspace. */
  workspaceId?: string | null
  /** Codex image attachments sent with this user message (see
   *  codex-attachment-service.ts) — absent for every other role/agent. */
  images?: string[]
  /** Needed to resolve `images`/`responseImages` through this session's own
   *  attachment storage or response-image roots — only present when either
   *  is non-empty. */
  sessionId?: string | null
  /** Images genuinely produced or referenced by the agent during this
   *  message's turn (see codex-response-image-service.ts /
   *  antigravity-response-image-service.ts) — assistant role only. */
  responseImages?: string[]
  /** Which agent's attachment IPC namespace `images`/`responseImages`
   *  resolve through — defaults to 'codex' so existing call sites are
   *  unaffected. */
  attachmentBackend?: 'codex' | 'antigravity'
}

export function MessageBubble({
  role,
  text,
  deliveryState,
  onRetry,
  workspaceId = null,
  images,
  sessionId = null,
  responseImages,
  attachmentBackend = 'codex'
}: MessageBubbleProps): React.JSX.Element {
  if (role === 'error') {
    return (
      <div className="ad-message ad-message--error">
        <div className="ad-message--error__row">
          <AlertTriangle size={14} />
          <div className="ad-message__text">{text}</div>
        </div>
        <div className="ad-message__toolbar ad-message__toolbar--error">
          <CopyButton text={text} label="Copy diagnostics" />
        </div>
      </div>
    )
  }

  if (role === 'assistant') {
    return (
      <div className="ad-message ad-message--assistant ad-message--group">
        {text && (
          <div className="ad-message__text">
            <MarkdownMessage text={text} workspaceId={workspaceId} />
          </div>
        )}
        {responseImages && responseImages.length > 0 && sessionId && (
          <div className="ad-message__attachments">
            {responseImages.map((path) => (
              <AttachmentThumbnail key={path} sessionId={sessionId} path={path} kind="response" backend={attachmentBackend} />
            ))}
          </div>
        )}
        {text && (
          <div className="ad-message__toolbar">
            <CopyButton text={text} label="Copy" />
          </div>
        )}
      </div>
    )
  }

  if (role === 'user') {
    return (
      <div className="ad-message ad-message--user-group ad-message--group">
        <div className="ad-message--user">
          {images && images.length > 0 && sessionId && (
            <div className="ad-message__attachments">
              {images.map((path) => (
                <AttachmentThumbnail key={path} sessionId={sessionId} path={path} backend={attachmentBackend} />
              ))}
            </div>
          )}
          {text && <div className="ad-message__text ad-message__text--plain">{text}</div>}
          {deliveryState === 'sending' && <div className="ad-message__delivery">Sending…</div>}
          {deliveryState === 'failed' && (
            <div className="ad-message__delivery ad-message__delivery--failed">
              Not delivered.{' '}
              <button className="ad-message__retry" onClick={onRetry}>
                Retry
              </button>
            </div>
          )}
        </div>
        {text && deliveryState !== 'sending' && deliveryState !== 'failed' && (
          <div className="ad-message__toolbar ad-message__toolbar--user">
            <CopyButton text={text} label="Copy" />
          </div>
        )}
      </div>
    )
  }

  // 'system' / 'approval' — rendered with the same plain (no-bubble) style as
  // assistant text, since neither is a user-authored message needing a pill.
  return (
    <div className="ad-message ad-message--assistant">
      {text && <div className="ad-message__text ad-message__text--plain">{text}</div>}
    </div>
  )
}
