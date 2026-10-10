/**
 * Accounting engine. Pure functions only: no React, no IndexedDB.
 * All amounts are integer poisha. See docs/SPEC.md for the rules.
 *
 * Two quantities are tracked separately per ledger:
 * - cash held by the manager:  openingCash + collected − spent
 * - member balances:           opening + net contribution − expense share  (positive = will receive, negative = due)
 * Within a month both change by the same amounts, so (Σ member balances − cash) only changes at a month
 * boundary, when a closing decision sets the next month's openings. Those changes are recorded as explicit
 * opening adjustments; reconciliation reports any difference the recorded adjustments do not explain.
 */
import { bySeq, firstDifferentMonth, sharers, type CategoryId, type MemberId, type Roster } from './household'
import { addMonths, monthIndex, monthLabel, monthRange } from './month'
import type { LedgerId, MemberMap, MonthClosing, Poisha, Transaction } from './types'

export type { MemberMap } from './types'

export interface MonthOpening {
  cash: Poisha
  balances: MemberMap
}

/** Where a month's opening figures came from. */
export interface OpeningInfo {
  /** 'start' = first month of the ledger (all zero); 'carry' = previous month not closed, provisional carry-forward;
   *  'closing' = set by an explicit closing decision of the previous month. */
  source: 'start' | 'carry' | 'closing'
  closing: MonthClosing | null
  /** Non-cash member adjustment recorded when the previous month was closed (settlement, waiver or verified
   *  adjustment). Fixed at closing time; never recalculated when old transactions change. */
  memberAdjustments: MemberMap
  /** Cash count adjustment recorded at closing (counted cash − closing cash at that time). Fixed. */
  cashAdjustment: Poisha
  /** Opening member balances as decided at closing (A: closing balances then; B: 0; C: verified values). */
  decidedBalances: MemberMap
  /** Opening cash as decided at closing (closing cash then, or the counted cash). */
  decidedCash: Poisha
  /** Changes to the previous month's closing balances made after it was closed (current − recorded).
   *  They are carried into this month on top of the decided opening. */
  memberCorrections: MemberMap
  /** Change to the previous month's closing cash after it was closed (current − recorded). */
  cashCorrection: Poisha
  /** Part of cashCorrection that is not applied because counted opening cash is preserved. It appears in
   *  reconciliation as an unexplained difference until the manager resolves it. */
  unappliedCashCorrection: Poisha
  /** True when the previous month's figures changed after the closing was confirmed. */
  sourceChangedSinceClosing: boolean
}

export interface MemberSummary {
  memberId: MemberId
  opening: Poisha
  contributed: Poisha
  returned: Poisha
  netContribution: Poisha
  share: Poisha
  closing: Poisha
}

export interface Reconciliation {
  openingBalanceSum: Poisha
  closingBalanceSum: Poisha
  remainingCash: Poisha
  /** Σ closing member balances − closing cash. Zero unless settlements/waivers/adjustments were recorded. */
  difference: Poisha
  /** Part of `difference` explained by recorded opening adjustments (cumulative over the ledger's history). */
  explainedDifference: Poisha
  /** difference − explainedDifference; non-zero means the figures do not add up. */
  unexplained: Poisha
  /** Part of `unexplained` caused by corrections to closed months whose counted opening cash was kept
   *  (cumulative). The cause is known, but it is still unreconciled and needs review. */
  correctionDifference: Poisha
  /** unexplained − correctionDifference: a difference with no known cause. */
  unknownDifference: Poisha
  /**
   * 'balanced'   — member balances equal cash;
   * 'explained'  — the difference is fully explained by recorded closing adjustments;
   * 'review'     — unreconciled cash difference after a historical correction (and nothing else);
   * 'unknown'    — a difference whose cause is unknown (possibly alongside a correction difference).
   */
  status: 'balanced' | 'explained' | 'review' | 'unknown'
  /** True only when status is 'balanced' or 'explained' (nothing unreconciled). */
  balanced: boolean
}

export interface MonthSummary {
  ledger: LedgerId
  month: string
  openingCash: Poisha
  opening: OpeningInfo
  contributionsGross: Poisha
  memberRefunds: Poisha
  totalCollected: Poisha
  expensesGross: Poisha
  expenseRefunds: Poisha
  totalSpent: Poisha
  remainingCash: Poisha
  /** totalSpent / number of members sharing the month, rounded half away from zero (display only). */
  averagePerPerson: Poisha
  /** Members sharing this month's expenses, in rounding order. */
  sharers: MemberId[]
  /** Spending that could not be shared because nobody shares the month (shows as unreconciled). */
  unallocatedSpend: Poisha
  /**
   * Rows shown for the month, in roster order: members who share it, plus anyone with a balance carried in or
   * an entry this month (e.g. a member who left and still has a balance). A row's share is 0 if not sharing.
   */
  members: MemberSummary[]
  /** Net spend per category used this month; utilities only (null for bazar). Missing category = 0. */
  categoryTotals: Record<CategoryId, Poisha> | null
  reconciliation: Reconciliation
  transactionCount: number
  /** Active closing decision for this month (this month as source), if any. */
  closing: MonthClosing | null
}

