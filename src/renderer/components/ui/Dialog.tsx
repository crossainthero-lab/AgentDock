import type React from 'react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { IconButton } from './IconButton'
import './Dialog.css'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  footer?: React.ReactNode
  width?: number
  closeOnBackdrop?: boolean
}

export function Dialog({ open, onClose, title, children, footer, width = 480, closeOnBackdrop = true }: DialogProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="ad-dialog-backdrop"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose()
      }}
    >
      <div className="ad-dialog" ref={panelRef} style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="ad-dialog__header">
          <h2 className="ad-dialog__title">{title}</h2>
          <IconButton label="Close" size="sm" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="ad-dialog__body">{children}</div>
        {footer && <div className="ad-dialog__footer">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}
