import { CheckCircle2, CircleAlert, X } from 'lucide-react'
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react'

type ToastTone = 'success' | 'warning'

interface ToastItem {
  id: number
  message: string
  tone: ToastTone
}

interface ToastContextValue {
  show: (message: string, tone?: ToastTone) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: PropsWithChildren) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((items) => items.filter((item) => item.id !== id))
  }, [])

  const show = useCallback(
    (message: string, tone: ToastTone = 'success') => {
      const id = Date.now()
      setToasts((items) => [...items, { id, message, tone }].slice(-3))
      window.setTimeout(() => dismiss(id), 4500)
    },
    [dismiss],
  )

  const value = useMemo(() => ({ show }), [show])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div className="toast" data-tone={toast.tone} role="status" key={toast.id}>
            {toast.tone === 'success' ? (
              <CheckCircle2 aria-hidden="true" size={18} />
            ) : (
              <CircleAlert aria-hidden="true" size={18} />
            )}
            <span>{toast.message}</span>
            <button aria-label="关闭通知" onClick={() => dismiss(toast.id)}>
              <X aria-hidden="true" size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast must be used inside ToastProvider')
  return value
}
