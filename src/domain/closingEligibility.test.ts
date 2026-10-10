import { describe, expect, it } from 'vitest'
import { analyzeUndo, buildClosing, canClose } from './ledger'
import { currentMonth } from './month'
import { R4, tx } from './testUtils'
import type { LedgerId, MonthClosing } from './types'

const close = (ledger: LedgerId, sourceMonth: string, closings: MonthClosing[] = []) =>
  buildClosing({ ledger, sourceMonth, method: 'carry', cashMode: 'carry' }, R4, [], closings, `${ledger}-${sourceMonth}`, 1)

describe('a month can be closed only after it has ended (device local date)', () => {
  it('last minute of the month vs first minute of the next', () => {
    const lastMinute = currentMonth(new Date(2026, 9, 31, 23, 59, 59)) // local 31 Oct 23:59:59
    const firstMinute = currentMonth(new Date(2026, 10, 1, 0, 0, 0)) // local 1 Nov 00:00
    expect(lastMinute).toBe('2026-10')
    expect(firstMinute).toBe('2026-11')
    const blocked = canClose('bazar', '2026-10', [], lastMinute)
    expect(blocked).toMatchObject({ ok: false, availableFrom: '2026-11-01' })
    if (!blocked.ok) expect(blocked.reason).toContain('from 1 November 2026')
    expect(canClose('bazar', '2026-10', [], firstMinute)).toEqual({ ok: true })
  })

  it('across the year change', () => {
    const dec31 = currentMonth(new Date(2026, 11, 31, 23, 59, 59))
    const jan1 = currentMonth(new Date(2027, 0, 1, 0, 0, 0))
    expect([dec31, jan1]).toEqual(['2026-12', '2027-01'])
    const blocked = canClose('utilities', '2026-12', [], dec31)
    expect(blocked).toMatchObject({ ok: false, availableFrom: '2027-01-01' })
    if (!blocked.ok) expect(blocked.reason).toContain('1 January 2027')
    expect(canClose('utilities', '2026-12', [], jan1)).toEqual({ ok: true })
    expect(canClose('utilities', '2027-01', [], jan1)).toMatchObject({ ok: false })
  })

  it('future months are never closable', () => {
    expect(canClose('bazar', '2026-12', [], '2026-10')).toMatchObject({ ok: false, availableFrom: '2027-01-01' })
  })

  it('earlier eligible months close in order', () => {
    const now = '2026-11'
    expect(canClose('bazar', '2026-08', [], now)).toEqual({ ok: true })
    const aug = close('bazar', '2026-08')
    expect(canClose('bazar', '2026-09', [aug], now)).toEqual({ ok: true })
    const sep = close('bazar', '2026-09', [aug])
    expect(canClose('bazar', '2026-10', [aug, sep], now)).toEqual({ ok: true })
    // Going backwards is refused while a later month is closed.
    expect(canClose('bazar', '2026-07', [aug, sep], now)).toMatchObject({ ok: false, blockingMonth: '2026-09' })
  })

  it('each ledger is judged on its own closings', () => {
    const now = '2026-11'
    const utilSep = close('utilities', '2026-09')
    // A Utilities closing does not block or allow anything in Bazar.
    expect(canClose('bazar', '2026-08', [utilSep], now)).toEqual({ ok: true })
    expect(canClose('utilities', '2026-08', [utilSep], now)).toMatchObject({ ok: false, blockingMonth: '2026-09' })
    expect(canClose('bazar', '2026-09', [utilSep], now)).toEqual({ ok: true })
    expect(canClose('utilities', '2026-09', [utilSep], now)).toMatchObject({ ok: false })
  })

  it('still refuses to undo an older closing while a later one remains', () => {
    const txs = [tx('bazar', 'expense', 100, '2026-08-02')]
    const aug = close('bazar', '2026-08')
    const sep = close('bazar', '2026-09', [aug])
    expect(analyzeUndo(aug, R4, txs, [aug, sep], '2026-11').blockedBy.map((c) => c.sourceMonth)).toEqual(['2026-09'])
    expect(analyzeUndo(sep, R4, txs, [aug, sep], '2026-11').blockedBy).toEqual([])
    // A later closing in the other ledger does not block.
    const utilSep = close('utilities', '2026-09')
    expect(analyzeUndo(aug, R4, txs, [aug, utilSep], '2026-11').blockedBy).toEqual([])
  })
})
