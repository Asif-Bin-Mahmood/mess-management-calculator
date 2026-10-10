import { currentMonth, parseMonthInput } from '../domain/month'

/**
 * The month selected when the app starts: the saved month if it is a valid month of the supported range,
 * otherwise the current month. A valid month is never moved to some data-dependent window.
 */
export function initialMonth(saved: unknown, now = new Date()): string {
  return parseMonthInput(saved) ?? currentMonth(now)
}
