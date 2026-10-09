/**
 * Regression tests: changing a transaction in a month that is already closed (audit item 1).
 * The adjustment recorded when the month was closed must not change; the correction itself must
 * flow into the next month (members) or show up as an unexplained cash difference (counted cash).
 */
import { describe, expect, it } from 'vitest'
import { analyzeCorrection, buildClosing, computeLedgerMonth, type ClosingInput, type MemberMap, type MonthSummary } from './ledger'
import { tx } from './testUtils'
import type { LedgerId, MonthClosing, Transaction } from './types'

const balances = (s: MonthSummary, key: 'opening' | 'closing') => Object.fromEntries(s.members.map((m) => [m.memberId, m[key]])) as MemberMap

function september(ledger: LedgerId): Transaction[] {
  const cat = ledger === 'utilities' ? { category: 'gas' as const } : {}
  return [
    tx(ledger, 'contribution', 3000, '2026-09-01', { memberId: 'asif' }),
    tx(ledger, 'contribution', 1500, '2026-09-01', { memberId: 'dipu' }),
    tx(ledger, 'contribution', 500, '2026-09-02', { memberId: 'yusha' }),
    tx(ledger, 'expense', 4000, '2026-09-10', cat),
  ]
}
// September closes at: asif +2000, dipu +500, yusha −500, ovi −1000; cash 1000.

const METHODS: Record<string, Omit<ClosingInput, 'ledger' | 'sourceMonth'>> = {
  'A carry': { method: 'carry', cashMode: 'carry' },
  'B settled, cash carried': { method: 'settled', settlementKind: 'settled', cashMode: 'carry' },
  'B waived, counted cash': { method: 'settled', settlementKind: 'waived', cashMode: 'set', openingCash: 1000_00 },
  'C verified': { method: 'manual', cashMode: 'set', openingCash: 950_00, openingBalances: { asif: 1800_00, dipu: 500_00, yusha: -400_00, ovi: -1000_00 } },
}

type Change = 'add' | 'edit' | 'delete'

/** Applies a late change to September: +400 expense (add), 4000→4400 (edit), or delete Yusha's ৳500. */
function lateChange(base: Transaction[], change: Change, ledger: LedgerId): Transaction[] {
  const cat = ledger === 'utilities' ? { category: 'others' as const } : {}
  if (change === 'add') return [...base, tx(ledger, 'expense', 400, '2026-09-28', cat)]
  if (change === 'edit') return base.map((t) => (t.type === 'expense' ? { ...t, amount: 4400_00, updatedAt: t.updatedAt + 1 } : t))
  return base.map((t) => (t.memberId === 'yusha' ? { ...t, deletedAt: 99 } : t))
}

// Per-member effect on September closing balances and cash, by change.
const EFFECT: Record<Change, { members: MemberMap; cash: number }> = {
  add: { members: { asif: -100_00, dipu: -100_00, yusha: -100_00, ovi: -100_00 }, cash: -400_00 },
  edit: { members: { asif: -100_00, dipu: -100_00, yusha: -100_00, ovi: -100_00 }, cash: -400_00 },
  delete: { members: { asif: 0, dipu: 0, yusha: -500_00, ovi: 0 }, cash: -500_00 },
}

for (const ledger of ['bazar', 'utilities'] as const) {
  describe(`${ledger}: late changes after closing September`, () => {
    for (const [name, m] of Object.entries(METHODS)) {
      for (const change of ['add', 'edit', 'delete'] as Change[]) {
        it(`${name} — ${change}`, () => {
          const base = september(ledger)
          const closing: MonthClosing = buildClosing({ ledger, sourceMonth: '2026-09', ...m }, base, [], 'c1', 1)
          const before = computeLedgerMonth(ledger, base, '2026-10', [closing])
          const recordedAdj = { ...before.opening.memberAdjustments }
          const recordedCashAdj = before.opening.cashAdjustment

          const changed = lateChange(base, change, ledger)
          const after = computeLedgerMonth(ledger, changed, '2026-10', [closing])
          const eff = EFFECT[change]

          // 1. The adjustment recorded at closing is never recalculated.
          expect(after.opening.memberAdjustments).toEqual(recordedAdj)
          expect(after.opening.cashAdjustment).toBe(recordedCashAdj)
          expect(closing.adjustments).toEqual({ members: recordedAdj, cash: recordedCashAdj })

          // 2. The correction flows into next month's member balances, shown separately.
          expect(after.opening.memberCorrections).toEqual(eff.members)
          expect(after.opening.sourceChangedSinceClosing).toBe(true)
          for (const id of ['asif', 'dipu', 'yusha', 'ovi'] as const) {
            expect(balances(after, 'opening')[id]).toBe(balances(before, 'opening')[id] + eff.members[id])
            // Decided opening (the settlement / verified values) is preserved.
            expect(after.opening.decidedBalances[id]).toBe(before.opening.decidedBalances[id])
          }

          // 3. Cash: carried cash follows the correction; counted cash is preserved and the gap is unexplained.
          if (closing.cashMode === 'set') {
            expect(after.openingCash).toBe(closing.openingCash)
            expect(after.opening.unappliedCashCorrection).toBe(eff.cash)
            expect(after.reconciliation.unexplained).toBe(eff.cash)
            expect(after.reconciliation.balanced).toBe(false)
          } else {
            expect(after.openingCash).toBe(before.openingCash + eff.cash)
            expect(after.opening.unappliedCashCorrection).toBe(0)
            expect(after.reconciliation.unexplained).toBe(0)
          }

          // 4. Nothing was invented: explained difference is still only the recorded adjustment.
          expect(after.reconciliation.explainedDifference).toBe(before.reconciliation.explainedDifference)
          // September itself shows the corrected figures; history of the closing snapshot is untouched.
          expect(closing.snapshot.closingCash).toBe(1000_00)
          expect(computeLedgerMonth(ledger, changed, '2026-09', [closing]).remainingCash).toBe(1000_00 + eff.cash)
        })
      }
    }
  })
}

