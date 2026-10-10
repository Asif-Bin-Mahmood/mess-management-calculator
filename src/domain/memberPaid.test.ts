import { describe, expect, it } from 'vitest'
import golden from './__fixtures__/v1.2.0-household-golden.json'
import { MIN_MONTH } from './month'
import type { BazarMethod } from './bazarMethod'
import type { Member } from './household'
import { allocateShares, analyzeCorrection, buildClosing, computeHistory, computeLedgerMonth, memberBalances, previewClosing, type MonthSummary } from './ledger'
import { roster, tx } from './testUtils'
import type { MonthClosing, Transaction } from './types'
import { validateTxInput, type TxInput } from './validate'
import { buildReport, dashboardAlerts, reconciliationLines } from '../report/reportModel'

const FROM_START: BazarMethod = { memberPaidFrom: MIN_MONTH }
const paid = (memberId: string, taka: number, date: string, extra: { deletedAt?: number } = {}) => tx('bazar', 'purchase', taka, date, { memberId, ...extra })
const settle = (from: string, to: string, taka: number, date: string): Transaction => ({ ...tx('bazar', 'settlement', taka, date, { memberId: from }), counterpartyId: to })
const month = (r: Member[], txs: Transaction[], m: string, closings: MonthClosing[] = [], method: BazarMethod | null = FROM_START) =>
  computeLedgerMonth('bazar', r, txs, m, closings, method)
const row = (s: MonthSummary, id: string) => s.members.find((m) => m.memberId === id)!

