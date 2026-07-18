import type React from 'react'
import './InlineCode.css'

export function InlineCode({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return <code className="ad-inline-code">{children}</code>
}
