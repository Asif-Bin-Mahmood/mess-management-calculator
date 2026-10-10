import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildClosing, computeLedgerMonth } from '../domain/ledger'
import { monthRange } from '../domain/month'
import { LEGACY_CATEGORIES, LEGACY_DEFAULT_NAMES, LEGACY_MEMBER_IDS as MEMBER_IDS, LEGACY_MEMBER_NAMES, memberName, setHouseholdDisplay, validateNames } from '../domain/household'
import type { LedgerId, MonthClosing, Transaction } from '../domain/types'
import { buildReport } from '../report/reportModel'
import { BACKUP_SCHEMA_VERSION, checkBackup, createBackup, getRestoreUndo, importStatus, restoreBackup, undoLastRestore, type BackupFile, type RestoreProgress } from './backup'
import { DB_NAME, MEMBER_NAMES_KEY, MessDb } from './db'
import { renameMember } from './household'
import { applyMutation, loadHousehold } from './repo'
import { CATS5, R4 } from '../domain/testUtils'
import { seedLegacyHousehold } from './testDb'

type MemberNames = Record<string, string>
/** A backup file as written by app 1.1.1 or earlier (schema 1-3: no member/category registry). */
type LegacyFile = Omit<BackupFile, 'members' | 'categories'> & { memberNames?: MemberNames }

/** Current display names of the members on a device, by id. */
async function loadMemberNames(d: MessDb): Promise<MemberNames> {
  return Object.fromEntries((await loadHousehold(d)).members.map((m) => [m.id, m.name]))
}

/** Renames the members (display only), as the Members screen does. */
async function saveMemberNames(names: MemberNames, d: MessDb, now: number) {
  for (const [id, name] of Object.entries(names)) await renameMember(id, name, d, now)
}

let db: MessDb
let n = 0
const NOW = new Date('2026-10-20T10:00:00').getTime()

beforeEach(async () => {
  n += 1
  db = new MessDb(`restore-names-${n}`)
  await db.open()
  await seedLegacyHousehold(db)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await db.delete()
})

/** A realistic disposable backup: `months` months of both ledgers, carry-forward closings and audit history. */
function makeBackup(opts: { from: string; to: string; bazarPerMonth: number; schema?: 1 | 2 | 3; names?: MemberNames; id?: string }): LegacyFile {
  let seq = 0
  let t = Date.UTC(2023, 0, 1)
  const txs: Transaction[] = []
  const audit: LegacyFile['audit'] = []
  const add = (ledger: LedgerId, type: Transaction['type'], amount: number, month: string, extra: Partial<Transaction> = {}) => {
    t += 1000
    const tx: Transaction = { id: `b-${opts.id ?? 'x'}-${++seq}`, ledger, type, amount, date: `${month}-${String(1 + (seq % 28)).padStart(2, '0')}`, month, createdAt: t, updatedAt: t, ...extra }
    txs.push(tx)
    audit.push({ at: t, action: 'create', txId: tx.id, ledger, after: tx })
  }
  for (const month of monthRange(opts.from, opts.to)) {
    for (const m of MEMBER_IDS) {
      add('bazar', 'contribution', 300000 + seq, month, { memberId: m })
      add('utilities', 'contribution', 150000, month, { memberId: m })
    }
    for (let i = 0; i < opts.bazarPerMonth; i++) add('bazar', 'expense', 2000 + ((seq * 37) % 40000), month)
    for (const c of ['service', 'current', 'gas', 'wifi', 'others'] as const) add('utilities', 'expense', 50000 + ((seq * 13) % 70000), month, { category: c })
  }
  const closings: MonthClosing[] = []
  const schema = opts.schema ?? 3
  if (schema >= 2) {
    let k = 0
    for (const ledger of ['utilities', 'bazar'] as const)
      for (const month of monthRange(opts.from, opts.to).slice(0, -2)) closings.push(buildClosing({ ledger, sourceMonth: month, method: 'carry', cashMode: 'carry' }, R4, txs, closings, `bc-${opts.id ?? 'x'}-${++k}`, t + k))
  }
  const file: LegacyFile = { app: 'mess-ledger', schemaVersion: schema, backupId: `gen-${opts.id ?? 'x'}`, exportedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(), scope: 'all', transactions: txs, closings, audit }
  if (schema >= 3) file.memberNames = opts.names ?? { ...LEGACY_DEFAULT_NAMES }
  return file
}