describe('member-paid Bazar month', () => {
  it('total = sum of member-paid amounts; balance change = paid − equal share', () => {
    const r = roster(3)
    const s = month(r, [paid('m1', 900, '2026-05-02'), paid('m2', 300, '2026-05-10')], '2026-05')
    expect(s.method).toBe('memberPaid')
    expect(s.totalSpent).toBe(120000)
    expect(s.averagePerPerson).toBe(40000)
    // No shared cash: nothing is collected and no cash is held.
    expect(s.totalCollected).toBe(0)
    expect(s.remainingCash).toBe(0)
    expect(s.categoryTotals).toBeNull()
    expect(s.members.map((m) => [m.memberId, m.contributed, m.share, m.closing])).toEqual([
      ['m1', 90000, 40000, 50000], // paid above the share: will receive
      ['m2', 30000, 40000, -10000], // paid below: due
      ['m3', 0, 40000, -40000], // paid nothing: due the full share
    ])
    expect(s.reconciliation.status).toBe('balanced')
    expect(dashboardAlerts(s)).toEqual([])
    expect(reconciliationLines(s.reconciliation, s.method)[0].text).toMatch(/amounts due equal amounts to receive/)
  })

  it.each([1, 2, 3, 4, 5, 6, 7, 11])('%i members: shares add up to the exact total with deterministic poisha rounding', (n) => {
    const r = roster(n)
    const txs = [paid('m1', 1000.01, '2026-07-03'), paid(`m${n}`, 333.33, '2026-07-20')]
    const s = month(r, txs, '2026-07')
    const total = 100001 + 33333
    expect(s.totalSpent).toBe(total)
    const shares = s.members.map((m) => m.share)
    expect(shares.reduce((a, b) => a + b, 0)).toBe(total)
    // Same rotation rule as the cash method: floor(total / n), leftover poisha rotating by month.
    expect(Object.fromEntries(s.members.map((m) => [m.memberId, m.share]))).toEqual(allocateShares(total, '2026-07', r.map((m) => m.id)))
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1)
    // Balances always net to zero: what some will receive is exactly what the others owe.
    expect(s.members.reduce((a, m) => a + m.closing, 0)).toBe(0)
  })

  it('a month with no Bazar amounts: total and share ৳0, balances carry over unchanged', () => {
    const r = roster(3)
    const txs = [paid('m1', 600, '2026-03-05')]
    const april = month(r, txs, '2026-04')
    expect(april.totalSpent).toBe(0)
    expect(april.averagePerPerson).toBe(0)
    expect(april.members.map((m) => [m.memberId, m.opening, m.share, m.closing])).toEqual([
      ['m1', 40000, 0, 40000],
      ['m2', -20000, 0, -20000],
      ['m3', -20000, 0, -20000],
    ])
  })

  it('zero or negative amounts are rejected', () => {
    const r = roster(2)
    const ctx = { roster: r, categories: [], bazarMethod: FROM_START, entry: true }
    for (const amount of [0, -100]) {
      expect(validateTxInput({ ledger: 'bazar', type: 'purchase', amount, date: '2026-05-01', memberId: 'm1' }, ctx).amount).toBeTruthy()
    }
  })

  it('deleted Bazar amounts do not count', () => {
    const r = roster(2)
    const s = month(r, [paid('m1', 500, '2026-05-01'), paid('m2', 900, '2026-05-02', { deletedAt: 1 })], '2026-05')
    expect(s.totalSpent).toBe(50000)
  })

  it('members joining, leaving and rejoining share only their whole calendar months', () => {
    const r: Member[] = [
      { id: 'a', name: 'A', seq: 0, createdAt: 0, periods: [{}] },
      { id: 'b', name: 'B', seq: 1, createdAt: 0, periods: [{ until: '2026-02' }, { from: '2026-04' }] },
      { id: 'c', name: 'C', seq: 2, createdAt: 0, periods: [{ from: '2026-02' }] },
    ]
    const txs = [paid('a', 300, '2026-01-10'), paid('a', 300, '2026-02-10'), paid('c', 200, '2026-03-10'), paid('b', 900, '2026-04-10')]
    const h = computeHistory('bazar', r, txs, '2026-04', [], FROM_START)
    const [jan, feb, mar, apr] = h
    expect(jan.sharers).toEqual(['a', 'b'])
    expect(jan.members.map((m) => [m.memberId, m.closing])).toEqual([
      ['a', 15000],
      ['b', -15000],
    ])
    expect(feb.sharers).toEqual(['a', 'b', 'c'])
    expect(feb.members.map((m) => [m.memberId, m.share, m.closing])).toEqual([
      ['a', 10000, 35000],
      ['b', 10000, -25000],
      ['c', 10000, -10000],
    ])
    // March: B has left. B keeps the old balance (shown, no share); A and C split March's Bazar.
    expect(mar.sharers).toEqual(['a', 'c'])
    expect(mar.members.map((m) => [m.memberId, m.share, m.closing])).toEqual([
      ['a', 10000, 25000],
      ['b', 0, -25000],
      ['c', 10000, 0],
    ])
    // April: B rejoins and pays.
    expect(apr.sharers).toEqual(['a', 'b', 'c'])
    expect(apr.members.map((m) => [m.memberId, m.share, m.closing])).toEqual([
      ['a', 30000, -5000],
      ['b', 30000, 35000],
      ['c', 30000, -30000],
    ])
    for (const s of h) expect(s.members.reduce((x, m) => x + m.closing, 0)).toBe(0)
  })

  it('a former member settling an old balance is not counted as Bazar spending', () => {
    const r: Member[] = [
      { id: 'a', name: 'A', seq: 0, createdAt: 0, periods: [{}] },
      { id: 'b', name: 'B', seq: 1, createdAt: 0, periods: [{ until: '2026-01' }] },
      { id: 'c', name: 'C', seq: 2, createdAt: 0, periods: [{}] },
    ]
    // January: A paid for everyone; B leaves due ৳200.
    const jan = [paid('a', 600, '2026-01-05')]
    const before = month(r, jan, '2026-02')
    expect(row(before, 'b').closing).toBe(-20000)
    // February: B (former member) pays A the ৳200 owed; A and C buy ৳400 of Bazar.
    const feb = [...jan, settle('b', 'a', 200, '2026-02-03'), paid('c', 400, '2026-02-10')]
    const s = month(r, feb, '2026-02')
    expect(s.totalSpent).toBe(40000) // the settlement is not spending
    expect(s.averagePerPerson).toBe(20000)
    expect(s.sharers).toEqual(['a', 'c'])
    expect(s.members.map((m) => [m.memberId, m.opening, m.contributed, m.settled, m.share, m.closing])).toEqual([
      ['a', 40000, 0, -20000, 20000, 0],
      ['b', -20000, 0, 20000, 0, 0],
      ['c', -20000, 40000, 0, 20000, 0],
    ])
    expect(s.reconciliation.status).toBe('balanced')
  })

  it('a former member cannot add a Bazar amount (settlement instead); settlements need two different members', () => {
    const r: Member[] = [
      { id: 'a', name: 'A', seq: 0, createdAt: 0, periods: [{}] },
      { id: 'b', name: 'B', seq: 1, createdAt: 0, periods: [{ until: '2026-01' }] },
    ]
    const ctx = { roster: r, categories: [], bazarMethod: FROM_START, entry: true }
    const base: TxInput = { ledger: 'bazar', type: 'purchase', amount: 100, date: '2026-02-01', memberId: 'b' }
    expect(validateTxInput(base, ctx).memberId).toMatch(/settlement/)
    expect(validateTxInput({ ...base, type: 'settlement', counterpartyId: 'a' }, ctx)).toEqual({})
    expect(validateTxInput({ ...base, type: 'settlement', counterpartyId: 'b' }, ctx).counterpartyId).toBeTruthy()
    expect(validateTxInput({ ...base, type: 'settlement' }, ctx).counterpartyId).toBeTruthy()
    expect(validateTxInput({ ...base, memberId: 'a', counterpartyId: 'b' }, ctx).counterpartyId).toBeTruthy()
  })

  it('each month accepts only the entry types of its method; Utilities never takes member-paid entries', () => {
    const r = roster(2)
    const method: BazarMethod = { memberPaidFrom: '2026-05' }
    const ctx = { roster: r, categories: [], bazarMethod: method, entry: true }
    const e = (i: TxInput) => validateTxInput(i, ctx)
    expect(e({ ledger: 'bazar', type: 'purchase', amount: 100, date: '2026-05-01', memberId: 'm1' })).toEqual({})
    expect(e({ ledger: 'bazar', type: 'expense', amount: 100, date: '2026-05-01' }).type).toBeTruthy()
    expect(e({ ledger: 'bazar', type: 'contribution', amount: 100, date: '2026-05-01', memberId: 'm1' }).type).toBeTruthy()
    expect(e({ ledger: 'bazar', type: 'expense', amount: 100, date: '2026-04-30' })).toEqual({})
    expect(e({ ledger: 'bazar', type: 'purchase', amount: 100, date: '2026-04-30', memberId: 'm1' }).type).toBeTruthy()
    expect(e({ ledger: 'utilities', type: 'purchase', amount: 100, date: '2026-05-01', memberId: 'm1' }).type).toBeTruthy()
    expect(e({ ledger: 'utilities', type: 'expense', amount: 100, date: '2026-05-01', category: 'wifi' }).type).toBeUndefined()
  })

  it('closing a member-paid month: carry, settled and verified balances move balances, never cash', () => {
    const r = roster(3)
    const txs = [paid('m1', 900, '2026-05-02')]
    for (const input of [
      { ledger: 'bazar' as const, sourceMonth: '2026-05', method: 'carry' as const, cashMode: 'carry' as const },
      { ledger: 'bazar' as const, sourceMonth: '2026-05', method: 'settled' as const, settlementKind: 'settled' as const, cashMode: 'carry' as const },
      { ledger: 'bazar' as const, sourceMonth: '2026-05', method: 'manual' as const, cashMode: 'set' as const, openingCash: 0, openingBalances: { m1: 10000, m2: -5000, m3: -5000 } },
    ]) {
      const c = buildClosing(input, r, txs, [], 'c1', 1, FROM_START)
      const p = previewClosing(c, r, txs, [], FROM_START)
      expect(p.target.method).toBe('memberPaid')
      expect(p.target.openingCash).toBe(0)
      const june = month(r, txs, '2026-06', [c])
      expect(june.remainingCash).toBe(0)
      expect(june.reconciliation.balanced).toBe(true)
      const expected = input.method === 'carry' ? [60000, -30000, -30000] : input.method === 'settled' ? [0, 0, 0] : [10000, -5000, -5000]
      expect(june.members.map((m) => m.opening)).toEqual(expected)
    }
  })

  it('a later edit to a closed member-paid month is reported like any correction', () => {
    const r = roster(2)
    const t1 = paid('m1', 400, '2026-05-02')
    const c = buildClosing({ ledger: 'bazar', sourceMonth: '2026-05', method: 'carry', cashMode: 'carry' }, r, [t1], [], 'c1', 1, FROM_START)
    const impact = analyzeCorrection('bazar', r, [t1], [{ ...t1, amount: 60000 }], '2026-05', '2026-07', [c], FROM_START)
    expect(impact).not.toBeNull()
  })
})

