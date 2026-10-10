import { describe, expect, it } from 'vitest'
import golden from './__fixtures__/legacy-v1.1.1-golden.json'
import { LEGACY_MEMBER_IDS, legacyMembers } from './household'
import { allocateShares, computeHistory } from './ledger'
import type { LedgerId, MonthClosing, Transaction } from './types'

// The fixture holds a deterministic dataset and the month-by-month results of the v1.1.1 engine (four fixed
// members). An upgraded installation has exactly these four members sharing since the beginning, so every
// figure must be identical after the configurable-household refactor.
const txs = golden.transactions as Transaction[]
const closings = golden.closings as MonthClosing[]
const roster = legacyMembers()

/** v1.1.1 always listed all four members (zeros included); the new engine omits zero entries. */
const nonZero = (m: Record<string, number> | null) => (m === null ? null : Object.fromEntries(Object.entries(m).filter(([, v]) => v !== 0)))

function compact(ledger: LedgerId) {
  return computeHistory(ledger, roster, txs, '2026-10', closings).map((s) => ({
    month: s.month,
    openingCash: s.openingCash,
    remainingCash: s.remainingCash,
    totalCollected: s.totalCollected,
    totalSpent: s.totalSpent,
    averagePerPerson: s.averagePerPerson,
    members: s.members.map((x) => [x.memberId, x.opening, x.contributed, x.returned, x.share, x.closing]),
    categoryTotals: nonZero(s.categoryTotals),
    reconciliation: s.reconciliation,
    opening: {
      source: s.opening.source,
      closingId: s.opening.closing?.id ?? null,
      memberAdjustments: nonZero(s.opening.memberAdjustments),
      cashAdjustment: s.opening.cashAdjustment,
      decidedBalances: nonZero(s.opening.decidedBalances),
      decidedCash: s.opening.decidedCash,
      memberCorrections: nonZero(s.opening.memberCorrections),
      cashCorrection: s.opening.cashCorrection,
      unappliedCashCorrection: s.opening.unappliedCashCorrection,
      sourceChangedSinceClosing: s.opening.sourceChangedSinceClosing,
    },
    transactionCount: s.transactionCount,
    closingId: s.closing?.id ?? null,
  }))
}

function expected(ledger: LedgerId) {
  return golden.expected[ledger].map((s) => ({
    ...s,
    categoryTotals: nonZero(s.categoryTotals as Record<string, number> | null),
    opening: {
      ...s.opening,
      memberAdjustments: nonZero(s.opening.memberAdjustments),
      decidedBalances: nonZero(s.opening.decidedBalances),
      memberCorrections: nonZero(s.opening.memberCorrections),
    },
  }))
}

describe('upgraded v1.1.1 households compute exactly as before', () => {
  it('dataset covers the important paths', () => {
    expect(txs.length).toBeGreaterThan(500)
    expect(new Set(closings.map((c) => c.method))).toEqual(new Set(['carry', 'settled', 'manual']))
    expect(closings.some((c) => c.undoneAt !== undefined)).toBe(true)
    expect(golden.expected.utilities.some((s) => s.opening.sourceChangedSinceClosing)).toBe(true)
  })

  it.each(['utilities', 'bazar'] as const)('%s: every month, member, closing and reconciliation figure matches v1.1.1', (ledger) => {
    expect(compact(ledger)).toEqual(expected(ledger))
  })

  it('share allocation matches v1.1.1 for the four original members', () => {
    for (const [total, month, shares] of golden.shares as [number, string, Record<string, number>][]) {
      const got = allocateShares(total, month, LEGACY_MEMBER_IDS)
      expect(LEGACY_MEMBER_IDS.map((id) => got[id] ?? 0)).toEqual(LEGACY_MEMBER_IDS.map((id) => shares[id]))
    }
  })
})
