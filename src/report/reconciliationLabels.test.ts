import { describe, expect, it } from 'vitest'
import { buildClosing, computeLedgerMonth, computeMonth, EMPTY_OPENING } from '../domain/ledger'
import { tx } from '../domain/testUtils'
import type { Transaction } from '../domain/types'
import { layoutReport } from './render'
import { buildReport, reconciliationLines } from './reportModel'

const REVIEW = 'Unreconciled cash difference after historical correction — review required'

// September Bazar closes with cash ৳1,000; Asif +2000, Dipu +500, Yusha −500, Ovi −1000.
const sep: Transaction[] = [
  tx('bazar', 'contribution', 3000, '2026-09-01', { memberId: 'asif' }),
  tx('bazar', 'contribution', 1500, '2026-09-01', { memberId: 'dipu' }),
  tx('bazar', 'contribution', 500, '2026-09-02', { memberId: 'yusha' }),
  tx('bazar', 'expense', 4000, '2026-09-10'),
]
const lateExpense = tx('bazar', 'expense', 400, '2026-09-28', { description: 'forgotten receipt' })
const counted = buildClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived', cashMode: 'set', openingCash: 1000_00 }, sep, [], 'cc', 1)
const carried = buildClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived', cashMode: 'carry' }, sep, [], 'cc', 1)

const texts = (lines: { text: string }[]) => lines.map((l) => l.text).join('\n')

function fakeCanvas(w: number, h: number) {
  const out: string[] = []
  const ctx = {
    set font(_f: string) {},
    fillStyle: '',
    textAlign: '',
    textBaseline: '',
    fillRect() {},
    beginPath() {},
    roundRect() {},
    fill() {},
    fillText(s: string) {
      out.push(s)
    },
    measureText(s: string) {
      return { width: s.length * 11 }
    },
  }
  return { width: w, height: h, out, getContext: () => ctx as unknown as CanvasRenderingContext2D }
}

