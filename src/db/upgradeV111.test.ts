import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import golden from '../domain/__fixtures__/legacy-v1.1.1-golden.json'
import { LEGACY_CATEGORIES, LEGACY_MEMBER_IDS } from '../domain/household'
import { computeHistory, type MonthSummary } from '../domain/ledger'
import type { LedgerId, MonthClosing, Transaction } from '../domain/types'
import { checkBackup, createBackup, getRestoreUndo, restoreBackup, undoLastRestore } from './backup'
import { MEMBER_NAMES_KEY, MessDb } from './db'
import { applyMutation, loadHousehold } from './repo'

// End-to-end upgrade of a realistic installation made by app 1.1.1 (Dexie schema v3), through the real database
// code: every record must survive unchanged and every figure must equal the v1.1.1 engine's results.

const txs = golden.transactions as Transaction[]
const closings = golden.closings as MonthClosing[]
const NAMES = { asif: 'Rafi', dipu: 'Sami', yusha: 'Tanvir', ovi: 'Nabil' }
const opened: Dexie[] = []
let n = 0

afterEach(async () => {
  for (const d of opened.splice(0)) await d.delete()
})

class V111Db extends Dexie {
  constructor(name: string) {
    super(name)
    this.version(1).stores({ transactions: 'id, ledger, [ledger+month], date, updatedAt', audit: '++seq, txId, at', meta: 'key' })
    this.version(2).stores({ closings: 'id, ledger, [ledger+sourceMonth], createdAt' })
    this.version(3).stores({})
  }
}

async function v111Install() {
  const name = `v111-${++n}`
  const old = new V111Db(name)
  await old.open()
  await old.table('transactions').bulkAdd(structuredClone(txs))
  await old.table('closings').bulkAdd(structuredClone(closings))
  await old.table('audit').bulkAdd(txs.slice(0, 50).map((t, i) => ({ at: t.createdAt + i, action: 'create', txId: t.id, ledger: t.ledger, after: t })))
  await old.table('audit').add({ at: 9, action: 'rename-members', txId: 'members', note: JSON.stringify({ after: NAMES }) })
  await old.table('meta').bulkPut([
    { key: MEMBER_NAMES_KEY, value: NAMES },
    { key: 'lastBackupAt', value: 1234 },
    // A restore made in 1.1.1 that changed the names; its undo must still work after the upgrade.
    { key: 'lastRestoreUndo', value: { scope: 'bazar', at: 5, backupId: 'old', transactions: txs.filter((t) => t.ledger === 'bazar'), closings: closings.filter((c) => c.ledger === 'bazar'), memberNames: { asif: 'A0', dipu: 'B0', yusha: 'C0', ovi: 'D0' } } },
    { key: 'lastRestoreUndoInfo', value: { scope: 'bazar', at: 5 } },
  ])
  const auditCount = await old.table('audit').count()
  old.close()
  const db = new MessDb(name)
  await db.open()
  opened.push(db)
  return { db, auditCount }
}

const nonZero = (m: Record<string, number> | null) => (m === null ? null : Object.fromEntries(Object.entries(m).filter(([, v]) => v !== 0)))
const compact = (s: MonthSummary) => ({
  month: s.month,
  remainingCash: s.remainingCash,
  members: s.members.map((x) => [x.memberId, x.opening, x.contributed, x.returned, x.share, x.closing]),
  categoryTotals: nonZero(s.categoryTotals),
  reconciliation: s.reconciliation,
})
const expected = (ledger: LedgerId) =>
  golden.expected[ledger].map((s) => ({
    month: s.month,
    remainingCash: s.remainingCash,
    members: s.members,
    categoryTotals: nonZero(s.categoryTotals as Record<string, number> | null),
    reconciliation: s.reconciliation,
  }))

async function figures(db: MessDb) {
  const h = await loadHousehold(db)
  const t = await db.transactions.toArray()
  const c = await db.closings.toArray()
  return { utilities: computeHistory('utilities', h.members, t, '2026-10', c).map(compact), bazar: computeHistory('bazar', h.members, t, '2026-10', c).map(compact) }
}

