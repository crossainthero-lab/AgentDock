import type React from 'react'
import './StatusDot.css'
import type { SessionStatus } from '@shared/types'

export function StatusDot({ status }: { status: SessionStatus }): React.JSX.Element {
  return <span className={`ad-status-dot ad-status-dot--${status}`} aria-hidden="true" />
}
