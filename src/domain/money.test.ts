import { describe, expect, it } from 'vitest'
import { formatTaka, parseTaka, poishaToInput } from './money'
import { addMonths, dayLabel, isValidDate, monthLabel, monthRange } from './month'
import { validateTransaction, validateTxInput } from './validate'
import { tx } from './testUtils'

describe('parseTaka', () => {
  it.each([
    ['0', 0],
    ['1', 100],
    ['1250', 125000],
    ['1,250.5', 125050],
    ['৳ 99.99', 9999],
    ['.75', 75],
    ['10.', 1000],
  ])('parses %s', (input, expected) => {
    expect(parseTaka(input)).toBe(expected)
  })

  it.each(['', 'abc', '-5', '1.234', '1e5', '1.2.3', '9999999999'])('rejects %s', (input) => {
    expect(parseTaka(input)).toBeNull()
  })
})

describe('formatTaka', () => {
  it('uses taka sign and lakh grouping', () => {
    expect(formatTaka(12550050)).toBe('৳1,25,500.50')
    expect(formatTaka(10000000)).toBe('৳1,00,000')
    expect(formatTaka(10000000, { decimals: 'always' })).toBe('৳1,00,000.00')
    expect(formatTaka(-5)).toBe('−৳0.05')
    expect(formatTaka(500, { sign: true })).toBe('+৳5')
    expect(formatTaka(0)).toBe('৳0')
  })

  it('round-trips through the input format', () => {
    for (const p of [0, 5, 100, 12345, 99999999]) expect(parseTaka(poishaToInput(p))).toBe(p)
  })
})

describe('months', () => {
  it('handles year boundaries', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(monthRange('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02'])
    expect(monthRange('2026-03', '2026-02')).toEqual([])
  })

  it('validates real dates', () => {
    expect(isValidDate('2026-02-28')).toBe(true)
    expect(isValidDate('2026-02-29')).toBe(false)
    expect(isValidDate('2028-02-29')).toBe(true)
    expect(isValidDate('2026-13-01')).toBe(false)
  })

  it('labels months and days', () => {
    expect(monthLabel('2026-10')).toBe('October 2026')
    expect(dayLabel('2026-10-09')).toBe('Fri 9 Oct')
  })
})

describe('validation', () => {
  it('requires a member for contributions and a category for utility expenses', () => {
    expect(validateTxInput({ ledger: 'bazar', type: 'contribution', amount: 100, date: '2026-01-01' }).memberId).toBeTruthy()
    expect(validateTxInput({ ledger: 'utilities', type: 'expense', amount: 100, date: '2026-01-01' }).category).toBeTruthy()
    expect(validateTxInput({ ledger: 'utilities', type: 'expense', amount: 100, date: '2026-01-01', category: 'gas' })).toEqual({})
  })

  it('rejects categories on Bazar expenses', () => {
    expect(validateTxInput({ ledger: 'bazar', type: 'expense', amount: 100, date: '2026-01-01', category: 'gas' }).category).toBeTruthy()
  })

  it('rejects zero, negative and fractional amounts', () => {
    for (const amount of [0, -1, 1.5, Number.NaN]) {
      expect(validateTxInput({ ledger: 'bazar', type: 'expense', amount, date: '2026-01-01' }).amount).toBeTruthy()
    }
  })

  it('validates stored records strictly', () => {
    const ok = tx('bazar', 'expense', 10, '2026-01-01')
    expect(validateTransaction(ok)).toEqual([])
    expect(validateTransaction({ ...ok, month: '2026-02' })).toContain('month does not match date')
    expect(validateTransaction({ ...ok, extra: 1 })).toContain('unexpected field "extra"')
    expect(validateTransaction(null)).toEqual(['not an object'])
  })
})
