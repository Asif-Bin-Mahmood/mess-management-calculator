import { computeLedgerMonth, openingFromClosing, type MonthOpening, type MonthSummary, type Reconciliation } from '../domain/ledger'
import { formatTaka } from '../domain/money'
import { monthLabel } from '../domain/month'
import type { Roster } from '../domain/household'
import { categoryName, isMemberTx, ledgerName, memberName, type LedgerId, type MemberId, type MonthClosing, type Transaction } from '../domain/types'

export interface Report {
  ledger: LedgerId
  ledgerName: string
  month: string
  monthLabel: string
  generatedAt: Date
  summary: MonthSummary
  /** Non-deleted transactions of this ledger and month, oldest first. */
  transactions: Transaction[]
  /** Opening of the next month as set by this month's closing (null while the month is not closed). */
  nextOpening: MonthOpening | null
  /** Issues worth flagging (same rules as the dashboard). */
  alerts: DashboardAlert[]
}

/**
 * Builds a single-ledger monthly report. Only `ledger`'s transactions and closings are read; the inputs
 * are not modified.
 */
export function buildReport(
  ledger: LedgerId,
  roster: Roster,
  month: string,
  all: readonly Transaction[],
  closings: readonly MonthClosing[] = [],
  generatedAt = new Date(),
): Report {
  const own = all.filter((t) => t.ledger === ledger)
  const ownClosings = closings.filter((c) => c.ledger === ledger)
  const summary = computeLedgerMonth(ledger, roster, own, month, ownClosings)
  return {
    ledger,
    ledgerName: ledgerName(ledger),
    month,
    monthLabel: monthLabel(month),
    generatedAt,
    summary,
    transactions: own
      .filter((t) => t.month === month && t.deletedAt === undefined)
      .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt),
    nextOpening: summary.closing ? openingFromClosing(summary, summary.closing).opening : null,
    alerts: dashboardAlerts(summary),
  }
}

export type BalanceStatus = 'due' | 'receivable' | 'settled'

export function balanceStatus(closing: number): BalanceStatus {
  return closing < 0 ? 'due' : closing > 0 ? 'receivable' : 'settled'
}

export function balanceLabel(closing: number): string {
  const s = balanceStatus(closing)
  if (s === 'settled') return 'Settled'
  return `${s === 'due' ? 'Due' : 'Will receive'} ${formatTaka(Math.abs(closing), { decimals: 'always' })}`
}

/** Which members received the leftover poisha of the expense split, in allocation order. */
export function roundingNote(summary: MonthSummary): string {
  // Only members sharing the month have a share (a former member shown for a balance has none).
  const sharing = summary.members.filter((m) => summary.sharers.includes(m.memberId))
  if (sharing.length === 0) return 'Nobody shares this month’s expenses.'
  const min = Math.min(...sharing.map((m) => m.share))
  const extra = sharing.filter((m) => m.share > min).map((m) => memberName(m.memberId))
  if (extra.length === 0) return `Expense split equally: ${formatTaka(min, { decimals: 'always' })} each.`
  return `Expense split ${formatTaka(min, { decimals: 'always' })} each; the leftover ${extra.length} poisha went one each to ${extra.join(', ')} (rotating by month) so shares add up exactly.`
}

export function txTitle(t: Transaction): string {
  if (isMemberTx(t.type)) return t.type === 'contribution' ? `${memberName(t.memberId!)} · contribution` : `Returned to ${memberName(t.memberId!)}`
  if (!t.category) return t.type === 'expense' ? 'Bazar expense' : 'Bazar refund'
  return t.type === 'expense' ? categoryName(t.category) : `${categoryName(t.category)} · refund`
}

/** Signed effect on cash: money in is positive. */
export function txCashEffect(t: Transaction): number {
  return t.type === 'contribution' || t.type === 'expenseRefund' ? t.amount : -t.amount
}

export function memberRow(summary: MonthSummary, id: MemberId) {
  return summary.members.find((m) => m.memberId === id)
}

export function reportFileBase(r: Report): string {
  return `mess-${r.ledger}-${r.month}`
}

export interface ReconciliationLine {
  tone: 'ok' | 'review' | 'bad'
  text: string
}

/**
 * Wording for a reconciliation result. A cash difference left by a correction to a closed month is
 * reported separately from a difference with no known cause; neither is ever reported as reconciled.
 */
export function reconciliationLines(rec: Reconciliation): ReconciliationLine[] {
  const t = (p: number) => formatTaka(p, { decimals: 'always' })
  if (rec.status === 'balanced') return [{ tone: 'ok', text: '✓ Balanced — member balances equal the cash held.' }]
  if (rec.status === 'explained') {
    return [{ tone: 'ok', text: `✓ Reconciled — the ${t(rec.difference)} difference comes from recorded closing adjustments, not missing cash.` }]
  }
  const lines: ReconciliationLine[] = []
  if (rec.correctionDifference !== 0) {
    lines.push({
      tone: 'review',
      text: `⚠ Unreconciled cash difference after historical correction — review required: ${t(rec.correctionDifference)}. A closed month was corrected after its opening cash was counted.`,
    })
  }
  if (rec.unknownDifference !== 0) {
    lines.push({ tone: 'bad', text: `✗ Unexplained difference of ${t(rec.unknownDifference)} — cause unknown, check the records.` })
  }
  return lines
}

export type AlertKind = 'cash-short' | 'correction-review' | 'correction-info' | 'unknown-difference'

export interface DashboardAlert {
  kind: AlertKind
  /** 'danger' and 'review' need action; 'info' is for awareness only. */
  tone: 'danger' | 'review' | 'info'
  title: string
  detail: string
}

const monthName = (month: string) => monthLabel(month).split(' ')[0]

/**
 * Short, plain-language alerts for one ledger month, in display order. Each issue appears once;
 * the full explanation lives in the details sheet. Never omits a shortage or an unresolved difference.
 */
export function dashboardAlerts(s: MonthSummary): DashboardAlert[] {
  const out: DashboardAlert[] = []
  const rec = s.reconciliation
  const o = s.opening
  if (s.remainingCash < 0) {
    out.push({ kind: 'cash-short', tone: 'danger', title: `Cash short by ${formatTaka(-s.remainingCash)}`, detail: 'Spent more than collected' })
  }
  if (rec.correctionDifference !== 0) {
    const prev = o.unappliedCashCorrection !== 0 ? `${monthName(o.closing!.sourceMonth)} cash` : 'Cash'
    out.push({
      kind: 'correction-review',
      tone: 'review',
      title: `${prev} needs review`,
      detail: `Correction after closing · ${formatTaka(Math.abs(rec.correctionDifference))} difference`,
    })
  } else if (o.sourceChangedSinceClosing && o.closing) {
    out.push({
      kind: 'correction-info',
      tone: 'info',
      title: `${monthName(o.closing.sourceMonth)} changed after closing`,
      detail: 'Balances updated for this month',
    })
  }
  if (rec.unknownDifference !== 0) {
    out.push({ kind: 'unknown-difference', tone: 'danger', title: 'Cash does not match records', detail: `${formatTaka(Math.abs(rec.unknownDifference))} unexplained` })
  }
  return out
}