describe('switching to member-paid keeps every earlier figure', () => {
  const r = golden.roster as Member[]
  const txs = golden.transactions as Transaction[]
  const closings = golden.closings as MonthClosing[]
  const pick = (s: MonthSummary) => ({ ...s, method: undefined })

  it('Bazar months before the switch are identical to v1.2.0; later months use the new method', () => {
    const method: BazarMethod = { memberPaidFrom: '2026-11' }
    const extra = [paid('m_a', 1200.5, '2026-11-04'), paid('m_b', 300, '2026-11-09')]
    const cashOnly = computeHistory('bazar', r, txs, '2026-10', closings)
    const switched = computeHistory('bazar', r, [...txs, ...extra], '2026-11', closings, method)
    expect(switched.slice(0, -1).map(pick)).toEqual(cashOnly.map(pick))
    expect(switched.slice(0, -1).every((s) => s.method === 'cash')).toBe(true)
    const nov = switched[switched.length - 1]
    const oct = cashOnly[cashOnly.length - 1]
    expect(nov.method).toBe('memberPaid')
    expect(nov.totalSpent).toBe(150050)
    // Balances carry over unchanged into the first member-paid month.
    for (const m of oct.members) expect(row(nov, m.memberId)?.opening ?? 0).toBe(m.closing)
    // Any cash left from the cash method is carried as is and flagged, never treated as Bazar money.
    expect(nov.remainingCash).toBe(oct.remainingCash)
    expect(nov.totalCollected).toBe(0)
    if (oct.remainingCash !== 0) expect(dashboardAlerts(nov).map((a) => a.kind)).toContain('legacy-cash')
  })

  it('Utilities is identical whatever the Bazar method (history, report, closing, balances)', () => {
    for (const method of [null, FROM_START, { memberPaidFrom: '2026-03' }]) {
      expect(computeHistory('utilities', r, txs, '2026-10', closings, method)).toEqual(computeHistory('utilities', r, txs, '2026-10', closings))
      const at = new Date(0)
      expect(buildReport('utilities', r, '2026-09', txs, closings, at, method)).toEqual(buildReport('utilities', r, '2026-09', txs, closings, at))
      const input = { ledger: 'utilities' as const, sourceMonth: '2026-10', method: 'carry' as const, cashMode: 'carry' as const }
      const c = buildClosing(input, r, txs, closings, 'x', 5, method)
      expect(c).toEqual(buildClosing(input, r, txs, closings, 'x', 5))
      expect(previewClosing(c, r, txs, closings, method)).toEqual(previewClosing(c, r, txs, closings))
      expect(memberBalances(r, txs, closings, '2026-10', method).utilities).toEqual(memberBalances(r, txs, closings, '2026-10').utilities)
    }
  })
})
