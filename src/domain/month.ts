/** Month keys are "YYYY-MM"; they sort lexicographically in calendar order. */

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const [y, m, d] = date.split('-').map(Number)
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1) return false
  return d <= daysInMonth(y, m)
}

export function isValidMonth(month: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(month)) return false
  const [y, m] = month.split('-').map(Number)
  return y >= 2000 && y <= 2100 && m >= 1 && m <= 12
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
