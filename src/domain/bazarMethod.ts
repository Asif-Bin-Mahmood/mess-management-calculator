/**
 * Bazar accounting methods.
 *
 * - Cash method (v1.2.0 and earlier): members contribute cash to a shared pool; expenses are paid from it.
 * - Member-paid method: each Bazar entry records what one member personally paid for shared Bazar
 *   purchases. There is no shared cash. A month's total Bazar is split equally among the members sharing
 *   that month; each member's balance changes by (paid − share). Members settle balances with each other
 *   through settlement entries, which are not Bazar spending.
 *
 * The member-paid method applies from `memberPaidFrom` (inclusive) onwards; earlier months keep the cash method
 * and their v1.2.0 figures. Utilities always uses the cash method.
 */
import { isValidMonth } from './month'
import type { LedgerId } from './types'

export interface BazarMethod {
  /** First month (YYYY-MM) recorded with the member-paid method. */
  memberPaidFrom: string
}

export function isMemberPaidMonth(method: BazarMethod | null | undefined, ledger: LedgerId, month: string): boolean {
  return ledger === 'bazar' && !!method && month >= method.memberPaidFrom
}

/** Structural check of a stored or imported method record; returns a problem or null. */
export function bazarMethodProblem(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid Bazar method'
  const m = raw as Partial<BazarMethod>
  if (typeof m.memberPaidFrom !== 'string' || !isValidMonth(m.memberPaidFrom)) return 'invalid Bazar method start month'
  if (Object.keys(m).some((k) => k !== 'memberPaidFrom')) return 'unexpected field in Bazar method'
  return null
}
