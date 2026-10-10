import { describe, expect, it } from 'vitest'
import { checkBackup } from '../db/backup'
import { buildClosing, checkMemberReturn, computeLedgerMonth } from './ledger'
import { CTX4, R4, tx } from './testUtils'
import type { Transaction } from './types'
import { validateTransaction } from './validate'

// October Bazar: Asif +2500 (will receive), Dipu +500, Yusha −500, Ovi −500; cash ৳2000.
const oct: Transaction[] = [
  tx('bazar', 'contribution', 3000, '2026-10-01', { memberId: 'asif' }),
  tx('bazar', 'contribution', 1000, '2026-10-01', { memberId: 'dipu' }),
  tx('bazar', 'expense', 2000, '2026-10-10'),
]

describe('checkMemberReturn', () => {
  it('no warning for a return within the will-receive balance and the cash', () => {
    const c = checkMemberReturn('bazar', R4, oct, [], { memberId: 'asif', amount: 1000_00, month: '2026-10' })
    expect(c).toMatchObject({ balanceBefore: 2500_00, balanceAfter: 1500_00, cashBefore: 2000_00, cashAfter: 1000_00, exceedsBalance: false, makesCashNegative: false })
  })

  it('warns when the return is more than the member will receive', () => {
    const c = checkMemberReturn('bazar', R4, oct, [], { memberId: 'dipu', amount: 800_00, month: '2026-10' })
    expect(c).toMatchObject({ balanceBefore: 500_00, balanceAfter: -300_00, exceedsBalance: true, makesCashNegative: false })
  })

  it('warns for any return to a member who is due or settled', () => {
    expect(checkMemberReturn('bazar', R4, oct, [], { memberId: 'yusha', amount: 1, month: '2026-10' }).exceedsBalance).toBe(true)
  })

  it('warns when the ledger cash would become negative', () => {
    const c = checkMemberReturn('bazar', R4, oct, [], { memberId: 'asif', amount: 2500_00, month: '2026-10' })
    expect(c).toMatchObject({ balanceAfter: 0, exceedsBalance: false, cashAfter: -500_00, makesCashNegative: true })
  })

  it('leaves out the entry being edited', () => {
    const existing = tx('bazar', 'memberRefund', 2000, '2026-10-12', { memberId: 'asif' })
    const all = [...oct, existing]
    const c = checkMemberReturn('bazar', R4, all, [], { memberId: 'asif', amount: 2100_00, month: '2026-10' }, existing.id)
    expect(c).toMatchObject({ balanceBefore: 2500_00, cashBefore: 2000_00, exceedsBalance: false, makesCashNegative: true })
  })

  it('includes the opening set by a closing', () => {
    const sep = [tx('bazar', 'contribution', 1000, '2026-09-01', { memberId: 'ovi' })]
    const closing = buildClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'settled', cashMode: 'carry' }, R4, sep, [], 'c', 1)
    // Ovi would have opened October at +1000; the settlement opens everyone at 0, so a return now exceeds his balance.
    const c = checkMemberReturn('bazar', R4, [...sep, ...oct], [closing], { memberId: 'ovi', amount: 100_00, month: '2026-10' })
    expect(c.balanceBefore).toBe(-500_00)
    expect(c.exceedsBalance).toBe(true)
  })

  it('uses only its own ledger', () => {
    const util = [tx('utilities', 'contribution', 9000, '2026-10-01', { memberId: 'dipu' })]
    const inBazar = checkMemberReturn('bazar', R4, [...oct, ...util], [], { memberId: 'dipu', amount: 800_00, month: '2026-10' })
    expect(inBazar).toEqual(checkMemberReturn('bazar', R4, oct, [], { memberId: 'dipu', amount: 800_00, month: '2026-10' }))
    const inUtil = checkMemberReturn('utilities', R4, [...oct, ...util], [], { memberId: 'dipu', amount: 800_00, month: '2026-10' })
    expect(inUtil).toMatchObject({ balanceBefore: 9000_00, cashBefore: 9000_00, exceedsBalance: false, makesCashNegative: false })
  })
})

describe('historical returns stay valid', () => {
  it('an existing return larger than the balance still validates, counts, and restores from backup', () => {
    const big = tx('bazar', 'memberRefund', 4000, '2026-10-15', { memberId: 'asif', description: 'recorded before warnings existed' })
    expect(validateTransaction(big, CTX4)).toEqual([])
    const s = computeLedgerMonth('bazar', R4, [...oct, big], '2026-10')
    expect(s.members.find((m) => m.memberId === 'asif')!.closing).toBe(-1500_00)
    expect(s.remainingCash).toBe(-2000_00)
    expect(s.reconciliation.unexplained).toBe(0)
    const file = { app: 'mess-ledger', schemaVersion: 2, backupId: 'b1', exportedAt: '2026-10-20T00:00:00Z', scope: 'bazar', transactions: [...oct, big], closings: [], audit: [] }
    const check = checkBackup(JSON.stringify(file))
    expect(check.ok).toBe(true)
    if (check.ok) expect(check.data.transactions.find((t) => t.id === big.id)).toEqual(big)
  })
})
