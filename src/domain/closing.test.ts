import { describe, expect, it } from 'vitest'
import {
  analyzeCorrection,
  analyzeUndo,
  buildClosing,
  canClose,
  computeHistory,
  computeLedgerMonth,
  computeMonth,
  EMPTY_OPENING,
  previewClosing,
  type ClosingInput,
  type MonthSummary,
} from './ledger'
import { tx } from './testUtils'
import type { MemberId, MonthClosing, Transaction } from './types'

const ids: MemberId[] = ['asif', 'dipu', 'yusha', 'ovi']
const m = (s: MonthSummary, id: MemberId) => s.members.find((x) => x.memberId === id)!
let n = 0
const close = (input: Partial<ClosingInput> & Pick<ClosingInput, 'ledger' | 'sourceMonth' | 'method'>, txs: Transaction[], closings: MonthClosing[] = []) =>
  buildClosing({ cashMode: 'carry', ...input }, txs, closings, `c${++n}`, 1000 + n)

// September: unequal contributions, spending ৳4000 (৳1000 each)
const sep: Transaction[] = [
  tx('bazar', 'contribution', 3000, '2026-09-01', { memberId: 'asif' }),
  tx('bazar', 'contribution', 1500, '2026-09-01', { memberId: 'dipu' }),
  tx('bazar', 'contribution', 500, '2026-09-02', { memberId: 'yusha' }),
  tx('bazar', 'expense', 4000, '2026-09-10'),
]
// closing Sep: cash 1000; balances asif +2000, dipu +500, yusha −500, ovi −1000

describe('Option A — carry forward', () => {
  it('opens the next month with each closing balance and the closing cash, exactly once', () => {
    const c = close({ ledger: 'bazar', sourceMonth: '2026-09', method: 'carry' }, sep)
    const oct = computeLedgerMonth('bazar', sep, '2026-10', [c])
    expect(oct.openingCash).toBe(1000_00)
    expect(ids.map((id) => m(oct, id).opening)).toEqual([2000_00, 500_00, -500_00, -1000_00])
    expect(oct.opening.source).toBe('closing')
    expect(oct.opening.cashAdjustment).toBe(0)
    expect(Object.values(oct.opening.memberAdjustments)).toEqual([0, 0, 0, 0])
    expect(oct.transactionCount).toBe(0)
    expect(oct.totalCollected).toBe(0)
    expect(oct.reconciliation).toMatchObject({ difference: 0, unexplained: 0, balanced: true })
    // Same figures as the provisional carry-forward without a closing record.
    const provisional = computeLedgerMonth('bazar', sep, '2026-10', [])
    expect(provisional.opening.source).toBe('carry')
    expect(provisional.members).toEqual(oct.members)
  })
})

