/** Month keys are "YYYY-MM"; they sort lexicographically in calendar order. */

/**
 * The supported calendar range, January 2000 to December 2100. Every entry date, closing month, membership
 * month and every month that can be viewed must lie inside it; the month pickers use the same bounds, so the
 * UI never offers a month the accounting rules would reject.
 */
export const MIN_YEAR = 2000
export const MAX_YEAR = 2100
export const MIN_MONTH = `${MIN_YEAR}-01`
export const MAX_MONTH = `${MAX_YEAR}-12`
export const MIN_DATE = `${MIN_MONTH}-01`
export const MAX_DATE = `${MAX_MONTH}-31`

export function isValidDate(date: string): boolean {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const [y, m, d] = date.split('-').map(Number)
  if (y < MIN_YEAR || y > MAX_YEAR || m < 1 || m > 12 || d < 1) return false
  return d <= daysInMonth(y, m)
}

export function isValidMonth(month: string): boolean {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) return false
  const [y, m] = month.split('-').map(Number)
  return y >= MIN_YEAR && y <= MAX_YEAR && m >= 1 && m <= 12
}

/** `n` months from `month`, or null if that leaves the supported range. Handles year boundaries. */
export function stepMonth(month: string, n: number): string | null {
  if (!isValidMonth(month)) return null
  const next = addMonths(month, n)
  return isValidMonth(next) ? next : null
}

/** A month typed or picked by the user ("YYYY-MM", surrounding spaces ignored), or null if invalid or unsupported. */
export function parseMonthInput(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return isValidMonth(v) ? v : null
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export function monthOf(date: string): string {
  return date.slice(0, 7)
}

export function monthIndex(month: string): number {
  const [y, m] = month.split('-').map(Number)
  return y * 12 + (m - 1)
}

export function addMonths(month: string, n: number): string {
  const idx = monthIndex(month) + n
  const y = Math.floor(idx / 12)
  const m = (idx % 12) + 1
  return `${y}-${String(m).padStart(2, '0')}`
}

/** Inclusive list of months from `from` to `to`; empty when from > to. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = []
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m)
  return out
}

export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function currentMonth(now = new Date()): string {
  return toDateKey(now).slice(0, 7)
}

export function lastDayOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${month}-${String(daysInMonth(y, m)).padStart(2, '0')}`
}

const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const shortMonthFmt = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

function toUtc(month: string, day = 1): Date {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day))
}

export function monthLabel(month: string): string {
  return monthFmt.format(toUtc(month))
}

export function shortMonthLabel(month: string): string {
  return shortMonthFmt.format(toUtc(month))
}

export function dayLabel(date: string): string {
  return dayFmt.format(toUtc(date.slice(0, 7), Number(date.slice(8, 10))))
}
