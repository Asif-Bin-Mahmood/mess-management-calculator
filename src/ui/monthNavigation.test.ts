import 'fake-indexeddb/auto'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import golden from '../domain/__fixtures__/legacy-v1.1.1-golden.json'
import { legacyCategories, legacyMembers, setHouseholdDisplay, type Member } from '../domain/household'
import { analyzeRosterChange, buildClosing, computeHistory, computeLedgerMonth, monthClosingStatus } from '../domain/ledger'
import { addMonths, currentMonth, isValidDate, isValidMonth, MAX_DATE, MAX_MONTH, MIN_DATE, MIN_MONTH, monthLabel, parseMonthInput, stepMonth } from '../domain/month'
import { CATS5, R4, tx } from '../domain/testUtils'
import type { MonthClosing, Transaction } from '../domain/types'
import { validateTxInput } from '../domain/validate'
import { buildReport } from '../report/reportModel'
import { MonthSwitcher } from './common'
import { AppContext, type AppState } from './context'
import { initialMonth } from './monthState'
import { Home } from './screens/Home'
import { Ledger } from './screens/Ledger'
import { Reports } from './screens/Reports'

setHouseholdDisplay(legacyMembers(), legacyCategories())

const txs: Transaction[] = [
  tx('bazar', 'contribution', 1000, '2026-03-02', { memberId: 'asif' }),
  tx('bazar', 'expense', 400, '2026-03-05'),
  tx('utilities', 'expense', 200, '2026-03-06', { category: 'gas' }),
  tx('bazar', 'expense', 100, '2026-06-01'),
]

/** Deep-freezes the inputs: any attempt by a computation to modify a record throws. */
function frozen<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(frozen)
    Object.freeze(v)
  }
  return v
}

describe('supported month range and navigation', () => {
  it('has one documented range shared by validation and the pickers', () => {
    expect([MIN_MONTH, MAX_MONTH, MIN_DATE, MAX_DATE]).toEqual(['2000-01', '2100-12', '2000-01-01', '2100-12-31'])
    expect(isValidMonth(MIN_MONTH) && isValidMonth(MAX_MONTH)).toBe(true)
    expect(isValidDate(MIN_DATE) && isValidDate(MAX_DATE)).toBe(true)
    expect(isValidMonth('1999-12') || isValidMonth('2101-01')).toBe(false)
    // The entry form cannot save a date outside the range either.
    const entry = (date: string) => validateTxInput({ ledger: 'bazar', type: 'expense', amount: 100, date }, { roster: R4, categories: CATS5, entry: true })
    expect(entry('1999-12-31').date).toBeTruthy()
    expect(entry('2101-01-01').date).toBeTruthy()
    expect(entry('2000-01-01')).toEqual({})
    expect(entry('2100-12-31')).toEqual({})
  })

  it('steps across December–January and January–December, in any year', () => {
    expect(stepMonth('2026-12', 1)).toBe('2027-01')
    expect(stepMonth('2027-01', -1)).toBe('2026-12')
    expect(stepMonth('2009-12', 1)).toBe('2010-01')
    expect(stepMonth('2045-01', -1)).toBe('2044-12')
    expect(stepMonth('2026-05', 13)).toBe('2027-06')
    expect(stepMonth('2026-05', -29)).toBe('2023-12')
    // Stops at the edges of the supported range.
    expect(stepMonth(MIN_MONTH, -1)).toBeNull()
    expect(stepMonth(MAX_MONTH, 1)).toBeNull()
    expect(stepMonth('2026-13', 1)).toBeNull()
  })

  it.each([
    ['2031-02', '2031-02'],
    [' 2005-11 ', '2005-11'],
    ['2000-01', '2000-01'],
    ['2100-12', '2100-12'],
    ['1999-12', null],
    ['2101-01', null],
    ['2026-13', null],
    ['2026-00', null],
    ['2026-1', null],
    ['2026-01-05', null],
    ['', null],
    ['January', null],
    [42, null],
    [null, null],
    [undefined, null],
  ])('parses picker input %j as %j', (input, want) => {
    expect(parseMonthInput(input)).toBe(want)
  })

  it('keeps any valid saved month (past, before the first entry, or future); only invalid values fall back', () => {
    const now = new Date('2026-10-15T12:00:00')
    expect(initialMonth('2005-03', now)).toBe('2005-03') // long before any entry: not clamped
    expect(initialMonth('2040-07', now)).toBe('2040-07') // far future: not clamped
    expect(initialMonth('2026-02', now)).toBe('2026-02')
    expect(initialMonth('2026-13', now)).toBe('2026-10')
    expect(initialMonth('1990-01', now)).toBe('2026-10')
    expect(initialMonth(null, now)).toBe('2026-10')
  })
})

