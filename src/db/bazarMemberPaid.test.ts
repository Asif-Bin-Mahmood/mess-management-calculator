import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIN_MONTH } from '../domain/month'
import { computeLedgerMonth, type MonthSummary } from '../domain/ledger'
import type { LedgerId, MonthClosing, Transaction } from '../domain/types'
import { dashboardAlerts } from '../report/reportModel'
import { BACKUP_SCHEMA_VERSION, checkBackup, createBackup, restoreBackup, undoLastRestore } from './backup'
import { applyBazarSwitch, bazarSwitchUndoProblem, loadBazarMethod, planBazarSwitch, suggestBazarSwitchMonth, undoBazarSwitch } from './bazarMethod'
import { applyClosing, undoClosing } from './closing'
import { MessDb } from './db'
import { setupHousehold } from './household'
import { applyMutation, loadHousehold, ValidationError } from './repo'

const NOW = new Date('2026-06-15T10:00:00').getTime()
let db: MessDb
let n = 0
const extra: Dexie[] = []

beforeEach(async () => {
  n += 1
  db = new MessDb(`bazar-mp-${n}`)
  await db.open()
})
afterEach(async () => {
  await db.delete()
  for (const d of extra.splice(0)) await d.delete()
})

async function otherDb(tag: string) {
  const d = new MessDb(`bazar-mp-${tag}-${n}`)
  await d.open()
  extra.push(d)
  return d
}

/** A household upgraded from v1.2.0: Bazar recorded with the cash method. */
async function cashHousehold(d: MessDb = db) {
  await setupHousehold(['Ana', 'Ben', 'Cy'], ['Power'], d, NOW)
  await d.meta.delete('bazarMethod')
  return ids(d)
}
async function ids(d: MessDb = db) {
  const h = await loadHousehold(d)
  const [a, b, c] = h.members.map((m) => m.id)
  return { a, b, c, power: h.categories[0]?.id }
}

const add = (input: Parameters<typeof applyMutation>[0] extends infer M ? (M extends { kind: 'create'; input: infer I } ? I : never) : never, d: MessDb = db) =>
  applyMutation({ kind: 'create', input }, d, NOW)
const contribution = (memberId: string, taka: number, date: string, ledger: LedgerId = 'bazar', d: MessDb = db) =>
  add({ ledger, type: 'contribution', amount: taka * 100, date, memberId }, d)
const expense = (taka: number, date: string, d: MessDb = db) => add({ ledger: 'bazar', type: 'expense', amount: taka * 100, date }, d)
const purchase = (memberId: string, taka: number, date: string, d: MessDb = db) => add({ ledger: 'bazar', type: 'purchase', amount: taka * 100, date, memberId }, d)
const settlement = (memberId: string, counterpartyId: string, taka: number, date: string, d: MessDb = db) =>
  add({ ledger: 'bazar', type: 'settlement', amount: taka * 100, date, memberId, counterpartyId }, d)

async function summary(ledger: LedgerId, month: string, d: MessDb = db) {
  const h = await loadHousehold(d)
  const method = await loadBazarMethod(d)
  return computeLedgerMonth(ledger, h.members, await d.transactions.toArray(), month, await d.closings.toArray(), ledger === 'bazar' ? method : null)
}

/** Cash-method Bazar for March and April that ends April with ৳0 shared cash. */
async function cashHistory() {
  const { a, b, c } = await cashHousehold()
  for (const [m, t] of [
    [a, 400],
    [b, 300],
    [c, 200],
  ] as const) {
    await contribution(m, t, '2026-03-02')
    await contribution(m, t, '2026-04-02')
  }
  await expense(900, '2026-03-20')
  await expense(900, '2026-04-20')
  return { a, b, c }
}

describe('new households', () => {
  it('record Bazar member-paid from the start; contributions and expenses are not accepted', async () => {
    await setupHousehold(['Ana', 'Ben'], [], db, NOW)
    expect(await loadBazarMethod(db)).toEqual({ memberPaidFrom: MIN_MONTH })
    const { a, b } = await ids()
    await purchase(a, 500, '2026-06-01')
    await purchase(b, 100.01, '2026-06-02')
    await expect(expense(100, '2026-06-03')).rejects.toBeInstanceOf(ValidationError)
    await expect(contribution(a, 100, '2026-06-03')).rejects.toBeInstanceOf(ValidationError)
    const s = await summary('bazar', '2026-06')
    expect(s.totalSpent).toBe(60001)
    // The leftover poisha rotates by month, exactly as in the cash method.
    expect(s.members.map((m) => [m.share, m.closing])).toEqual([
      [30000, 20000],
      [30001, -20000],
    ])
    // Utilities keeps its cash workflow.
    await contribution(a, 100, '2026-06-01', 'utilities')
  })
})