/** An empty member map (a missing member counts as 0). */
export function zeroMembers(): MemberMap {
  return {}
}

export function amountOf(map: MemberMap | undefined, id: MemberId): Poisha {
  return map?.[id] ?? 0
}

function keysOf(...maps: (MemberMap | undefined)[]): Set<MemberId> {
  const out = new Set<MemberId>()
  for (const m of maps) if (m) for (const k of Object.keys(m)) out.add(k)
  return out
}

/** Member ids in roster order (unknown ids, which only damaged data could contain, last by id). */
export function inRosterOrder(roster: Roster, ids: Iterable<MemberId>): MemberId[] {
  const seq = new Map(roster.map((m) => [m.id, m.seq]))
  return [...new Set(ids)].sort((a, b) => {
    const sa = seq.get(a)
    const sb = seq.get(b)
    if (sa !== undefined && sb !== undefined) return sa - sb
    if (sa !== undefined) return -1
    if (sb !== undefined) return 1
    return a < b ? -1 : a > b ? 1 : 0
  })
}

export const EMPTY_OPENING: MonthOpening = { cash: 0, balances: zeroMembers() }

const START_INFO: OpeningInfo = {
  source: 'start',
  closing: null,
  memberAdjustments: zeroMembers(),
  cashAdjustment: 0,
  decidedBalances: zeroMembers(),
  decidedCash: 0,
  memberCorrections: zeroMembers(),
  cashCorrection: 0,
  unappliedCashCorrection: 0,
  sourceChangedSinceClosing: false,
}

/**
 * Splits `total` poisha equally among the n sharing members (given in rounding order) so the shares sum exactly
 * to `total`: base = floor(total / n); the 0…n−1 leftover poisha go one each to consecutive members starting at
 * position (monthIndex mod n), so the extra poisha rotate from month to month. Deterministic.
 * With no sharers nothing is allocated (the caller reports the amount as unallocated).
 */
export function allocateShares(total: Poisha, month: string, sharerIds: readonly MemberId[]): MemberMap {
  if (!Number.isSafeInteger(total)) throw new Error('total must be an integer number of poisha')
  const n = sharerIds.length
  const shares = zeroMembers()
  if (n === 0) return shares
  const base = Math.floor(total / n)
  const remainder = total - base * n
  const start = ((monthIndex(month) % n) + n) % n
  sharerIds.forEach((id) => (shares[id] = base))
  for (let k = 0; k < remainder; k++) shares[sharerIds[(start + k) % n]] += 1
  return shares
}

function roundHalfAwayFromZero(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x))
}

function sum(xs: readonly number[]): number {
  let s = 0
  for (const x of xs) s += x
  return s
}

/**
 * Computes one month of one ledger from its opening state and that month's transactions.
 * `explainedBefore` is the cumulative explained difference at the start of the month.
 */
