import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeLedgerMonth } from '../domain/ledger'
import type { LedgerId, MemberId } from '../domain/types'
import { checkBackup, createBackup, getRestoreUndo, importStatus, restoreBackup, undoLastRestore } from './backup'
import { applyClosing, ClosingError, planClosing, planUndoClosing, undoClosing } from './closing'
import { MessDb } from './db'
import { applyMutation } from './repo'

let db: MessDb
let n = 0
const NOW = new Date('2026-10-20T10:00:00').getTime()

beforeEach(async () => {
  n += 1
  db = new MessDb(`closing-${n}`)
  await db.open()
})

afterEach(async () => {
  await db.delete()
})

async function seed(ledger: LedgerId) {
  const cat = ledger === 'utilities' ? { category: 'gas' as const } : {}
  const c = (memberId: MemberId, taka: number, date: string) =>
    applyMutation({ kind: 'create', input: { ledger, type: 'contribution', amount: taka * 100, date, memberId } }, db, NOW)
  await c('asif', 3000, '2026-09-01')
  await c('dipu', 1000, '2026-09-02')
  await applyMutation({ kind: 'create', input: { ledger, type: 'expense', amount: 2000_00, date: '2026-09-05', ...cat } }, db, NOW)
}

/** Everything stored for one ledger, for before/after isolation checks. */
async function ledgerRows(ledger: LedgerId) {
  const txs = (await db.transactions.toArray()).filter((t) => t.ledger === ledger).sort((a, b) => a.id.localeCompare(b.id))
  const closings = (await db.closings.toArray()).filter((c) => c.ledger === ledger).sort((a, b) => a.id.localeCompare(b.id))
  return { txs, closings }
}

async function month(ledger: LedgerId, m: string) {
  return computeLedgerMonth(ledger, await db.transactions.toArray(), m, await db.closings.toArray())
}

describe('closing a month', () => {
  it('initialises the next month from the chosen method without any file transfer', async () => {
    await seed('bazar')
    const plan = await planClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'settled', cashMode: 'carry' }, db, NOW)
    expect(plan.preview.target.members.every((m) => m.opening === 0)).toBe(true)
    expect(await db.closings.count()).toBe(0) // planning writes nothing

    const c = await applyClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'settled', cashMode: 'carry' }, db, NOW)
    expect(c.targetMonth).toBe('2026-10')
    expect(c.snapshot.closingCash).toBe(2000_00)
    const oct = await month('bazar', '2026-10')
    expect(oct.members.every((m) => m.opening === 0)).toBe(true)
    expect(oct.openingCash).toBe(2000_00)
    expect(await db.transactions.count()).toBe(3) // no transactions created
    const audit = await db.audit.toArray()
    expect(audit.at(-1)).toMatchObject({ action: 'close', ledger: 'bazar' })
  })

  it('validates input and rejects duplicate closings, including concurrent double taps', async () => {
    await seed('bazar')
    await expect(applyClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'manual', cashMode: 'set' }, db, NOW)).rejects.toBeInstanceOf(ClosingError)
    const input = { ledger: 'bazar' as const, sourceMonth: '2026-09', method: 'carry' as const, cashMode: 'carry' as const }
    const results = await Promise.allSettled([applyClosing(input, db, NOW), applyClosing(input, db, NOW)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await db.closings.count()).toBe(1)
    await expect(applyClosing(input, db, NOW)).rejects.toThrow(/already closed/)
    await expect(applyClosing({ ...input, sourceMonth: '2026-11' }, db, NOW)).rejects.toThrow(/once it has ended/)
    await expect(applyClosing({ ...input, sourceMonth: '2026-10' }, db, NOW)).rejects.toThrow(/once it has ended/) // current month
  })

  it('keeps closings after the app is closed and reopened', async () => {
    await seed('utilities')
    const c = await applyClosing({ ledger: 'utilities', sourceMonth: '2026-09', method: 'carry', cashMode: 'carry' }, db, NOW)
    db.close()
    const again = new MessDb(db.name)
    await again.open()
    expect(await again.closings.get(c.id)).toEqual(c)
    expect(await again.transactions.count()).toBe(3)
    again.close()
    await db.open()
  })
})

