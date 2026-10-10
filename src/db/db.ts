import Dexie, { type EntityTable } from 'dexie'
import { LEGACY_DEFAULT_NAMES, LEGACY_MEMBER_NAMES, legacyCategories, legacyMembers, type Category, type Member } from '../domain/household'
import type { LedgerId, MonthClosing, Transaction } from '../domain/types'

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'restore'
  | 'import'
  | 'close'
  | 'undo-close'
  | 'undo-import'
  /** v1.1.1: the four display names were changed (note holds before/after). */
  | 'rename-members'
  | 'household-setup'
  | 'member-add'
  | 'member-update'
  | 'member-delete'
  | 'category-add'
  | 'category-update'
  | 'category-delete'

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
  memberBefore?: Member
  memberAfter?: Member
  categoryBefore?: Category
  categoryAfter?: Category
  note?: string
}

export interface MetaEntry {
  key: string
  value: unknown
}

export const DB_NAME = 'mess-ledger'
/** v1.1.1 stored the four display names here; read once by the v4 upgrade (and by undo of a v1.1.1 restore). */
export const MEMBER_NAMES_KEY = 'memberNames'

export class MessDb extends Dexie {
  transactions!: EntityTable<Transaction, 'id'>
  audit!: EntityTable<AuditEntry, 'seq'>
  meta!: EntityTable<MetaEntry, 'key'>
  closings!: EntityTable<MonthClosing, 'id'>
  members!: EntityTable<Member, 'id'>
  categories!: EntityTable<Category, 'id'>

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
    // v4: configurable household. Members and Utilities categories become records with permanent ids.
    // An existing installation keeps its four original member ids (sharing since the beginning, so every
    // balance stays identical), the names it shows, and the five original categories under their original ids.
    // Transactions, closings and the audit trail are not modified. A fresh installation starts empty and
    // shows the household setup.
    this.version(4)
      .stores({ members: 'id', categories: 'id' })
      .upgrade(async (tx) => {
        const hasData = (await tx.table('transactions').count()) + (await tx.table('closings').count()) > 0
        const stored = (await tx.table('meta').get(MEMBER_NAMES_KEY))?.value as Record<string, string> | undefined
        if (!hasData && !stored) return
        const now = Date.now()
        const names = { ...(hasData ? LEGACY_MEMBER_NAMES : LEGACY_DEFAULT_NAMES), ...(stored ?? {}) }
        if ((await tx.table('members').count()) === 0) await tx.table('members').bulkAdd(legacyMembers(names, now))
        if ((await tx.table('categories').count()) === 0) await tx.table('categories').bulkAdd(legacyCategories(now))
        await tx.table('meta').delete(MEMBER_NAMES_KEY)
      })
  }
}

// The live-query cache is disabled (constructor option): queries simply re-run after each commit, so large
// bulk writes such as a backup restore are not also applied to cached query results on the main thread.
export const db = new MessDb()
