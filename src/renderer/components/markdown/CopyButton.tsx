import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import './CopyButton.css'

interface CopyButtonProps {
  /** Static text known at render time (CodeBlock, copy-whole-response). */
  text?: string
  /** Lazily computed at click time instead (MarkdownTable — reads the
   *  rendered DOM's current cell text, which isn't otherwise available
   *  from react-markdown's `children` without walking the tree). Exactly
   *  one of `text`/`getText` should be provided. */
  getText?: () => string
  label?: string
  className?: string
}

/** Reusable copy-to-clipboard button with a clear, temporary "Copied"
 *  confirmation — used by CodeBlock (per-block), MarkdownTable (per-table),
 *  and MessageBubble (copy-whole-response). */
export function CopyButton({ text, getText, label = 'Copy', className }: CopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  async function handleClick(): Promise<void> {
    try {
      await navigator.clipboard.writeText(getText ? getText() : (text ?? ''))
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1800)
    } catch (err) {
      console.error('[markdown] copy to clipboard failed', err)
    }
  }

  return (
    <button
      type="button"
      className={`ad-copy-btn${copied ? ' ad-copy-btn--copied' : ''}${className ? ` ${className}` : ''}`}
      onClick={handleClick}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      <span>{copied ? 'Copied' : label}</span>
    </button>
  )
}