/** Parse as the app does (round-trip through JSON and validation). */
function parse(file: LegacyFile | BackupFile | Record<string, unknown>) {
  const check = checkBackup(JSON.stringify(file))
  if (!check.ok) throw new Error(check.errors.join('; '))
  return check.data
}

async function seedDevice() {
  const c = (memberId: 'asif' | 'dipu', taka: number) => applyMutation({ kind: 'create', input: { ledger: 'bazar', type: 'contribution', amount: taka * 100, date: '2026-10-02', memberId } }, db, NOW)
  await c('asif', 500)
  await c('dipu', 700)
  await applyMutation({ kind: 'create', input: { ledger: 'utilities', type: 'expense', amount: 300_00, date: '2026-10-03', category: 'gas' } }, db, NOW)
}

async function snapshot() {
  return {
    txs: (await db.transactions.toArray()).sort((a, b) => a.id.localeCompare(b.id)),
    closings: (await db.closings.toArray()).sort((a, b) => a.id.localeCompare(b.id)),
    audit: await db.audit.count(),
    meta: (await db.meta.toArray()).sort((a, b) => a.key.localeCompare(b.key)),
    members: (await db.members.toArray()).sort((a, b) => a.id.localeCompare(b.id)),
    categories: (await db.categories.toArray()).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

describe('restore', () => {
  it('replaces existing data with an older backup and keeps the device audit trail', async () => {
    await seedDevice()
    const deviceAudit = await db.audit.toArray()
    const backup = parse(makeBackup({ from: '2025-01', to: '2025-06', bazarPerMonth: 10, id: 'old', schema: 2 }))
    const status = await importStatus(backup, db)
    expect(status.newerLocalChanges).toBe(3) // the 3 device records are newer than the backup and would be lost
    await restoreBackup(backup, db, NOW + 1)
    const after = await snapshot()
    expect(after.txs).toEqual([...backup.transactions].sort((a, b) => a.id.localeCompare(b.id)))
    expect(after.closings).toHaveLength(backup.closings.length)
    // Balances and cash computed from the database equal those computed from the backup itself.
    for (const ledger of ['utilities', 'bazar'] as const) {
      expect(computeLedgerMonth(ledger, R4, after.txs, '2025-06', after.closings)).toEqual(computeLedgerMonth(ledger, R4, backup.transactions, '2025-06', backup.closings))
    }
    const audit = await db.audit.toArray()
    for (const a of deviceAudit) expect(audit).toContainEqual(a) // device history kept
    expect(audit.length).toBe(deviceAudit.length + backup.audit.length + 1) // + backup history + import entry
  })

  it('restores a single ledger without touching the other', async () => {
    await seedDevice()
    const utilBefore = (await db.transactions.where('ledger').equals('utilities').toArray()).sort((a, b) => a.id.localeCompare(b.id))
    const full = makeBackup({ from: '2025-01', to: '2025-04', bazarPerMonth: 8, id: 'bz' })
    const bazarOnly = parse({ ...full, scope: 'bazar', transactions: full.transactions.filter((t) => t.ledger === 'bazar'), closings: full.closings.filter((c) => c.ledger === 'bazar'), audit: full.audit.filter((a) => a.ledger === 'bazar') })
    await restoreBackup(bazarOnly, db, NOW + 1)
    expect((await db.transactions.where('ledger').equals('utilities').toArray()).sort((a, b) => a.id.localeCompare(b.id))).toEqual(utilBefore)
    expect(await db.transactions.where('ledger').equals('bazar').count()).toBe(bazarOnly.transactions.length)
    expect(await db.closings.where('ledger').equals('utilities').count()).toBe(0)
  })

  it('reports progress and finishes a realistically large backup', async () => {
    const big = parse(makeBackup({ from: '2023-11', to: '2026-10', bazarPerMonth: 60, id: 'big' }))
    expect(big.transactions.length).toBeGreaterThan(2500)
    const progress: RestoreProgress[] = []
    const t0 = performance.now()
    await restoreBackup(big, db, NOW, (p) => progress.push(p))
    const ms = performance.now() - t0
    expect(await db.transactions.count()).toBe(big.transactions.length)
    expect(await db.closings.count()).toBe(big.closings.length)
    const entries = progress.filter((p) => p.phase === 'entries')
    expect(entries.length).toBeGreaterThan(10) // written in batches, so the UI can update between them
    expect(entries.at(-1)).toMatchObject({ done: big.transactions.length, total: big.transactions.length })
    for (let i = 1; i < entries.length; i++) expect(entries[i].done).toBeGreaterThan(entries[i - 1].done)
    console.info(`restore of ${big.transactions.length} entries + ${big.audit.length} audit rows (fake-indexeddb): ${Math.round(ms)} ms`)
  })

  it('a failure part-way leaves the previous data, names and undo state exactly as they were', async () => {
    await seedDevice()
    await saveMemberNames({ asif: 'Rafi', dipu: 'Sami', yusha: 'Tanvir', ovi: 'Nabil' }, db, NOW)
    const before = await snapshot()
    const backup = parse(makeBackup({ from: '2025-01', to: '2025-06', bazarPerMonth: 30, id: 'fail' }))
    const real = db.audit.bulkAdd.bind(db.audit)
    let calls = 0
    vi.spyOn(db.audit, 'bulkAdd').mockImplementation(((rows: never[]) => {
      calls += 1
      if (calls === 2) return Promise.reject(new Error('disk full (simulated)'))
      return real(rows)
    }) as never)
    await expect(restoreBackup(backup, db, NOW + 1)).rejects.toThrow(/simulated/)
    expect(await snapshot()).toEqual(before)
    expect(await loadMemberNames(db)).toEqual({ asif: 'Rafi', dipu: 'Sami', yusha: 'Tanvir', ovi: 'Nabil' })
  })

  it('refuses a ledger restore whose ids clash with the other ledger, changing nothing', async () => {
    await seedDevice()
    const before = await snapshot()
    const clashId = before.txs.find((t) => t.ledger === 'utilities')!.id
    const file = parse({ app: 'mess-ledger', schemaVersion: 2, backupId: 'clash', exportedAt: '2026-01-01T00:00:00Z', scope: 'bazar', transactions: [{ id: clashId, ledger: 'bazar', type: 'expense', amount: 100, date: '2026-01-02', month: '2026-01', createdAt: 1, updatedAt: 1 }], closings: [], audit: [] })
    await expect(restoreBackup(file, db, NOW)).rejects.toThrow(/other ledger/)
    expect(await snapshot()).toEqual(before)
  })

  it('detects duplicate imports and rejects malformed or incompatible files', async () => {
    const backup = parse(makeBackup({ from: '2025-01', to: '2025-02', bazarPerMonth: 3, id: 'dup' }))
    await restoreBackup(backup, db, NOW)
    expect(await importStatus(backup, db)).toMatchObject({ identical: true, alreadyImportedAt: NOW })
    expect(checkBackup('{not json').ok).toBe(false)
    expect(checkBackup(JSON.stringify({ app: 'other', schemaVersion: 3 })).ok).toBe(false)
    expect(checkBackup(JSON.stringify({ ...backup, schemaVersion: BACKUP_SCHEMA_VERSION + 1 }))).toMatchObject({ ok: false })
    expect(checkBackup(JSON.stringify({ ...backup, memberNames: { asif: 'A', dipu: 'a', yusha: 'B', ovi: 'C' } }))).toMatchObject({ ok: false }) // duplicate names
    expect(checkBackup(JSON.stringify({ ...backup, memberNames: undefined }))).toMatchObject({ ok: false }) // v3 requires names
  })

  it('undo puts back the replaced data and names', async () => {
    await seedDevice()
    await saveMemberNames({ asif: 'Rafi', dipu: 'Sami', yusha: 'Tanvir', ovi: 'Nabil' }, db, NOW)
    const before = await snapshot()
    await restoreBackup(parse(makeBackup({ from: '2025-01', to: '2025-02', bazarPerMonth: 3, id: 'u', names: { asif: 'W', dipu: 'X', yusha: 'Y', ovi: 'Z' } })), db, NOW + 1)
    expect(await loadMemberNames(db)).toEqual({ asif: 'W', dipu: 'X', yusha: 'Y', ovi: 'Z' })
    expect(await getRestoreUndo(db)).toMatchObject({ scope: 'all' })
    await undoLastRestore(db, NOW + 2)
    const after = await snapshot()
    expect(after.txs).toEqual(before.txs)
    expect(await loadMemberNames(db)).toEqual({ asif: 'Rafi', dipu: 'Sami', yusha: 'Tanvir', ovi: 'Nabil' })
    expect(await getRestoreUndo(db)).toBeNull()
  })
})

describe('member names', () => {
  it('validates names: trimmed, not blank, not too long, not duplicated', () => {
    expect(validateNames(['  Rafi  Ahmed ', 'Sami', 'Tanvir', 'Nabil'])).toEqual({ names: ['Rafi Ahmed', 'Sami', 'Tanvir', 'Nabil'], errors: [null, null, null, null] })
    expect(validateNames(['', 'Sami', 'Tanvir', 'Nabil']).errors.map(Boolean)).toEqual([true, false, false, false])
    expect(validateNames(['Sami', 'sami', 'Tanvir', 'Nabil']).errors.map(Boolean)).toEqual([true, true, false, false])
    expect(validateNames(['x'.repeat(25), 'Sami', 'Tanvir', 'Nabil']).errors[0]).toBeTruthy()
  })

  it('a fresh installation has no household yet (setup is shown) and no legacy names', async () => {
    const fresh = new MessDb(`fresh-install-${n}`)
    await fresh.open()
    expect(await loadHousehold(fresh)).toEqual({ members: [], categories: [] })
    expect(await fresh.meta.get(MEMBER_NAMES_KEY)).toBeUndefined()
    await fresh.delete()
  })

  it('renaming changes only display names: records, balances, closings and reports stay correct', async () => {
    await seedDevice()
    const c = buildClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'carry', cashMode: 'carry' }, R4, await db.transactions.toArray(), [], 'c1', NOW)
    await db.closings.add(c)
    const before = await snapshot()
    const summaryBefore = computeLedgerMonth('bazar', R4, before.txs, '2026-11', before.closings)

    await saveMemberNames({ asif: 'Rafi', dipu: 'Sami', yusha: 'Tanvir', ovi: 'Nabil' }, db, NOW + 5)
    const after = await snapshot()
    expect(after.txs).toEqual(before.txs) // ownership by member id unchanged
    expect(after.closings).toEqual(before.closings)
    const h = await loadHousehold(db)
    expect(h.members.map((m) => [m.id, m.seq, m.periods])).toEqual(R4.map((m) => [m.id, m.seq, m.periods])) // ids, order and membership unchanged
    expect(computeLedgerMonth('bazar', h.members, after.txs, '2026-11', after.closings)).toEqual(summaryBefore)
    expect((await db.audit.toArray()).at(-1)).toMatchObject({ action: 'member-update', txId: 'member:ovi', memberAfter: { name: 'Nabil' } })

    setHouseholdDisplay(h.members, h.categories)
    expect(memberName('asif')).toBe('Rafi')
    const report = buildReport('bazar', h.members, '2026-10', after.txs, after.closings)
    expect(report.summary).toEqual(computeLedgerMonth('bazar', R4, after.txs, '2026-10', after.closings))
    setHouseholdDisplay([], [])
  })

  it('upgrading a v1.1.0 installation keeps the original names and categories; an empty one starts with setup', async () => {
    // Simulate an installation created by app 1.1.0 (database schema v2).
    class V2Db extends Dexie {
      constructor(name: string) {
        super(name)
        this.version(1).stores({ transactions: 'id, ledger, [ledger+month], date, updatedAt', audit: '++seq, txId, at', meta: 'key' })
        this.version(2).stores({ closings: 'id, ledger, [ledger+sourceMonth], createdAt' })
      }
    }
    const withData = new V2Db(`upgrade-data-${n}`)
    await withData.open()
    await withData.table('transactions').add({ id: 't1', ledger: 'bazar', type: 'contribution', amount: 100, date: '2026-09-01', month: '2026-09', memberId: 'asif', createdAt: 1, updatedAt: 1 })
    withData.close()
    const upgraded = new MessDb(`upgrade-data-${n}`)
    await upgraded.open()
    expect(await loadMemberNames(upgraded)).toEqual(LEGACY_MEMBER_NAMES)
    const h = await loadHousehold(upgraded)
    expect(h.members.map((m) => [m.id, m.seq, m.periods])).toEqual(MEMBER_IDS.map((id, i) => [id, i, [{}]])) // same ids, sharing since the start
    expect(h.categories.map((c) => [c.id, c.name])).toEqual(LEGACY_CATEGORIES.map((c) => [c.id, c.name]))
    expect(await upgraded.transactions.get('t1')).toMatchObject({ memberId: 'asif', amount: 100 }) // data untouched
    await upgraded.delete()

    const empty = new V2Db(`upgrade-empty-${n}`)
    await empty.open()
    empty.close()
    const upgradedEmpty = new MessDb(`upgrade-empty-${n}`)
    await upgradedEmpty.open()
    expect(await loadHousehold(upgradedEmpty)).toEqual({ members: [], categories: [] })
    await upgradedEmpty.delete()
    expect(DB_NAME).toBe('mess-ledger') // production database name unchanged
  })

  it('upgrading a v1.1.1 installation keeps the names it shows (renamed or not) and every record', async () => {
    // Simulate app 1.1.1 (database schema v3 with meta.memberNames).
    class V3Db extends Dexie {
      constructor(name: string) {
        super(name)
        this.version(1).stores({ transactions: 'id, ledger, [ledger+month], date, updatedAt', audit: '++seq, txId, at', meta: 'key' })
        this.version(2).stores({ closings: 'id, ledger, [ledger+sourceMonth], createdAt' })
        this.version(3).stores({})
      }
    }
    const cases: [string, MemberNames, boolean][] = [
      ['renamed-with-data', { asif: 'Rafi', dipu: 'Sami', yusha: 'Tanvir', ovi: 'Nabil' }, true],
      ['neutral-with-data', { ...LEGACY_DEFAULT_NAMES }, true],
      ['named-no-data', { asif: 'Ana', dipu: 'Ben', yusha: 'Cy', ovi: 'Di' }, false],
    ]
    for (const [label, names, withTx] of cases) {
      const name = `upgrade-v3-${label}-${n}`
      const v3 = new V3Db(name)
      await v3.open()
      await v3.table('meta').put({ key: MEMBER_NAMES_KEY, value: names })
      const closing = buildClosing({ ledger: 'utilities', sourceMonth: '2026-08', method: 'carry', cashMode: 'carry' }, R4, [], [], 'c-old', 5)
      if (withTx) {
        await v3.table('transactions').add({ id: 'u1', ledger: 'utilities', type: 'expense', amount: 4321, date: '2026-09-02', month: '2026-09', category: 'gas', createdAt: 2, updatedAt: 2 })
        await v3.table('closings').add(closing)
        await v3.table('audit').add({ at: 3, action: 'rename-members', txId: 'members', note: '{}' })
      }
      v3.close()
      const up = new MessDb(name)
      await up.open()
      expect(await loadMemberNames(up)).toEqual(names)
      expect((await loadHousehold(up)).categories.map((c) => c.id)).toEqual(LEGACY_CATEGORIES.map((c) => c.id))
      expect(await up.meta.get(MEMBER_NAMES_KEY)).toBeUndefined() // moved into the member records
      if (withTx) {
        expect(await up.transactions.get('u1')).toMatchObject({ category: 'gas', amount: 4321 })
        expect(await up.closings.get('c-old')).toEqual(closing)
        expect(await up.audit.count()).toBe(1)
      }
      await up.delete()
    }
  })

  it('backups carry the registry (schema 4); older backups keep the names this device shows', async () => {
    await saveMemberNames({ asif: 'Rafi', dipu: 'Sami', yusha: 'Tanvir', ovi: 'Nabil' }, db, NOW)
    const own = await createBackup(db, new Date(NOW))
    expect(own.schemaVersion).toBe(4)
    expect(own.members.map((m) => [m.id, m.name])).toEqual([
      ['asif', 'Rafi'],
      ['dipu', 'Sami'],
      ['yusha', 'Tanvir'],
      ['ovi', 'Nabil'],
    ])
    expect(own.categories.map((c) => c.id)).toEqual(CATS5.map((c) => c.id))

    // v2 backup into a renamed install: names are kept.
    await restoreBackup(parse(makeBackup({ from: '2025-01', to: '2025-02', bazarPerMonth: 2, schema: 2, id: 'v2a' })), db, NOW + 1)
    expect(await loadMemberNames(db)).toEqual({ asif: 'Rafi', dipu: 'Sami', yusha: 'Tanvir', ovi: 'Nabil' })

    // v1 and v2 backups into a fresh install: the names those backups were made with come back.
    for (const schema of [1, 2] as const) {
      const fresh = new MessDb(`fresh-${schema}-${n}`)
      await fresh.open()
      const raw = makeBackup({ from: '2025-01', to: '2025-02', bazarPerMonth: 2, schema, id: `f${schema}` })
      await restoreBackup(parse(schema === 1 ? { app: raw.app, schemaVersion: 1, exportedAt: raw.exportedAt, transactions: raw.transactions, audit: raw.audit } : raw), fresh, NOW)
      expect(await loadMemberNames(fresh)).toEqual(LEGACY_MEMBER_NAMES)
      expect((await loadHousehold(fresh)).categories.map((c) => c.id)).toEqual(LEGACY_CATEGORIES.map((c) => c.id))
      expect(await fresh.transactions.count()).toBe(raw.transactions.length)
      await fresh.delete()
    }

    // A single-ledger restore never changes names.
    const v3 = makeBackup({ from: '2025-01', to: '2025-02', bazarPerMonth: 2, id: 'v3', names: { asif: 'A1', dipu: 'B2', yusha: 'C3', ovi: 'D4' } })
    await restoreBackup(
      parse({
        ...v3,
        scope: 'utilities',
        transactions: v3.transactions.filter((t) => t.ledger === 'utilities'),
        closings: v3.closings.filter((c) => c.ledger === 'utilities'),
        audit: v3.audit.filter((a) => a.ledger === 'utilities'),
      }),
      db,
      NOW + 2,
    )
    expect(await loadMemberNames(db)).toEqual({ asif: 'Rafi', dipu: 'Sami', yusha: 'Tanvir', ovi: 'Nabil' })
  })
})
