import { beforeAll, describe, expect, it } from 'vitest'
import { LEGACY_MEMBER_NAMES, setMemberNames } from '../domain/types'

// Display names used in these tests (ids are fixed; names are configurable).
beforeAll(() => setMemberNames(LEGACY_MEMBER_NAMES))
import { tx } from '../domain/testUtils'
import { buildPdf } from './pdf'
import { balanceLabel, buildReport, roundingNote, txCashEffect } from './reportModel'

describe('buildReport', () => {
  const txs = [
    tx('utilities', 'contribution', 2000, '2026-09-01', { memberId: 'asif' }),
    tx('utilities', 'expense', 1000, '2026-09-03', { category: 'gas' }),
    tx('utilities', 'contribution', 500, '2026-10-02', { memberId: 'dipu' }),
    tx('utilities', 'expense', 1500.01, '2026-10-05', { category: 'current' }),
    tx('utilities', 'expense', 300, '2026-10-04', { category: 'wifi' }),
    tx('utilities', 'expense', 999, '2026-10-06', { category: 'others', deletedAt: 5 }),
    tx('bazar', 'expense', 700, '2026-10-05'),
  ]
  const r = buildReport('utilities', '2026-10', txs, [], new Date('2026-10-09T12:00:00'))

  it('contains only this ledger and month, sorted by date', () => {
    expect(r.transactions.map((t) => t.date)).toEqual(['2026-10-02', '2026-10-04', '2026-10-05'])
    expect(r.transactions.every((t) => t.ledger === 'utilities')).toBe(true)
  })

  it('uses carried-forward openings and matches the transactions', () => {
    const s = r.summary
    expect(s.openingCash).toBe(1000_00)
    expect(s.totalCollected).toBe(500_00)
    expect(s.totalSpent).toBe(1800_01)
    expect(s.remainingCash).toBe(1000_00 + 500_00 - 1800_01)
    const net = r.transactions.reduce((a, t) => a + txCashEffect(t), 0)
    expect(s.openingCash + net).toBe(s.remainingCash)
    expect(s.categoryTotals).toEqual({ service: 0, current: 1500_01, gas: 0, wifi: 300_00, others: 0 })
    const catSum = Object.values(s.categoryTotals!).reduce((a, b) => a + b, 0)
    expect(catSum).toBe(s.totalSpent)
    expect(s.members.find((m) => m.memberId === 'asif')!.opening).toBe(2000_00 - 250_00)
    expect(s.reconciliation.balanced).toBe(true)
  })

  it('has no categories for Bazar', () => {
    expect(buildReport('bazar', '2026-10', txs).summary.categoryTotals).toBeNull()
  })

  it('labels balances and explains rounding', () => {
    expect(balanceLabel(-1250)).toBe('Due ৳12.50')
    expect(balanceLabel(1250)).toBe('Will receive ৳12.50')
    expect(balanceLabel(0)).toBe('Settled')
    // 180001 / 4 → 45000 r1; 2026-10 index % 4 = 1 → Dipu gets the extra poisha
    expect(roundingNote(r.summary)).toContain('Dipu')
  })
})

describe('buildPdf', () => {
  it('writes a structurally valid PDF with a correct xref table', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    const bytes = buildPdf([{ jpeg, width: 10, height: 14 }, { jpeg, width: 10, height: 14 }], 'Utilities (Oct) — test')
    const text = new TextDecoder('latin1').decode(bytes)
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(text).toContain('/Count 2')
    expect(text).toContain('/Title (Utilities \\(Oct\\) - test)')

    const startxref = Number(/startxref\n(\d+)/.exec(text)![1])
    expect(text.slice(startxref, startxref + 4)).toBe('xref')
    const entries = text.slice(startxref).split('\n').slice(3, 3 + 9)
    entries.forEach((line, i) => {
      const off = Number(line.slice(0, 10))
      expect(text.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`)
    })
  })
})