describe('Option B — settled member balances', () => {
  it('starts at zero member balances, keeps cash separate and records the adjustment explicitly', () => {
    const c = close({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived' }, sep)
    const oct = computeLedgerMonth('bazar', sep, '2026-10', [c])
    expect(ids.map((id) => m(oct, id).opening)).toEqual([0, 0, 0, 0])
    expect(oct.openingCash).toBe(1000_00) // cash is NOT reset
    expect(oct.opening.memberAdjustments).toEqual({ asif: -2000_00, dipu: -500_00, yusha: 500_00, ovi: 1000_00 })
    expect(oct.opening.cashAdjustment).toBe(0)
    // Member balances (0) no longer equal cash (1000): shown as a difference, explained by the recorded adjustment.
    expect(oct.reconciliation.difference).toBe(-1000_00)
    expect(oct.reconciliation.explainedDifference).toBe(-1000_00)
    expect(oct.reconciliation.unexplained).toBe(0)
    expect(oct.reconciliation.balanced).toBe(true)
    // No cash movement was invented: no contributions or expenses in October.
    expect(oct.totalCollected).toBe(0)
    expect(oct.totalSpent).toBe(0)
  })

  it('can use a verified cash count instead of carrying cash', () => {
    const c = close({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'settled', cashMode: 'set', openingCash: 950_00 }, sep)
    const oct = computeLedgerMonth('bazar', sep, '2026-10', [c])
    expect(oct.openingCash).toBe(950_00)
    expect(oct.opening.cashAdjustment).toBe(-50_00)
    expect(oct.reconciliation.difference).toBe(-950_00)
    expect(oct.reconciliation.unexplained).toBe(0)
  })

  it('leaves the closed month and its transactions unchanged', () => {
    const before = computeLedgerMonth('bazar', sep, '2026-09', [])
    const c = close({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'settled' }, sep)
    const after = computeLedgerMonth('bazar', sep, '2026-09', [c])
    expect(after.members).toEqual(before.members)
    expect(after.remainingCash).toBe(before.remainingCash)
    expect(after.closing?.id).toBe(c.id)
  })
})

describe('Option C — verified opening balances', () => {
  it('uses the entered balances and cash and records the difference from the previous closing', () => {
    const c = close(
      {
        ledger: 'bazar',
        sourceMonth: '2026-09',
        method: 'manual',
        cashMode: 'set',
        openingCash: 800_00,
        openingBalances: { asif: 1500_00, dipu: 500_00, yusha: -400_00, ovi: -800_00 },
        note: 'Counted with everyone on 30 Sep',
      },
      sep,
    )
    expect(c.cashMode).toBe('set')
    const oct = computeLedgerMonth('bazar', sep, '2026-10', [c])
    expect(ids.map((id) => m(oct, id).opening)).toEqual([1500_00, 500_00, -400_00, -800_00])
    expect(oct.openingCash).toBe(800_00)
    expect(oct.opening.memberAdjustments).toEqual({ asif: -500_00, dipu: 0, yusha: 100_00, ovi: 200_00 })
    expect(oct.opening.cashAdjustment).toBe(-200_00)
    expect(oct.reconciliation.difference).toBe(800_00 - 800_00)
    expect(oct.reconciliation.unexplained).toBe(0)
    // September itself is unchanged.
    expect(computeLedgerMonth('bazar', sep, '2026-09', [c]).remainingCash).toBe(1000_00)
  })

  it('can set starting balances for a new ledger by closing the month before the first entries', () => {
    const c = close(
      { ledger: 'utilities', sourceMonth: '2026-08', method: 'manual', cashMode: 'set', openingCash: 200_00, openingBalances: { asif: 200_00, dipu: 0, yusha: 0, ovi: 0 } },
      [],
    )
    const txs = [tx('utilities', 'expense', 400, '2026-09-03', { category: 'gas' })]
    const s = computeLedgerMonth('utilities', txs, '2026-09', [c])
    expect(s.openingCash).toBe(200_00)
    expect(m(s, 'asif').closing).toBe(100_00)
    expect(s.remainingCash).toBe(-200_00)
    expect(s.reconciliation.unexplained).toBe(0)
  })
})

describe('history and later months', () => {
  it('counts each month only once and carries the chosen openings onward', () => {
    const oct = [tx('bazar', 'contribution', 1000, '2026-10-02', { memberId: 'ovi' }), tx('bazar', 'expense', 2000, '2026-10-05')]
    const all = [...sep, ...oct]
    const c = close({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'settled' }, all)
    const [s, o, nov] = computeHistory('bazar', all, '2026-11', [c])
    expect(s.totalSpent).toBe(4000_00)
    expect(o.totalSpent).toBe(2000_00)
    expect(o.totalCollected).toBe(1000_00)
    expect(m(o, 'ovi').closing).toBe(1000_00 - 500_00)
    expect(m(o, 'asif').closing).toBe(-500_00)
    expect(o.remainingCash).toBe(1000_00 + 1000_00 - 2000_00)
    // November: provisional carry from October, nothing re-counted.
    expect(nov.transactionCount).toBe(0)
    expect(nov.openingCash).toBe(o.remainingCash)
    expect(nov.members.map((x) => x.opening)).toEqual(o.members.map((x) => x.closing))
    for (const x of [s, o, nov]) expect(x.reconciliation.unexplained).toBe(0)
  })

  it('flags a closed month whose figures changed after the closing was confirmed', () => {
    const c = close({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived' }, sep)
    const corrected = [...sep, tx('bazar', 'expense', 400, '2026-09-20')]
    const oct = computeLedgerMonth('bazar', corrected, '2026-10', [c])
    expect(oct.opening.sourceChangedSinceClosing).toBe(true)
    // The waiver recorded at closing stands; the late ৳100 share each is carried into October as due.
    expect(oct.opening.memberAdjustments).toEqual({ asif: -2000_00, dipu: -500_00, yusha: 500_00, ovi: 1000_00 })
    expect(ids.map((id) => m(oct, id).opening)).toEqual([-100_00, -100_00, -100_00, -100_00])
    expect(oct.openingCash).toBe(600_00) // cash still follows the real cash ledger
    expect(oct.reconciliation.unexplained).toBe(0)
  })

  it('reports how a correction affects a closed month without changing its recorded adjustment', () => {
    const c = close({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived' }, sep)
    const corrected = [...sep, tx('bazar', 'expense', 400, '2026-09-20')]
    const impact = analyzeCorrection('bazar', sep, corrected, '2026-09', '2026-10', [c])!
    expect(impact.closedMonths).toEqual(['2026-09'])
    expect(impact.closingEffects).toHaveLength(1)
    const e = impact.closingEffects[0]
    expect(Object.values(e.recordedAdjustments.members).reduce((x, y) => x + y, 0)).toBe(-1000_00)
    expect(e.openingBefore.balances.ovi).toBe(0)
    expect(e.openingAfter.balances.ovi).toBe(-100_00)
  })

  it('detects an unexplained difference instead of hiding it', () => {
    const s = computeMonth('bazar', '2026-09', { cash: 100_00, balances: EMPTY_OPENING.balances }, [])
    expect(s.reconciliation.difference).toBe(-100_00)
    expect(s.reconciliation.unexplained).toBe(-100_00)
    expect(s.reconciliation.balanced).toBe(false)
  })
})

describe('closing safeguards', () => {
  it('rejects future months, duplicates and out-of-order closings', () => {
    const c = close({ ledger: 'bazar', sourceMonth: '2026-09', method: 'carry' }, sep)
    expect(canClose('bazar', '2026-11', [], '2026-10')).toMatchObject({ ok: false })
    expect(canClose('bazar', '2026-10', [], '2026-10')).toMatchObject({ ok: false, availableFrom: '2026-11-01' }) // current month
    expect(canClose('bazar', '2026-10', [], '2026-11')).toEqual({ ok: true })
    expect(canClose('bazar', '2026-09', [c], '2026-10')).toMatchObject({ ok: false })
    expect(canClose('bazar', '2026-08', [c], '2026-10')).toMatchObject({ ok: false, blockingMonth: '2026-09' })
    // An undone closing no longer blocks.
    expect(canClose('bazar', '2026-09', [{ ...c, undoneAt: 5 }], '2026-10')).toEqual({ ok: true })
    // The other ledger is independent.
    expect(canClose('utilities', '2026-09', [c], '2026-10')).toEqual({ ok: true })
  })

  it('previews without changing anything', () => {
    const c = close({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'settled' }, sep)
    const frozen = Object.freeze([...sep])
    const p = previewClosing(c, frozen, [])
    expect(p.target.members.every((x) => x.opening === 0)).toBe(true)
    expect(p.source.remainingCash).toBe(1000_00)
  })
})

describe('undo analysis', () => {
  it('returns the target month to provisional carry-forward', () => {
    const c = close({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived' }, sep)
    const a = analyzeUndo(c, sep, [c], '2026-10')
    expect(a.blockedBy).toEqual([])
    expect(Object.values(a.openingNow.balances)).toEqual([0, 0, 0, 0])
    expect(a.openingAfter.balances).toEqual({ asif: 2000_00, dipu: 500_00, yusha: -500_00, ovi: -1000_00 })
    expect(a.openingAfter.cash).toBe(a.openingNow.cash)
  })

  it('is blocked by a later closing and counts dependent transactions', () => {
    const oct = [tx('bazar', 'expense', 100, '2026-10-02')]
    const all = [...sep, ...oct]
    const c9 = close({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived' }, all)
    const c10 = close({ ledger: 'bazar', sourceMonth: '2026-10', method: 'carry' }, all, [c9])
    const a = analyzeUndo(c9, all, [c9, c10], '2026-10')
    expect(a.blockedBy.map((c) => c.sourceMonth)).toEqual(['2026-10'])
    expect(a.dependentTransactionCount).toBe(1)
    expect(analyzeUndo(c10, all, [c9, c10], '2026-10').blockedBy).toEqual([])
  })
})

describe('isolation with closings', () => {
  it('a Utilities closing never changes Bazar figures, and vice versa', () => {
    const util = [tx('utilities', 'contribution', 900, '2026-09-01', { memberId: 'dipu' }), tx('utilities', 'expense', 400, '2026-09-04', { category: 'wifi' })]
    const all = [...sep, ...util]
    const cu = close({ ledger: 'utilities', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived' }, all)
    const bazarBefore = computeHistory('bazar', all, '2026-11', [])
    const bazarAfter = computeHistory('bazar', all, '2026-11', [cu])
    expect(bazarAfter).toEqual(bazarBefore)
    const cb = close({ ledger: 'bazar', sourceMonth: '2026-09', method: 'manual', cashMode: 'set', openingCash: 0, openingBalances: { asif: 0, dipu: 0, yusha: 0, ovi: 0 } }, all)
    expect(computeHistory('utilities', all, '2026-11', [cu, cb])).toEqual(computeHistory('utilities', all, '2026-11', [cu]))
  })
})
