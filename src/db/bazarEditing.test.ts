import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeLedgerMonth } from '../domain/ledger'
import type { Transaction } from '../domain/types'
import { applyBazarSwitch, loadBazarMethod } from './bazarMethod'
import { applyClosing } from './closing'
import { MessDb } from './db'
import { applyMemberChange, HouseholdError, planMemberChange, rosterPlanProblem, setupHousehold } from './household'
import { applyMutation, loadHousehold, planMutation, ValidationError, type Mutation } from './repo'

// Editing, deleting and restoring member-paid Bazar amounts: recalculation, correction previews for closed months,
// the audit trail, and that a refused change writes nothing.

const NOW = new Date('2026-06-15T10:00:00').getTime()
let db: MessDb
let n = 0

beforeEach(async () => {
  n += 1
  db = new MessDb(`bazar-edit-${n}`)
  await db.open()
  await setupHousehold(['Ana', 'Ben', 'Cy'], [], db, NOW)
})
afterEach(async () => {
  await db.delete()
})

async function ids() {
  const [a, b, c] = (await loadHousehold(db)).members.map((m) => m.id)
  return { a, b, c }
}
const purchase = (memberId: string, taka: number, date: string, description?: string) =>
  applyMutation({ kind: 'create', input: { ledger: 'bazar', type: 'purchase', amount: Math.round(taka * 100), date, memberId, description } }, db, NOW)
const update = (t: Transaction, change: Partial<Transaction>) =>
  ({ kind: 'update', id: t.id, input: { ledger: t.ledger, type: t.type, amount: t.amount, date: t.date, memberId: t.memberId, counterpartyId: t.counterpartyId, description: t.description, ...change } }) as Mutation
async function month(m: string) {
  const h = await loadHousehold(db)
  return computeLedgerMonth('bazar', h.members, await db.transactions.toArray(), m, await db.closings.toArray(), await loadBazarMethod(db))
}
const balances = async (m: string) => (await month(m)).members.map((x) => x.closing)
async function snapshot() {
  return JSON.stringify([await db.transactions.toArray(), await db.audit.toArray(), await db.closings.toArray(), await db.members.toArray(), await db.meta.toArray()])
}

describe('editing a Bazar amount', () => {
  it('changes amount, payer, date and description, recalculates both months and keeps original and corrected values in the audit', async () => {
    const { a, b } = await ids()
    const t = await purchase(a, 300, '2026-04-05', 'rice')
    await purchase(b, 600, '2026-05-05')
    expect(await balances('2026-05')).toEqual([0, 30000, -30000])

    const edited = await applyMutation(update(t, { amount: 45000, memberId: b, date: '2026-05-20', description: 'fish' }), db, NOW + 1)
    expect(edited).toMatchObject({ id: t.id, amount: 45000, memberId: b, month: '2026-05', description: 'fish', createdAt: t.createdAt })
    // April now has no Bazar; May has both amounts, paid by Ben.
    expect((await month('2026-04')).totalSpent).toBe(0)
    const may = await month('2026-05')
    expect(may.totalSpent).toBe(105000)
    expect(may.members.map((m) => [m.contributed, m.share, m.closing])).toEqual([
      [0, 35000, -35000],
      [105000, 35000, 70000],
      [0, 35000, -35000],
    ])
    const entry = (await db.audit.toArray()).filter((e) => e.txId === t.id && e.action === 'update')
    expect(entry).toHaveLength(1)
    expect(entry[0].before).toMatchObject({ amount: 30000, memberId: a, date: '2026-04-05', description: 'rice' })
    expect(entry[0].after).toMatchObject({ amount: 45000, memberId: b, date: '2026-05-20', description: 'fish' })
  })

  it('previews the effect on later months and on a closed month before an edit is saved', async () => {
    const { a } = await ids()
    const t = await purchase(a, 300, '2026-04-05')
    await applyClosing({ ledger: 'bazar', sourceMonth: '2026-04', method: 'carry', cashMode: 'carry' }, db, NOW)
    const before = await snapshot()
    const plan = await planMutation(update(t, { amount: 60000 }), db, NOW)
    expect(await snapshot()).toBe(before) // planning writes nothing
    expect(plan.impact).not.toBeNull()
    expect(plan.impact!.memberPaid).toBe(true)
    expect(plan.impact!.closedMonths).toEqual(['2026-04'])
    expect(plan.impact!.laterMonths[0]).toBe('2026-05')
    expect(plan.impact!.members.map((m) => [m.before, m.after])).toEqual([
      [20000, 40000],
      [-10000, -20000],
      [-10000, -20000],
    ])
    expect([plan.impact!.cashBefore, plan.impact!.cashAfter]).toEqual([0, 0])
    // Saving the correction carries it into May; balances still net to zero and no cash appears.
    await applyMutation(update(t, { amount: 60000 }), db, NOW)
    const may = await month('2026-05')
    expect(may.members.map((m) => m.opening)).toEqual([40000, -20000, -20000])
    expect(may.remainingCash).toBe(0)
    expect(may.reconciliation.balanced).toBe(true)
  })

  it('a correction under a "settled" closing keeps the recorded settlement and carries only the change', async () => {
    const { a } = await ids()
    const t = await purchase(a, 300, '2026-04-05')
    await applyClosing({ ledger: 'bazar', sourceMonth: '2026-04', method: 'settled', settlementKind: 'settled', cashMode: 'carry' }, db, NOW)
    expect(await balances('2026-05')).toEqual([0, 0, 0])
    const plan = await planMutation(update(t, { amount: 33000 }), db, NOW)
    expect(plan.impact!.closingEffects).toHaveLength(1)
    await applyMutation(update(t, { amount: 33000 }), db, NOW)
    const may = await month('2026-05')
    expect(may.members.map((m) => m.opening)).toEqual([2000, -1000, -1000])
    // The settlement recorded at closing stays; the later correction nets to zero across members.
    expect(may.reconciliation.status).toBe('balanced')
    expect(may.reconciliation.balanced).toBe(true)
  })

  it('refused edits write nothing', async () => {
    const { a } = await ids()
    const t = await purchase(a, 300, '2026-04-05')
    const before = await snapshot()
    const bad: Mutation[] = [
      update(t, { amount: 0 }),
      update(t, { memberId: 'nobody' }),
      update(t, { type: 'expense', memberId: undefined }), // cash-method type in a member-paid month
    ]
    for (const m of bad) await expect(applyMutation(m, db, NOW)).rejects.toBeInstanceOf(ValidationError)
    await expect(applyMutation(update(t, { ledger: 'utilities' }), db, NOW)).rejects.toThrow() // cannot move between ledgers
    expect(await snapshot()).toBe(before)
  })

  it('cannot move a Bazar amount into a cash-method month, or a cash entry into a member-paid month', async () => {
    await db.meta.delete('bazarMethod')
    const { a } = await ids()
    const cash = await applyMutation({ kind: 'create', input: { ledger: 'bazar', type: 'expense', amount: 100, date: '2026-04-05' } }, db, NOW)
    await applyMutation({ kind: 'create', input: { ledger: 'bazar', type: 'contribution', amount: 100, date: '2026-04-06', memberId: a } }, db, NOW)
    await applyBazarSwitch('2026-05', db, NOW)
    const paid = await purchase(a, 50, '2026-05-02')
    const before = await snapshot()
    await expect(applyMutation(update(paid, { date: '2026-04-30' }), db, NOW)).rejects.toBeInstanceOf(ValidationError)
    await expect(applyMutation(update(cash, { date: '2026-05-01' }), db, NOW)).rejects.toBeInstanceOf(ValidationError)
    expect(await snapshot()).toBe(before)
  })
})

