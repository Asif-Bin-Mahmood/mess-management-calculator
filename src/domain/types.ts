import type { CategoryId, MemberId } from './household'

export type { CategoryId, MemberId } from './household'
export { categoryName, memberName } from './household'

export type LedgerId = 'utilities' | 'bazar'
/**
 * Cash-method types (Utilities, and Bazar before its member-paid start month): contribution, memberRefund,
 * expense, expenseRefund. Member-paid Bazar types: purchase (a member paid for shared Bazar) and settlement
 * (member `memberId` paid member `counterpartyId` to settle balances; never Bazar spending).
 */
export type TxType = 'contribution' | 'memberRefund' | 'expense' | 'expenseRefund' | 'purchase' | 'settlement'

/** Amounts are integer poisha (1 taka = 100 poisha). */
export type Poisha = number

export interface Transaction {
  id: string
  ledger: LedgerId
  type: TxType
  amount: Poisha
  /** YYYY-MM-DD */
  date: string
  /** YYYY-MM, always derived from `date` */
  month: string
  memberId?: MemberId
  /** Settlement only: the member who received the payment. */
  counterpartyId?: MemberId
  /** Utilities expense category (stable id from the category registry). */
  category?: CategoryId
  description?: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
}

export const LEDGERS: readonly { id: LedgerId; name: string }[] = [
  { id: 'utilities', name: 'Utilities' },
  { id: 'bazar', name: 'Bazar' },
]

export const CASH_TX_TYPES: readonly TxType[] = ['contribution', 'memberRefund', 'expense', 'expenseRefund']
export const MEMBER_PAID_TX_TYPES: readonly TxType[] = ['purchase', 'settlement']
export const TX_TYPES: readonly TxType[] = [...CASH_TX_TYPES, ...MEMBER_PAID_TX_TYPES]

export function isMemberPaidType(type: TxType): boolean {
  return type === 'purchase' || type === 'settlement'
}

export function ledgerName(id: LedgerId): string {
  return id === 'utilities' ? 'Utilities' : 'Bazar'
}

export function isMemberTx(type: TxType): boolean {
  return type === 'contribution' || type === 'memberRefund'
}

export function txTypeLabel(type: TxType): string {
  switch (type) {
    case 'contribution':
      return 'Contribution'
    case 'memberRefund':
      return 'Returned to member'
    case 'expense':
      return 'Expense'
    case 'expenseRefund':
      return 'Expense refund'
    case 'purchase':
      return 'Bazar amount'
    case 'settlement':
      return 'Settlement'
  }
}

/**
 * How a month is closed (per ledger):
 * - carry:   next month opens with each member's closing balance and the closing cash.
 * - settled: member balances were settled outside the app or waived; next month opens at zero
 *            member balances. Cash is handled separately (carried or entered).
 * - manual:  the manager enters verified opening balances for each member and opening cash.
 */
export type ClosingMethod = 'carry' | 'settled' | 'manual'
export type SettlementKind = 'settled' | 'waived'

/** Per-member amounts. Only members that appear in the month are present; a missing member counts as 0. */
export type MemberMap = Record<MemberId, Poisha>

export interface ClosingSnapshot {
  closingCash: Poisha
  closingBalances: MemberMap
  transactionCount: number
  /** Latest updatedAt among the source month's transactions when the closing was made. */
  sourceUpdatedAt: number
}

/** A persistent month-closing decision for one ledger. Never deleted; undo sets `undoneAt`. */
export interface MonthClosing {
  id: string
  ledger: LedgerId
  /** YYYY-MM being closed */
  sourceMonth: string
  /** YYYY-MM opened by this decision (always sourceMonth + 1) */
  targetMonth: string
  method: ClosingMethod
  settlementKind?: SettlementKind
  /** 'carry' keeps closing cash; 'set' uses `openingCash`. Always 'carry' for method 'carry'. */
  cashMode: 'carry' | 'set'
  openingCash?: Poisha
  /** Only for method 'manual'. */
  openingBalances?: MemberMap
  note?: string
  /** Figures the manager saw when confirming (reference for later changes). */
  snapshot: ClosingSnapshot
  /** Adjustments recorded at closing: decided opening − snapshot. Optional only for records made before
   *  adjustments were stored; those are derived from the snapshot with the same formula. */
  adjustments?: { members: MemberMap; cash: Poisha }
  createdAt: number
  undoneAt?: number
}

export const CLOSING_METHODS: readonly ClosingMethod[] = ['carry', 'settled', 'manual']

export function closingMethodLabel(c: Pick<MonthClosing, 'method' | 'settlementKind'>): string {
  if (c.method === 'carry') return 'Carry forward balances'
  if (c.method === 'manual') return 'Verified opening balances'
  return c.settlementKind === 'waived' ? 'Balances waived' : 'Balances settled outside the app'
}
