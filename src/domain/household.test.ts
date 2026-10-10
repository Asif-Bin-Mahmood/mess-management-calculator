import { describe, expect, it } from 'vitest'
import {
  firstDifferentMonth,
  legacyCategories,
  sharers,
  validateCategories,
  validatePeriods,
  validateRoster,
  type Member,
} from './household'
import {
  allocateShares,
  analyzeRosterChange,
  buildClosing,
  computeHistory,
  computeLedgerMonth,
  firstOpenMonth,
  latestClosedMonth,
  memberBalances,
  memberIsReferenced,
} from './ledger'
import { monthIndex, monthRange } from './month'
import { roster, tx } from './testUtils'
import type { MonthClosing, Transaction } from './types'
import { validateTxInput } from './validate'

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const ids = (r: Member[]) => r.map((m) => m.id)

/** Σ member balances − cash must equal the recorded closing adjustments (0 without settlements). */
function expectReconciled(history: ReturnType<typeof computeHistory>) {
  for (const s of history) expect(s.reconciliation.unexplained).toBe(0)
}

describe('equal sharing with integer-poisha rounding, any household size', () => {
  it.each([1, 2, 3, 4, 5, 7, 13])('%i members: shares sum exactly to the total, differ by at most 1 poisha, and rotate by month', (n) => {
    const r = ids(roster(n))
    for (const total of [0, 1, 2, n - 1, n, n + 1, 99, 100, 12345, 999_999_99, -1, -7, -12345]) {
      for (const month of ['2024-01', '2025-06', '2026-11']) {
        const shares = allocateShares(total, month, r)
        const values = r.map((id) => shares[id] ?? 0)
        expect(sum(values)).toBe(total)
        expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1)
        expect(allocateShares(total, month, r)).toEqual(shares) // deterministic
        // The extra poisha start at position monthIndex mod n and continue in roster order.
        const extra = total - Math.floor(total / n) * n
        const start = ((monthIndex(month) % n) + n) % n
        const got = r.map((id, i) => (shares[id] === Math.floor(total / n) + 1 ? i : -1)).filter((i) => i >= 0)
        const want = Array.from({ length: extra }, (_, k) => (start + k) % n).sort((a, b) => a - b)
        expect(got).toEqual(want)
      }
    }
  })

  it('with nobody sharing, nothing is allocated', () => {
    expect(allocateShares(500, '2026-01', [])).toEqual({})
  })

  it.each([1, 2, 4, 9])('%i members: balances add up to the cash in hand every month', (n) => {
    const r = roster(n)
    const txs: Transaction[] = []
    let k = 0
    for (const m of monthRange('2025-01', '2025-12')) {
      for (const member of r) txs.push(tx('bazar', 'contribution', 300 + (k++ % 7) + 0.37, `${m}-02`, { memberId: member.id }))
      txs.push(tx('bazar', 'expense', 1001.03 * n + k, `${m}-10`))
      if (k % 3 === 0) txs.push(tx('bazar', 'memberRefund', 12.11, `${m}-12`, { memberId: r[k % n].id }))
    }
    const h = computeHistory('bazar', r, txs, '2025-12')
    expectReconciled(h)
    for (const s of h) {
      expect(s.sharers).toEqual(ids(r))
      expect(sum(s.members.map((m) => m.share))).toBe(s.totalSpent)
      expect(sum(s.members.map((m) => m.closing))).toBe(s.remainingCash)
    }
  })
})

