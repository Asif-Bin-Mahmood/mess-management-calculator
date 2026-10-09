import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { pushOverlay } from './backNav'
import { ConfirmContext, ToastContext, type ConfirmFn, type ConfirmOptions, type Toast, type ToastFn } from './context'

/* ───────────── Confirmation sheet ───────────── */

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ o: ConfirmOptions; resolve: (v: boolean) => void } | null>(null)
  const [typed, setTyped] = useState('')
  const ref = useRef<HTMLDialogElement>(null)

  const confirm = useCallback<ConfirmFn>(
    (o) =>
      new Promise<boolean>((resolve) => {
        setTyped('')
        setState({ o, resolve })
      }),
    [],
  )

  useEffect(() => {
    const d = ref.current
    if (state && d && !d.open) {
      d.showModal()
      // Start at the top with the title focused, so long sheets are read from the beginning.
      d.scrollTop = 0
      d.querySelector<HTMLElement>('#confirm-title')?.focus()
    }
  }, [state])

  // Android Back closes the open sheet (same as Cancel).
  useEffect(() => {
    if (!state) return
    return pushOverlay(() => {
      ref.current?.close()
      state.resolve(false)
      setState(null)
    })
  }, [state])

  const close = (v: boolean) => {
    ref.current?.close()
    state?.resolve(v)
    setState(null)
  }

  const o = state?.o
  const blocked = !!o?.requireText && typed.trim().toUpperCase() !== o.requireText
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <dialog
        ref={ref}
        className="sheet"
        aria-labelledby="confirm-title"
        onCancel={(e) => {
          e.preventDefault()
          close(false)
        }}
        onClick={(e) => {
          if (e.target === ref.current) close(false)
        }}
      >
        {o && (
          <div className="sheet-body">
            <div className="sheet-grip" aria-hidden="true" />
            <h2 id="confirm-title" className="sheet-title" tabIndex={-1}>
              {o.title}
            </h2>
            {o.body && <div className="sheet-content">{o.body}</div>}
            {o.requireText && (
              <label className="field">
                <span className="field-label">Type {o.requireText} to confirm</span>
                <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" />
              </label>
            )}
            <div className={`sheet-actions ${o.cancelLabel === null ? 'single' : ''}`}>
              {o.cancelLabel !== null && (
                <button type="button" className="btn btn-ghost" onClick={() => close(false)}>
                  {o.cancelLabel ?? 'Cancel'}
                </button>
              )}
              <button
                type="button"
                className={o.danger ? 'btn btn-danger' : 'btn btn-primary'}
                disabled={blocked}
                onClick={() => close(true)}
              >
                {o.confirmLabel}
              </button>
            </div>
          </div>
        )}
      </dialog>
    </ConfirmContext.Provider>
  )
}

/* ───────────── Toasts ───────────── */

let toastSeq = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), [])

  const show = useCallback<ToastFn>(
    (t) => {
      const id = ++toastSeq
      setToasts((ts) => [...ts.slice(-2), { ...t, id }])
      if (!t.sticky) setTimeout(() => dismiss(id), t.action ? 6000 : 3500)
    },
    [dismiss],
  )

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === 'error' ? 'toast-error' : ''}`}>
            <span>{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  t.action!.run()
                  dismiss(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
            {t.sticky && !t.action && (
              <button type="button" className="toast-action" onClick={() => dismiss(t.id)}>
                OK
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