describe('viewing any month', () => {
  it.each(['utilities', 'bazar'] as const)('%s: a month before the first entry shows zeros', (ledger) => {
    const s = computeLedgerMonth(ledger, R4, txs, '2019-04')
    expect(s).toMatchObject({ month: '2019-04', transactionCount: 0, openingCash: 0, remainingCash: 0, totalSpent: 0 })
    expect(s.members.every((m) => m.opening === 0 && m.closing === 0)).toBe(true)
  })

  it.each(['utilities', 'bazar'] as const)('%s: an empty month between entries and far-future months carry the figures forward', (ledger) => {
    const march = computeLedgerMonth(ledger, R4, txs, '2026-03')
    for (const month of ['2026-04', '2027-01', '2031-02', '2040-07']) {
      const s = computeLedgerMonth(ledger, R4, txs, month)
      expect(s.transactionCount).toBe(0)
      // The only later entry is a ৳100 Bazar expense in June 2026.
      expect(s.remainingCash).toBe(ledger === 'bazar' && month >= '2026-06' ? march.remainingCash - 100_00 : march.remainingCash)
      expect(s.reconciliation.unexplained).toBe(0)
    }
  })

  it('reports work for historical, empty and future months of both ledgers', () => {
    for (const ledger of ['utilities', 'bazar'] as const) {
      for (const month of ['2004-08', '2026-04', '2031-02']) {
        const r = buildReport(ledger, R4, month, txs, [])
        expect(r.monthLabel).toBe(monthLabel(month))
        expect(r.transactions).toEqual([])
        expect(r.summary.ledger).toBe(ledger)
      }
    }
  })

  it('viewing never modifies data, and the latest supported month computes quickly', () => {
    const data = frozen(structuredClone(golden.transactions) as Transaction[])
    const closings = frozen(structuredClone(golden.closings) as MonthClosing[])
    const t0 = performance.now()
    for (const ledger of ['utilities', 'bazar'] as const) {
      computeHistory(ledger, R4, data, MAX_MONTH, closings)
      computeLedgerMonth(ledger, R4, data, '2001-05', closings)
      buildReport(ledger, R4, '2075-11', data, closings)
    }
    const ms = performance.now() - t0
    expect(data).toEqual(golden.transactions) // unchanged (and frozen: a write would have thrown)
    expect(ms).toBeLessThan(5000)
  })
})

