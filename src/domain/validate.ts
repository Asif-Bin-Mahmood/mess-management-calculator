import { closingAdjustments } from './ledger'
import { MAX_AMOUNT } from './money'
import { addMonths, isValidDate, isValidMonth, monthOf } from './month'
import {
  CLOSING_METHODS,
  isMemberTx,
  MEMBER_IDS,
  TX_TYPES,
  UTILITY_CATEGORIES,
  type LedgerId,
  type ClosingMethod,
  type MemberId,
  type MonthClosing,
  type Transaction,
  type TxType,
  type UtilityCategory,
} from './types'

/** The user-editable part of a transaction. */
export interface TxInput {
  ledger: LedgerId
  type: TxType
  amount: number
  date: string
  memberId?: MemberId
  category?: UtilityCategory
  description?: string
}

export type TxErrors = Partial<Record<'ledger' | 'type' | 'amount' | 'date' | 'memberId' | 'category' | 'description', string>>

export const MAX_DESCRIPTION = 200

export function validateTxInput(tx: TxInput): TxErrors {
  const e: TxErrors = {}
  if (tx.ledger !== 'utilities' && tx.ledger !== 'bazar') e.ledger = 'Unknown ledger'
  if (!TX_TYPES.includes(tx.type)) e.type = 'Unknown transaction type'
  if (!Number.isSafeInteger(tx.amount) || tx.amount <= 0) e.amount = 'Enter an amount greater than ৳0'
  else if (tx.amount > MAX_AMOUNT) e.amount = 'Amount is too large'
  if (typeof tx.date !== 'string' || !isValidDate(tx.date)) e.date = 'Choose a valid date'

  if (TX_TYPES.includes(tx.type)) {
    if (isMemberTx(tx.type)) {
      if (!tx.memberId || !MEMBER_IDS.includes(tx.memberId)) e.memberId = 'Choose a member'
      if (tx.category !== undefined) e.category = 'Contributions have no category'
    } else {
      if (tx.memberId !== undefined) e.memberId = 'Expenses are not tied to a member'
      if (tx.ledger === 'utilities') {
        if (!tx.category || !UTILITY_CATEGORIES.some((c) => c.id === tx.category)) e.category = 'Choose a category'
      } else if (tx.category !== undefined) {
        e.category = 'Bazar expenses have no category'
      }
    }
  }
  if (tx.description !== undefined) {
    if (typeof tx.description !== 'string') e.description = 'Invalid note'
    else if (tx.description.length > MAX_DESCRIPTION) e.description = `Keep the note under ${MAX_DESCRIPTION} characters`
  }
  return e
}

/** Full structural validation for stored / imported records. Returns a list of problems. */
export function validateTransaction(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return ['not an object']
  const t = raw as Partial<Transaction>
  const problems: string[] = []
  if (typeof t.id !== 'string' || t.id.length === 0 || t.id.length > 64) problems.push('invalid id')
  const fieldErrors = validateTxInput(t as TxInput)
  problems.push(...Object.values(fieldErrors))
  if (typeof t.date === 'string' && t.month !== monthOf(t.date)) problems.push('month does not match date')
  if (!Number.isFinite(t.createdAt)) problems.push('invalid createdAt')
  if (!Number.isFinite(t.updatedAt)) problems.push('invalid updatedAt')
  if (t.deletedAt !== undefined && !Number.isFinite(t.deletedAt)) problems.push('invalid deletedAt')
  const allowed = new Set(['id', 'ledger', 'type', 'amount', 'date', 'month', 'memberId', 'category', 'description', 'createdAt', 'updatedAt', 'deletedAt'])
  for (const k of Object.keys(t)) if (!allowed.has(k)) problems.push(`unexpected field "${k}"`)
  return problems
}

/** Normalises form input: trims the note and removes fields that do not apply to the type. */
export function normalizeTxInput(tx: TxInput): TxInput {
  const out: TxInput = { ledger: tx.ledger, type: tx.type, amount: tx.amount, date: tx.date }
  if (isMemberTx(tx.type)) out.memberId = tx.memberId
  else if (tx.ledger === 'utilities') out.category = tx.category
  const note = tx.description?.trim()
  if (note) out.description = note
  return out
}

/* ───────────── Month closings ───────────── */

const MAX_BALANCE = MAX_AMOUNT * 10

function isMoney(v: unknown, max = MAX_BALANCE): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && Math.abs(v) <= max
}

export interface ClosingInputErrors {
  method?: string
  settlementKind?: string
  openingCash?: string
  openingBalances?: Partial<Record<MemberId, string>>
  note?: string
  month?: string
}

