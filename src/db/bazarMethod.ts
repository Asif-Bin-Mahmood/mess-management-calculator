/**
 * Switching Bazar from the cash method to the member-paid method (the cutover).
 *
 * The switch takes effect from a month the user chooses. It is refused unless:
 * - the month is still open in Bazar (after the latest Bazar closing) — closed months never change;
 * - no live cash-method Bazar entry (contribution, return, expense, refund) is dated in or after it — old entries
 *   are never reinterpreted as member-paid amounts;
 * - Bazar's shared cash at the end of the previous month is ৳0 — the member-paid method has no cash pool, so any
 *   money still held (or owed) must be settled with cash-method entries first.
 * Member balances carry into the first member-paid month unchanged, and every earlier month keeps its figures.
 * The switch can be undone while no member-paid entry has been recorded and no later month is closed.
 */
import type { BazarMethod } from '../domain/bazarMethod'
import { activeClosings, computeLedgerMonth, type MemberChange } from '../domain/ledger'
import { addMonths, currentMonth, isValidMonth, monthLabel } from '../domain/month'
import { isMemberPaidType } from '../domain/types'
import { db as defaultDb, type MessDb } from './db'

export const BAZAR_METHOD_KEY = 'bazarMethod'

export async function loadBazarMethod(database: MessDb = defaultDb): Promise<BazarMethod | null> {
  return ((await database.meta.get(BAZAR_METHOD_KEY))?.value as BazarMethod | undefined) ?? null
}

export interface BazarSwitchPlan {
  from: string
  /** Earliest month the switch could start (first month open in Bazar), or null if any month is open. */
  firstOpenMonth: string | null
  /** Reasons the switch cannot be made now (empty = allowed). */
  problems: string[]
  /** Bazar cash at the end of the month before `from` (must be ৳0). */
  cashBefore: number
  /** Member balances carried into `from`, unchanged. */
  balances: MemberChange[]
  /** Months in or after `from` that still have cash-method Bazar entries. */
  cashEntryMonths: string[]
}

export class BazarMethodError extends Error {}

async function bazarData(database: MessDb) {
  const [transactions, closings, members] = await Promise.all([
    database.transactions.where('ledger').equals('bazar').toArray(),
    database.closings.where('ledger').equals('bazar').toArray(),
    database.members.toArray(),
  ])
  return { transactions, closings, members }
}

/** What switching from `from` would do (nothing is written). */
export async function planBazarSwitch(from: string, database: MessDb = defaultDb, now = Date.now()): Promise<BazarSwitchPlan> {
  const { transactions, closings, members } = await bazarData(database)
  const problems: string[] = []
  const current = await loadBazarMethod(database)
  if (current) problems.push(`Bazar already uses member-paid entries from ${monthLabel(current.memberPaidFrom)}.`)
  const lastClosed = [...activeClosings('bazar', closings).keys()].sort().pop() ?? null
  const firstOpenMonth = lastClosed ? addMonths(lastClosed, 1) : null
  if (!isValidMonth(from)) {
    problems.push('Choose a month.')
    return { from, firstOpenMonth, problems, cashBefore: 0, balances: [], cashEntryMonths: [] }
  }
  if (firstOpenMonth && from < firstOpenMonth) {
    problems.push(`${monthLabel(lastClosed!)} is closed. Choose ${monthLabel(firstOpenMonth)} or later, or undo that closing first.`)
  }
  const cashEntryMonths = [...new Set(transactions.filter((t) => t.deletedAt === undefined && !isMemberPaidType(t.type) && t.month >= from).map((t) => t.month))].sort()
  if (cashEntryMonths.length) {
    problems.push(
      `Bazar already has contributions or expenses in ${cashEntryMonths.map(monthLabel).join(', ')}. Choose the month after them, or move or delete those entries first — old entries are never converted.`,
    )
  }
  const before = computeLedgerMonth('bazar', members, transactions, addMonths(from, -1), closings)
  const cashBefore = before.remainingCash
  if (cashBefore !== 0) {
    problems.push(
      cashBefore > 0
        ? `Bazar still holds ৳${(cashBefore / 100).toFixed(2)} of shared cash at the end of ${monthLabel(addMonths(from, -1))}. The new method has no shared cash, so return it to members (Returned to member) or record the remaining expenses first.`
        : `Bazar is ৳${(-cashBefore / 100).toFixed(2)} short at the end of ${monthLabel(addMonths(from, -1))}. The new method has no shared cash, so collect the shortfall (Contribution) first.`,
    )
  }
  void now
  return {
    from,
    firstOpenMonth,
    problems,
    cashBefore,
    balances: before.members.filter((m) => m.closing !== 0).map((m) => ({ memberId: m.memberId, before: m.closing, after: m.closing })),
    cashEntryMonths,
  }
}

/** A good default start month: the current month if allowed, else the first month that would be allowed. */
export async function suggestBazarSwitchMonth(database: MessDb = defaultDb, now = Date.now()): Promise<string> {
  const { transactions, closings } = await bazarData(database)
  const lastClosed = [...activeClosings('bazar', closings).keys()].sort().pop()
  const lastCash = transactions.filter((t) => t.deletedAt === undefined && !isMemberPaidType(t.type)).map((t) => t.month).sort().pop()
  const candidates = [currentMonth(new Date(now)), lastClosed ? addMonths(lastClosed, 1) : null, lastCash ? addMonths(lastCash, 1) : null].filter((m): m is string => !!m)
  return candidates.sort().pop()!
}

export async function applyBazarSwitch(from: string, database: MessDb = defaultDb, now = Date.now()): Promise<BazarMethod> {
  return database.transaction('rw', [database.meta, database.audit, database.transactions, database.closings, database.members], async () => {
    const plan = await planBazarSwitch(from, database, now)
    if (plan.problems.length) throw new BazarMethodError(plan.problems[0])
    const method: BazarMethod = { memberPaidFrom: from }
    await database.meta.put({ key: BAZAR_METHOD_KEY, value: method })
    await database.audit.add({ at: now, action: 'bazar-method', txId: 'bazar-method', ledger: 'bazar', note: JSON.stringify({ memberPaidFrom: from }) })
    return method
  })
}

/** Why the switch cannot be undone, or null. */
export async function bazarSwitchUndoProblem(database: MessDb = defaultDb): Promise<string | null> {
  const method = await loadBazarMethod(database)
  if (!method) return 'Bazar uses the cash method.'
  const { transactions, closings } = await bazarData(database)
  if (transactions.some((t) => isMemberPaidType(t.type))) return 'Member-paid Bazar entries exist (including deleted ones), so the switch is kept.'
  if ([...activeClosings('bazar', closings).keys()].some((m) => m >= method.memberPaidFrom)) return 'A member-paid Bazar month is already closed, so the switch is kept.'
  return null
}

export async function undoBazarSwitch(database: MessDb = defaultDb, now = Date.now()): Promise<void> {
  await database.transaction('rw', [database.meta, database.audit, database.transactions, database.closings, database.members], async () => {
    const problem = await bazarSwitchUndoProblem(database)
    if (problem) throw new BazarMethodError(problem)
    const method = await loadBazarMethod(database)
    await database.meta.delete(BAZAR_METHOD_KEY)
    await database.audit.add({ at: now, action: 'bazar-method', txId: 'bazar-method', ledger: 'bazar', note: JSON.stringify({ undone: method }) })
  })
}
