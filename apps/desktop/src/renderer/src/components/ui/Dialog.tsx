import { X } from 'lucide-react'
import { createPortal } from 'react-dom'
import {
  type KeyboardEvent,
  type PropsWithChildren,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from 'react'
import { Button } from './Button'

interface DialogProps extends PropsWithChildren {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  footer?: ReactNode
  variant?: 'dialog' | 'drawer'
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function Dialog({
  open,
  title,
  description,
  onClose,
  footer,
  variant = 'dialog',
  children,
}: DialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const appRoot = document.getElementById('root')
    appRoot?.setAttribute('inert', '')
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusTimer = window.setTimeout(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(
        '[data-autofocus], ' + FOCUSABLE_SELECTOR,
      )
      first?.focus()
    }, 0)

    return () => {
      window.clearTimeout(focusTimer)
      appRoot?.removeAttribute('inert')
      document.body.style.overflow = previousOverflow
      previousFocusRef.current?.focus()
    }
  }, [open])

  if (!open) return null

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab' || !panelRef.current) return
    const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    if (!focusable.length) {
      event.preventDefault()
      panelRef.current.focus()
      return
    }
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first && last) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last && first) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div className="dialog-layer" data-variant={variant}>
      <div className="dialog-backdrop" aria-hidden="true" onMouseDown={onClose} />
      <div
        ref={panelRef}
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <Button variant="quiet" size="small" aria-label="关闭" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </Button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer ? <footer className="dialog-footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  )
}