export function computeMonth(
  ledger: LedgerId,
  roster: Roster,
  month: string,
  opening: MonthOpening,
  transactions: readonly Transaction[],
  info: OpeningInfo = START_INFO,
  explainedBefore = 0,
  closing: MonthClosing | null = null,
  correctionBefore = 0,
): MonthSummary {
  const txs = transactions.filter((t) => t.ledger === ledger && t.month === month && t.deletedAt === undefined)
  const contributed = zeroMembers()
  const returned = zeroMembers()
  let expensesGross = 0
  let expenseRefunds = 0
  const categoryTotals: Record<CategoryId, Poisha> | null = ledger === 'utilities' ? {} : null
  const addCat = (c: CategoryId, v: Poisha) => {
    if (categoryTotals) categoryTotals[c] = (categoryTotals[c] ?? 0) + v
  }

  for (const t of txs) {
    switch (t.type) {
      case 'contribution':
        contributed[t.memberId!] = amountOf(contributed, t.memberId!) + t.amount
        break
      case 'memberRefund':
        returned[t.memberId!] = amountOf(returned, t.memberId!) + t.amount
        break
      case 'expense':
        expensesGross += t.amount
        if (t.category) addCat(t.category, t.amount)
        break
      case 'expenseRefund':
        expenseRefunds += t.amount
        if (t.category) addCat(t.category, -t.amount)
        break
    }
  }

  const contributionsGross = sum(Object.values(contributed))
  const memberRefunds = sum(Object.values(returned))
  const totalCollected = contributionsGross - memberRefunds
  const totalSpent = expensesGross - expenseRefunds
  const remainingCash = opening.cash + totalCollected - totalSpent
  const sharing = sharers(roster, month).map((m) => m.id)
  const shares = allocateShares(totalSpent, month, sharing)
  const unallocatedSpend = sharing.length === 0 ? totalSpent : 0

  const rowIds = inRosterOrder(roster, [
    ...sharing,
    ...[...keysOf(opening.balances)].filter((id) => opening.balances[id] !== 0),
    ...keysOf(contributed, returned),
  ])
  const members: MemberSummary[] = rowIds.map((id) => {
    const netContribution = amountOf(contributed, id) - amountOf(returned, id)
    const share = amountOf(shares, id)
    return {
      memberId: id,
      opening: amountOf(opening.balances, id),
      contributed: amountOf(contributed, id),
      returned: amountOf(returned, id),
      netContribution,
      share,
      closing: amountOf(opening.balances, id) + netContribution - share,
    }
  })

  const closingBalanceSum = sum(members.map((m) => m.closing))
  const openingBalanceSum = sum(Object.values(opening.balances))
  const difference = closingBalanceSum - remainingCash
  const unexplained = difference - explainedBefore
  const unknownDifference = unexplained - correctionBefore
  // Judge each part on its own so a correction difference and an unknown one can never cancel out unseen.
  const status: Reconciliation['status'] =
    unknownDifference !== 0 ? 'unknown' : correctionBefore !== 0 ? 'review' : difference !== 0 ? 'explained' : 'balanced'

  return {
    ledger,
    month,
    openingCash: opening.cash,
    opening: info,
    contributionsGross,
    memberRefunds,
    totalCollected,
    expensesGross,
    expenseRefunds,
    totalSpent,
    remainingCash,
    averagePerPerson: sharing.length ? roundHalfAwayFromZero(totalSpent / sharing.length) : 0,
    sharers: sharing,
    unallocatedSpend,
    members,
    categoryTotals,
    reconciliation: {
      openingBalanceSum,
      closingBalanceSum,
      remainingCash,
      difference,
      explainedDifference: explainedBefore,
      unexplained,
      correctionDifference: correctionBefore,
      unknownDifference,
      status,
      balanced: status === 'balanced' || status === 'explained',
    },
    transactionCount: txs.length,
    closing,
  }
}

export function closingAsOpening(s: MonthSummary): MonthOpening {
  const balances = zeroMembers()
  for (const m of s.members) balances[m.memberId] = m.closing
  return { cash: s.remainingCash, balances }
}

/** Opening member balances and cash as decided by a closing, relative to its snapshot. */
export function decidedOpening(closing: MonthClosing): MonthOpening {
  const snap = closing.snapshot
  const balances = zeroMembers()
  for (const id of keysOf(snap.closingBalances, closing.method === 'manual' ? closing.openingBalances : undefined)) {
    balances[id] =
      closing.method === 'carry' ? amountOf(snap.closingBalances, id) : closing.method === 'settled' ? 0 : amountOf(closing.openingBalances, id)
  }
  const cash = closing.method !== 'carry' && closing.cashMode === 'set' ? (closing.openingCash ?? 0) : snap.closingCash
  return { cash, balances }
}

/**
 * Adjustments a closing records: decided opening − closing figures at the time of closing (snapshot).
 * Stored on the record since this rule was introduced; derived identically for older records.
 */
export function closingAdjustments(closing: MonthClosing): { members: MemberMap; cash: Poisha } {
  if (closing.adjustments) return { members: { ...closing.adjustments.members }, cash: closing.adjustments.cash }
  const d = decidedOpening(closing)
  const members = zeroMembers()
  for (const id of keysOf(d.balances, closing.snapshot.closingBalances)) {
    members[id] = amountOf(d.balances, id) - amountOf(closing.snapshot.closingBalances, id)
  }
  return { members, cash: d.cash - closing.snapshot.closingCash }
}

/**
 * Next month's opening state from a month's summary and its (optional) closing decision.
 * Without a closing, balances and cash carry forward provisionally.
 *
 * With a closing, the recorded adjustment is applied to the *current* closing figures, so a later
 * correction to the closed month is carried forward instead of being absorbed into the settlement:
 *   member opening = current closing + recorded adjustment  (= decided opening + correction)
 *   opening cash   = counted cash (preserved) or current closing cash (carried)
 */
