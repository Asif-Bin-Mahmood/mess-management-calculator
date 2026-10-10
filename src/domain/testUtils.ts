import { LEGACY_MEMBER_IDS, legacyCategories, legacyMembers, type CategoryId, type Member, type MemberId } from './household'
import { monthOf } from './month'
import type { LedgerId, Transaction, TxType } from './types'
import type { TxContext } from './validate'

let seq = 0

/** The household of an upgraded v1.1.1 installation: the four original members sharing since the beginning. */
export const R4: Member[] = legacyMembers()
/** The five original Utilities categories. */
export const CATS5 = legacyCategories()
export const CTX4: TxContext = { roster: R4, categories: CATS5 }
export const IDS4 = LEGACY_MEMBER_IDS

/** A roster of `n` members sharing since the beginning (ids m1…mn). */
export function roster(n: number, periods: Member['periods'] = [{}]): Member[] {
  return Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, name: `Person ${i + 1}`, seq: i, createdAt: 0, periods: periods.map((p) => ({ ...p })) }))
}

/** Test helper: builds a valid transaction. Amount is given in taka for readability. */
export function tx(
  ledger: LedgerId,
  type: TxType,
  taka: number,
  date: string,
  extra: { memberId?: MemberId; category?: CategoryId; description?: string; deletedAt?: number } = {},
): Transaction {
  seq += 1
  return {
    id: `t${seq}`,
    ledger,
    type,
    amount: Math.round(taka * 100),
    date,
    month: monthOf(date),
    createdAt: seq,
    updatedAt: seq,
    ...extra,
  }
}
