import type { Poisha } from './types'

/** Largest accepted single amount: ৳ 1,00,00,000 (one crore). */
export const MAX_AMOUNT: Poisha = 1_00_00_000 * 100

/**
 * Parses user input such as "1,250", "৳ 99.5" or "0.75" into poisha.
 * Returns null for anything that is not a non-negative amount with at most two decimals.
 */
export function parseTaka(input: string): Poisha | null {
  const s = input.replace(/[৳,\s]/g, '')
  if (!/^\d{1,9}(\.\d{0,2})?$/.test(s) && !/^\.\d{1,2}$/.test(s)) return null
  const [intPart, frac = ''] = s.split('.')
  return Number(intPart || '0') * 100 + Number((frac + '00').slice(0, 2))
}

const groupFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

/**
 * Formats poisha as Bangladeshi taka with lakh grouping, e.g. 12550050 → "৳1,25,500.50".
 * `decimals: 'auto'` drops ".00" for whole amounts.
 */
export function formatTaka(
  p: Poisha,
  opts: { decimals?: 'auto' | 'always'; sign?: boolean } = {},
): string {
  const { decimals = 'auto', sign = false } = opts
  const abs = Math.abs(p)
  const whole = Math.floor(abs / 100)
  const frac = abs % 100
  let out = '৳' + groupFmt.format(whole)
  if (decimals === 'always' || frac !== 0) out += '.' + String(frac).padStart(2, '0')
  if (p < 0) return '−' + out
  if (sign && p > 0) return '+' + out
  return out
}

/** Value for an <input> when editing an existing amount. */
export function poishaToInput(p: Poisha): string {
  const whole = Math.floor(p / 100)
  const frac = p % 100
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`
}

/** Like parseTaka but accepts a leading minus sign (for opening balances and cash). */
export function parseSignedTaka(input: string): Poisha | null {
  const s = input.trim().replace(/^[−–]/, '-')
  const neg = s.startsWith('-')
  const p = parseTaka(neg ? s.slice(1) : s)
  if (p === null) return null
  return neg ? -p : p
}

export function signedToInput(p: Poisha): string {
  return (p < 0 ? '-' : '') + poishaToInput(Math.abs(p))
}
