import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeLedgerMonth } from '../domain/ledger'
import { checkBackup, createBackup, planRestore, restoreBackup, undoLastRestore } from './backup'
import { applyClosing } from './closing'
import { MessDb } from './db'
import {
  addCategory,
  applyMemberChange,
  archiveCategory,
  canDeleteMember,
  deleteCategory,
  deleteMember,
  planMemberChange,
  renameCategory,
  renameMember,
  restoreCategory,
  rosterPlanProblem,
  setupHousehold,
} from './household'
import { applyMutation, loadHousehold, ValidationError } from './repo'

let db: MessDb
let n = 0
const NOW = new Date('2026-06-15T10:00:00').getTime()

beforeEach(async () => {
  n += 1
  db = new MessDb(`household-${n}`)
  await db.open()
})
afterEach(async () => {
  await db.delete()
})

const byName = async (name: string, d = db) => (await loadHousehold(d)).members.find((m) => m.name === name)!
const bazar = (taka: number, date: string) => applyMutation({ kind: 'create', input: { ledger: 'bazar', type: 'expense', amount: taka * 100, date } }, db, NOW)
const pay = (memberId: string, taka: number, date: string, ledger: 'bazar' | 'utilities' = 'bazar') =>
  applyMutation({ kind: 'create', input: { ledger, type: 'contribution', amount: taka * 100, date, memberId } }, db, NOW)
const summary = async (ledger: 'bazar' | 'utilities', month: string, d = db) => {
  const h = await loadHousehold(d)
  return computeLedgerMonth(ledger, h.members, await d.transactions.toArray(), month, await d.closings.toArray())
}

describe('first launch', () => {
  it('starts without a household; nothing can be recorded until it is set up', async () => {
    expect(await loadHousehold(db)).toEqual({ members: [], categories: [] })
    await expect(bazar(100, '2026-06-01')).rejects.toBeInstanceOf(ValidationError)
    expect(await db.transactions.count()).toBe(0)
  })

  it('sets up any number of members with validated, unique names and optional categories', async () => {
    await expect(setupHousehold(['Ana', 'ana'], [], db, NOW)).rejects.toThrow(/already used/)
    await expect(setupHousehold([], [], db, NOW)).rejects.toThrow(/at least one/)
    await expect(setupHousehold(['  ', 'B'], [], db, NOW)).rejects.toThrow(/Enter a name/)
    await setupHousehold(['  Ana  Rahman ', 'Ben', 'Cy'], ['Water Bill', 'Internet'], db, NOW)
    const h = await loadHousehold(db)
    expect(h.members.map((m) => [m.name, m.seq, m.periods])).toEqual([
      ['Ana Rahman', 0, [{}]],
      ['Ben', 1, [{}]],
      ['Cy', 2, [{}]],
    ])
    expect(new Set(h.members.map((m) => m.id)).size).toBe(3)
    expect(h.categories.map((c) => c.name)).toEqual(['Water Bill', 'Internet'])
    expect((await db.audit.toArray()).at(-1)).toMatchObject({ action: 'household-setup' })
    await expect(setupHousehold(['Dan'], [], db, NOW)).rejects.toThrow(/already set up/)
    // A three-member household splits three ways; the leftover poisha goes to position monthIndex(June 2026) mod 3 = 2.
    await bazar(100, '2026-06-02')
    expect((await summary('bazar', '2026-06')).members.map((m) => m.share)).toEqual([3333, 3333, 3334])
  })

  it('a single-member household works', async () => {
    await setupHousehold(['Solo'], [], db, NOW)
    await bazar(55.55, '2026-06-02')
    expect((await summary('bazar', '2026-06')).members).toEqual([expect.objectContaining({ share: 5555, closing: -5555 })])
  })
})