export function openingFromClosing(prev: MonthSummary, closing: MonthClosing | null): { opening: MonthOpening; info: OpeningInfo } {
  const carried = closingAsOpening(prev)
  if (!closing) {
    return {
      opening: carried,
      info: { ...START_INFO, source: 'carry', decidedBalances: { ...carried.balances }, decidedCash: carried.cash },
    }
  }
  const snap = closing.snapshot
  const adj = closingAdjustments(closing)
  const decided = decidedOpening(closing)
  const corrections = zeroMembers()
  const balances = zeroMembers()
  for (const id of keysOf(carried.balances, snap.closingBalances)) corrections[id] = amountOf(carried.balances, id) - amountOf(snap.closingBalances, id)
  for (const id of keysOf(carried.balances, adj.members)) balances[id] = amountOf(carried.balances, id) + amountOf(adj.members, id)
  const cashCorrection = carried.cash - snap.closingCash
  const countedCash = closing.method !== 'carry' && closing.cashMode === 'set'
  const cash = countedCash ? decided.cash : carried.cash
  return {
    opening: { cash, balances },
    info: {
      source: 'closing',
      closing,
      memberAdjustments: adj.members,
      cashAdjustment: adj.cash,
      decidedBalances: decided.balances,
      decidedCash: decided.cash,
      memberCorrections: corrections,
      cashCorrection,
      unappliedCashCorrection: countedCash ? cashCorrection : 0,
      sourceChangedSinceClosing: cashCorrection !== 0 || Object.values(corrections).some((v) => v !== 0),
    },
  }
}

/** Active (not undone) closings of one ledger, keyed by source month. */
export function activeClosings(ledger: LedgerId, closings: readonly MonthClosing[]): Map<string, MonthClosing> {
  const map = new Map<string, MonthClosing>()
  for (const c of closings) {
    if (c.ledger !== ledger || c.undoneAt !== undefined) continue
    const existing = map.get(c.sourceMonth)
    // Duplicates cannot be created through the app; if imported data had them, the earliest one wins.
    if (!existing || c.createdAt < existing.createdAt) map.set(c.sourceMonth, c)
  }
  return map
}

/** Earliest month that has a (non-deleted) transaction in this ledger, or null. */
export function firstMonth(ledger: LedgerId, transactions: readonly Transaction[]): string | null {
  let first: string | null = null
  for (const t of transactions) {
    if (t.ledger !== ledger || t.deletedAt !== undefined) continue
    if (first === null || t.month < first) first = t.month
  }
  return first
}

/** Latest month that has a (non-deleted) transaction in this ledger, or null. */
export function lastMonth(ledger: LedgerId, transactions: readonly Transaction[]): string | null {
  let last: string | null = null
  for (const t of transactions) {
    if (t.ledger !== ledger || t.deletedAt !== undefined) continue
    if (last === null || t.month > last) last = t.month
  }
  return last
}

/**
 * Computes every month of a ledger from its first month (first transaction or first closing) through
 * `untilMonth`, applying each month's closing decision (or provisional carry-forward) at the boundary.
 * Only this ledger's transactions and closings are used.
 */
export function computeHistory(
  ledger: LedgerId,
  roster: Roster,
  transactions: readonly Transaction[],
  untilMonth: string,
  closings: readonly MonthClosing[] = [],
): MonthSummary[] {
  const byMonth = new Map<string, Transaction[]>()
  for (const t of transactions) {
    if (t.ledger !== ledger || t.deletedAt !== undefined) continue
    const list = byMonth.get(t.month)
    if (list) list.push(t)
    else byMonth.set(t.month, [t])
  }
  const active = activeClosings(ledger, closings)
  let start = firstMonth(ledger, transactions)
  for (const m of active.keys()) if (start === null || m < start) start = m
  if (start === null || start > untilMonth) {
    return [computeMonth(ledger, roster, untilMonth, EMPTY_OPENING, [], START_INFO, 0, active.get(untilMonth) ?? null)]
  }

  const out: MonthSummary[] = []
  let opening = EMPTY_OPENING
  let info = START_INFO
  let explained = 0
  let corrected = 0
  for (const m of monthRange(start, untilMonth)) {
    explained += sum(Object.values(info.memberAdjustments)) - info.cashAdjustment
    corrected += info.unappliedCashCorrection
    const closing = active.get(m) ?? null
    const summary = computeMonth(ledger, roster, m, opening, byMonth.get(m) ?? [], info, explained, closing, corrected)
    out.push(summary)
    ;({ opening, info } = openingFromClosing(summary, closing))
  }
  return out
}

export function computeLedgerMonth(
  ledger: LedgerId,
  roster: Roster,
  transactions: readonly Transaction[],
  month: string,
  closings: readonly MonthClosing[] = [],
): MonthSummary {
  const history = computeHistory(ledger, roster, transactions, month, closings)
  return history[history.length - 1]
}

export interface MemberChange {
  memberId: MemberId
  before: Poisha
  after: Poisha
}

export interface ClosingEffectChange {
  sourceMonth: string
  closing: MonthClosing
  /** Closing figures of the closed month when it was closed (snapshot). */
  original: MonthOpening
  /** Closing figures of the closed month now, and after this change. */
  closingBefore: MonthOpening
  closingAfter: MonthOpening
  /** The adjustment recorded at closing (unchanged by corrections). */
  recordedAdjustments: { members: MemberMap; cash: Poisha }
  /** Next month's opening now and after this change. */
  openingBefore: MonthOpening
  openingAfter: MonthOpening
  /** Unexplained difference in the next month, now and after this change. */
  unexplainedBefore: Poisha
  unexplainedAfter: Poisha
}

