import type React from 'react'
import './Badge.css'

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }): React.JSX.Element {
  return <span className={`ad-badge ad-badge--${tone}`}>{children}</span>
}