describe('membership in whole calendar months', () => {
  const base = roster(3) // m1, m2, m3 since the beginning
  const joiner: Member = { id: 'm4', name: 'Joiner', seq: 3, createdAt: 0, periods: [{ from: '2026-03' }] }
  const leaver = (until: string): Member[] => base.map((m) => (m.id === 'm3' ? { ...m, periods: [{ until }] } : m))
  const txs = [
    ...monthRange('2026-01', '2026-06').flatMap((m) => [
      tx('utilities', 'expense', 900, `${m}-05`, { category: 'gas' }),
      tx('bazar', 'expense', 1200, `${m}-05`),
    ]),
    tx('bazar', 'contribution', 3000, '2026-01-01', { memberId: 'm1' }),
  ]

  it('a joining member shares from their first month only', () => {
    const r = [...base, joiner]
    const feb = computeLedgerMonth('bazar', r, txs, '2026-02')
    const mar = computeLedgerMonth('bazar', r, txs, '2026-03')
    expect(feb.sharers).toEqual(['m1', 'm2', 'm3'])
    expect(feb.members.map((m) => m.memberId)).toEqual(['m1', 'm2', 'm3']) // not shown before joining
    expect(mar.sharers).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(mar.members.find((m) => m.memberId === 'm4')).toMatchObject({ opening: 0, share: 300_00 })
    expect(mar.averagePerPerson).toBe(300_00)
    expectReconciled(computeHistory('bazar', r, txs, '2026-06'))
  })

  it('a member who leaves keeps their balance; it is never moved onto the others', () => {
    const r = leaver('2026-02')
    const h = computeHistory('bazar', r, txs, '2026-06')
    const feb = h.find((s) => s.month === '2026-02')!
    const owed = feb.members.find((m) => m.memberId === 'm3')!.closing
    expect(owed).toBe(-800_00) // two months of 400 shares, nothing paid
    for (const s of h.filter((x) => x.month > '2026-02')) {
      const m3 = s.members.find((m) => m.memberId === 'm3')!
      expect(m3).toMatchObject({ share: 0, opening: owed, closing: owed }) // shown, unchanged, not sharing
      expect(s.sharers).toEqual(['m1', 'm2'])
      expect(s.members.filter((m) => m.memberId !== 'm3').map((m) => m.share)).toEqual([600_00, 600_00])
    }
    expectReconciled(h)
  })

  it('settling a former member’s balance removes them from later months', () => {
    const r = leaver('2026-02')
    const settled = [...txs, tx('bazar', 'contribution', 800, '2026-04-09', { memberId: 'm3' })]
    const h = computeHistory('bazar', r, settled, '2026-06')
    expect(h.find((s) => s.month === '2026-04')!.members.find((m) => m.memberId === 'm3')!.closing).toBe(0)
    expect(h.find((s) => s.month === '2026-05')!.members.map((m) => m.memberId)).toEqual(['m1', 'm2'])
    expectReconciled(h)
  })

  it('leaving and rejoining: sharing follows each period', () => {
    const r: Member[] = base.map((m) => (m.id === 'm2' ? { ...m, periods: [{ until: '2026-02' }, { from: '2026-05' }] } : m))
    expect(monthRange('2026-01', '2026-06').map((m) => sharers(r, m).length)).toEqual([3, 3, 2, 2, 3, 3])
    expectReconciled(computeHistory('utilities', r, txs, '2026-06'))
  })

  it('membership is household-wide: both ledgers use the same sharers', () => {
    const r = [...base, joiner]
    for (const m of monthRange('2026-01', '2026-06')) {
      expect(computeLedgerMonth('utilities', r, txs, m).sharers).toEqual(computeLedgerMonth('bazar', r, txs, m).sharers)
    }
  })

  it('one member alone carries every expense', () => {
    const r = roster(1)
    const s = computeLedgerMonth('bazar', r, [tx('bazar', 'expense', 123.45, '2026-01-04')], '2026-01')
    expect(s.members).toEqual([expect.objectContaining({ memberId: 'm1', share: 12345, closing: -12345 })])
  })
})

