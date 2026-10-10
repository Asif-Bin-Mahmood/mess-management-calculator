import { isMemberPaidMonth, type BazarMethod } from './bazarMethod'
import { sharers, type Category, type CategoryId, type Roster } from './household'
import { closingAdjustments } from './ledger'
import { MAX_AMOUNT } from './money'
import { addMonths, isValidDate, isValidMonth, monthLabel, monthOf } from './month'
import { CLOSING_METHODS, isMemberPaidType, isMemberTx, TX_TYPES, type ClosingMethod, type LedgerId, type MemberId, type MonthClosing, type Transaction, type TxType } from './types'

/**
 * The household registry a transaction is checked against.
 * - `entry`: true for entries made in the app now (new or edited). Then a Utilities category must not be
 *   archived (except `keepCategory`, the category an edited entry already had), and an expense month must have
 *   at least one member sharing it. Stored or imported records (`entry` false) only need existing references.
 */
export interface TxContext {
  roster: Roster
  categories: readonly Category[]
  entry?: boolean
  keepCategory?: CategoryId
  /** Bazar method of the installation or backup: decides which entry types each Bazar month accepts. */
  bazarMethod?: BazarMethod | null
}

/** The user-editable part of a transaction. */
export interface TxInput {
  ledger: LedgerId
  type: TxType
  amount: number
  date: string
  memberId?: MemberId
  /** Settlement only: the member who received the payment. */
  counterpartyId?: MemberId
  category?: CategoryId
  description?: string
}

export type TxErrors = Partial<Record<'ledger' | 'type' | 'amount' | 'date' | 'memberId' | 'counterpartyId' | 'category' | 'description', string>>

export const MAX_DESCRIPTION = 200

