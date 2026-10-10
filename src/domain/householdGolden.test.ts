import { describe, expect, it } from 'vitest'
import golden from './__fixtures__/v1.2.0-household-golden.json'
import type { Member } from './household'
import { computeHistory } from './ledger'
import type { LedgerId, MonthClosing, Transaction } from './types'

// v1.2.0 results for a household whose members join, leave and rejoin, recorded before the Bazar member-paid
// method existed. Cash-method months (all Utilities months, and Bazar months before any switch) must never change.
const roster = golden.roster as Member[]
const txs = golden.transactions as Transaction[]
const closings = golden.closings as MonthClosing[]

function compact(ledger: LedgerId) {
  return computeHistory(ledger, roster, txs, '2026-10', closings).map((s) => ({
    month: s.month,
    remainingCash: s.remainingCash,
    totalCollected: s.totalCollected,
    totalSpent: s.totalSpent,
    averagePerPerson: s.averagePerPerson,
    sharers: s.sharers,
    members: s.members.map((x) => [x.memberId, x.opening, x.contributed, x.returned, x.share, x.closing]),
    categoryTotals: s.categoryTotals,
    reconciliation: s.reconciliation,
    openingSource: s.opening.source,
  }))
}

describe('v1.2.0 dynamic-household results are preserved', () => {
  it.each(['utilities', 'bazar'] as const)('%s: every month matches v1.2.0', (ledger) => {
    expect(compact(ledger)).toEqual(golden.expected[ledger])
  })
})