describe('closed months are never recalculated by membership changes', () => {
  const r = roster(2)
  const txs = monthRange('2026-01', '2026-04').map((m) => tx('bazar', 'expense', 100, `${m}-03`))
  const closeJan: MonthClosing = buildClosing({ ledger: 'bazar', sourceMonth: '2026-01', method: 'carry', cashMode: 'carry' }, r, txs, [], 'c1', 1)
  const closeFebUtil: MonthClosing = buildClosing({ ledger: 'utilities', sourceMonth: '2026-02', method: 'carry', cashMode: 'carry' }, r, [], [], 'c2', 2)

  it('the first open month is after the latest closing in either ledger', () => {
    expect(latestClosedMonth([closeJan])).toBe('2026-01')
    expect(firstOpenMonth([closeJan, closeFebUtil])).toBe('2026-03')
    expect(firstOpenMonth([{ ...closeFebUtil, undoneAt: 5 }])).toBeNull()
  })

  it('refuses a change reaching into a closed month (in either ledger) and allows it from the first open month', () => {
    const add = (from: string): Member[] => [...r, { id: 'new', name: 'New', seq: 2, createdAt: 0, periods: [{ from }] }]
    const closings = [closeJan, closeFebUtil]
    expect(analyzeRosterChange(r, add('2026-02'), txs, closings, '2026-04').blockedBy).toBe('2026-02') // Utilities Feb is closed
    expect(analyzeRosterChange(r, add('2026-01'), txs, closings, '2026-04').blockedBy).toBe('2026-02')
    const ok = analyzeRosterChange(r, add('2026-03'), txs, closings, '2026-04')
    expect(ok.blockedBy).toBeNull()
    expect(ok.firstChangedMonth).toBe('2026-03')
    const bazar = ok.ledgers.find((l) => l.ledger === 'bazar')!
    expect(bazar.changedMonths).toEqual(['2026-03', '2026-04'])
    // The closed month's figures are identical with either roster.
    expect(computeLedgerMonth('bazar', add('2026-03'), txs, '2026-01', closings)).toEqual(computeLedgerMonth('bazar', r, txs, '2026-01', closings))
  })

  it('ending a membership "since the beginning" before a closed month is refused', () => {
    const ended = r.map((m) => (m.id === 'm2' ? { ...m, periods: [{ until: '2025-12' }] } : m))
    expect(analyzeRosterChange(r, ended, txs, [closeJan], '2026-04').blockedBy).toBe('2026-01')
  })

  it('finds the first month two period lists differ', () => {
    expect(firstDifferentMonth([{}], [{}], '2026-01')).toBeNull()
    expect(firstDifferentMonth([{}], [{ until: '2026-03' }], '2026-06')).toBe('2026-04')
    expect(firstDifferentMonth([], [{ from: '2026-02' }], '2026-06')).toBe('2026-02')
    expect(firstDifferentMonth([{ from: '2026-02' }], [{}], '2026-06')).toBe('')
    expect(firstDifferentMonth([{ until: '2026-01' }, { from: '2026-05' }], [{ until: '2026-01' }, { from: '2026-04' }], '2026-06')).toBe('2026-04')
  })
})

describe('closings with any household size', () => {
  it('a manual closing records a verified balance for every member shown, and a settlement can clear a former member', () => {
    const r: Member[] = [...roster(2), { id: 'gone', name: 'Gone', seq: 2, createdAt: 0, periods: [{ until: '2026-01' }] }]
    const txs = [tx('bazar', 'expense', 300, '2026-01-03'), tx('bazar', 'expense', 200, '2026-02-03'), tx('bazar', 'contribution', 500, '2026-02-04', { memberId: 'm1' })]
    const feb = computeLedgerMonth('bazar', r, txs, '2026-02')
    expect(feb.members.map((m) => m.memberId)).toEqual(['m1', 'm2', 'gone']) // former member still owes January's share
    const manual = buildClosing({ ledger: 'bazar', sourceMonth: '2026-02', method: 'manual', cashMode: 'set', openingCash: 0, openingBalances: { m1: 100, m2: -100 } }, r, txs, [], 'cm', 1)
    expect(manual.openingBalances).toEqual({ m1: 100, m2: -100, gone: 0 })
    const waived = buildClosing({ ledger: 'bazar', sourceMonth: '2026-02', method: 'settled', settlementKind: 'waived', cashMode: 'carry' }, r, txs, [], 'cw', 1)
    const mar = computeLedgerMonth('bazar', r, txs, '2026-03', [waived])
    expect(mar.members.find((m) => m.memberId === 'gone')).toBeUndefined() // waived: no balance left
    expect(mar.reconciliation.unexplained).toBe(0) // the waiver is a recorded adjustment; nothing is unexplained
    expect(memberIsReferenced('gone', txs, [waived])).toBe(true)
  })
})