describe('audit scenario figures', () => {
  const base = september('bazar')
  const late = [...base, tx('bazar', 'expense', 400, '2026-09-28')]

  it('B settled: Ovi’s recorded settlement stays ৳1,000 and the late ৳100 share is due in October', () => {
    const c = buildClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'settled', cashMode: 'carry' }, base, [], 'c', 1)
    const oct = computeLedgerMonth('bazar', late, '2026-10', [c])
    expect(oct.opening.memberAdjustments.ovi).toBe(1000_00)
    expect(balances(oct, 'opening')).toEqual({ asif: -100_00, dipu: -100_00, yusha: -100_00, ovi: -100_00 })
    expect(oct.openingCash).toBe(600_00)
    expect(oct.reconciliation).toMatchObject({ difference: -1000_00, explainedDifference: -1000_00, unexplained: 0 })
  })

  it('C verified: no +৳100 or +৳400 adjustment is invented', () => {
    const c = buildClosing(
      { ledger: 'bazar', sourceMonth: '2026-09', method: 'manual', cashMode: 'set', openingCash: 1000_00, openingBalances: { asif: 2000_00, dipu: 500_00, yusha: -500_00, ovi: -1000_00 } },
      base,
      [],
      'c',
      1,
    )
    const oct = computeLedgerMonth('bazar', late, '2026-10', [c])
    expect(Object.values(oct.opening.memberAdjustments)).toEqual([0, 0, 0, 0])
    expect(oct.opening.cashAdjustment).toBe(0)
    expect(balances(oct, 'opening')).toEqual({ asif: 1900_00, dipu: 400_00, yusha: -600_00, ovi: -1100_00 })
    expect(oct.openingCash).toBe(1000_00) // counted cash preserved
    expect(oct.reconciliation.unexplained).toBe(-400_00) // shown, not hidden
  })

  it('closings made before this fix (no stored adjustments) are read from their snapshot', () => {
    const c = buildClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived', cashMode: 'carry' }, base, [], 'c', 1)
    const legacy = { ...c } as MonthClosing
    delete legacy.adjustments
    // Compare the computed figures; the summaries embed the two (intentionally different) records.
    const figures = (s: MonthSummary) => ({ members: s.members, cash: s.openingCash, rec: s.reconciliation, info: { ...s.opening, closing: null } })
    expect(figures(computeLedgerMonth('bazar', late, '2026-10', [legacy]))).toEqual(figures(computeLedgerMonth('bazar', late, '2026-10', [c])))
  })

  it('the correction preview shows original, current and corrected figures', () => {
    const c = buildClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived', cashMode: 'set', openingCash: 1000_00 }, base, [], 'c', 1)
    const impact = analyzeCorrection('bazar', base, late, '2026-09', '2026-10', [c])!
    const e = impact.closingEffects[0]
    expect(e.sourceMonth).toBe('2026-09')
    expect(e.original.cash).toBe(1000_00)
    expect(e.original.balances.ovi).toBe(-1000_00)
    expect(e.closingAfter.balances.ovi).toBe(-1100_00)
    expect(e.closingAfter.cash).toBe(600_00)
    expect(e.recordedAdjustments.members.ovi).toBe(1000_00)
    expect(e.openingBefore.balances.ovi).toBe(0)
    expect(e.openingAfter.balances.ovi).toBe(-100_00)
    expect(e.openingAfter.cash).toBe(1000_00)
    expect(e.unexplainedBefore).toBe(0)
    expect(e.unexplainedAfter).toBe(-400_00)
  })

  it('a late change in Bazar never alters Utilities, and vice versa', () => {
    const util = september('utilities')
    const cu = buildClosing({ ledger: 'utilities', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived', cashMode: 'set', openingCash: 1000_00 }, util, [], 'cu', 1)
    const cb = buildClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'carry', cashMode: 'carry' }, base, [], 'cb', 2)
    const utilBefore = computeLedgerMonth('utilities', [...util, ...base], '2026-10', [cu, cb])
    expect(computeLedgerMonth('utilities', [...util, ...late], '2026-10', [cu, cb])).toEqual(utilBefore)
    const bazarBefore = computeLedgerMonth('bazar', [...util, ...base], '2026-10', [cu, cb])
    const utilLate = [...util, tx('utilities', 'expense', 400, '2026-09-28', { category: 'wifi' })]
    expect(computeLedgerMonth('bazar', [...utilLate, ...base], '2026-10', [cu, cb])).toEqual(bazarBefore)
  })
})