describe('reconciliation status and wording', () => {
  it('balanced: no difference at all', () => {
    const r = computeLedgerMonth('bazar', sep, '2026-10').reconciliation
    expect(r).toMatchObject({ status: 'balanced', balanced: true, unexplained: 0, correctionDifference: 0, unknownDifference: 0 })
    expect(reconciliationLines(r)).toEqual([{ tone: 'ok', text: '✓ Balanced — member balances equal the cash held.' }])
  })

  it('explained: the difference comes only from recorded closing adjustments', () => {
    const r = computeLedgerMonth('bazar', sep, '2026-10', [carried]).reconciliation
    expect(r).toMatchObject({ status: 'explained', balanced: true, difference: -1000_00, unexplained: 0 })
    expect(texts(reconciliationLines(r))).toContain('✓ Reconciled')
  })

  it('review: a correction to a closed month with counted cash is flagged, never shown as reconciled', () => {
    const r = computeLedgerMonth('bazar', [...sep, lateExpense], '2026-10', [counted]).reconciliation
    expect(r).toMatchObject({ status: 'review', balanced: false, unexplained: -400_00, correctionDifference: -400_00, unknownDifference: 0 })
    const lines = reconciliationLines(r)
    expect(lines).toHaveLength(1)
    expect(lines[0].tone).toBe('review')
    expect(lines[0].text).toContain(REVIEW)
    expect(lines[0].text).toContain('−৳400.00')
    expect(texts(lines)).not.toMatch(/✓|Reconciled|Balanced|cause unknown/)
  })

  it('review: carried cash follows the correction, so nothing is left to review', () => {
    const r = computeLedgerMonth('bazar', [...sep, lateExpense], '2026-10', [carried]).reconciliation
    expect(r.status).toBe('explained')
    expect(r.correctionDifference).toBe(0)
  })

  it('review: the flag persists into later months until resolved, without changing cash', () => {
    const later = [...sep, lateExpense, tx('bazar', 'contribution', 100, '2026-11-02', { memberId: 'ovi' })]
    const nov = computeLedgerMonth('bazar', later, '2026-11', [counted])
    expect(nov.reconciliation).toMatchObject({ status: 'review', correctionDifference: -400_00, unknownDifference: 0 })
    expect(nov.openingCash).toBe(1000_00) // counted cash carried, not auto-adjusted
    expect(nov.remainingCash).toBe(1100_00)
  })

  it('review is cleared only by resolving the cause (removing the entry or undoing the closing)', () => {
    const fixed = [...sep, { ...lateExpense, deletedAt: 5 }]
    expect(computeLedgerMonth('bazar', fixed, '2026-10', [counted]).reconciliation.status).toBe('explained')
    const undone = { ...counted, undoneAt: 5 }
    expect(computeLedgerMonth('bazar', [...sep, lateExpense], '2026-10', [undone]).reconciliation.status).toBe('balanced')
  })

  it('unknown: a difference with no recorded cause is reported as unknown', () => {
    const r = computeMonth('bazar', '2026-09', { cash: 100_00, balances: EMPTY_OPENING.balances }, []).reconciliation
    expect(r).toMatchObject({ status: 'unknown', balanced: false, unknownDifference: -100_00, correctionDifference: 0 })
    const lines = reconciliationLines(r)
    expect(lines).toEqual([{ tone: 'bad', text: '✗ Unexplained difference of −৳100.00 — cause unknown, check the records.' }])
    expect(texts(lines)).not.toContain('historical correction')
  })

  it('a correction difference and an unknown one are both shown even if they cancel out', () => {
    // correctionBefore −400 with a zero total difference: unknown part +400.
    const r = computeMonth('bazar', '2026-10', EMPTY_OPENING, [], undefined, 0, null, -400_00).reconciliation
    expect(r.unexplained).toBe(0)
    expect(r).toMatchObject({ status: 'unknown', balanced: false, correctionDifference: -400_00, unknownDifference: 400_00 })
    const lines = reconciliationLines(r)
    expect(lines.map((l) => l.tone)).toEqual(['review', 'bad'])
  })

  it('the concise report flags the review with its amount and makes no reconciled claim', () => {
    const r = buildReport('bazar', '2026-10', [...sep, lateExpense], [counted])
    const text = layoutReport(r, fakeCanvas, true).flatMap((p) => p.out).join(' ')
    expect(text).toContain('Attention: September cash needs review — correction after closing · ৳400 difference.')
    expect(text).not.toMatch(/Reconciled|Balanced|✓/)
    // The full wording remains available in the app's details view.
    expect(reconciliationLines(r.summary.reconciliation)[0].text).toContain(REVIEW)
  })

  it('a Bazar review state never affects Utilities, and vice versa', () => {
    const util = [tx('utilities', 'contribution', 1000, '2026-09-01', { memberId: 'asif' }), tx('utilities', 'expense', 400, '2026-09-05', { category: 'gas' })]
    const all = [...sep, lateExpense, ...util]
    expect(computeLedgerMonth('bazar', all, '2026-10', [counted]).reconciliation.status).toBe('review')
    expect(computeLedgerMonth('utilities', all, '2026-10', [counted]).reconciliation.status).toBe('balanced')
    const cu = buildClosing({ ledger: 'utilities', sourceMonth: '2026-09', method: 'manual', cashMode: 'set', openingCash: 600_00, openingBalances: { asif: 900_00, dipu: -100_00, yusha: -100_00, ovi: -100_00 } }, util, [], 'cu', 2)
    const utilLate = [...all, tx('utilities', 'expense', 200, '2026-09-29', { category: 'others' })]
    expect(computeLedgerMonth('utilities', utilLate, '2026-10', [counted, cu]).reconciliation).toMatchObject({ status: 'review', correctionDifference: -200_00 })
    expect(computeLedgerMonth('bazar', utilLate, '2026-10', [counted, cu]).reconciliation).toMatchObject({ status: 'review', correctionDifference: -400_00 })
  })
})