export function validateClosingInput(input: {
  ledger: LedgerId
  sourceMonth: string
  method: string
  settlementKind?: string
  cashMode: string
  openingCash?: number
  openingBalances?: Partial<Record<MemberId, number>>
  note?: string
}): ClosingInputErrors {
  const e: ClosingInputErrors = {}
  if (input.ledger !== 'utilities' && input.ledger !== 'bazar') e.month = 'Unknown ledger'
  if (!isValidMonth(input.sourceMonth)) e.month = 'Invalid month'
  if (input.method !== 'carry' && input.method !== 'settled' && input.method !== 'manual') e.method = 'Choose how to open the next month'
  if (input.method === 'settled' && input.settlementKind !== 'settled' && input.settlementKind !== 'waived') {
    e.settlementKind = 'Choose whether balances were settled or waived'
  }
  const needsCash = input.method === 'manual' || (input.method === 'settled' && input.cashMode === 'set')
  if (input.cashMode !== 'carry' && input.cashMode !== 'set') e.openingCash = 'Choose how to handle cash'
  if (needsCash && !isMoney(input.openingCash)) e.openingCash = 'Enter the opening cash (numbers only, up to 2 decimals)'
  if (input.method === 'manual') {
    const be: Partial<Record<MemberId, string>> = {}
    for (const id of MEMBER_IDS) if (!isMoney(input.openingBalances?.[id])) be[id] = 'Enter an amount'
    if (Object.keys(be).length) e.openingBalances = be
  }
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > MAX_DESCRIPTION)) {
    e.note = `Keep the note under ${MAX_DESCRIPTION} characters`
  }
  return e
}

function isMemberMap(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false
  const keys = Object.keys(v)
  return keys.length === MEMBER_IDS.length && MEMBER_IDS.every((id) => isMoney((v as Record<string, unknown>)[id]))
}

/** Structural validation of a stored / imported closing record. Returns a list of problems. */
export function validateClosing(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return ['not an object']
  const c = raw as Partial<MonthClosing>
  const p: string[] = []
  if (typeof c.id !== 'string' || c.id.length === 0 || c.id.length > 64) p.push('invalid id')
  if (c.ledger !== 'utilities' && c.ledger !== 'bazar') p.push('unknown ledger')
  if (typeof c.sourceMonth !== 'string' || !isValidMonth(c.sourceMonth)) p.push('invalid source month')
  else if (c.targetMonth !== addMonths(c.sourceMonth, 1)) p.push('target month must follow source month')
  if (!CLOSING_METHODS.includes(c.method as ClosingMethod)) p.push('unknown closing method')
  if (c.cashMode !== 'carry' && c.cashMode !== 'set') p.push('invalid cash mode')
  if (c.method === 'carry' && c.cashMode !== 'carry') p.push('carry-forward must carry cash')
  if (c.method === 'manual' && c.cashMode !== 'set') p.push('manual opening must set cash')
  if (c.cashMode === 'set' && !isMoney(c.openingCash)) p.push('invalid opening cash')
  if (c.method === 'settled' && c.settlementKind !== 'settled' && c.settlementKind !== 'waived') p.push('invalid settlement kind')
  if (c.method === 'manual' && !isMemberMap(c.openingBalances)) p.push('invalid opening balances')
  if (c.note !== undefined && (typeof c.note !== 'string' || c.note.length > MAX_DESCRIPTION)) p.push('invalid note')
  const s = c.snapshot
  if (
    typeof s !== 'object' ||
    s === null ||
    !isMoney(s.closingCash) ||
    !isMemberMap(s.closingBalances) ||
    !Number.isSafeInteger(s.transactionCount) ||
    !Number.isFinite(s.sourceUpdatedAt)
  ) {
    p.push('invalid snapshot')
  }
  if (c.adjustments !== undefined) {
    const a = c.adjustments
    if (typeof a !== 'object' || a === null || !isMemberMap(a.members) || !isMoney(a.cash)) p.push('invalid adjustments')
    else if (p.length === 0) {
      // Must equal what the decision and snapshot imply (decided opening − closing at that time).
      const derived = closingAdjustments({ ...(c as MonthClosing), adjustments: undefined })
      if (derived.cash !== a.cash || MEMBER_IDS.some((id) => derived.members[id] !== a.members[id])) p.push('adjustments do not match the closing decision')
    }
  }
  if (!Number.isFinite(c.createdAt)) p.push('invalid createdAt')
  if (c.undoneAt !== undefined && !Number.isFinite(c.undoneAt)) p.push('invalid undoneAt')
  const allowed = new Set(['id', 'ledger', 'sourceMonth', 'targetMonth', 'method', 'settlementKind', 'cashMode', 'openingCash', 'openingBalances', 'note', 'snapshot', 'adjustments', 'createdAt', 'undoneAt'])
  for (const k of Object.keys(c)) if (!allowed.has(k)) p.push(`unexpected field "${k}"`)
  return p
}