describe('members', () => {
  beforeEach(async () => {
    await setupHousehold(['Ana', 'Ben'], ['Gas Bill'], db, NOW - 1)
  })

  it('adds a member from a chosen month, with a preview of the change in open months', async () => {
    await bazar(100, '2026-05-03')
    await bazar(300, '2026-06-03')
    const plan = await planMemberChange({ kind: 'add', name: 'Cy', from: '2026-06' }, db, NOW)
    expect(rosterPlanProblem(plan)).toBeNull()
    const bz = plan.impact.ledgers.find((l) => l.ledger === 'bazar')!
    expect(bz.changedMonths).toEqual(['2026-06'])
    expect(await db.members.count()).toBe(2) // planning writes nothing
    await applyMemberChange({ kind: 'add', name: 'Cy', from: '2026-06' }, db, NOW)
    const may = await summary('bazar', '2026-05')
    const jun = await summary('bazar', '2026-06')
    expect(may.sharers).toHaveLength(2)
    expect(jun.sharers).toHaveLength(3)
    expect(jun.members.find((m) => m.memberId === (jun.sharers[2]))?.share).toBe(100_00)
    expect((await db.audit.toArray()).at(-1)).toMatchObject({ action: 'member-add', memberAfter: { name: 'Cy' } })
    await expect(applyMemberChange({ kind: 'add', name: 'cy', from: '2026-06' }, db, NOW)).rejects.toThrow(/already used/)
  })

  it('never changes a closed month: changes must start after the latest closing in either ledger', async () => {
    await bazar(100, '2026-04-03')
    await applyClosing({ ledger: 'utilities', sourceMonth: '2026-04', method: 'carry', cashMode: 'carry' }, db, NOW)
    const before = await summary('bazar', '2026-04')
    const plan = await planMemberChange({ kind: 'add', name: 'Cy', from: '2026-04' }, db, NOW)
    expect(rosterPlanProblem(plan)).toMatch(/April 2026 is closed/)
    await expect(applyMemberChange({ kind: 'add', name: 'Cy', from: '2026-04' }, db, NOW)).rejects.toThrow(/closed/)
    await expect(applyMemberChange({ kind: 'end', id: (await byName('Ben')).id, lastMonth: '2026-03' }, db, NOW)).rejects.toThrow(/closed/)
    expect(await db.members.count()).toBe(2)
    await applyMemberChange({ kind: 'add', name: 'Cy', from: '2026-05' }, db, NOW)
    expect(await summary('bazar', '2026-04')).toEqual(before) // closed month unchanged
  })

  it('a member leaving with an outstanding balance keeps it until settled; nothing is redistributed', async () => {
    const ana = await byName('Ana')
    const ben = await byName('Ben')
    await pay(ana.id, 400, '2026-04-01')
    await bazar(400, '2026-04-02') // Ana +200, Ben −200
    const plan = await planMemberChange({ kind: 'end', id: ben.id, lastMonth: '2026-04' }, db, NOW)
    expect(rosterPlanProblem(plan)).toBeNull()
    await applyMemberChange({ kind: 'end', id: ben.id, lastMonth: '2026-04' }, db, NOW)
    await bazar(100, '2026-05-02')
    const may = await summary('bazar', '2026-05')
    expect(may.sharers).toEqual([ana.id])
    expect(may.members.find((m) => m.memberId === ben.id)).toMatchObject({ opening: -200_00, share: 0, closing: -200_00 })
    expect(may.members.find((m) => m.memberId === ana.id)).toMatchObject({ opening: 200_00, share: 100_00, closing: 100_00 })
    expect(may.reconciliation.balanced).toBe(true)
    // Ben settles in June: the balance clears and Ben disappears from later months.
    await pay(ben.id, 200, '2026-06-01')
    expect((await summary('bazar', '2026-06')).members.find((m) => m.memberId === ben.id)?.closing).toBe(0)
    expect((await summary('bazar', '2026-07')).members.map((m) => m.memberId)).toEqual([ana.id])
    expect(await canDeleteMember(ben.id, db)).toBe(false) // history is kept
    await expect(deleteMember(ben.id, db, NOW)).rejects.toThrow(/End the membership/)
  })

  it('refuses ending the last member of a month that has expenses', async () => {
    await bazar(50, '2026-06-03')
    const ana = await byName('Ana')
    const ben = await byName('Ben')
    await applyMemberChange({ kind: 'end', id: ben.id, lastMonth: '2026-05' }, db, NOW)
    await expect(applyMemberChange({ kind: 'end', id: ana.id, lastMonth: '2026-05' }, db, NOW)).rejects.toThrow(/Nobody would share the expenses of June 2026/)
  })

  it('rejoins in a later month, renames without touching any figure, and removes only unused members', async () => {
    const ben = await byName('Ben')
    await bazar(100, '2026-03-02')
    await applyMemberChange({ kind: 'end', id: ben.id, lastMonth: '2026-03' }, db, NOW)
    await expect(applyMemberChange({ kind: 'rejoin', id: ben.id, from: '2026-03' }, db, NOW)).rejects.toThrow(/after March 2026/)
    await applyMemberChange({ kind: 'rejoin', id: ben.id, from: '2026-05' }, db, NOW)
    expect((await loadHousehold(db)).members.find((m) => m.id === ben.id)!.periods).toEqual([{ until: '2026-03' }, { from: '2026-05' }])

    const before = await summary('bazar', '2026-06')
    await renameMember(ben.id, 'Benjamin', db, NOW)
    expect(await summary('bazar', '2026-06')).toEqual(before)
    await expect(renameMember(ben.id, 'ana', db, NOW)).rejects.toThrow(/already used/)

    await applyMemberChange({ kind: 'add', name: 'Typo', from: '2026-06' }, db, NOW)
    const typo = await byName('Typo')
    expect(await canDeleteMember(typo.id, db)).toBe(true)
    await deleteMember(typo.id, db, NOW)
    expect(await db.members.get(typo.id)).toBeUndefined()
    expect((await db.audit.toArray()).at(-1)).toMatchObject({ action: 'member-delete', memberBefore: { name: 'Typo' } })
  })
})

