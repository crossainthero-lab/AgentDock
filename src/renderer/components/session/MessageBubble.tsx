import type React from 'react'
import { Fragment } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { MessageRole } from '@shared/types'
import './MessageBubble.css'

interface MessageBubbleProps {
  role: MessageRole
  text: string
}

export function MessageBubble({ role, text }: MessageBubbleProps): React.JSX.Element {
  if (role === 'error') {
    return (
      <div className="ad-message ad-message--error">
        <AlertTriangle size={14} />
        <div className="ad-message__text">{renderRichText(text)}</div>
      </div>
    )
  }

  return (
    <div className={`ad-message ad-message--${role === 'user' ? 'user' : 'assistant'}`}>
      <div className="ad-message__text">{renderRichText(text)}</div>
    </div>
  )
}

/** Minimal rendering: preserves line breaks and renders ```fenced``` blocks as code. */
function renderRichText(text: string): React.ReactNode {
  const parts = text.split(/```/g)
  if (parts.length === 1) {
    return text
  }
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      const firstNewline = part.indexOf('\n')
      const code = firstNewline >= 0 ? part.slice(firstNewline + 1) : part
      return (
        <pre className="ad-message__code" key={i}>
          <code>{code.replace(/\n$/, '')}</code>
        </pre>
      )
    }
    return <Fragment key={i}>{part}</Fragment>
  })
}
