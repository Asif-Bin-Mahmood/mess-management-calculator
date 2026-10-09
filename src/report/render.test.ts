import { describe, expect, it } from 'vitest'
import { buildClosing } from '../domain/ledger'
import { tx } from '../domain/testUtils'
import type { MonthClosing, Transaction } from '../domain/types'
import { layoutReport, PAGE_H } from './render'
import { buildReport } from './reportModel'

/** A canvas stand-in that records every string drawn, with a crude text measure. */
function fakeCanvas(w: number, h: number) {
  const texts: string[] = []
  let size = 20
  const ctx = {
    set font(f: string) {
      size = Number(/(\d+)px/.exec(f)?.[1] ?? 20)
    },
    fillStyle: '',
    textAlign: '',
    textBaseline: '',
    fillRect() {},
    beginPath() {},
    roundRect() {},
    fill() {},
    fillText(s: string) {
      texts.push(s)
    },
    measureText(s: string) {
      return { width: s.length * size * 0.55 }
    },
  }
  return { width: w, height: h, texts, getContext: () => ctx as unknown as CanvasRenderingContext2D }
}

const textOf = (pages: ReturnType<typeof fakeCanvas>[]) => pages.flatMap((p) => p.texts).join('\n')
const count = (text: string, needle: string) => text.split(needle).length - 1

const data: Transaction[] = [
  tx('utilities', 'contribution', 2000, '2026-09-01', { memberId: 'asif' }),
  tx('utilities', 'expense', 1200, '2026-09-03', { category: 'gas', description: 'UTIL-ONLY-NOTE' }),
  tx('utilities', 'expense', 300, '2026-10-04', { category: 'wifi', description: 'UTIL-OCT-NOTE' }),
  tx('bazar', 'contribution', 5000, '2026-09-01', { memberId: 'dipu' }),
  tx('bazar', 'expense', 3999, '2026-09-05', { description: 'BAZAR-ONLY-NOTE' }),
  tx('bazar', 'expense', 100, '2026-10-05', { description: 'BAZAR-OCT-NOTE' }),
]
const closings: MonthClosing[] = [
  buildClosing({ ledger: 'utilities', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived', cashMode: 'carry', note: 'Agreed at meeting' }, data, [], 'cu', 1),
  buildClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'carry', cashMode: 'carry' }, data, [], 'cb', 2),
]

/** Sections and wording that the concise default report must not contain. */
const REMOVED = ['OPENING BALANCES', 'RECONCILIATION', 'Cash held by the manager', 'Manager’s note', 'Closed on', 'Set by the closing', 'leftover', 'poisha', 'snapshot', 'Explained by']