describe('utilities categories', () => {
  beforeEach(async () => {
    await setupHousehold(['Ana', 'Ben'], ['Gas Bill', 'Water'], db, NOW - 1)
  })

  it('create, rename, archive, restore; archived ones stay on old entries but are not offered for new ones', async () => {
    const gas = (await loadHousehold(db)).categories[0]
    const e = await applyMutation({ kind: 'create', input: { ledger: 'utilities', type: 'expense', amount: 500_00, date: '2026-06-02', category: gas.id } }, db, NOW)
    await renameCategory(gas.id, 'Gas', db, NOW)
    expect((await db.transactions.get(e.id))!.category).toBe(gas.id) // id unchanged; the new name shows everywhere
    await expect(renameCategory(gas.id, 'water', db, NOW)).rejects.toThrow(/already used/)
    await archiveCategory(gas.id, db, NOW)
    await expect(applyMutation({ kind: 'create', input: { ledger: 'utilities', type: 'expense', amount: 1, date: '2026-06-03', category: gas.id } }, db, NOW)).rejects.toBeInstanceOf(
      ValidationError,
    )
    // Editing the old entry keeps its (archived) category.
    await applyMutation({ kind: 'update', id: e.id, input: { ledger: 'utilities', type: 'expense', amount: 600_00, date: '2026-06-02', category: gas.id } }, db, NOW + 1)
    expect((await summary('utilities', '2026-06')).categoryTotals).toEqual({ [gas.id]: 600_00 })
    await restoreCategory(gas.id, db, NOW)
    expect((await db.categories.get(gas.id))!.archivedAt).toBeUndefined()
    const c = await addCategory('Internet', db, NOW)
    expect(c.seq).toBe(2)
  })

  it('a category used by any entry (even a deleted one) is kept; unused ones can be deleted', async () => {
    const [gas, water] = (await loadHousehold(db)).categories
    const e = await applyMutation({ kind: 'create', input: { ledger: 'utilities', type: 'expense', amount: 1_00, date: '2026-06-02', category: gas.id } }, db, NOW)
    await applyMutation({ kind: 'delete', id: e.id }, db, NOW + 1)
    await expect(deleteCategory(gas.id, db, NOW)).rejects.toThrow(/Archive it instead/)
    await deleteCategory(water.id, db, NOW)
    expect(await db.categories.get(water.id)).toBeUndefined()
    expect((await db.audit.toArray()).at(-1)).toMatchObject({ action: 'category-delete', categoryBefore: { name: 'Water' } })
  })
})

