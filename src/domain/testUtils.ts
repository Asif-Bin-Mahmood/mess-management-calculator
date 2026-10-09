import { monthOf } from './month'
import type { LedgerId, MemberId, Transaction, TxType, UtilityCategory } from './types'

let seq = 0

/** Test helper: builds a valid transaction. Amount is given in taka for readability. */
export function tx(
  ledger: LedgerId,
  type: TxType,
  taka: number,
  date: string,
  extra: { memberId?: MemberId; category?: UtilityCategory; description?: string; deletedAt?: number } = {},
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
