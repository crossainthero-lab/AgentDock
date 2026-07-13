import type React from 'react'
import './Spinner.css'

export function Spinner({ size = 16 }: { size?: number }): React.JSX.Element {
  return (
    <span
      className="ad-spinner"
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
    />
  )
}
