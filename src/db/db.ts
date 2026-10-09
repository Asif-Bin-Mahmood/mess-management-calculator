import Dexie, { type EntityTable } from 'dexie'
import type { LedgerId, MonthClosing, Transaction } from '../domain/types'

export type AuditAction = 'create' | 'update' | 'delete' | 'restore' | 'import' | 'close' | 'undo-close' | 'undo-import'

export interface AuditEntry {
  seq?: number
  at: number
  action: AuditAction
  /** Transaction id, `closing:<id>` for closings, or `*` / `ledger:<id>` for imports. */
  txId: string
  ledger?: LedgerId
  before?: Transaction
  after?: Transaction
  closingBefore?: MonthClosing
  closingAfter?: MonthClosing
  note?: string
}

export interface MetaEntry {
  key: string
  value: unknown
}

export const DB_NAME = 'mess-ledger'

export class MessDb extends Dexie {
  transactions!: EntityTable<Transaction, 'id'>
  audit!: EntityTable<AuditEntry, 'seq'>
  meta!: EntityTable<MetaEntry, 'key'>
  closings!: EntityTable<MonthClosing, 'id'>

  constructor(name = DB_NAME) {
    super(name)
    // Schema history. Never edit a released version: add db.version(n + 1) with an
    // .upgrade() step instead, so data survives app updates.
    this.version(1).stores({
      transactions: 'id, ledger, [ledger+month], date, updatedAt',
      audit: '++seq, txId, at',
      meta: 'key',
    })
    // v2: persistent month-closing decisions per ledger. Existing data is kept as is; months
    // without a closing record keep the provisional carry-forward they had in v1.
    this.version(2).stores({
      closings: 'id, ledger, [ledger+sourceMonth], createdAt',
    })
  }
}

export const db = new MessDb()
