import { describe, expect, it } from 'vitest'
import {
  allocateShares,
  analyzeCorrection,
  computeHistory,
  computeLedgerMonth,
  type MonthSummary,
} from './ledger'
import { tx } from './testUtils'
import type { MemberId } from './types'

const bal = (s: MonthSummary, id: MemberId) => s.members.find((m) => m.memberId === id)!

function expectReconciled(s: MonthSummary) {
  expect(s.reconciliation.balanced).toBe(true)
  expect(s.members.reduce((a, m) => a + m.closing, 0)).toBe(s.remainingCash)
  expect(s.members.reduce((a, m) => a + m.share, 0)).toBe(s.totalSpent)
}

describe('allocateShares', () => {
  it('splits evenly divisible totals equally', () => {
    expect(allocateShares(400_00, '2026-01')).toEqual({ asif: 100_00, dipu: 100_00, yusha: 100_00, ovi: 100_00 })
  })

  it('always sums exactly to the total, including remainders and negatives', () => {
    for (const total of [0, 1, 2, 3, 5, 99, 1001, 123457, -1, -2, -3, -101]) {
      for (const month of ['2026-01', '2026-02', '2026-03', '2026-04']) {
        const s = allocateShares(total, month)
        const values = Object.values(s)
        expect(values.reduce((a, b) => a + b, 0)).toBe(total)
        expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('rotates the leftover poisha deterministically by month', () => {
    // monthIndex(2026-01) = 2026*12 = 24312 → 24312 % 4 = 0 → starts at Asif
    expect(allocateShares(1, '2026-01')).toEqual({ asif: 1, dipu: 0, yusha: 0, ovi: 0 })
    expect(allocateShares(1, '2026-02')).toEqual({ asif: 0, dipu: 1, yusha: 0, ovi: 0 })
    expect(allocateShares(2, '2026-04')).toEqual({ asif: 1, dipu: 0, yusha: 0, ovi: 1 })
    expect(allocateShares(3, '2026-03')).toEqual({ asif: 1, dipu: 0, yusha: 1, ovi: 1 })
  })

  it('rejects fractional poisha', () => {
    expect(() => allocateShares(1.5, '2026-01')).toThrow()
  })
})

describe('computeLedgerMonth — single month formulas', () => {
  it('computes collected, spent, remaining, average and balances with unequal contributions', () => {
    const txs = [
      tx('bazar', 'contribution', 3000, '2026-05-01', { memberId: 'asif' }),
      tx('bazar', 'contribution', 2000, '2026-05-02', { memberId: 'dipu' }),
      tx('bazar', 'contribution', 1000, '2026-05-03', { memberId: 'yusha' }),
      tx('bazar', 'expense', 1500, '2026-05-04'),
      tx('bazar', 'expense', 2500.5, '2026-05-10'),
    ]
    const s = computeLedgerMonth('bazar', txs, '2026-05')
    expect(s.totalCollected).toBe(6000_00)
    expect(s.totalSpent).toBe(4000_50)
    expect(s.remainingCash).toBe(1999_50)
    expect(s.averagePerPerson).toBe(1000_13) // 1000.125 rounded half up
    // 400050 / 4 = 100012 r2 ; 2026-05 → index%4 = 0 → Asif, Dipu get +1
    expect(bal(s, 'asif').share).toBe(1000_13)
    expect(bal(s, 'dipu').share).toBe(1000_13)
    expect(bal(s, 'yusha').share).toBe(1000_12)
    expect(bal(s, 'ovi').share).toBe(1000_12)
    expect(bal(s, 'asif').closing).toBe(1999_87) // receivable
    expect(bal(s, 'yusha').closing).toBe(-12) // due 12 poisha
    expect(bal(s, 'ovi').closing).toBe(-1000_12) // due, paid nothing
    expect(s.categoryTotals).toBeNull()
    expectReconciled(s)
  })

  it('handles a month with contributions but zero expenses', () => {
    const s = computeLedgerMonth('utilities', [tx('utilities', 'contribution', 500, '2026-06-02', { memberId: 'ovi' })], '2026-06')
    expect(s.totalSpent).toBe(0)
    expect(s.averagePerPerson).toBe(0)
    expect(bal(s, 'ovi').closing).toBe(500_00)
    expect(s.remainingCash).toBe(500_00)
    expectReconciled(s)
  })

  it('handles over-spending (negative remaining cash) while staying reconciled', () => {
    const txs = [
      tx('bazar', 'contribution', 100, '2026-06-01', { memberId: 'asif' }),
      tx('bazar', 'expense', 1000, '2026-06-02'),
    ]
    const s = computeLedgerMonth('bazar', txs, '2026-06')
    expect(s.remainingCash).toBe(-900_00)
    expect(bal(s, 'asif').closing).toBe(-150_00)
    expect(bal(s, 'dipu').closing).toBe(-250_00)
    expectReconciled(s)
  })

  it('applies expense refunds and returns to members', () => {
    const txs = [
      tx('utilities', 'contribution', 1000, '2026-07-01', { memberId: 'asif' }),
      tx('utilities', 'contribution', 1000, '2026-07-01', { memberId: 'dipu' }),
      tx('utilities', 'memberRefund', 200, '2026-07-05', { memberId: 'dipu' }),
      tx('utilities', 'expense', 1200, '2026-07-03', { category: 'current' }),
      tx('utilities', 'expenseRefund', 400, '2026-07-08', { category: 'current' }),
      tx('utilities', 'expense', 1000, '2026-07-09', { category: 'wifi' }),
    ]
    const s = computeLedgerMonth('utilities', txs, '2026-07')
    expect(s.contributionsGross).toBe(2000_00)
    expect(s.memberRefunds).toBe(200_00)
    expect(s.totalCollected).toBe(1800_00)
    expect(s.expensesGross).toBe(2200_00)
    expect(s.expenseRefunds).toBe(400_00)
    expect(s.totalSpent).toBe(1800_00)
    expect(s.remainingCash).toBe(0)
    expect(s.categoryTotals).toEqual({ service: 0, current: 800_00, gas: 0, wifi: 1000_00, others: 0 })
    expect(bal(s, 'dipu').netContribution).toBe(800_00)
    expect(bal(s, 'dipu').closing).toBe(800_00 - 450_00)
    expectReconciled(s)
  })

  it('ignores soft-deleted transactions', () => {
    const txs = [
      tx('bazar', 'expense', 1000, '2026-06-02', { deletedAt: 1 }),
      tx('bazar', 'contribution', 50, '2026-06-02', { memberId: 'asif' }),
    ]
    const s = computeLedgerMonth('bazar', txs, '2026-06')
    expect(s.totalSpent).toBe(0)
    expect(s.transactionCount).toBe(1)
  })

  it('returns an empty, balanced month when there are no transactions', () => {
    const s = computeLedgerMonth('bazar', [], '2026-06')
    expect(s.remainingCash).toBe(0)
    expect(s.members.every((m) => m.closing === 0)).toBe(true)
    expectReconciled(s)
  })
})

describe('ledger isolation', () => {
  it('never mixes Utilities and Bazar transactions', () => {
    const txs = [
      tx('utilities', 'contribution', 1000, '2026-05-01', { memberId: 'asif' }),
      tx('utilities', 'expense', 400, '2026-05-02', { category: 'gas' }),
      tx('bazar', 'contribution', 300, '2026-05-01', { memberId: 'asif' }),
      tx('bazar', 'expense', 800, '2026-05-03'),
    ]
    const u = computeLedgerMonth('utilities', txs, '2026-05')
    const b = computeLedgerMonth('bazar', txs, '2026-05')
    expect(u.totalCollected).toBe(1000_00)
    expect(u.totalSpent).toBe(400_00)
    expect(b.totalCollected).toBe(300_00)
    expect(b.totalSpent).toBe(800_00)
    expect(bal(u, 'asif').closing).toBe(900_00)
    expect(bal(b, 'asif').closing).toBe(100_00)

    // Carry-forward is per ledger too.
    const u2 = computeLedgerMonth('utilities', txs, '2026-06')
    const b2 = computeLedgerMonth('bazar', txs, '2026-06')
    expect(u2.openingCash).toBe(600_00)
    expect(b2.openingCash).toBe(-500_00)
  })

  it('starts each ledger chain at its own first month', () => {
    const txs = [
      tx('utilities', 'contribution', 100, '2026-01-01', { memberId: 'ovi' }),
      tx('bazar', 'contribution', 100, '2026-04-01', { memberId: 'ovi' }),
    ]
    expect(computeHistory('utilities', txs, '2026-04').map((s) => s.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04'])
    expect(computeHistory('bazar', txs, '2026-04').map((s) => s.month)).toEqual(['2026-04'])
  })
})

describe('carry-forward', () => {
  const txs = [
    tx('bazar', 'contribution', 4000, '2026-01-05', { memberId: 'asif' }),
    tx('bazar', 'contribution', 1000, '2026-01-05', { memberId: 'dipu' }),
    tx('bazar', 'expense', 3000.03, '2026-01-20'),
    // February: no transactions
    tx('bazar', 'contribution', 500, '2026-03-02', { memberId: 'ovi' }),
    tx('bazar', 'expense', 1000, '2026-03-15'),
  ]

  it('carries closing balances and cash into the next month without re-counting transactions', () => {
    const [jan, feb, mar] = computeHistory('bazar', txs, '2026-03')
    expectReconciled(jan)
    expect(jan.remainingCash).toBe(1999_97)

    expect(feb.transactionCount).toBe(0)
    expect(feb.totalCollected).toBe(0)
    expect(feb.totalSpent).toBe(0)
    expect(feb.openingCash).toBe(jan.remainingCash)
    expect(feb.remainingCash).toBe(jan.remainingCash)
    for (const id of ['asif', 'dipu', 'yusha', 'ovi'] as const) {
      expect(bal(feb, id).opening).toBe(bal(jan, id).closing)
      expect(bal(feb, id).closing).toBe(bal(jan, id).closing)
      expect(bal(mar, id).opening).toBe(bal(feb, id).closing)
    }
    expectReconciled(feb)

    // March counts only its own transactions.
    expect(mar.totalCollected).toBe(500_00)
    expect(mar.totalSpent).toBe(1000_00)
    expect(mar.remainingCash).toBe(1999_97 + 500_00 - 1000_00)
    expect(bal(mar, 'ovi').closing).toBe(bal(feb, 'ovi').closing + 500_00 - 250_00)
    expectReconciled(mar)
  })

  it('stays reconciled over many months of random activity', () => {
    const members = ['asif', 'dipu', 'yusha', 'ovi'] as const
    let r = 42
    const rand = () => ((r = (r * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const many = []
    for (let i = 0; i < 400; i++) {
      const month = `2025-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}`
      const date = `${month}-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`
      const amount = Math.floor(rand() * 500000) / 100 + 0.01
      const k = rand()
      if (k < 0.45) many.push(tx('bazar', 'contribution', amount, date, { memberId: members[Math.floor(rand() * 4)] }))
      else if (k < 0.5) many.push(tx('bazar', 'memberRefund', amount / 10, date, { memberId: members[Math.floor(rand() * 4)] }))
      else if (k < 0.95) many.push(tx('bazar', 'expense', amount, date))
      else many.push(tx('bazar', 'expenseRefund', amount / 10, date))
    }
    const history = computeHistory('bazar', many, '2026-03')
    for (const s of history) expectReconciled(s)
  })
})

describe('analyzeCorrection', () => {
  const base = [
    tx('utilities', 'contribution', 1000, '2026-08-01', { memberId: 'asif' }),
    tx('utilities', 'expense', 400, '2026-08-10', { category: 'gas' }),
    tx('utilities', 'expense', 400, '2026-09-10', { category: 'gas' }),
  ]

  it('returns null for changes in the latest month', () => {
    const after = [...base, tx('utilities', 'expense', 100, '2026-10-02', { category: 'others' })]
    expect(analyzeCorrection('utilities', base, after, '2026-10', '2026-10')).toBeNull()
  })

  it('describes the ripple into later months for historical corrections', () => {
    const corrected = base.map((t, i) => (i === 1 ? { ...t, amount: 800_00 } : t))
    const impact = analyzeCorrection('utilities', base, corrected, '2026-08', '2026-10')!
    expect(impact.laterMonths).toEqual(['2026-09', '2026-10'])
    expect(impact.cashBefore).toBe(200_00)
    expect(impact.cashAfter).toBe(-200_00)
    const asif = impact.members.find((m) => m.memberId === 'asif')!
    expect(asif.before).toBe(1000_00 - 100_00 - 100_00)
    expect(asif.after).toBe(1000_00 - 200_00 - 100_00)
  })

  it('extends the horizon to later transaction months beyond the current month', () => {
    const later = [...base, tx('utilities', 'expense', 100, '2026-12-01', { category: 'others' })]
    const impact = analyzeCorrection('utilities', later, later.slice(1), '2026-08', '2026-10')!
    expect(impact.horizon).toBe('2026-12')
  })
})