export interface CorrectionImpact {
  ledger: LedgerId
  /** The earliest month whose figures change. */
  changedMonth: string
  /** Months after changedMonth (through horizon) whose opening balances get recalculated. */
  laterMonths: string[]
  horizon: string
  cashBefore: Poisha
  cashAfter: Poisha
  /** Closing balances at the horizon month, before and after the change. */
  members: MemberChange[]
  /** Closed months (from changedMonth on) whose recorded adjustments change. */
  closingEffects: ClosingEffectChange[]
  /** Closed months from changedMonth on (whether or not their adjustments change). */
  closedMonths: string[]
}

function latest(...ms: (string | null)[]): string {
  return ms.filter((m): m is string => m !== null).sort().pop()!
}

/**
 * Describes how a change to `changedMonth` ripples into later months. Returns null when no later
 * month exists in the chain (i.e. the change is in the latest month), meaning no confirmation is needed.
 * `horizon` is normally max(current month, latest transaction month).
 */
export function analyzeCorrection(
  ledger: LedgerId,
  roster: Roster,
  before: readonly Transaction[],
  after: readonly Transaction[],
  changedMonth: string,
  horizon: string,
  closings: readonly MonthClosing[] = [],
): CorrectionImpact | null {
  const active = activeClosings(ledger, closings)
  const lastClosingTarget = [...active.values()].map((c) => c.targetMonth).sort().pop() ?? null
  const end = latest(horizon, lastMonth(ledger, before), lastMonth(ledger, after), lastClosingTarget)
  if (changedMonth >= end) return null
  const hb = computeHistory(ledger, roster, before, end, closings)
  const ha = computeHistory(ledger, roster, after, end, closings)
  const b = hb[hb.length - 1]
  const a = ha[ha.length - 1]
  const byMonthA = new Map(ha.map((s) => [s.month, s]))
  const byMonthB = new Map(hb.map((s) => [s.month, s]))
  const closingEffects: ClosingEffectChange[] = []
  const closedMonths: string[] = []
  const openingOf = (x: MonthSummary): MonthOpening => ({
    cash: x.openingCash,
    balances: Object.fromEntries(x.members.map((m) => [m.memberId, m.opening])) as MemberMap,
  })
  for (const sb of hb) {
    const c = active.get(sb.month)
    if (!c || sb.month < changedMonth) continue
    closedMonths.push(sb.month)
    const sa = byMonthA.get(sb.month)
    const nb = byMonthB.get(c.targetMonth)
    const na = byMonthA.get(c.targetMonth)
    if (!sa || !nb || !na) continue
    closingEffects.push({
      sourceMonth: sb.month,
      closing: c,
      original: { cash: c.snapshot.closingCash, balances: { ...c.snapshot.closingBalances } },
      closingBefore: closingAsOpening(sb),
      closingAfter: closingAsOpening(sa),
      recordedAdjustments: closingAdjustments(c),
      openingBefore: openingOf(nb),
      openingAfter: openingOf(na),
      unexplainedBefore: nb.reconciliation.unexplained,
      unexplainedAfter: na.reconciliation.unexplained,
    })
  }
  return {
    ledger,
    changedMonth,
    laterMonths: monthRange(addMonths(changedMonth, 1), end),
    horizon: end,
    cashBefore: b.remainingCash,
    cashAfter: a.remainingCash,
    members: memberChanges(roster, b, a),
    closingEffects,
    closedMonths,
  }
}

/** Closing balance of every member shown in either summary, before and after (0 when not shown). */
export function memberChanges(roster: Roster, before: MonthSummary, after: MonthSummary): MemberChange[] {
  const b = new Map(before.members.map((m) => [m.memberId, m.closing]))
  const a = new Map(after.members.map((m) => [m.memberId, m.closing]))
  return inRosterOrder(roster, [...b.keys(), ...a.keys()]).map((id) => ({ memberId: id, before: b.get(id) ?? 0, after: a.get(id) ?? 0 }))
}

/* ───────────── Closing decisions ───────────── */

export interface ClosingInput {
  ledger: LedgerId
  sourceMonth: string
  method: 'carry' | 'settled' | 'manual'
  settlementKind?: 'settled' | 'waived'
  cashMode: 'carry' | 'set'
  openingCash?: Poisha
  openingBalances?: MemberMap
  note?: string
}

export type ClosingCheck = { ok: true } | { ok: false; reason: string; blockingMonth?: string; availableFrom?: string }

/**
 * Whether `sourceMonth` of `ledger` may be closed now. `currentMonth` is the device's local month.
 * A month can be closed only after it has ended, and closings must stay in month order.
 */
