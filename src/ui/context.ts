import { createContext, useContext, type ReactNode } from 'react'
import type { Category, Member } from '../domain/household'
import type { MonthClosing, Transaction } from '../domain/types'

export interface ConfirmOptions {
  title: string
  body?: ReactNode
  confirmLabel: string
  /** null hides the cancel button (information-only sheet). */
  cancelLabel?: string | null
  danger?: boolean
  /** When set, the user must type this word before confirming. */
  requireText?: string
  /** Information sheet (not a decision): a single neutral Close button. */
  help?: boolean
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
  /** Every member ever registered (current and former), in roster order. Accounting uses it as the roster. */
  members: Member[]
  /** Utilities categories (active and archived), in display order. */
  categories: Category[]
  /** True on a fresh installation until the household is set up. */
  needsSetup: boolean
  /** The selected month (shared by Home, both ledgers and Reports); always inside the supported range. */
  month: string
  /** Selects a month; invalid or unsupported values are ignored. */
  setMonth: (m: string) => void
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