describe('concise report — content per ledger', () => {
  it('Utilities: header, summary, members, categories; only Utilities data', () => {
    for (const paginate of [false, true]) {
      const text = textOf(layoutReport(buildReport('utilities', '2026-09', data, closings), fakeCanvas, paginate))
      expect(text).toContain('Utilities — September 2026')
      for (const label of ['Total collected', 'Total spent', 'Cash in hand', 'MEMBERS', 'Contributed', 'Due / will receive', 'BY CATEGORY']) expect(text).toContain(label)
      for (const c of ['Service Charge', 'Current Bill', 'Gas Bill', 'Wi-Fi Bill', 'Others']) expect(text).toContain(c)
      for (const m of ['Asif', 'Dipu', 'Yusha', 'Ovi']) expect(text).toContain(m)
      expect(text).toContain('Will receive ৳1,700.00') // Asif: 2000 − 300 share
      expect(text).not.toContain('Bazar')
      expect(text).not.toContain('৳5,000') // Bazar contribution amount
      expect(text).not.toContain('UTIL-ONLY-NOTE') // entries are optional
      for (const r of REMOVED) expect(text).not.toContain(r)
    }
  })

  it('Bazar: no Utilities categories or data', () => {
    for (const paginate of [false, true]) {
      const text = textOf(layoutReport(buildReport('bazar', '2026-09', data, closings), fakeCanvas, paginate))
      expect(text).toContain('Bazar — September 2026')
      for (const c of ['BY CATEGORY', 'Service Charge', 'Current Bill', 'Gas Bill', 'Wi-Fi Bill', 'Utilities', 'UTIL-ONLY-NOTE']) expect(text).not.toContain(c)
      for (const r of REMOVED) expect(text).not.toContain(r)
    }
  })

  it('optional entries stay within their own ledger', () => {
    const u = textOf(layoutReport(buildReport('utilities', '2026-09', data, closings), fakeCanvas, true, { includeTransactions: true }))
    expect(u).toContain('UTIL-ONLY-NOTE')
    expect(u).not.toContain('BAZAR-ONLY-NOTE')
    const b = textOf(layoutReport(buildReport('bazar', '2026-09', data, closings), fakeCanvas, false, { includeTransactions: true }))
    expect(b).toContain('BAZAR-ONLY-NOTE')
    expect(b).not.toContain('UTIL-ONLY-NOTE')
  })

  it('a shortage is shown once as “Cash short” with its amount, with no extra warning', () => {
    const short = [...data, tx('bazar', 'expense', 2000, '2026-09-20')]
    const text = textOf(layoutReport(buildReport('bazar', '2026-09', short, []), fakeCanvas, false))
    expect(text).toContain('Cash short')
    expect(count(text, '৳999.00')).toBe(1) // 5000 − 3999 − 2000 = −999
    expect(text).not.toContain('Cash in hand')
    expect(text).not.toContain('Attention')
  })

  it('a waiver alone needs no attention note (it is recorded and explained)', () => {
    const text = textOf(layoutReport(buildReport('utilities', '2026-10', data, closings), fakeCanvas, false))
    expect(text).not.toContain('Attention')
  })

  it('paginates the optional entry list without losing or repeating entries', () => {
    const many = Array.from({ length: 150 }, (_, i) =>
      tx('bazar', 'expense', 10 + i, `2026-08-${String(1 + (i % 28)).padStart(2, '0')}`, { description: `ROW-${String(i).padStart(3, '0')}` }),
    )
    const pages = layoutReport(buildReport('bazar', '2026-08', many), fakeCanvas, true, { includeTransactions: true })
    expect(pages.length).toBeGreaterThan(3)
    for (const p of pages) expect(p.height).toBe(PAGE_H)
    const all = pages.flatMap((p) => p.texts)
    for (let i = 0; i < 150; i++) expect(all.filter((s) => s === `ROW-${String(i).padStart(3, '0')}`)).toHaveLength(1)
    pages.forEach((p, i) => expect(p.texts).toContain(`Page ${i + 1} of ${pages.length}`))
    const first = pages.findIndex((p) => p.texts.includes('ENTRIES (150)'))
    expect(first).toBeGreaterThanOrEqual(0)
    for (const p of pages.slice(first + 1)) expect(p.texts.some((s) => s.includes('(continued)'))).toBe(true)
    // The default report for the same month fits on one page.
    expect(layoutReport(buildReport('bazar', '2026-08', many), fakeCanvas, true)).toHaveLength(1)
    const image = layoutReport(buildReport('bazar', '2026-08', many), fakeCanvas, false, { includeTransactions: true })
    expect(image).toHaveLength(1)
    expect(image[0].height).toBeGreaterThan(PAGE_H * 3)
  })

  it('does not modify the data it reports on', () => {
    const frozen = data.map((t) => Object.freeze({ ...t }))
    Object.freeze(frozen)
    const fc = closings.map((c) => Object.freeze({ ...c }))
    const snapshot = JSON.stringify([frozen, fc])
    layoutReport(buildReport('utilities', '2026-10', frozen, fc), fakeCanvas, true, { includeTransactions: true })
    layoutReport(buildReport('bazar', '2026-10', frozen, fc), fakeCanvas, false)
    expect(JSON.stringify([frozen, fc])).toBe(snapshot)
  })
})

describe('concise report after a late correction to a closed month', () => {
  it('states once that cash needs review, with the amount, and never claims the accounts balance', () => {
    const base = data.filter((t) => t.ledger === 'utilities')
    const c = buildClosing({ ledger: 'utilities', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived', cashMode: 'set', openingCash: 800_00 }, base, [], 'cl', 1)
    const late = [...base, tx('utilities', 'expense', 400, '2026-09-29', { category: 'others' })]
    const r = buildReport('utilities', '2026-10', late, [c])
    expect(r.summary.reconciliation.unexplained).toBe(-400_00)
    for (const paginate of [false, true]) {
      const text = layoutReport(r, fakeCanvas, paginate).flatMap((p) => p.texts).join(' ') // wrapped lines read as one
      expect(count(text, 'Attention:')).toBe(1)
      expect(text).toContain('Attention: September cash needs review — correction after closing · ৳400 difference.')
      expect(text).not.toMatch(/Balanced|Reconciled|✓/)
    }
  })
})