export function canClose(ledger: LedgerId, sourceMonth: string, closings: readonly MonthClosing[], currentMonth: string): ClosingCheck {
  if (sourceMonth >= currentMonth) {
    const from = `${addMonths(sourceMonth, 1)}-01`
    const fromLabel = `1 ${monthLabel(addMonths(sourceMonth, 1))}`
    return {
      ok: false,
      reason: `${monthLabel(sourceMonth)} can be closed once it has ended, from ${fromLabel}. Entries can still be added until then.`,
      availableFrom: from,
    }
  }
  const active = activeClosings(ledger, closings)
  if (active.has(sourceMonth)) return { ok: false, reason: 'This month is already closed. Undo that closing first to choose differently.' }
  const later = [...active.keys()].filter((m) => m > sourceMonth).sort()
  if (later.length) {
    return { ok: false, reason: 'A later month is already closed. Undo later closings first (newest first).', blockingMonth: later[later.length - 1] }
  }
  return { ok: true }
}

/** Builds the closing record for confirmation. Pure; validation is done by validateClosingInput. */
export function buildClosing(
  input: ClosingInput,
  roster: Roster,
  transactions: readonly Transaction[],
  closings: readonly MonthClosing[],
  id: string,
  now: number,
): MonthClosing {
  const source = computeLedgerMonth(input.ledger, roster, transactions, input.sourceMonth, closings)
  const balances = zeroMembers()
  for (const m of source.members) balances[m.memberId] = m.closing
  const sourceTxs = transactions.filter((t) => t.ledger === input.ledger && t.month === input.sourceMonth)
  const c: MonthClosing = {
    id,
    ledger: input.ledger,
    sourceMonth: input.sourceMonth,
    targetMonth: addMonths(input.sourceMonth, 1),
    method: input.method,
    cashMode: input.method === 'carry' ? 'carry' : input.method === 'manual' ? 'set' : input.cashMode,
    snapshot: {
      closingCash: source.remainingCash,
      closingBalances: balances,
      transactionCount: source.transactionCount,
      sourceUpdatedAt: sourceTxs.reduce((a, t) => Math.max(a, t.updatedAt), 0),
    },
    createdAt: now,
  }
  if (input.method === 'settled') c.settlementKind = input.settlementKind ?? 'settled'
  if (c.cashMode === 'set') c.openingCash = input.openingCash ?? 0
  if (input.method === 'manual') {
    // One verified opening balance for each member shown in the closed month (missing = 0).
    c.openingBalances = Object.fromEntries(source.members.map((m) => [m.memberId, amountOf(input.openingBalances, m.memberId)]))
  }
  const note = input.note?.trim()
  if (note) c.note = note
  c.adjustments = closingAdjustments(c)
  return c
}

export interface ClosingPreview {
  source: MonthSummary
  /** The target month as it will look with this closing applied. */
  target: MonthSummary
  /** Number of transactions already recorded in the target month and later. */
  laterTransactionCount: number
}

export function previewClosing(
  closing: MonthClosing,
  roster: Roster,
  transactions: readonly Transaction[],
  closings: readonly MonthClosing[],
): ClosingPreview {
  const all = [...closings, closing]
  const source = computeLedgerMonth(closing.ledger, roster, transactions, closing.sourceMonth, all)
  const target = computeLedgerMonth(closing.ledger, roster, transactions, closing.targetMonth, all)
  const laterTransactionCount = transactions.filter(
    (t) => t.ledger === closing.ledger && t.deletedAt === undefined && t.month >= closing.targetMonth,
  ).length
  return { source, target, laterTransactionCount }
}

export interface UndoAnalysis {
  closing: MonthClosing
  /** Non-empty when undo is unsafe: later closings that depend on this one (undo those first, newest first). */
  blockedBy: MonthClosing[]
  /** Transactions already recorded in the target month or later; they are kept but their balances shift. */
  dependentTransactionCount: number
  /** Opening of the target month with the closing (now) and after undo (provisional carry-forward). */
  openingNow: MonthOpening
  openingAfter: MonthOpening
  horizon: string
  /** Closing balances at the horizon, now and after undo. */
  members: MemberChange[]
  cashBefore: Poisha
  cashAfter: Poisha
}