describe('undo a closing', () => {
  it('undoes immediately, keeps the record and the audit trail, and refuses a second undo', async () => {
    await seed('bazar')
    const c = await applyClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived', cashMode: 'carry' }, db, NOW)
    const plan = await planUndoClosing(c.id, db, NOW)
    expect(plan.openingAfter.balances.asif).toBe(2500_00)
    const undone = await undoClosing(c.id, db, NOW + 1)
    expect(undone.undoneAt).toBe(NOW + 1)
    expect(await db.closings.count()).toBe(1) // never deleted
    const oct = await month('bazar', '2026-10')
    expect(oct.opening.source).toBe('carry')
    expect(oct.members.find((m) => m.memberId === 'asif')!.opening).toBe(2500_00)
    expect((await db.audit.toArray()).map((a) => a.action).slice(-2)).toEqual(['close', 'undo-close'])
    await expect(undoClosing(c.id, db, NOW + 2)).rejects.toThrow(/already been undone/)
    // After undo the month can be closed again with a different method.
    await applyClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'carry', cashMode: 'carry' }, db, NOW + 3)
    expect((await month('bazar', '2026-10')).opening.closing?.method).toBe('carry')
  })

  it('undoes after the app has been restarted', async () => {
    await seed('bazar')
    const c = await applyClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'settled', cashMode: 'carry' }, db, NOW)
    db.close()
    const again = new MessDb(db.name)
    await again.open()
    await undoClosing(c.id, again, NOW + 1)
    expect((await again.closings.get(c.id))?.undoneAt).toBe(NOW + 1)
    again.close()
    await db.open()
  })

  it('keeps next-month transactions untouched and only shifts their balances', async () => {
    await seed('bazar')
    const c = await applyClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived', cashMode: 'carry' }, db, NOW)
    const t = await applyMutation({ kind: 'create', input: { ledger: 'bazar', type: 'expense', amount: 400_00, date: '2026-10-03' } }, db, NOW)
    const plan = await planUndoClosing(c.id, db, NOW)
    expect(plan.dependentTransactionCount).toBe(1)
    expect(plan.blockedBy).toEqual([])
    const txsBefore = await db.transactions.toArray()
    await undoClosing(c.id, db, NOW + 1)
    expect(await db.transactions.toArray()).toEqual(txsBefore)
    const oct = await month('bazar', '2026-10')
    expect(oct.totalSpent).toBe(400_00)
    expect(oct.members.find((m) => m.memberId === 'asif')!.closing).toBe(2500_00 - 100_00)
    expect((await db.transactions.get(t.id))?.amount).toBe(400_00)
  })

  it('refuses to undo when a later closing depends on it, then allows newest-first', async () => {
    await seed('bazar')
    const c9 = await applyClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived', cashMode: 'carry' }, db, NOW)
    const NOV = new Date('2026-11-02T10:00:00').getTime()
    const c10 = await applyClosing({ ledger: 'bazar', sourceMonth: '2026-10', method: 'carry', cashMode: 'carry' }, db, NOV)
    expect((await planUndoClosing(c9.id, db, NOV)).blockedBy.map((c) => c.id)).toEqual([c10.id])
    const before = await ledgerRows('bazar')
    await expect(undoClosing(c9.id, db, NOV + 2)).rejects.toMatchObject({ blockingMonth: '2026-10' })
    expect(await ledgerRows('bazar')).toEqual(before) // nothing changed
    await undoClosing(c10.id, db, NOV + 3)
    await undoClosing(c9.id, db, NOV + 4)
    expect((await db.closings.toArray()).every((c) => c.undoneAt !== undefined)).toBe(true)
  })

  it('also refuses to close an earlier month out of order', async () => {
    await seed('bazar')
    await applyClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'carry', cashMode: 'carry' }, db, NOW)
    await expect(applyClosing({ ledger: 'bazar', sourceMonth: '2026-08', method: 'carry', cashMode: 'carry' }, db, NOW)).rejects.toMatchObject({
      blockingMonth: '2026-09',
    })
  })
})

