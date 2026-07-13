import type React from 'react'
import './Button.css'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  title?: string
}

export function Button({ variant = 'secondary', size = 'md', className, children, ...rest }: ButtonProps): React.JSX.Element {
  const classes = ['ad-btn', `ad-btn--${variant}`, `ad-btn--${size}`, className].filter(Boolean).join(' ')
  return (
    <button className={classes} {...rest}>
      {children}
    </button>
  )
}
