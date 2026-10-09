export type LedgerId = 'utilities' | 'bazar'
export type MemberId = 'asif' | 'dipu' | 'yusha' | 'ovi'
export type TxType = 'contribution' | 'memberRefund' | 'expense' | 'expenseRefund'
export type UtilityCategory = 'service' | 'current' | 'gas' | 'wifi' | 'others'

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
  category?: UtilityCategory
  description?: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
}

/**
 * Permanent member identities. They link transactions, balances and closings and never change.
 * The order is also the order used for leftover-poisha rounding (member 1 → 4).
 * The ids are historical; what users see is the configurable display name below.
 */
export const MEMBER_IDS: readonly MemberId[] = ['asif', 'dipu', 'yusha', 'ovi']

export type MemberNames = Record<MemberId, string>

/** Display names for a fresh installation. */
export const DEFAULT_MEMBER_NAMES: MemberNames = { asif: 'Member 1', dipu: 'Member 2', yusha: 'Member 3', ovi: 'Member 4' }

/**
 * Names used by installations and backups created before names were configurable (app ≤ 1.1.0,
 * backup schema 1–2). Only used to keep those existing installations and backups unchanged.
 */
export const LEGACY_MEMBER_NAMES: MemberNames = { asif: 'Asif', dipu: 'Dipu', yusha: 'Yusha', ovi: 'Ovi' }

export const MAX_MEMBER_NAME = 24

let currentNames: MemberNames = { ...DEFAULT_MEMBER_NAMES }

/** Sets the display names used by memberName()/members(). Display only: never affects accounting. */
export function setMemberNames(names: MemberNames): void {
  currentNames = { ...names }
}

export function getMemberNames(): MemberNames {
  return { ...currentNames }
}

/** Members in their fixed order with their current display names. */
export function members(): { id: MemberId; name: string }[] {
  return MEMBER_IDS.map((id) => ({ id, name: currentNames[id] }))
}

export function sameMemberNames(a: MemberNames, b: MemberNames): boolean {
  return MEMBER_IDS.every((id) => a[id] === b[id])
}

/** Trims names and reports problems: blank, too long, or duplicated (case-insensitive). */
export function validateMemberNames(raw: Partial<Record<MemberId, unknown>>): { names: MemberNames; errors: Partial<Record<MemberId, string>> } {
  const names = {} as MemberNames
  const errors: Partial<Record<MemberId, string>> = {}
  for (const id of MEMBER_IDS) {
    const v = raw[id]
    const name = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : ''
    names[id] = name
    if (!name) errors[id] = 'Enter a name'
    else if (name.length > MAX_MEMBER_NAME) errors[id] = `Use at most ${MAX_MEMBER_NAME} characters`
  }
  for (const id of MEMBER_IDS) {
    if (errors[id]) continue
    const dup = MEMBER_IDS.find((o) => o !== id && names[o].toLowerCase() === names[id].toLowerCase())
    if (dup) errors[id] = 'Each member needs a different name'
  }
  return { names, errors }
}

export const UTILITY_CATEGORIES: readonly { id: UtilityCategory; name: string }[] = [
  { id: 'service', name: 'Service Charge' },
  { id: 'current', name: 'Current Bill' },
  { id: 'gas', name: 'Gas Bill' },
  { id: 'wifi', name: 'Wi-Fi Bill' },
  { id: 'others', name: 'Others' },
]

export const LEDGERS: readonly { id: LedgerId; name: string }[] = [
  { id: 'utilities', name: 'Utilities' },
  { id: 'bazar', name: 'Bazar' },
]

export const TX_TYPES: readonly TxType[] = ['contribution', 'memberRefund', 'expense', 'expenseRefund']

export function memberName(id: MemberId): string {
  return currentNames[id] ?? id
}

export function categoryName(id: UtilityCategory): string {
  return UTILITY_CATEGORIES.find((c) => c.id === id)?.name ?? id
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

export interface ClosingSnapshot {
  closingCash: Poisha
  closingBalances: Record<MemberId, Poisha>
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
  openingBalances?: Record<MemberId, Poisha>
  note?: string
  /** Figures the manager saw when confirming (reference for later changes). */
  snapshot: ClosingSnapshot
  /** Adjustments recorded at closing: decided opening − snapshot. Optional only for records made before
   *  adjustments were stored; those are derived from the snapshot with the same formula. */
  adjustments?: { members: Record<MemberId, Poisha>; cash: Poisha }
  createdAt: number
  undoneAt?: number
}

export const CLOSING_METHODS: readonly ClosingMethod[] = ['carry', 'settled', 'manual']

export function closingMethodLabel(c: Pick<MonthClosing, 'method' | 'settlementKind'>): string {
  if (c.method === 'carry') return 'Carry forward balances'
  if (c.method === 'manual') return 'Verified opening balances'
  return c.settlementKind === 'waived' ? 'Balances waived' : 'Balances settled outside the app'
}