export function analyzeUndo(
  closing: MonthClosing,
  roster: Roster,
  transactions: readonly Transaction[],
  closings: readonly MonthClosing[],
  horizon: string,
): UndoAnalysis {
  const ledger = closing.ledger
  const blockedBy = [...activeClosings(ledger, closings).values()]
    .filter((c) => c.sourceMonth > closing.sourceMonth)
    .sort((a, b) => b.sourceMonth.localeCompare(a.sourceMonth))
  const without = closings.map((c) => (c.id === closing.id ? { ...c, undoneAt: c.undoneAt ?? 0 } : c))
  const end = latest(horizon, closing.targetMonth, lastMonth(ledger, transactions))
  const nowTarget = computeLedgerMonth(ledger, roster, transactions, closing.targetMonth, closings)
  const afterTarget = computeLedgerMonth(ledger, roster, transactions, closing.targetMonth, without)
  const nowEnd = computeLedgerMonth(ledger, roster, transactions, end, closings)
  const afterEnd = computeLedgerMonth(ledger, roster, transactions, end, without)
  const openingOf = (s: MonthSummary): MonthOpening => {
    const balances = zeroMembers()
    for (const m of s.members) balances[m.memberId] = m.opening
    return { cash: s.openingCash, balances }
  }
  return {
    closing,
    blockedBy,
    dependentTransactionCount: transactions.filter(
      (t) => t.ledger === ledger && t.deletedAt === undefined && t.month >= closing.targetMonth,
    ).length,
    openingNow: openingOf(nowTarget),
    openingAfter: openingOf(afterTarget),
    horizon: end,
    members: memberChanges(roster, nowEnd, afterEnd),
    cashBefore: nowEnd.remainingCash,
    cashAfter: afterEnd.remainingCash,
  }
}

/* ───────────── Returned to member ───────────── */

export interface MemberReturnCheck {
  memberId: MemberId
  amount: Poisha
  month: string
  /** The member's balance for that month without this return (positive = will receive). */
  balanceBefore: Poisha
  balanceAfter: Poisha
  /** The ledger's closing cash for that month without this return. */
  cashBefore: Poisha
  cashAfter: Poisha
  /** The return is larger than what the member will receive. */
  exceedsBalance: boolean
  /** The ledger's cash would be negative after the return. */
  makesCashNegative: boolean
}

/**
 * Checks a cash return to a member (memberRefund) against that member's balance and the ledger's cash
 * for the month, using only this ledger's records. `excludeId` leaves out the entry being edited.
 * Purely informational: it never blocks or changes records.
 */
export function checkMemberReturn(
  ledger: LedgerId,
  roster: Roster,
  transactions: readonly Transaction[],
  closings: readonly MonthClosing[],
  ret: { memberId: MemberId; amount: Poisha; month: string },
  excludeId?: string,
): MemberReturnCheck {
  const others = transactions.filter((t) => t.ledger === ledger && t.id !== excludeId)
  const s = computeLedgerMonth(ledger, roster, others, ret.month, closings)
  const balanceBefore = s.members.find((m) => m.memberId === ret.memberId)?.closing ?? 0
  const cashBefore = s.remainingCash
  return {
    memberId: ret.memberId,
    amount: ret.amount,
    month: ret.month,
    balanceBefore,
    balanceAfter: balanceBefore - ret.amount,
    cashBefore,
    cashAfter: cashBefore - ret.amount,
    exceedsBalance: ret.amount > Math.max(balanceBefore, 0),
    makesCashNegative: cashBefore - ret.amount < 0,
  }
}

/* ───────── Month-closing status for the dashboard ───────── */

export type MonthClosingStatus =
  | { kind: 'closed'; closing: MonthClosing }
  /** The viewed month can be closed now. */
  | { kind: 'can-close'; month: string }
  /** The viewed month cannot be closed yet, but an earlier month can: offer that one. */
  | { kind: 'pending'; month: string }
  /** Nothing can be closed now; the viewed month becomes closable on `availableFrom` (YYYY-MM-DD). */
  | { kind: 'not-yet'; availableFrom: string }
  /** Closing this month is blocked (e.g. a later month is closed). */
  | { kind: 'blocked'; reason: string }

/**
 * The month the dashboard should offer to close: the previous calendar month, when this ledger has
 * entries (or closings) up to then, it is not closed yet, and closing it is allowed. Older unclosed months
 * remain provisional and can still be closed from their own month view.
 */
export function nextMonthToClose(ledger: LedgerId, transactions: readonly Transaction[], closings: readonly MonthClosing[], currentMonth: string): string | null {
  const prev = addMonths(currentMonth, -1)
  const active = activeClosings(ledger, closings)
  if (active.has(prev)) return null
  const first = firstMonth(ledger, transactions)
  const hasHistory = (first !== null && first <= prev) || [...active.keys()].some((m) => m < prev)
  if (!hasHistory) return null
  return canClose(ledger, prev, closings, currentMonth).ok ? prev : null
}

/** What the dashboard should offer for the viewed month. Uses only this ledger's records. */
export function monthClosingStatus(
  ledger: LedgerId,
  viewedMonth: string,
  transactions: readonly Transaction[],
  closings: readonly MonthClosing[],
  currentMonth: string,
): MonthClosingStatus {
  const closed = activeClosings(ledger, closings).get(viewedMonth)
  if (closed) return { kind: 'closed', closing: closed }
  const check = canClose(ledger, viewedMonth, closings, currentMonth)
  if (check.ok) return { kind: 'can-close', month: viewedMonth }
  const pending = nextMonthToClose(ledger, transactions, closings, currentMonth)
  if (pending && pending !== viewedMonth) return { kind: 'pending', month: pending }
  if (check.availableFrom) return { kind: 'not-yet', availableFrom: check.availableFrom }
  return { kind: 'blocked', reason: check.reason }
}

