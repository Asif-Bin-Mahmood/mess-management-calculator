import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeLedgerMonth } from '../domain/ledger'
import { MessDb } from './db'
import { checkBackup, createBackup, restoreBackup } from './backup'
import { applyMutation, planMutation, ValidationError } from './repo'

let db: MessDb
let n = 0
const NOW = new Date('2026-10-09T10:00:00').getTime()

beforeEach(async () => {
  n += 1
  db = new MessDb(`test-${n}`)
  await db.open()
})

afterEach(async () => {
  await db.delete()
})

const contribution = (taka: number, date: string, memberId: 'asif' | 'dipu' | 'yusha' | 'ovi' = 'asif') =>
  ({ kind: 'create', input: { ledger: 'bazar', type: 'contribution', amount: taka * 100, date, memberId } }) as const
const bazarExpense = (taka: number, date: string) =>
  ({ kind: 'create', input: { ledger: 'bazar', type: 'expense', amount: taka * 100, date } }) as const

describe('persistence', () => {
  it('stores transactions and survives reopening the database', async () => {
    const t = await applyMutation(contribution(500, '2026-10-01'), db, NOW)
    expect(t.month).toBe('2026-10')
    db.close()
    const again = new MessDb(db.name)
    await again.open()
    expect(await again.transactions.get(t.id)).toEqual(t)
    again.close()
    await db.open()
  })

  it('rejects invalid input without writing', async () => {
    await expect(
      applyMutation({ kind: 'create', input: { ledger: 'utilities', type: 'expense', amount: 100, date: '2026-10-01' } }, db, NOW),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(await db.transactions.count()).toBe(0)
    expect(await db.audit.count()).toBe(0)
  })

  it('strips fields that do not apply and trims notes', async () => {
    const t = await applyMutation(
      { kind: 'create', input: { ledger: 'bazar', type: 'expense', amount: 100, date: '2026-10-01', memberId: 'asif', description: '  fish  ' } },
      db,
      NOW,
    )
    expect(t.memberId).toBeUndefined()
    expect(t.description).toBe('fish')
  })

  it('soft-deletes and restores with an audit trail', async () => {
    const t = await applyMutation(bazarExpense(300, '2026-10-02'), db, NOW)
    await applyMutation({ kind: 'delete', id: t.id }, db, NOW + 1)
    let all = await db.transactions.toArray()
    expect(all[0].deletedAt).toBe(NOW + 1)
    expect(computeLedgerMonth('bazar', all, '2026-10').totalSpent).toBe(0)

    await applyMutation({ kind: 'restore', id: t.id }, db, NOW + 2)
    all = await db.transactions.toArray()
    expect(all[0].deletedAt).toBeUndefined()
    expect(computeLedgerMonth('bazar', all, '2026-10').totalSpent).toBe(300_00)

    const audit = await db.audit.toArray()
    expect(audit.map((a) => a.action)).toEqual(['create', 'delete', 'restore'])
    expect(audit[1].before?.deletedAt).toBeUndefined()
  })

  it('keeps the original id and createdAt on edit and refuses ledger moves', async () => {
    const t = await applyMutation(bazarExpense(300, '2026-10-02'), db, NOW)
    const edited = await applyMutation({ kind: 'update', id: t.id, input: { ledger: 'bazar', type: 'expense', amount: 350_00, date: '2026-10-03' } }, db, NOW + 5)
    expect(edited.id).toBe(t.id)
    expect(edited.createdAt).toBe(NOW)
    expect(edited.updatedAt).toBe(NOW + 5)
    await expect(
      applyMutation({ kind: 'update', id: t.id, input: { ledger: 'utilities', type: 'expense', amount: 1, date: '2026-10-03', category: 'gas' } }, db, NOW),
    ).rejects.toThrow(/between ledgers/)
  })
})

describe('historical correction planning', () => {
  it('needs no confirmation for changes in the current month', async () => {
    await applyMutation(contribution(1000, '2026-09-01'), db, NOW)
    const plan = await planMutation(bazarExpense(100, '2026-10-05'), db, NOW)
    expect(plan.impact).toBeNull()
  })

  it('reports the carry-forward impact of editing a past month', async () => {
    await applyMutation(contribution(1000, '2026-08-01'), db, NOW)
    const e = await applyMutation(bazarExpense(400, '2026-08-10'), db, NOW)
    const plan = await planMutation({ kind: 'update', id: e.id, input: { ledger: 'bazar', type: 'expense', amount: 800_00, date: '2026-08-10' } }, db, NOW)
    expect(plan.impact?.laterMonths).toEqual(['2026-09', '2026-10'])
    expect(plan.impact?.cashBefore).toBe(600_00)
    expect(plan.impact?.cashAfter).toBe(200_00)
    // Nothing written by planning.
    expect((await db.transactions.get(e.id))?.amount).toBe(400_00)
  })

  it('treats moving a transaction into the past as a correction from the earlier month', async () => {
    const e = await applyMutation(bazarExpense(400, '2026-10-01'), db, NOW)
    const plan = await planMutation({ kind: 'update', id: e.id, input: { ledger: 'bazar', type: 'expense', amount: 400_00, date: '2026-07-31' } }, db, NOW)
    expect(plan.impact?.changedMonth).toBe('2026-07')
  })

  it('does not consider the other ledger', async () => {
    await applyMutation({ kind: 'create', input: { ledger: 'utilities', type: 'expense', amount: 100, date: '2026-12-01', category: 'gas' } }, db, NOW)
    const plan = await planMutation(bazarExpense(100, '2026-10-05'), db, NOW)
    expect(plan.impact).toBeNull()
  })
})

describe('backup and restore', () => {
  it('round-trips all data through JSON', async () => {
    await applyMutation(contribution(1000, '2026-08-01', 'dipu'), db, NOW)
    const e = await applyMutation({ kind: 'create', input: { ledger: 'utilities', type: 'expense', amount: 1234, date: '2026-09-01', category: 'wifi', description: 'Link3' } }, db, NOW)
    await applyMutation({ kind: 'delete', id: e.id }, db, NOW + 1)

    const backup = await createBackup(db, new Date(NOW))
    const text = JSON.stringify(backup)
    const check = checkBackup(text)
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.summary).toMatchObject({ transactions: 1, deleted: 1, utilities: 0, bazar: 1 })

    const other = new MessDb(`restore-${n}`)
    await other.open()
    await applyMutation(bazarExpense(9999, '2026-01-01'), other, NOW) // will be replaced
    await restoreBackup(check.data, other, NOW + 10)
    const restored = await other.transactions.toArray()
    expect(restored.sort((a, b) => a.id.localeCompare(b.id))).toEqual(backup.transactions.sort((a, b) => a.id.localeCompare(b.id)))
    expect((await other.audit.toArray()).at(-1)?.action).toBe('import')
    await other.delete()
  })

  it.each([
    ['not json', '{oops'],
    ['wrong app', JSON.stringify({ app: 'other', schemaVersion: 1, transactions: [] })],
    ['newer version', JSON.stringify({ app: 'mess-ledger', schemaVersion: 99, transactions: [] })],
    ['bad amount', JSON.stringify({ app: 'mess-ledger', schemaVersion: 1, transactions: [{ id: 'a', ledger: 'bazar', type: 'expense', amount: 1.5, date: '2026-01-01', month: '2026-01', createdAt: 1, updatedAt: 1 }] })],
    ['duplicate ids', JSON.stringify({ app: 'mess-ledger', schemaVersion: 1, transactions: [1, 2].map(() => ({ id: 'a', ledger: 'bazar', type: 'expense', amount: 1, date: '2026-01-01', month: '2026-01', createdAt: 1, updatedAt: 1 })) })],
    ['bazar category', JSON.stringify({ app: 'mess-ledger', schemaVersion: 1, transactions: [{ id: 'a', ledger: 'bazar', type: 'expense', amount: 1, category: 'gas', date: '2026-01-01', month: '2026-01', createdAt: 1, updatedAt: 1 }] })],
  ])('rejects %s', (_label, text) => {
    expect(checkBackup(text).ok).toBe(false)
  })
})
