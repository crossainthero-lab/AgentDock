import type React from 'react'
import { AlertTriangle } from 'lucide-react'
import type { MessageRole } from '@shared/types'
import type { DeliveryState } from '@shared/events/AgentEventReducer'
import { MarkdownMessage } from '../markdown/MarkdownMessage'
import { CopyButton } from '../markdown/CopyButton'
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
}

export function MessageBubble({ role, text, deliveryState, onRetry, workspaceId = null }: MessageBubbleProps): React.JSX.Element {
  if (role === 'error') {
    return (
      <div className="ad-message ad-message--error">
        <AlertTriangle size={14} />
        <div className="ad-message__text">{text}</div>
      </div>
    )
  }

  if (role === 'assistant') {
    return (
      <div className="ad-message ad-message--assistant ad-message--group">
        <div className="ad-message__text">
          <MarkdownMessage text={text} workspaceId={workspaceId} />
        </div>
        <div className="ad-message__toolbar">
          <CopyButton text={text} label="Copy" />
        </div>
      </div>
    )
  }

  return (
    <div className={`ad-message ad-message--${role === 'user' ? 'user' : 'assistant'}`}>
      <div className="ad-message__text ad-message__text--plain">{text}</div>
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
  )
}
