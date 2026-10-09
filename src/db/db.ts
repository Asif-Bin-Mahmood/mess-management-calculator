import Dexie, { type EntityTable } from 'dexie'
import { LEGACY_MEMBER_NAMES, type LedgerId, type MonthClosing, type Transaction } from '../domain/types'

export type AuditAction = 'create' | 'update' | 'delete' | 'restore' | 'import' | 'close' | 'undo-close' | 'undo-import' | 'rename-members'

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
export const MEMBER_NAMES_KEY = 'memberNames'

export class MessDb extends Dexie {
  transactions!: EntityTable<Transaction, 'id'>
  audit!: EntityTable<AuditEntry, 'seq'>
  meta!: EntityTable<MetaEntry, 'key'>
  closings!: EntityTable<MonthClosing, 'id'>

  constructor(name = DB_NAME) {
    super(name, { cache: 'disabled' })
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
    // v3: member display names became configurable (meta key 'memberNames'). Installations that already
    // hold records keep the names they have always shown; fresh installations start with neutral names.
    this.version(3)
      .stores({})
      .upgrade(async (tx) => {
        const hasData = (await tx.table('transactions').count()) + (await tx.table('closings').count()) > 0
        if (hasData && !(await tx.table('meta').get(MEMBER_NAMES_KEY))) {
          await tx.table('meta').put({ key: MEMBER_NAMES_KEY, value: { ...LEGACY_MEMBER_NAMES } })
        }
      })
  }
}

// The live-query cache is disabled (constructor option): queries simply re-run after each commit, so large
// bulk writes such as a backup restore are not also applied to cached query results on the main thread.
export const db = new MessDb()
