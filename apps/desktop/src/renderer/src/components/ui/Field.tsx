import { cloneElement, isValidElement, type ReactElement, type ReactNode, useId } from 'react'

interface FieldProps {
  label: string
  hint?: string
  error?: string
  required?: boolean
  children: ReactElement<{
    id?: string | undefined
    'aria-describedby'?: string | undefined
    'aria-invalid'?: boolean | undefined
    required?: boolean | undefined
  }>
}

export function Field({ label, hint, error, required = false, children }: FieldProps) {
  const generatedId = useId()
  const controlId = children.props.id ?? `field-${generatedId}`
  const hintId = hint ? `${controlId}-hint` : undefined
  const errorId = error ? `${controlId}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined

  if (!isValidElement(children)) return null

  return (
    <div className="field">
      <label className="field__label" htmlFor={controlId}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {cloneElement(children, {
        id: controlId,
        required,
        'aria-describedby': describedBy,
        'aria-invalid': Boolean(error),
      })}
      {hint ? (
        <div className="field__hint" id={hintId}>
          {hint}
        </div>
      ) : null}
      {error ? (
        <div className="field__error" id={errorId}>
          {error}
        </div>
      ) : null}
    </div>
  )
}

export function FieldGroup({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="field-group">
      <legend>{legend}</legend>
      {children}
    </fieldset>
  )
}
