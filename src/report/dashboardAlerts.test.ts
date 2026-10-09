import { describe, expect, it } from 'vitest'
import { buildClosing, computeLedgerMonth, computeMonth, EMPTY_OPENING } from '../domain/ledger'
import { tx } from '../domain/testUtils'
import type { Transaction } from '../domain/types'
import { dashboardAlerts } from './reportModel'

// September Bazar: closes with cash ৳1,000; Asif +2000, Dipu +500, Yusha −500, Ovi −1000.
const sep: Transaction[] = [
  tx('bazar', 'contribution', 3000, '2026-09-01', { memberId: 'asif' }),
  tx('bazar', 'contribution', 1500, '2026-09-01', { memberId: 'dipu' }),
  tx('bazar', 'contribution', 500, '2026-09-02', { memberId: 'yusha' }),
  tx('bazar', 'expense', 4000, '2026-09-10'),
]
const late = tx('bazar', 'expense', 400, '2026-09-28')
const bigOct = tx('bazar', 'expense', 2510.75, '2026-10-05') // makes October cash short by ৳1,510.75
const counted = buildClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived', cashMode: 'set', openingCash: 1000_00 }, sep, [], 'cc', 1)
const carried = buildClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived', cashMode: 'carry' }, sep, [], 'cr', 1)

describe('dashboard alerts', () => {
  it('none when cash is positive and accounts match', () => {
    expect(dashboardAlerts(computeLedgerMonth('bazar', sep, '2026-09'))).toEqual([])
    expect(dashboardAlerts(computeLedgerMonth('bazar', sep, '2026-10', [carried]))).toEqual([])
  })

  it('cash short: one compact alert with the shortage amount', () => {
    const s = computeLedgerMonth('bazar', [...sep, bigOct], '2026-10', [carried])
    expect(s.remainingCash).toBe(-1510_75)
    expect(dashboardAlerts(s)).toEqual([{ kind: 'cash-short', tone: 'danger', title: 'Cash short by ৳1,510.75', detail: 'Spent more than collected' }])
  })

  it('historical correction with counted cash: separate review alert naming the month and the difference', () => {
    const alerts = dashboardAlerts(computeLedgerMonth('bazar', [...sep, late], '2026-10', [counted]))
    expect(alerts).toEqual([{ kind: 'correction-review', tone: 'review', title: 'September cash needs review', detail: 'Correction after closing · ৳400 difference' }])
  })

  it('both issues are shown, each once, shortage first', () => {
    const alerts = dashboardAlerts(computeLedgerMonth('bazar', [...sep, late, tx('bazar', 'expense', 2510.75, '2026-10-05')], '2026-10', [counted]))
    expect(alerts.map((a) => a.kind)).toEqual(['cash-short', 'correction-review'])
    expect(alerts[0].title).toBe('Cash short by ৳1,510.75')
  })

  it('correction with carried cash is information only, not a warning', () => {
    const alerts = dashboardAlerts(computeLedgerMonth('bazar', [...sep, late], '2026-10', [carried]))
    expect(alerts).toEqual([{ kind: 'correction-info', tone: 'info', title: 'September changed after closing', detail: 'Balances updated for this month' }])
  })

  it('the review alert persists in later months without a month name', () => {
    const alerts = dashboardAlerts(computeLedgerMonth('bazar', [...sep, late], '2026-11', [counted]))
    expect(alerts).toEqual([{ kind: 'correction-review', tone: 'review', title: 'Cash needs review', detail: 'Correction after closing · ৳400 difference' }])
  })

  it('an unexplained difference is always shown', () => {
    const s = computeMonth('bazar', '2026-09', { cash: 100_00, balances: EMPTY_OPENING.balances }, [])
    expect(dashboardAlerts(s)).toEqual([{ kind: 'unknown-difference', tone: 'danger', title: 'Cash does not match records', detail: '৳100 unexplained' }])
  })

  it('never hides an unresolved state: unbalanced months always get a non-info alert', () => {
    const cases = [
      computeLedgerMonth('bazar', [...sep, late], '2026-10', [counted]),
      computeLedgerMonth('bazar', [...sep, late], '2026-12', [counted]),
      computeMonth('bazar', '2026-10', EMPTY_OPENING, [], undefined, 0, null, -400_00),
    ]
    for (const s of cases) {
      expect(s.reconciliation.balanced).toBe(false)
      expect(dashboardAlerts(s).some((a) => a.tone !== 'info')).toBe(true)
    }
  })

  it('Bazar alerts never appear in Utilities', () => {
    const util = [tx('utilities', 'contribution', 1000, '2026-09-01', { memberId: 'asif' }), tx('utilities', 'expense', 400, '2026-09-05', { category: 'gas' })]
    const all = [...sep, late, bigOct, ...util]
    expect(dashboardAlerts(computeLedgerMonth('bazar', all, '2026-10', [counted])).length).toBe(2)
    expect(dashboardAlerts(computeLedgerMonth('utilities', all, '2026-10', [counted]))).toEqual([])
  })
})