export function validateTxInput(tx: TxInput, ctx: TxContext): TxErrors {
  const e: TxErrors = {}
  if (tx.ledger !== 'utilities' && tx.ledger !== 'bazar') e.ledger = 'Unknown ledger'
  if (!TX_TYPES.includes(tx.type)) e.type = 'Unknown transaction type'
  if (!Number.isSafeInteger(tx.amount) || tx.amount <= 0) e.amount = 'Enter an amount greater than ৳0'
  else if (tx.amount > MAX_AMOUNT) e.amount = 'Amount is too large'
  if (typeof tx.date !== 'string' || !isValidDate(tx.date)) e.date = 'Choose a valid date'

  // Each month accepts the entry types of its method: member-paid Bazar months take Bazar amounts and
  // settlements; cash months (all of Utilities, Bazar before the switch) take the cash types.
  const memberPaid = e.date === undefined && e.ledger === undefined && isMemberPaidMonth(ctx.bazarMethod, tx.ledger, monthOf(tx.date))
  if (TX_TYPES.includes(tx.type) && e.date === undefined && e.ledger === undefined && memberPaid !== isMemberPaidType(tx.type)) {
    e.type = memberPaid
      ? `Bazar uses member-paid entries from ${monthLabel(ctx.bazarMethod!.memberPaidFrom)}: record a Bazar amount or a settlement.`
      : tx.ledger === 'bazar' && ctx.bazarMethod
        ? `Bazar before ${monthLabel(ctx.bazarMethod.memberPaidFrom)} uses the cash method (contributions and expenses).`
        : 'This entry type is not available here.'
  }
  if (TX_TYPES.includes(tx.type) && isMemberPaidType(tx.type)) {
    if (tx.ledger !== 'bazar') e.ledger = 'Only Bazar records member-paid amounts'
    if (!tx.memberId || !ctx.roster.some((m) => m.id === tx.memberId)) e.memberId = tx.type === 'settlement' ? 'Choose who paid' : 'Choose a member'
    if (tx.category !== undefined) e.category = 'Bazar amounts have no category'
    if (tx.type === 'purchase') {
      if (tx.counterpartyId !== undefined) e.counterpartyId = 'A Bazar amount has no receiver'
      // Only a member sharing the month can add to its shared Bazar (a former member settles instead).
      if (ctx.entry && !e.memberId && e.date === undefined && !sharers(ctx.roster, monthOf(tx.date)).some((m) => m.id === tx.memberId)) {
        e.memberId = `This member does not share ${monthLabel(monthOf(tx.date))}. Record a settlement for an old balance instead.`
      }
    } else {
      if (!tx.counterpartyId || !ctx.roster.some((m) => m.id === tx.counterpartyId)) e.counterpartyId = 'Choose who received the payment'
      else if (tx.counterpartyId === tx.memberId) e.counterpartyId = 'Choose two different members'
    }
  } else if (TX_TYPES.includes(tx.type)) {
    if (tx.counterpartyId !== undefined) e.counterpartyId = 'Only settlements have a receiver'
    if (isMemberTx(tx.type)) {
      if (!tx.memberId || !ctx.roster.some((m) => m.id === tx.memberId)) e.memberId = 'Choose a member'
      if (tx.category !== undefined) e.category = 'Contributions have no category'
    } else {
      if (tx.memberId !== undefined) e.memberId = 'Expenses are not tied to a member'
      if (tx.ledger === 'utilities') {
        const cat = tx.category === undefined ? undefined : ctx.categories.find((c) => c.id === tx.category)
        if (!cat) e.category = 'Choose a category'
        else if (ctx.entry && cat.archivedAt !== undefined && cat.id !== ctx.keepCategory) e.category = 'This category is archived. Choose another one.'
      } else if (tx.category !== undefined) {
        e.category = 'Bazar expenses have no category'
      }
      if (ctx.entry && e.date === undefined && sharers(ctx.roster, monthOf(tx.date)).length === 0) {
        e.date = `No member shares expenses in ${monthLabel(monthOf(tx.date))}. Add or restore a member for that month first.`
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
export function validateTransaction(raw: unknown, ctx: TxContext): string[] {
  if (typeof raw !== 'object' || raw === null) return ['not an object']
  const t = raw as Partial<Transaction>
  const problems: string[] = []
  if (typeof t.id !== 'string' || t.id.length === 0 || t.id.length > 64) problems.push('invalid id')
  const fieldErrors = validateTxInput(t as TxInput, { roster: ctx.roster, categories: ctx.categories, bazarMethod: ctx.bazarMethod })
  problems.push(...Object.values(fieldErrors))
  if (typeof t.date === 'string' && t.month !== monthOf(t.date)) problems.push('month does not match date')
  if (!Number.isFinite(t.createdAt)) problems.push('invalid createdAt')
  if (!Number.isFinite(t.updatedAt)) problems.push('invalid updatedAt')
  if (t.deletedAt !== undefined && !Number.isFinite(t.deletedAt)) problems.push('invalid deletedAt')
  const allowed = new Set(['id', 'ledger', 'type', 'amount', 'date', 'month', 'memberId', 'counterpartyId', 'category', 'description', 'createdAt', 'updatedAt', 'deletedAt'])
  for (const k of Object.keys(t)) if (!allowed.has(k)) problems.push(`unexpected field "${k}"`)
  return problems
}

/** Normalises form input: trims the note and removes fields that do not apply to the type. */
export function normalizeTxInput(tx: TxInput): TxInput {
  const out: TxInput = { ledger: tx.ledger, type: tx.type, amount: tx.amount, date: tx.date }
  if (isMemberTx(tx.type) || isMemberPaidType(tx.type)) out.memberId = tx.memberId
  else if (tx.ledger === 'utilities') out.category = tx.category
  if (tx.type === 'settlement') out.counterpartyId = tx.counterpartyId
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

/** `memberIds` are the members shown in the month being closed (each needs a verified balance for 'manual'). */
export function validateClosingInput(
  input: {
    ledger: LedgerId
    sourceMonth: string
    method: string
    settlementKind?: string
    cashMode: string
    openingCash?: number
    openingBalances?: Partial<Record<MemberId, number>>
    note?: string
  },
  memberIds: readonly MemberId[],
): ClosingInputErrors {
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
    for (const id of memberIds) if (!isMoney(input.openingBalances?.[id])) be[id] = 'Enter an amount'
    if (Object.keys(be).length) e.openingBalances = be
  }
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > MAX_DESCRIPTION)) {
    e.note = `Keep the note under ${MAX_DESCRIPTION} characters`
  }
  return e
}

/** Per-member amounts: every key a registered member, every value money. (v1.1.1 records hold the four original ids.) */
function isMemberMap(v: unknown, roster: Roster): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const ids = new Set(roster.map((m) => m.id))
  return Object.entries(v).every(([k, x]) => ids.has(k) && isMoney(x))
}

/** Structural validation of a stored / imported closing record against the member registry. */
export function validateClosing(raw: unknown, roster: Roster): string[] {
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
  if (c.method === 'manual' && !isMemberMap(c.openingBalances, roster)) p.push('invalid opening balances')
  if (c.note !== undefined && (typeof c.note !== 'string' || c.note.length > MAX_DESCRIPTION)) p.push('invalid note')
  const s = c.snapshot
  if (
    typeof s !== 'object' ||
    s === null ||
    !isMoney(s.closingCash) ||
    !isMemberMap(s.closingBalances, roster) ||
    !Number.isSafeInteger(s.transactionCount) ||
    !Number.isFinite(s.sourceUpdatedAt)
  ) {
    p.push('invalid snapshot')
  }
  if (c.adjustments !== undefined) {
    const a = c.adjustments
    if (typeof a !== 'object' || a === null || !isMemberMap(a.members, roster) || !isMoney(a.cash)) p.push('invalid adjustments')
    else if (p.length === 0) {
      // Must equal what the decision and snapshot imply (decided opening − closing at that time).
      const derived = closingAdjustments({ ...(c as MonthClosing), adjustments: undefined })
      const ids = new Set([...Object.keys(derived.members), ...Object.keys(a.members)])
      if (derived.cash !== a.cash || [...ids].some((id) => (derived.members[id] ?? 0) !== (a.members[id] ?? 0))) p.push('adjustments do not match the closing decision')
    }
  }
  if (!Number.isFinite(c.createdAt)) p.push('invalid createdAt')
  if (c.undoneAt !== undefined && !Number.isFinite(c.undoneAt)) p.push('invalid undoneAt')
  const allowed = new Set(['id', 'ledger', 'sourceMonth', 'targetMonth', 'method', 'settlementKind', 'cashMode', 'openingCash', 'openingBalances', 'note', 'snapshot', 'adjustments', 'createdAt', 'undoneAt'])
  for (const k of Object.keys(c)) if (!allowed.has(k)) p.push(`unexpected field "${k}"`)
  return p
}