describe('switching an existing installation', () => {
  it('previews the switch, refuses unsafe start months and keeps every earlier figure', async () => {
    const { a, b, c } = await cashHistory()
    const before = { mar: await summary('bazar', '2026-03'), apr: await summary('bazar', '2026-04') }

    // April still has cash-method entries: never reinterpreted.
    expect((await planBazarSwitch('2026-04', db)).problems.join(' ')).toMatch(/April 2026/)
    expect(await suggestBazarSwitchMonth(db, NOW)).toBe('2026-06')

    const plan = await planBazarSwitch('2026-05', db)
    expect(plan.problems).toEqual([])
    expect(plan.cashBefore).toBe(0)
    // Balances carried into May, unchanged: paid 800/600/400 against shares of 600 each.
    expect(plan.balances).toEqual([
      { memberId: a, before: 20000, after: 20000 },
      { memberId: c, before: -20000, after: -20000 },
    ])

    await applyBazarSwitch('2026-05', db, NOW)
    expect(await loadBazarMethod(db)).toEqual({ memberPaidFrom: '2026-05' })
    expect((await db.audit.toArray()).some((e) => e.action === 'bazar-method')).toBe(true)
    await expect(applyBazarSwitch('2026-05', db, NOW)).rejects.toThrow(/already/)

    // Earlier months are exactly as before.
    expect({ ...(await summary('bazar', '2026-03')) }).toEqual(before.mar)
    expect({ ...(await summary('bazar', '2026-04')) }).toEqual(before.apr)

    // May onwards: Bazar amounts only. April (cash method) can still be corrected the old way.
    await expect(expense(100, '2026-05-03')).rejects.toBeInstanceOf(ValidationError)
    await purchase(b, 600, '2026-05-04')
    const may = await summary('bazar', '2026-05')
    expect(may.method).toBe('memberPaid')
    expect(may.members.map((m) => [m.memberId, m.opening, m.contributed, m.share])).toEqual([
      [a, 20000, 0, 20000],
      [b, 0, 60000, 20000],
      [c, -20000, 0, 20000],
    ])
    // April (cash method) can still be corrected the old way; the change carries into May's balances.
    await expense(3, '2026-04-21')
    expect((await summary('bazar', '2026-04')).totalSpent).toBe(90300)
    expect((await summary('bazar', '2026-05')).members.map((m) => m.opening)).toEqual([19900, -100, -20100])
  })

  it('refuses a closed month and a month that starts with shared cash', async () => {
    const { a } = await cashHistory()
    await applyClosing({ ledger: 'bazar', sourceMonth: '2026-04', method: 'carry', cashMode: 'carry' }, db, NOW)
    expect((await planBazarSwitch('2026-04', db)).problems.join(' ')).toMatch(/closed/)
    // Cash left over at the end of May blocks a June start until it is returned.
    await contribution(a, 50, '2026-05-02')
    const plan = await planBazarSwitch('2026-06', db)
    expect(plan.cashBefore).toBe(5000)
    expect(plan.problems.join(' ')).toMatch(/holds ৳50\.00/)
    await expect(applyBazarSwitch('2026-06', db, NOW)).rejects.toThrow(/৳50\.00/)
    expect(await loadBazarMethod(db)).toBeNull()
    await add({ ledger: 'bazar', type: 'memberRefund', amount: 5000, date: '2026-05-03', memberId: a })
    expect((await planBazarSwitch('2026-06', db)).problems).toEqual([])
  })

  it('can be undone only until a member-paid entry exists (even deleted) or a member-paid month is closed', async () => {
    const { a } = await cashHistory()
    await applyBazarSwitch('2026-05', db, NOW)
    expect(await bazarSwitchUndoProblem(db)).toBeNull()
    await undoBazarSwitch(db, NOW)
    expect(await loadBazarMethod(db)).toBeNull()

    await applyBazarSwitch('2026-05', db, NOW)
    const t = await purchase(a, 10, '2026-05-02')
    await applyMutation({ kind: 'delete', id: t.id }, db, NOW)
    expect(await bazarSwitchUndoProblem(db)).toMatch(/entries exist/)
    await expect(undoBazarSwitch(db, NOW)).rejects.toThrow()
    expect(await loadBazarMethod(db)).toEqual({ memberPaidFrom: '2026-05' })
  })

  it('a former member settling an old balance after the switch is not new Bazar spending', async () => {
    const { a, b, c } = await cashHistory()
    await applyBazarSwitch('2026-05', db, NOW)
    // Cy leaves after May (due ৳200 carried from April plus the May share).
    await purchase(a, 300, '2026-05-10')
    await db.members.update(c, { periods: [{ until: '2026-05' }] })
    await settlement(c, a, 300, '2026-06-02')
    await purchase(b, 200, '2026-06-05')
    const june = await summary('bazar', '2026-06')
    expect(june.totalSpent).toBe(20000)
    expect(june.sharers).toEqual([a, b])
    const cy = june.members.find((m) => m.memberId === c)!
    expect([cy.opening, cy.settled, cy.share, cy.closing]).toEqual([-30000, 30000, 0, 0])
    // A Bazar amount by the former member is refused: they settle instead.
    await expect(purchase(c, 10, '2026-06-06')).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('closing around the switch', () => {
  it('member-paid months close on balances only; cash cannot be introduced', async () => {
    await setupHousehold(['Ana', 'Ben'], [], db, NOW)
    const { a, b } = await ids()
    await purchase(a, 400, '2026-04-03')
    await expect(applyClosing({ ledger: 'bazar', sourceMonth: '2026-04', method: 'manual', cashMode: 'set', openingCash: 100, openingBalances: { [a]: 0, [b]: 0 } }, db, NOW)).rejects.toThrow(
      /no shared cash/,
    )
    const closing = await applyClosing({ ledger: 'bazar', sourceMonth: '2026-04', method: 'carry', cashMode: 'carry' }, db, NOW)
    const may = await summary('bazar', '2026-05')
    expect(may.opening.source).toBe('closing')
    expect(may.remainingCash).toBe(0)
    expect(may.members.map((m) => m.opening)).toEqual([20000, -20000])
    await undoClosing(closing.id, db, NOW)
    await applyClosing({ ledger: 'bazar', sourceMonth: '2026-04', method: 'settled', settlementKind: 'settled', cashMode: 'carry' }, db, NOW)
    expect((await summary('bazar', '2026-05')).members.map((m) => m.opening)).toEqual([0, 0])
    expect((await summary('bazar', '2026-05')).reconciliation.balanced).toBe(true)
  })

  it('the last cash-method month must hand over ৳0 cash; leftover cash is flagged, never counted as Bazar', async () => {
    const { a } = await cashHistory()
    await applyBazarSwitch('2026-05', db, NOW)
    // Money collected in April after the switch was planned: April is still a cash-method month.
    await contribution(a, 70, '2026-04-25')
    await expect(applyClosing({ ledger: 'bazar', sourceMonth: '2026-04', method: 'carry', cashMode: 'carry' }, db, NOW)).rejects.toThrow(/৳70/)
    const may = await summary('bazar', '2026-05')
    expect(may.totalSpent).toBe(0)
    expect(dashboardAlerts(may).map((x) => x.kind)).toEqual(['legacy-cash'])
    // Closing April with the cash returned (counted ৳0) is accepted.
    await applyClosing({ ledger: 'bazar', sourceMonth: '2026-04', method: 'settled', settlementKind: 'settled', cashMode: 'set', openingCash: 0 }, db, NOW)
    const after = await summary('bazar', '2026-05')
    expect(after.remainingCash).toBe(0)
    expect(dashboardAlerts(after)).toEqual([])
  })
})

describe('upgrading from v1.2.0 (database version 4)', () => {
  class V120Db extends Dexie {
    constructor(name: string) {
      super(name)
      this.version(1).stores({ transactions: 'id, ledger, [ledger+month], date, updatedAt', audit: '++seq, txId, at', meta: 'key' })
      this.version(2).stores({ closings: 'id, ledger, [ledger+sourceMonth], createdAt' })
      this.version(3).stores({})
      this.version(4).stores({ members: 'id', categories: 'id' })
    }
  }
  const member = (id: string, seq: number) => ({ id, name: id.toUpperCase(), seq, createdAt: 0, periods: [{}] })
  const t = (id: string, ledger: LedgerId, type: Transaction['type'], amount: number, extraFields: Partial<Transaction> = {}): Transaction => ({
    id,
    ledger,
    type,
    amount,
    date: '2026-03-05',
    month: '2026-03',
    createdAt: 1,
    updatedAt: 1,
    ...extraFields,
  })

  async function install(tag: string, txs: Transaction[], closings: MonthClosing[] = []) {
    const name = `v120-${tag}-${n}`
    const old = new V120Db(name)
    await old.open()
    await old.table('members').bulkAdd([member('m_a', 0), member('m_b', 1)])
    await old.table('categories').bulkAdd([{ id: 'c_p', name: 'Power', seq: 0, createdAt: 0 }])
    if (txs.length) await old.table('transactions').bulkAdd(structuredClone(txs))
    if (closings.length) await old.table('closings').bulkAdd(structuredClone(closings))
    old.close()
    const d = new MessDb(name)
    await d.open()
    extra.push(d)
    return d
  }

  it('an installation with Bazar history keeps the cash method and its records unchanged', async () => {
    const txs = [t('t1', 'bazar', 'contribution', 50000, { memberId: 'm_a' }), t('t2', 'bazar', 'expense', 30000), t('t3', 'utilities', 'expense', 1000, { category: 'c_p' })]
    const d = await install('cash', txs)
    expect(await loadBazarMethod(d)).toBeNull()
    expect((await d.transactions.toArray()).sort((x, y) => x.id.localeCompare(y.id))).toEqual(txs)
    expect((await summary('bazar', '2026-03', d)).method).toBe('cash')
    expect((await summary('bazar', '2026-03', d)).remainingCash).toBe(20000)
  })

  it('an installation with no Bazar records starts member-paid; Utilities is untouched', async () => {
    const txs = [t('t3', 'utilities', 'contribution', 1000, { memberId: 'm_a' })]
    const d = await install('fresh-bazar', txs)
    expect(await loadBazarMethod(d)).toEqual({ memberPaidFrom: MIN_MONTH })
    expect(await d.transactions.toArray()).toEqual(txs)
  })
})

describe('backups', () => {
  it('a v5 backup carries the Bazar method and restores it; undo puts back the previous method', async () => {
    const { a } = await cashHistory()
    await applyBazarSwitch('2026-05', db, NOW)
    await purchase(a, 120, '2026-05-02')
    const file = await createBackup(db, new Date(NOW))
    expect(file.schemaVersion).toBe(BACKUP_SCHEMA_VERSION)
    expect(file.bazarMethod).toEqual({ memberPaidFrom: '2026-05' })
    const check = checkBackup(JSON.stringify(file))
    if (!check.ok) throw new Error(check.errors.join(" "))

    const other = await otherDb('target')
    await setupHousehold(['Somebody'], [], other, NOW) // member-paid from the start
    await restoreBackup(check.data, other, NOW + 1)
    expect(await loadBazarMethod(other)).toEqual({ memberPaidFrom: '2026-05' })
    for (const m of ['2026-03', '2026-04', '2026-05']) expect(await summary('bazar', m, other)).toEqual(await summary('bazar', m, db))
    await undoLastRestore(other, NOW + 2)
    expect(await loadBazarMethod(other)).toEqual({ memberPaidFrom: MIN_MONTH })
  })

  it('a v1.2.0 (schema 4) backup restores as the cash method, with identical figures', async () => {
    await cashHistory()
    const v5 = await createBackup(db, new Date(NOW))
    const v4: Record<string, unknown> = { ...v5, schemaVersion: 4 }
    delete v4.bazarMethod
    const check = checkBackup(JSON.stringify(v4))
    if (!check.ok) throw new Error(check.errors.join(" "))
    const other = await otherDb('v4')
    await setupHousehold(['X', 'Y'], [], other, NOW)
    expect(await loadBazarMethod(other)).not.toBeNull()
    await restoreBackup(check.data, other, NOW + 1)
    expect(await loadBazarMethod(other)).toBeNull()
    for (const m of ['2026-03', '2026-04']) expect(await summary('bazar', m, other)).toEqual(await summary('bazar', m, db))
    // A schema-4 file cannot smuggle a method in (old files never had one).
    expect(checkBackup(JSON.stringify({ ...v4, bazarMethod: { memberPaidFrom: '2026-03' } })).ok).toBe(true)
    const c2 = checkBackup(JSON.stringify({ ...v4, bazarMethod: { memberPaidFrom: '2026-03' } }))
    if (c2.ok) expect(c2.data.bazarMethod ?? null).toBeNull()
  })

  it('rejects entries that do not match the backup’s method, and a method on a Utilities backup', async () => {
    await setupHousehold(['Ana', 'Ben'], [], db, NOW)
    const { a } = await ids()
    await purchase(a, 100, '2026-05-02')
    const file = await createBackup(db, new Date(NOW))
    const noMethod = checkBackup(JSON.stringify({ ...file, bazarMethod: null }))
    expect(noMethod.ok).toBe(false)
    const util = await createBackup(db, new Date(NOW), 'utilities')
    expect(util.bazarMethod).toBeUndefined()
    expect(checkBackup(JSON.stringify({ ...util, bazarMethod: { memberPaidFrom: MIN_MONTH } })).ok).toBe(false)
  })

  it('a Utilities-only restore keeps this device’s Bazar method', async () => {
    await setupHousehold(['Ana', 'Ben'], ['Power'], db, NOW)
    const { a } = await ids()
    await contribution(a, 100, '2026-05-02', 'utilities')
    const util = checkBackup(JSON.stringify(await createBackup(db, new Date(NOW), 'utilities')))
    if (!util.ok) throw new Error(util.errors.join(" "))
    await db.meta.put({ key: 'bazarMethod', value: { memberPaidFrom: '2026-01' } })
    await restoreBackup(util.data, db, NOW + 1)
    expect(await loadBazarMethod(db)).toEqual({ memberPaidFrom: '2026-01' })
  })
})

describe('Utilities is unchanged by the Bazar method', () => {
  async function utilitiesDevice(d: MessDb, memberPaid: boolean) {
    if (!memberPaid) await d.meta.delete('bazarMethod')
    const { a, b, c, power } = await ids(d)
    const h = await loadHousehold(d)
    const gas = h.categories[1].id
    await contribution(a, 1000, '2026-03-01', 'utilities', d)
    await contribution(b, 500.5, '2026-03-02', 'utilities', d)
    await add({ ledger: 'utilities', type: 'expense', amount: 100001, date: '2026-03-05', category: power }, d)
    await add({ ledger: 'utilities', type: 'expenseRefund', amount: 1234, date: '2026-03-06', category: power }, d)
    await add({ ledger: 'utilities', type: 'memberRefund', amount: 2000, date: '2026-03-07', memberId: c }, d)
    await add({ ledger: 'utilities', type: 'expense', amount: 33333, date: '2026-04-05', category: gas }, d)
    await applyClosing({ ledger: 'utilities', sourceMonth: '2026-03', method: 'manual', cashMode: 'set', openingCash: 30000, openingBalances: { [a]: 100, [b]: -100, [c]: 0 } }, d, NOW)
    await applyClosing({ ledger: 'utilities', sourceMonth: '2026-04', method: 'carry', cashMode: 'carry' }, d, NOW)
  }

  it('calculations, refunds, cash, closings and backups are identical with either Bazar method', async () => {
    // Two devices with the same household (same member and category ids), one per Bazar method.
    await setupHousehold(['Ana', 'Ben', 'Cy'], ['Power', 'Gas'], db, NOW)
    const reg = checkBackup(JSON.stringify(await createBackup(db, new Date(NOW))))
    if (!reg.ok) throw new Error(reg.errors.join(" "))
    const cash = await otherDb('u-cash')
    await restoreBackup(reg.data, cash, NOW)
    await utilitiesDevice(db, true)
    await utilitiesDevice(cash, false)
    expect(await loadBazarMethod(db)).not.toBeNull()
    expect(await loadBazarMethod(cash)).toBeNull()
    const noIds = (x: MonthSummary) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'id' || k === 'createdAt' ? undefined : v)))
    for (const m of ['2026-03', '2026-04', '2026-05']) expect(noIds(await summary('utilities', m, db))).toEqual(noIds(await summary('utilities', m, cash)))
    const norm = (cs: MonthClosing[]) => cs.map((c) => ({ ...c, id: undefined, createdAt: undefined })).sort((x, y) => x.sourceMonth.localeCompare(y.sourceMonth))
    expect(norm(await db.closings.toArray())).toEqual(norm(await cash.closings.toArray()))
    const bk = async (d: MessDb) => {
      const f = await createBackup(d, new Date(NOW), 'utilities')
      return { ...f, transactions: f.transactions.map((t) => ({ ...t, id: undefined })).sort((x, y) => x.date.localeCompare(y.date)), closings: norm(f.closings), audit: undefined, backupId: undefined }
    }
    expect(await bk(db)).toEqual(await bk(cash))
  })
})