describe('ledger isolation in storage', () => {
  for (const [ledger, other] of [
    ['utilities', 'bazar'],
    ['bazar', 'utilities'],
  ] as const) {
    it(`${ledger} transactions, corrections, closing, undo and restore never change ${other}`, async () => {
      await seed('utilities')
      await seed('bazar')
      const otherBefore = await ledgerRows(other)
      const otherSummary = await month(other, '2026-11')
      const cat = ledger === 'utilities' ? { category: 'wifi' as const } : {}

      const t = await applyMutation({ kind: 'create', input: { ledger, type: 'expense', amount: 500_00, date: '2026-09-20', ...cat } }, db, NOW)
      await applyMutation({ kind: 'update', id: t.id, input: { ledger, type: 'expense', amount: 600_00, date: '2026-09-21', ...cat } }, db, NOW)
      await applyMutation({ kind: 'delete', id: t.id }, db, NOW)
      const c = await applyClosing({ ledger, sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived', cashMode: 'set', openingCash: 0 }, db, NOW)
      await undoClosing(c.id, db, NOW)
      await applyClosing({ ledger, sourceMonth: '2026-09', method: 'manual', cashMode: 'set', openingCash: 5, openingBalances: { asif: 1, dipu: 2, yusha: 3, ovi: -1 } }, db, NOW)
      const backup = await createBackup(db, new Date(NOW), ledger)
      await applyMutation({ kind: 'create', input: { ledger, type: 'expense', amount: 1_00, date: '2026-10-01', ...cat } }, db, NOW)
      await restoreBackup(backup, db, NOW + 10)
      await undoLastRestore(db, NOW + 11)

      expect(await ledgerRows(other)).toEqual(otherBefore)
      expect(await month(other, '2026-11')).toEqual(otherSummary)
    })
  }
})

describe('per-ledger backup and restore', () => {
  it('exports only the chosen ledger and restores it without touching the other', async () => {
    await seed('utilities')
    await seed('bazar')
    await applyClosing({ ledger: 'utilities', sourceMonth: '2026-09', method: 'carry', cashMode: 'carry' }, db, NOW)
    const backup = await createBackup(db, new Date(NOW), 'utilities')
    expect(backup.scope).toBe('utilities')
    expect(backup.transactions.every((t) => t.ledger === 'utilities')).toBe(true)
    expect(backup.closings.every((c) => c.ledger === 'utilities')).toBe(true)
    expect(backup.audit.every((a) => (a.ledger ?? a.after?.ledger) === 'utilities')).toBe(true)

    const check = checkBackup(JSON.stringify(backup))
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.summary).toMatchObject({ scope: 'utilities', utilities: 3, bazar: 0, closings: 1 })

    // Change utilities on the device, then restore the backup.
    await applyMutation({ kind: 'create', input: { ledger: 'utilities', type: 'expense', amount: 1_00, date: '2026-10-01', category: 'others' } }, db, NOW + 5)
    const bazarBefore = await ledgerRows('bazar')
    const auditBefore = await db.audit.count()
    const status = await importStatus(check.data, db)
    expect(status).toMatchObject({ alreadyImportedAt: null, identical: false, newerLocalChanges: 1 })

    await restoreBackup(check.data, db, NOW + 10)
    expect((await ledgerRows('utilities')).txs).toHaveLength(3)
    expect(await ledgerRows('bazar')).toEqual(bazarBefore)
    expect(await db.audit.count()).toBeGreaterThan(auditBefore) // history kept and extended

    // Restoring the same file again is detected.
    const again = await importStatus(check.data, db)
    expect(again.alreadyImportedAt).toBe(NOW + 10)
    expect(again.identical).toBe(true)

    // The restore can be undone.
    expect(await getRestoreUndo(db)).toMatchObject({ scope: 'utilities' })
    await undoLastRestore(db, NOW + 11)
    expect((await ledgerRows('utilities')).txs).toHaveLength(4)
    expect(await getRestoreUndo(db)).toBeNull()
  })

  it('rejects a ledger backup that contains the other ledger, and malformed closings', async () => {
    await seed('bazar')
    const backup = await createBackup(db, new Date(NOW), 'bazar')
    const tampered = { ...backup, scope: 'utilities' }
    expect(checkBackup(JSON.stringify(tampered))).toMatchObject({ ok: false })
    const badClosing = { ...backup, closings: [{ id: 'x', ledger: 'bazar', sourceMonth: '2026-09', targetMonth: '2026-11', method: 'carry', cashMode: 'carry', snapshot: {}, createdAt: 1 }] }
    expect(checkBackup(JSON.stringify(badClosing))).toMatchObject({ ok: false })
    const unknownMember = { ...backup, transactions: [{ ...backup.transactions[0], memberId: 'rahim' }] }
    expect(checkBackup(JSON.stringify(unknownMember))).toMatchObject({ ok: false })
    const incompatible = { ...backup, schemaVersion: 3 }
    expect(checkBackup(JSON.stringify(incompatible))).toMatchObject({ ok: false })
  })

  it('accepts version 1 backups (no closings) as full backups', () => {
    const v1 = {
      app: 'mess-ledger',
      schemaVersion: 1,
      exportedAt: '2026-10-01T00:00:00.000Z',
      transactions: [{ id: 'a', ledger: 'bazar', type: 'expense', amount: 100, date: '2026-09-01', month: '2026-09', createdAt: 1, updatedAt: 1 }],
      audit: [],
    }
    const check = checkBackup(JSON.stringify(v1))
    expect(check.ok).toBe(true)
    if (check.ok) expect(check.data).toMatchObject({ scope: 'all', closings: [] })
  })

  it('full restore replaces both ledgers and keeps the device audit trail', async () => {
    await seed('utilities')
    const backup = await createBackup(db, new Date(NOW))
    await seed('bazar')
    const auditBefore = await db.audit.toArray()
    await restoreBackup(backup, db, NOW + 1)
    expect((await ledgerRows('bazar')).txs).toHaveLength(0)
    expect((await ledgerRows('utilities')).txs).toHaveLength(3)
    const auditAfter = await db.audit.toArray()
    for (const a of auditBefore) expect(auditAfter).toContainEqual(a)
  })
})

describe('late changes after closing (stored records)', () => {
  for (const method of ['carry', 'settled', 'manual'] as const) {
    it(`${method}: add, edit and delete in the closed month keep the closing record and audit intact`, async () => {
      await seed('bazar')
      await seed('utilities')
      const input =
        method === 'carry'
          ? { method, cashMode: 'carry' as const }
          : method === 'settled'
            ? { method, settlementKind: 'waived' as const, cashMode: 'set' as const, openingCash: 2000_00 }
            : { method, cashMode: 'set' as const, openingCash: 1900_00, openingBalances: { asif: 2500_00, dipu: 400_00, yusha: -500_00, ovi: -500_00 } }
      const c = await applyClosing({ ledger: 'bazar', sourceMonth: '2026-09', ...input }, db, NOW)
      const stored = await db.closings.get(c.id)
      expect(stored?.adjustments).toBeDefined()
      const utilBefore = await ledgerRows('utilities')
      const oct0 = await month('bazar', '2026-10')

      const t = await applyMutation({ kind: 'create', input: { ledger: 'bazar', type: 'expense', amount: 400_00, date: '2026-09-28' } }, db, NOW + 1)
      const oct1 = await month('bazar', '2026-10')
      await applyMutation({ kind: 'update', id: t.id, input: { ledger: 'bazar', type: 'expense', amount: 800_00, date: '2026-09-28' } }, db, NOW + 2)
      const oct2 = await month('bazar', '2026-10')
      await applyMutation({ kind: 'delete', id: t.id }, db, NOW + 3)
      const oct3 = await month('bazar', '2026-10')

      // The stored decision, its adjustments and snapshot never change.
      expect(await db.closings.get(c.id)).toEqual(stored)
      for (const o of [oct1, oct2, oct3]) expect(o.opening.memberAdjustments).toEqual(oct0.opening.memberAdjustments)
      // Each member carries their share of the late expense: −100 after add, −200 after edit, 0 after delete.
      const asif = (s: typeof oct0) => s.members.find((m) => m.memberId === 'asif')!.opening
      expect(asif(oct1)).toBe(asif(oct0) - 100_00)
      expect(asif(oct2)).toBe(asif(oct0) - 200_00)
      expect(asif(oct3)).toBe(asif(oct0))
      expect(oct3.reconciliation).toEqual(oct0.reconciliation)
      // Counted cash is preserved; carried cash follows the correction.
      if (c.cashMode === 'set') {
        expect([oct1.openingCash, oct2.openingCash]).toEqual([oct0.openingCash, oct0.openingCash])
        expect([oct1.reconciliation.unexplained, oct2.reconciliation.unexplained]).toEqual([-400_00, -800_00])
      } else {
        expect([oct1.openingCash, oct2.openingCash]).toEqual([oct0.openingCash - 400_00, oct0.openingCash - 800_00])
        expect(oct2.reconciliation.unexplained).toBe(0)
      }
      // Audit: closing, then create / update / delete with before and after copies.
      const audit = (await db.audit.toArray()).filter((a) => a.ledger === 'bazar').map((a) => a.action)
      expect(audit.slice(-4)).toEqual(['close', 'create', 'update', 'delete'])
      expect(await ledgerRows('utilities')).toEqual(utilBefore)
    })
  }

  it('rejects a backup whose closing adjustments were altered', async () => {
    await seed('bazar')
    await applyClosing({ ledger: 'bazar', sourceMonth: '2026-09', method: 'settled', settlementKind: 'waived', cashMode: 'carry' }, db, NOW)
    const backup = await createBackup(db, new Date(NOW), 'bazar')
    expect(checkBackup(JSON.stringify(backup)).ok).toBe(true)
    const c = backup.closings[0]
    const tampered = { ...backup, closings: [{ ...c, adjustments: { ...c.adjustments!, members: { ...c.adjustments!.members, ovi: 0 } } }] }
    const check = checkBackup(JSON.stringify(tampered))
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.errors.join(' ')).toContain('adjustments do not match')
  })
})