describe('backups of a configurable household', () => {
  async function richDevice(d: MessDb) {
    await setupHousehold(['Ana', 'Ben', 'Cy'], ['Gas Bill', 'Old Bill'], d, NOW - 1)
    const h = await loadHousehold(d)
    const [ana, ben, cy] = h.members
    const [gas, old] = h.categories
    await applyMutation({ kind: 'create', input: { ledger: 'utilities', type: 'expense', amount: 333_33, date: '2026-04-02', category: old.id } }, d, NOW)
    await applyMutation({ kind: 'create', input: { ledger: 'utilities', type: 'expense', amount: 100_00, date: '2026-05-02', category: gas.id } }, d, NOW)
    await applyMutation({ kind: 'create', input: { ledger: 'bazar', type: 'contribution', amount: 900_00, date: '2026-04-01', memberId: ana.id } }, d, NOW)
    await applyMutation({ kind: 'create', input: { ledger: 'bazar', type: 'expense', amount: 600_00, date: '2026-04-05' } }, d, NOW)
    await archiveCategory(old.id, d, NOW)
    await applyMemberChange({ kind: 'end', id: cy.id, lastMonth: '2026-04' }, d, NOW)
    await applyClosing({ ledger: 'bazar', sourceMonth: '2026-04', method: 'carry', cashMode: 'carry' }, d, NOW)
    return { ana, ben, cy, gas, old }
  }

  it('a full backup round-trips members, periods, archived categories and every figure', async () => {
    const { cy } = await richDevice(db)
    const file = await createBackup(db, new Date(NOW))
    const check = checkBackup(JSON.stringify(file))
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.summary.memberNames).toEqual(['Ana', 'Ben', 'Cy'])
    const other = new MessDb(`household-other-${n}`)
    await other.open()
    await setupHousehold(['Somebody Else'], [], other, NOW)
    await restoreBackup(check.data, other, NOW + 5)
    expect(await loadHousehold(other)).toEqual(await loadHousehold(db))
    for (const ledger of ['utilities', 'bazar'] as const) {
      for (const month of ['2026-04', '2026-05', '2026-06']) expect(await summary(ledger, month, other)).toEqual(await summary(ledger, month, db))
    }
    expect((await summary('bazar', '2026-05', other)).members.find((m) => m.memberId === cy.id)!.closing).toBe(-200_00) // former member's balance kept
    // Undo puts back the previous household too.
    await undoLastRestore(other, NOW + 6)
    expect((await loadHousehold(other)).members.map((m) => m.name)).toEqual(['Somebody Else'])
    await other.delete()
  })

  it('rejects a backup whose entries refer to unknown members or categories', async () => {
    await richDevice(db)
    const file = await createBackup(db, new Date(NOW))
    const broken = { ...file, members: file.members.slice(0, 2) }
    expect(checkBackup(JSON.stringify(broken))).toMatchObject({ ok: false })
    const noCats = { ...file, categories: [] }
    expect(checkBackup(JSON.stringify(noCats))).toMatchObject({ ok: false })
  })

  it('a single-ledger backup restores into the same household, but is refused for a different household', async () => {
    await richDevice(db)
    const bz = await createBackup(db, new Date(NOW), 'bazar')
    const check = checkBackup(JSON.stringify(bz))
    if (!check.ok) throw new Error(check.errors.join())
    // Same household: allowed, Utilities untouched.
    const utilBefore = await db.transactions.where('ledger').equals('utilities').toArray()
    expect((await planRestore(check.data, db, NOW)).problem).toBeNull()
    await restoreBackup(check.data, db, NOW + 1)
    expect(await db.transactions.where('ledger').equals('utilities').toArray()).toEqual(utilBefore)

    // A device with different members: refused before anything is written.
    const other = new MessDb(`household-diff-${n}`)
    await other.open()
    await setupHousehold(['Xavier', 'Yan'], [], other, NOW)
    await applyMutation({ kind: 'create', input: { ledger: 'utilities', type: 'expense', amount: 10_00, date: '2026-04-02' } }, other, NOW).catch(() => {})
    const plan = await planRestore(check.data, other, NOW)
    expect(plan.problem).toMatch(/different members|share different months/)
    const before = { txs: await other.transactions.toArray(), members: await other.members.toArray() }
    await expect(restoreBackup(check.data, other, NOW + 1)).rejects.toThrow(/Restore a full backup/)
    expect({ txs: await other.transactions.toArray(), members: await other.members.toArray() }).toEqual(before)
    await other.delete()
  })
})

describe('audit regressions', () => {
  it('a member who shares months with expenses cannot be removed, even with no own entries (their share would move)', async () => {
    await setupHousehold(['Ana', 'Ben'], [], db, NOW - 1)
    await applyMemberChange({ kind: 'add', name: 'Cy', from: '2026-05' }, db, NOW)
    const cy = await byName('Cy')
    await bazar(300, '2026-05-03') // Cy has a ৳100 share but no entry of their own
    await applyMemberChange({ kind: 'end', id: cy.id, lastMonth: '2026-05' }, db, NOW)
    const before = await summary('bazar', '2026-06')
    expect(await canDeleteMember(cy.id, db)).toBe(false)
    await expect(deleteMember(cy.id, db, NOW)).rejects.toThrow(/shared expenses/)
    expect(await summary('bazar', '2026-06')).toEqual(before)
  })

  it('undoing a single-ledger restore keeps members and categories the other ledger now uses', async () => {
    await setupHousehold(['Ana', 'Ben'], ['Gas'], db, NOW - 1)
    await bazar(100, '2026-05-03')
    const file = checkBackup(JSON.stringify(await createBackup(db, new Date(NOW), 'bazar')))
    if (!file.ok) throw new Error(file.errors.join())
    await restoreBackup(file.data, db, NOW + 1)
    // After the restore: a new member and category, used by Utilities entries.
    await applyMemberChange({ kind: 'add', name: 'Cy', from: '2026-06' }, db, NOW + 2)
    const cy = await byName('Cy')
    const water = await addCategory('Water', db, NOW + 2)
    await applyMutation({ kind: 'create', input: { ledger: 'utilities', type: 'contribution', amount: 50_00, date: '2026-06-02', memberId: cy.id } }, db, NOW + 3)
    await applyMutation({ kind: 'create', input: { ledger: 'utilities', type: 'expense', amount: 30_00, date: '2026-06-02', category: water.id } }, db, NOW + 3)
    await undoLastRestore(db, NOW + 4)
    const h = await loadHousehold(db)
    expect(h.members.map((m) => m.name)).toContain('Cy')
    expect(h.categories.map((c) => c.name)).toContain('Water')
    // Everything is still consistent: a new backup validates.
    expect(checkBackup(JSON.stringify(await createBackup(db, new Date(NOW + 5)))).ok).toBe(true)
  })
})
