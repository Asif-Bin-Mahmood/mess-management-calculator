import { describe, expect, it } from 'vitest'
import { buildClosing, computeLedgerMonth, monthClosingStatus, nextMonthToClose } from './ledger'
import { currentMonth } from './month'
import { R4, tx } from './testUtils'
import type { LedgerId, MonthClosing, Transaction } from './types'

const close = (ledger: LedgerId, sourceMonth: string, closings: MonthClosing[] = []) =>
  buildClosing({ ledger, sourceMonth, method: 'carry', cashMode: 'carry' }, R4, [], closings, `${ledger}-${sourceMonth}`, 1)

const sepAndOct: Transaction[] = [
  tx('bazar', 'contribution', 1000, '2026-09-02', { memberId: 'asif' }),
  tx('bazar', 'expense', 400, '2026-10-03'),
  tx('utilities', 'expense', 100, '2026-08-05', { category: 'gas' }),
]

describe('dashboard closing action (the month-closing option must be reachable)', () => {
  // Device local date 9 Oct 2026.
  const today = currentMonth(new Date(2026, 9, 9, 12, 0))

  it('on the current month (October), offers to close September instead of hiding the action', () => {
    expect(today).toBe('2026-10')
    expect(monthClosingStatus('bazar', '2026-10', sepAndOct, [], today)).toEqual({ kind: 'pending', month: '2026-09' })
  })

  it('viewing September offers Close for September', () => {
    expect(monthClosingStatus('bazar', '2026-09', sepAndOct, [], today)).toEqual({ kind: 'can-close', month: '2026-09' })
  })

  it('October cannot be closed before 1 November 2026', () => {
    const sep = close('bazar', '2026-09')
    expect(monthClosingStatus('bazar', '2026-10', sepAndOct, [sep], today)).toEqual({ kind: 'not-yet', availableFrom: '2026-11-01' })
    // From 1 November it is offered.
    const nov1 = currentMonth(new Date(2026, 10, 1, 0, 0))
    expect(monthClosingStatus('bazar', '2026-10', sepAndOct, [sep], nov1)).toEqual({ kind: 'can-close', month: '2026-10' })
  })

  it('a closed month shows its status (with its closing record for Undo)', () => {
    const sep = close('bazar', '2026-09')
    const st = monthClosingStatus('bazar', '2026-09', sepAndOct, [sep], today)
    expect(st).toEqual({ kind: 'closed', closing: sep })
  })

  it('an undone closing makes the month closable again', () => {
    const sep = { ...close('bazar', '2026-09'), undoneAt: 5 }
    expect(monthClosingStatus('bazar', '2026-09', sepAndOct, [sep], today)).toEqual({ kind: 'can-close', month: '2026-09' })
  })

  it('suggests the previous month, not the oldest unclosed one', () => {
    const many = [...sepAndOct, tx('bazar', 'expense', 10, '2024-01-01')]
    expect(nextMonthToClose('bazar', many, [], today)).toBe('2026-09')
    // Older months stay closable from their own view, in order.
    expect(monthClosingStatus('bazar', '2026-06', many, [], today)).toEqual({ kind: 'can-close', month: '2026-06' })
    const sep = close('bazar', '2026-09')
    expect(nextMonthToClose('bazar', many, [sep], today)).toBeNull() // previous month already closed
  })

  it('no suggestion when the ledger has no entries before the current month', () => {
    const onlyOct = [tx('bazar', 'expense', 400, '2026-10-03')]
    expect(nextMonthToClose('bazar', onlyOct, [], today)).toBeNull()
  })

  it('a later closed month blocks closing an earlier one', () => {
    const sep = close('bazar', '2026-09')
    // Viewing August with September closed: August cannot be closed; nothing earlier is pending.
    expect(monthClosingStatus('bazar', '2026-08', sepAndOct, [sep], today)).toMatchObject({ kind: 'blocked' })
  })

  it('nothing to close for an empty ledger', () => {
    expect(nextMonthToClose('bazar', [], [], today)).toBeNull()
    expect(monthClosingStatus('bazar', '2026-10', [], [], today)).toEqual({ kind: 'not-yet', availableFrom: '2026-11-01' })
  })

  it('Utilities and Bazar are judged independently', () => {
    const bazarSep = close('bazar', '2026-09')
    // Bazar's September closing does not close Utilities' September.
    expect(nextMonthToClose('bazar', sepAndOct, [bazarSep], today)).toBeNull()
    expect(nextMonthToClose('utilities', sepAndOct, [bazarSep], today)).toBe('2026-09')
    expect(monthClosingStatus('utilities', '2026-10', sepAndOct, [bazarSep], today)).toEqual({ kind: 'pending', month: '2026-09' })
    const utilSep = close('utilities', '2026-09')
    expect(nextMonthToClose('bazar', sepAndOct, [utilSep], today)).toBe('2026-09')
  })
})

describe('engine cost at realistic volume', () => {
  it('computes a month from three years of history quickly', () => {
    const rows: Transaction[] = []
    for (let y = 2023; y <= 2026; y++)
      for (let m = 1; m <= 12; m++) {
        const month = `${y}-${String(m).padStart(2, '0')}`
        for (let i = 0; i < 70; i++) rows.push(tx('bazar', i < 4 ? 'contribution' : 'expense', 50 + i, `${month}-10`, i < 4 ? { memberId: (['asif', 'dipu', 'yusha', 'ovi'] as const)[i] } : {}))
      }
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) computeLedgerMonth('bazar', R4, rows, '2026-12')
    const perCall = (performance.now() - t0) / 20
    expect(rows.length).toBe(3360)
    // Generous budget: catches accidental quadratic behaviour without being flaky.
    expect(perCall).toBeLessThan(50)
  })
})
