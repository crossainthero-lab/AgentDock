import type React from 'react'
import { useRef, useState } from 'react'
import { Square, ArrowUp } from 'lucide-react'
import './PromptComposer.css'

interface PromptComposerProps {
  disabled: boolean
  disabledReason: string | null
  isRunning: boolean
  onSend: (text: string) => void
  onInterrupt: () => void
}

export function PromptComposer({ disabled, disabledReason, isRunning, onSend, onInterrupt }: PromptComposerProps): React.JSX.Element {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const canSend = !disabled && !isRunning && text.trim().length > 0

  function handleSend(): void {
    if (!canSend) return
    onSend(text.trim())
    setText('')
    textareaRef.current?.focus()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const reason = disabled ? disabledReason : isRunning ? null : text.trim().length === 0 ? 'Type a task to send.' : null

  return (
    <div className="ad-composer">
      <div className={`ad-composer__box${disabled ? ' ad-composer__box--disabled' : ''}`} title={reason ?? undefined}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? (disabledReason ?? 'Sending is unavailable right now.') : 'Tell the agent what to do…'}
          disabled={disabled}
          rows={3}
        />
        <div className="ad-composer__toolbar">
          <span className="ad-composer__hint">
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
          </span>
          {isRunning ? (
            <button className="ad-composer__stop" onClick={onInterrupt} title="Interrupt the current task">
              <Square size={13} />
              Stop
            </button>
          ) : (
            <button className="ad-composer__send" onClick={handleSend} disabled={!canSend} title={reason ?? 'Send'}>
              <ArrowUp size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
