import type React from 'react'
import './IconButton.css'

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
  size?: 'sm' | 'md'
}

export function IconButton({ label, active, size = 'md', className, children, ...rest }: IconButtonProps): React.JSX.Element {
  const classes = ['ad-icon-btn', `ad-icon-btn--${size}`, active ? 'ad-icon-btn--active' : '', className]
    .filter(Boolean)
    .join(' ')
  return (
    <button className={classes} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  )
}
