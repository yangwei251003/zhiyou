import { forwardRef, type ButtonHTMLAttributes, type PropsWithChildren } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger'
  size?: 'small' | 'medium'
}

export const Button = forwardRef<HTMLButtonElement, PropsWithChildren<ButtonProps>>(function Button(
  { variant = 'primary', size = 'medium', className = '', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`button button--${variant} button--${size} ${className}`.trim()}
      {...props}
    />
  )
})