describe('upgrading a realistic v1.1.1 installation', () => {
  it('keeps every record and the names, creates the original members and categories, and every figure equals v1.1.1', async () => {
    const { db, auditCount } = await v111Install()
    const sortById = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id))
    expect(sortById(await db.transactions.toArray())).toEqual(sortById(txs))
    expect(sortById(await db.closings.toArray())).toEqual(sortById(closings))
    expect(await db.audit.count()).toBe(auditCount)
    expect(await db.meta.get('lastBackupAt')).toMatchObject({ value: 1234 })
    const h = await loadHousehold(db)
    expect(h.members.map((m) => [m.id, m.name, m.seq, m.periods])).toEqual(LEGACY_MEMBER_IDS.map((id, i) => [id, NAMES[id as keyof typeof NAMES], i, [{}]]))
    expect(h.categories.map((c) => [c.id, c.name, c.archivedAt])).toEqual(LEGACY_CATEGORIES.map((c) => [c.id, c.name, undefined]))
    const f = await figures(db)
    expect(f.utilities).toEqual(expected('utilities'))
    expect(f.bazar).toEqual(expected('bazar'))
  })

  it('new entries after the upgrade validate against the original members and categories', async () => {
    const { db } = await v111Install()
    await applyMutation({ kind: 'create', input: { ledger: 'bazar', type: 'contribution', amount: 100, date: '2026-10-02', memberId: 'ovi' } }, db, Date.UTC(2026, 9, 2))
    await applyMutation({ kind: 'create', input: { ledger: 'utilities', type: 'expense', amount: 100, date: '2026-10-02', category: 'gas' } }, db, Date.UTC(2026, 9, 2))
    expect(await db.transactions.count()).toBe(txs.length + 2)
  })

  it('a backup made after the upgrade restores to identical figures on another device', async () => {
    const { db } = await v111Install()
    const file = await createBackup(db)
    const check = checkBackup(JSON.stringify(file))
    expect(check.ok).toBe(true)
    if (!check.ok) return
    const other = new MessDb(`v111-other-${++n}`)
    await other.open()
    opened.push(other)
    await restoreBackup(check.data, other)
    expect(await loadHousehold(other)).toEqual(await loadHousehold(db))
    expect(await figures(other)).toEqual(await figures(db))
  })

  it('a backup file written by v1.1.1 (schema 3) restores to identical figures on a fresh install', async () => {
    const v111File = { app: 'mess-ledger', schemaVersion: 3, backupId: 'v111-file', exportedAt: '2026-10-01T00:00:00.000Z', scope: 'all', transactions: txs, closings, audit: [], memberNames: NAMES }
    const check = checkBackup(JSON.stringify(v111File))
    expect(check.ok).toBe(true)
    if (!check.ok) return
    const fresh = new MessDb(`v111-fresh-${++n}`)
    await fresh.open()
    opened.push(fresh)
    await restoreBackup(check.data, fresh)
    expect((await loadHousehold(fresh)).members.map((m) => m.name)).toEqual(['Rafi', 'Sami', 'Tanvir', 'Nabil'])
    const f = await figures(fresh)
    expect(f.utilities).toEqual(expected('utilities'))
    expect(f.bazar).toEqual(expected('bazar'))
  })

  it('undo of a restore made in v1.1.1 still works after the upgrade (records and names)', async () => {
    const { db } = await v111Install()
    expect(await getRestoreUndo(db)).toEqual({ scope: 'bazar', at: 5 })
    const utilBefore = await db.transactions.where('ledger').equals('utilities').toArray()
    await undoLastRestore(db)
    expect(await db.transactions.where('ledger').equals('utilities').toArray()).toEqual(utilBefore) // other ledger untouched
    expect(await db.transactions.where('ledger').equals('bazar').count()).toBe(txs.filter((t) => t.ledger === 'bazar').length)
    expect((await loadHousehold(db)).members.map((m) => m.name)).toEqual(['A0', 'B0', 'C0', 'D0'])
    expect(await getRestoreUndo(db)).toBeNull()
  })
})
