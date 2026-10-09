import { createContext, useContext, type ReactNode } from 'react'
import type { MemberNames, MonthClosing, Transaction } from '../domain/types'

export interface ConfirmOptions {
  title: string
  body?: ReactNode
  confirmLabel: string
  /** null hides the cancel button (information-only sheet). */
  cancelLabel?: string | null
  danger?: boolean
  /** When set, the user must type this word before confirming. */
  requireText?: string
}

export type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>

export interface Toast {
  id: number
  message: string
  tone?: 'info' | 'error'
  action?: { label: string; run: () => void }
  sticky?: boolean
}

export type ToastFn = (t: Omit<Toast, 'id'>) => void

export interface AppState {
  txs: Transaction[] | undefined
  closings: MonthClosing[]
  /** Current member display names (ids never change). */
  memberNames: MemberNames
  /** False until names are saved on this device (fresh installation). */
  memberNamesSet: boolean
  month: string
  setMonth: (m: string) => void
  minMonth: string
  maxMonth: string
}

export const ConfirmContext = createContext<ConfirmFn>(async () => false)
export const ToastContext = createContext<ToastFn>(() => {})
export const AppContext = createContext<AppState | null>(null)

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext)
}

export function useToast(): ToastFn {
  return useContext(ToastContext)
}

export function useApp(): AppState {
  const v = useContext(AppContext)
  if (!v) throw new Error('useApp must be used inside AppStateProvider')
  return v
}