describe('month-closing offers and membership rules are unchanged by wider browsing', () => {
  const today = '2026-10'
  it('does not offer to close empty months long before a ledger starts; does offer the month just before it', () => {
    expect(monthClosingStatus('bazar', '2005-03', txs, [], today)).toEqual({ kind: 'before-start', firstMonth: '2026-03' })
    expect(monthClosingStatus('bazar', '2026-02', txs, [], today)).toMatchObject({ kind: 'can-close', month: '2026-02' })
    expect(monthClosingStatus('bazar', '2026-09', txs, [], today)).toMatchObject({ kind: 'can-close' })
    // Viewing a future month: September 2026 is still waiting to be closed, so that is what is offered.
    expect(monthClosingStatus('bazar', '2031-02', txs, [], today)).toEqual({ kind: 'pending', month: '2026-09' })
    expect(monthClosingStatus('bazar', '2031-02', [], [], today)).toMatchObject({ kind: 'not-yet', availableFrom: '2031-03-01' })
    // An empty ledger can still record verified opening balances for the previous month.
    expect(monthClosingStatus('bazar', '2026-09', [], [], today)).toMatchObject({ kind: 'can-close', month: '2026-09' })
    expect(monthClosingStatus('bazar', '2026-08', [], [], today)).toEqual({ kind: 'before-start', firstMonth: null })
  })

  it('membership changes still may not reach into a closed month of either ledger', () => {
    const close = buildClosing({ ledger: 'utilities', sourceMonth: '2026-06', method: 'carry', cashMode: 'carry' }, R4, txs, [], 'c', 1)
    const add = (from: string): Member[] => [...R4, { id: 'n', name: 'New', seq: 4, createdAt: 0, periods: [{ from }] }]
    expect(analyzeRosterChange(R4, add('2026-06'), txs, [close], today).blockedBy).toBe('2026-06')
    expect(analyzeRosterChange(R4, add('2026-07'), txs, [close], today).blockedBy).toBeNull()
    expect(analyzeRosterChange(R4, add('2031-02'), txs, [close], today).blockedBy).toBeNull()
  })
})

describe('the month picker and the screens that use it', () => {
  const render = (month: string) => renderToStaticMarkup(h(MonthSwitcher, { month, onChange: () => {} }))

  it('offers the whole supported range to the native picker, across year boundaries', () => {
    const dec = render('2026-12')
    expect(dec).toContain('min="2000-01"')
    expect(dec).toContain('max="2100-12"')
    expect(dec).toContain('value="2026-12"')
    expect(dec).toContain('Next month, January 2027')
    expect(dec).toContain('Previous month, November 2026')
    expect(render('2027-01')).toContain('Previous month, December 2026')
    expect(render('2008-06')).toContain('June 2008')
    expect(render('2088-02')).toContain('February 2088')
  })

  it('disables only the arrow that would leave the supported range', () => {
    const first = render(MIN_MONTH)
    const last = render(MAX_MONTH)
    expect(first).toMatch(/aria-label="Previous month"[^>]*disabled|disabled[^>]*aria-label="Previous month"/)
    expect(first).toContain('Next month, February 2000')
    expect(last).toMatch(/aria-label="Next month"[^>]*disabled|disabled[^>]*aria-label="Next month"/)
    expect(last).toContain('Previous month, November 2100')
  })

  it('offers a way back to the current month when another month is shown', () => {
    const now = currentMonth()
    expect(render(now)).not.toContain('Back to this month')
    expect(render(addMonths(now, -40))).toContain(`Back to this month (${monthLabel(now)})`)
  })

  it('Home, both ledgers and Reports all show the one selected month (historical or future), with empty states', () => {
    for (const month of ['2004-08', '2031-02']) {
      const app: AppState = { txs, closings: [], members: R4, categories: CATS5, bazarMethod: null, needsSetup: false, month, setMonth: () => {} }
      const page = (el: ReturnType<typeof h>) => renderToStaticMarkup(h(AppContext.Provider, { value: app }, el))
      const label = monthLabel(month)
      const home = page(h(Home))
      expect(home).toContain(label)
      expect(home).toContain(`No entries in ${label}`)
      for (const ledger of ['utilities', 'bazar'] as const) {
        const screen = page(h(Ledger, { ledger }))
        expect(screen).toContain(label)
        expect(screen).toContain(`No entries in ${label}`)
        const report = page(h(Reports, { ledger }))
        expect(report).toContain(label)
        expect(report).toContain(`entries in ${label}`)
        expect(report).toContain('max="2100-12"')
      }
    }
  })
})