describe('deleting and restoring', () => {
  it('a deleted Bazar amount stops counting and comes back unchanged from Recently deleted', async () => {
    const { a } = await ids()
    const t = await purchase(a, 300, '2026-05-05')
    await applyMutation({ kind: 'delete', id: t.id }, db, NOW + 1)
    expect((await month('2026-05')).totalSpent).toBe(0)
    const restored = await applyMutation({ kind: 'restore', id: t.id }, db, NOW + 2)
    expect(restored.deletedAt).toBeUndefined()
    expect({ ...restored, updatedAt: 0 }).toEqual({ ...t, updatedAt: 0 })
    expect((await month('2026-05')).totalSpent).toBe(30000)
    expect((await db.audit.toArray()).filter((e) => e.txId === t.id).map((e) => e.action)).toEqual(['create', 'delete', 'restore'])
  })

  it('a deleted cash entry cannot be restored into a month that is now member-paid', async () => {
    await db.meta.delete('bazarMethod')
    const t = await applyMutation({ kind: 'create', input: { ledger: 'bazar', type: 'expense', amount: 100, date: '2026-05-05' } }, db, NOW)
    await applyMutation({ kind: 'delete', id: t.id }, db, NOW)
    await applyBazarSwitch('2026-05', db, NOW)
    const before = await snapshot()
    await expect(applyMutation({ kind: 'restore', id: t.id }, db, NOW)).rejects.toThrow(/other Bazar method/)
    expect(await snapshot()).toBe(before)
  })

  it('a deleted Bazar amount cannot be restored for a member who no longer shares that month', async () => {
    const { c } = await ids()
    const t = await purchase(c, 90, '2026-05-05')
    await applyMutation({ kind: 'delete', id: t.id }, db, NOW)
    // Allowed: the Bazar amount is deleted, so ending Cy's sharing after April refers to no live entry.
    await applyMemberChange({ kind: 'end', id: c, lastMonth: '2026-04' }, db, NOW)
    const before = await snapshot()
    await expect(applyMutation({ kind: 'restore', id: t.id }, db, NOW)).rejects.toThrow(/does not share/)
    expect(await snapshot()).toBe(before)
  })
})

describe('membership changes', () => {
  it('cannot end a member’s sharing in a month they paid Bazar for', async () => {
    const { c } = await ids()
    await purchase(c, 90, '2026-05-05')
    const before = await snapshot()
    const change = { kind: 'end' as const, id: c, lastMonth: '2026-04' }
    const plan = await planMemberChange(change, db, NOW)
    expect(plan.paidOutsideMembership).toEqual([{ memberId: c, month: '2026-05' }])
    expect(rosterPlanProblem(plan)).toMatch(/Cy paid for Bazar in May 2026/)
    await expect(applyMemberChange(change, db, NOW)).rejects.toBeInstanceOf(HouseholdError)
    expect(await snapshot()).toBe(before)
  })
})