describe('member balances and references', () => {
  it('reports each member’s latest balance per ledger, independently', () => {
    const r = roster(2)
    const txs = [tx('utilities', 'contribution', 100, '2026-01-02', { memberId: 'm1' }), tx('bazar', 'expense', 50, '2026-01-03')]
    expect(memberBalances(r, txs, [], '2026-01')).toEqual({ utilities: { m1: 100_00, m2: 0 }, bazar: { m1: -25_00, m2: -25_00 } })
    expect(memberIsReferenced('m1', txs, [])).toBe(true)
    expect(memberIsReferenced('m2', txs, [])).toBe(false)
  })
})

describe('validation against the household registry', () => {
  const r = roster(2)
  const cats = [...legacyCategories(), { id: 'old', name: 'Old Bill', seq: 9, createdAt: 0, archivedAt: 5 }]
  const ctx = { roster: r, categories: cats, entry: true }

  it('accepts only registered members and existing, active categories for new entries', () => {
    expect(validateTxInput({ ledger: 'bazar', type: 'contribution', amount: 100, date: '2026-01-02', memberId: 'm1' }, ctx)).toEqual({})
    expect(validateTxInput({ ledger: 'bazar', type: 'contribution', amount: 100, date: '2026-01-02', memberId: 'asif' }, ctx).memberId).toBeTruthy()
    expect(validateTxInput({ ledger: 'utilities', type: 'expense', amount: 100, date: '2026-01-02', category: 'nope' }, ctx).category).toBeTruthy()
    expect(validateTxInput({ ledger: 'utilities', type: 'expense', amount: 100, date: '2026-01-02', category: 'old' }, ctx).category).toMatch(/archived/)
    // Editing an entry that already uses the archived category keeps it; stored records only need it to exist.
    expect(validateTxInput({ ledger: 'utilities', type: 'expense', amount: 100, date: '2026-01-02', category: 'old' }, { ...ctx, keepCategory: 'old' })).toEqual({})
    expect(validateTxInput({ ledger: 'utilities', type: 'expense', amount: 100, date: '2026-01-02', category: 'old' }, { roster: r, categories: cats })).toEqual({})
  })

  it('refuses a new expense in a month nobody shares', () => {
    const left = r.map((m) => ({ ...m, periods: [{ until: '2026-01' }] }))
    expect(validateTxInput({ ledger: 'bazar', type: 'expense', amount: 100, date: '2026-02-02' }, { ...ctx, roster: left }).date).toMatch(/No member shares/)
    expect(validateTxInput({ ledger: 'bazar', type: 'expense', amount: 100, date: '2026-01-31' }, { ...ctx, roster: left })).toEqual({})
  })

  it('validates membership periods and registries', () => {
    expect(validatePeriods([{}])).toBeNull()
    expect(validatePeriods([{ until: '2026-01' }, { from: '2026-03' }])).toBeNull()
    expect(validatePeriods([{ from: '2026-03', until: '2026-01' }])).toMatch(/ends before/)
    expect(validatePeriods([{ until: '2026-03' }, { from: '2026-02' }])).toMatch(/overlap/)
    expect(validatePeriods([{}, { from: '2026-02' }])).toMatch(/open-ended/)
    expect(validatePeriods([{ from: '2026-13' }])).toMatch(/invalid/)
    expect(validateRoster(roster(3))).toEqual([])
    expect(validateRoster([...roster(2), { ...roster(1)[0] }]).join()).toMatch(/duplicate id/)
    expect(validateRoster([{ ...roster(1)[0], name: 'person 1 ' }])).not.toEqual([])
    expect(validateRoster([{ ...roster(1)[0], extra: 1 }]).join()).toMatch(/unexpected field/)
    expect(validateCategories(cats)).toEqual([])
    expect(validateCategories([...cats, { ...cats[0], id: 'x', seq: 99 }]).join()).toMatch(/duplicate name/)
  })
})