/* ───────────── Membership changes ───────────── */

/** Latest month closed (active closing) in either ledger, or null. Membership is household-wide. */
export function latestClosedMonth(closings: readonly MonthClosing[]): string | null {
  let last: string | null = null
  for (const ledger of ['utilities', 'bazar'] as const) {
    for (const m of activeClosings(ledger, closings).keys()) if (last === null || m > last) last = m
  }
  return last
}

/** First month whose sharing may still change: the month after the latest closed month (null = any month). */
export function firstOpenMonth(closings: readonly MonthClosing[]): string | null {
  const last = latestClosedMonth(closings)
  return last === null ? null : addMonths(last, 1)
}

export interface RosterLedgerImpact {
  ledger: LedgerId
  horizon: string
  /** Months whose member figures or cash change. */
  changedMonths: string[]
  /** Members whose balance at the horizon changes. */
  members: MemberChange[]
}

export interface RosterChangeImpact {
  /** Earliest month whose sharing changes ('' = from the very beginning), or null if sharing does not change. */
  firstChangedMonth: string | null
  /** Latest closed month when the change would alter who shares a closed month; such changes are refused. */
  blockedBy: string | null
  ledgers: RosterLedgerImpact[]
}

/**
 * Effect of replacing roster `before` by `after` on both ledgers (membership is household-wide).
 * A change that alters who shares a closed month is refused (blockedBy): closed months are never recalculated.
 */
export function analyzeRosterChange(
  before: Roster,
  after: Roster,
  transactions: readonly Transaction[],
  closings: readonly MonthClosing[],
  horizon: string,
): RosterChangeImpact {
  const ids = new Set([...before.map((m) => m.id), ...after.map((m) => m.id)])
  let first: string | null = null
  for (const id of ids) {
    const pb = before.find((m) => m.id === id)?.periods ?? []
    const pa = after.find((m) => m.id === id)?.periods ?? []
    const d = firstDifferentMonth(pb, pa, horizon)
    if (d !== null && (first === null || d < first)) first = d
  }
  const lastClosed = latestClosedMonth(closings)
  const blockedBy = first !== null && lastClosed !== null && first <= lastClosed ? lastClosed : null
  const ledgers: RosterLedgerImpact[] = []
  for (const ledger of ['utilities', 'bazar'] as const) {
    const end = latest(horizon, lastMonth(ledger, transactions))
    const hb = computeHistory(ledger, before, transactions, end, closings)
    const ha = computeHistory(ledger, after, transactions, end, closings)
    const byA = new Map(ha.map((x) => [x.month, x]))
    const changedMonths = hb
      .filter((x) => {
        const y = byA.get(x.month)
        if (!y) return true
        if (x.remainingCash !== y.remainingCash || x.averagePerPerson !== y.averagePerPerson) return true
        const shares = (s: MonthSummary) => JSON.stringify(s.members.map((m) => [m.memberId, m.share, m.closing]))
        return shares(x) !== shares(y)
      })
      .map((x) => x.month)
    ledgers.push({
      ledger,
      horizon: end,
      changedMonths,
      members: memberChanges(after, hb[hb.length - 1], ha[ha.length - 1]).filter((c) => c.before !== c.after),
    })
  }
  return { firstChangedMonth: first, blockedBy, ledgers }
}

/** Each member's balance per ledger at `month`, or at the ledger's latest month if later (positive = will receive). */
export function memberBalances(
  roster: Roster,
  transactions: readonly Transaction[],
  closings: readonly MonthClosing[],
  month: string,
): Record<LedgerId, MemberMap> {
  const out = { utilities: {}, bazar: {} } as Record<LedgerId, MemberMap>
  for (const ledger of ['utilities', 'bazar'] as const) {
    const end = latest(month, lastMonth(ledger, transactions))
    for (const m of computeLedgerMonth(ledger, roster, transactions, end, closings).members) out[ledger][m.memberId] = m.closing
  }
  return out
}

/** True when any transaction (including deleted ones) or closing refers to the member. */
export function memberIsReferenced(id: MemberId, transactions: readonly Transaction[], closings: readonly MonthClosing[]): boolean {
  if (transactions.some((t) => t.memberId === id)) return true
  return closings.some(
    (c) =>
      id in c.snapshot.closingBalances ||
      (c.openingBalances !== undefined && id in c.openingBalances) ||
      (c.adjustments !== undefined && id in c.adjustments.members),
  )
}

/** True when any transaction (including deleted ones) uses the category. */
export function categoryIsReferenced(id: CategoryId, transactions: readonly Transaction[]): boolean {
  return transactions.some((t) => t.category === id)
}

export { bySeq }
