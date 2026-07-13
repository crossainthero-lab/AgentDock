import type React from 'react'
import './EmptyState.css'

interface EmptyStateProps {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps): React.JSX.Element {
  return (
    <div className="ad-empty-state">
      {icon && <div className="ad-empty-state__icon">{icon}</div>}
      <div className="ad-empty-state__title">{title}</div>
      {description && <div className="ad-empty-state__description">{description}</div>}
      {action && <div className="ad-empty-state__action">{action}</div>}
    </div>
  )
}
