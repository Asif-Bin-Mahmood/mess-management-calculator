import 'fake-indexeddb/auto'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { legacyCategories, legacyMembers, setHouseholdDisplay } from '../domain/household'
import { CATS5, R4 } from '../domain/testUtils'
import type { Transaction } from '../domain/types'
import { AppContext, type AppState } from '../ui/context'
import { Settings } from '../ui/screens/Settings'
import { checkBackup, planRestore, restoreBackup, singleLedgerRestoreProblem } from './backup'
import { MessDb } from './db'
import { applyMemberChange, setupHousehold } from './household'
import { loadHousehold } from './repo'
import { seedLegacyHousehold } from './testDb'

// The service-worker helper needs a build-time virtual module; the Backup screen only uses its install prompt.
vi.mock('../ui/pwa', () => ({ useInstallPrompt: () => null, setupServiceWorker: () => {} }))

// Members are household-wide, so a single-ledger backup can only be restored while the members match it.
// Older single-ledger backups (made before someone joined or left) are refused with an explanation.

let db: MessDb
let n = 0
const NOW = Date.UTC(2026, 9, 15)

beforeEach(async () => {
  db = new MessDb(`single-ledger-${++n}`)
  await db.open()
  await seedLegacyHousehold(db) // an upgraded v1.1.1 installation
})
afterEach(async () => {
  await db.delete()
})

/** A Bazar-only backup as app 1.1.1 wrote it (schema 3): monthly expenses and contributions for `months`. */
function oldBazarBackup(months: string[]) {
  let k = 0
  const transactions: Transaction[] = months.flatMap((m) => [
    { id: `ob-${++k}`, ledger: 'bazar', type: 'expense', amount: 400_00, date: `${m}-05`, month: m, createdAt: k, updatedAt: k },
    { id: `ob-${++k}`, ledger: 'bazar', type: 'contribution', amount: 400_00, date: `${m}-06`, month: m, memberId: 'asif', createdAt: k, updatedAt: k },
  ])
  const file = { app: 'mess-ledger', schemaVersion: 3, backupId: `old-${months[0]}-${months.length}`, exportedAt: '2026-04-01T00:00:00Z', scope: 'bazar', transactions, closings: [], audit: [], memberNames: { asif: 'Asif', dipu: 'Dipu', yusha: 'Yusha', ovi: 'Ovi' } }
  const check = checkBackup(JSON.stringify(file))
  if (!check.ok) throw new Error(check.errors.join())
  return check.data
}

async function state() {
  return { txs: (await db.transactions.toArray()).sort((a, b) => a.id.localeCompare(b.id)), members: await db.members.toArray(), audit: await db.audit.count() }
}

describe('restoring an older single-ledger backup', () => {
  it('works while the members still match', async () => {
    const backup = oldBazarBackup(['2026-01', '2026-02', '2026-03'])
    expect((await planRestore(backup, db, NOW)).problem).toBeNull()
    await restoreBackup(backup, db, NOW)
    expect(await db.transactions.count()).toBe(6)
  })

  it('is refused with a clear explanation after a member joined in a month the backup covers; nothing changes', async () => {
    await applyMemberChange({ kind: 'add', name: 'Cy', from: '2026-02' }, db, NOW)
    const backup = oldBazarBackup(['2026-01', '2026-02', '2026-03'])
    const plan = await planRestore(backup, db, NOW)
    expect(plan.problemKind).toBe('this-ledger')
    expect(plan.problem).toBe(singleLedgerRestoreProblem('this-ledger', 'bazar'))
    for (const phrase of ['joined or left', 'Members are shared by both ledgers', 'Nothing was changed', 'Restore a full backup']) expect(plan.problem).toContain(phrase)
    const before = await state()
    await expect(restoreBackup(backup, db, NOW + 1)).rejects.toThrow(/Restore a full backup/)
    expect(await state()).toEqual(before)
  })

  it('is refused after a member left during the backup’s months too', async () => {
    await applyMemberChange({ kind: 'end', id: 'ovi', lastMonth: '2026-01' }, db, NOW)
    const plan = await planRestore(oldBazarBackup(['2026-01', '2026-02']), db, NOW)
    expect(plan.problemKind).toBe('this-ledger')
  })

  it('still restores when the change only affects months after the backup', async () => {
    await applyMemberChange({ kind: 'add', name: 'Cy', from: '2026-04' }, db, NOW)
    const backup = oldBazarBackup(['2026-01', '2026-02', '2026-03'])
    expect((await planRestore(backup, db, NOW)).problem).toBeNull()
    await restoreBackup(backup, db, NOW)
    expect((await loadHousehold(db)).members.map((m) => m.name)).toContain('Cy') // household kept
  })

  it('a full backup is the way out: it restores and brings back the backup’s household', async () => {
    await applyMemberChange({ kind: 'add', name: 'Cy', from: '2026-02' }, db, NOW)
    const old = oldBazarBackup(['2026-01', '2026-02'])
    const full = checkBackup(JSON.stringify({ ...old, schemaVersion: 3, scope: 'all', backupId: 'full-old', memberNames: { asif: 'Asif', dipu: 'Dipu', yusha: 'Yusha', ovi: 'Ovi' } }))
    if (!full.ok) throw new Error(full.errors.join())
    expect((await planRestore(full.data, db, NOW)).problem).toBeNull()
    await restoreBackup(full.data, db, NOW)
    expect((await loadHousehold(db)).members.map((m) => m.id)).toEqual(['asif', 'dipu', 'yusha', 'ovi'])
  })

  it('a single-ledger backup from a different household is refused because it would change the other ledger', async () => {
    const other = new MessDb(`single-ledger-other-${++n}`)
    await other.open()
    await setupHousehold(['Xavier', 'Yan'], ['Gas'], other, NOW)
    const { applyMutation } = await import('./repo')
    await applyMutation({ kind: 'create', input: { ledger: 'utilities', type: 'expense', amount: 10_00, date: '2026-01-02', category: (await loadHousehold(other)).categories[0].id } }, other, NOW)
    const plan = await planRestore(oldBazarBackup(['2026-01']), other, NOW)
    expect(plan.problemKind).toBe('other-ledger')
    expect(plan.problem).toContain('Restoring it would also change the Utilities balances')
    await other.delete()
  })
})

describe('the Backup screen explains the limitation before a file is chosen', () => {
  it('shows the single-ledger note on the Restore card', () => {
    setHouseholdDisplay(legacyMembers(), legacyCategories())
    const app: AppState = { txs: [], closings: [], members: R4, categories: CATS5, needsSetup: false, month: '2026-10', setMonth: () => {} }
    const html = renderToStaticMarkup(h(AppContext.Provider, { value: app }, h(Settings)))
    expect(html).toContain('id="single-ledger-note"')
    expect(html).toContain('Members are shared by both ledgers')
    expect(html).toContain('Restore a full backup in that case')
  })
})
