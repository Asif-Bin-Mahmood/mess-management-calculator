import { validateClosing, validateTransaction } from '../domain/validate'
import type { LedgerId, MonthClosing, Transaction } from '../domain/types'
import { db as defaultDb, type AuditEntry, type MessDb } from './db'

export const BACKUP_APP = 'mess-ledger'
/** v1: whole database, transactions + audit. v2: adds closings, scope and backupId. */
export const BACKUP_SCHEMA_VERSION = 2

/** 'all' = both ledgers; otherwise a single ledger, which can only be restored into that ledger. */
export type BackupScope = 'all' | LedgerId

export interface BackupFile {
  app: typeof BACKUP_APP
  schemaVersion: number
  backupId: string
  exportedAt: string
  scope: BackupScope
  transactions: Transaction[]
  closings: MonthClosing[]
  audit: AuditEntry[]
}

export interface BackupSummary {
  scope: BackupScope
  backupId: string
  exportedAt: string
  transactions: number
  deleted: number
  utilities: number
  bazar: number
  closings: number
  firstMonth: string | null
  lastMonth: string | null
}

export type BackupCheck = { ok: true; data: BackupFile; summary: BackupSummary } | { ok: false; errors: string[] }

const inScope = (scope: BackupScope, ledger: LedgerId | undefined) => scope === 'all' || ledger === scope

function auditLedger(a: AuditEntry): LedgerId | undefined {
  return a.ledger ?? a.after?.ledger ?? a.before?.ledger ?? a.closingAfter?.ledger ?? a.closingBefore?.ledger
}

export async function createBackup(database: MessDb = defaultDb, now = new Date(), scope: BackupScope = 'all'): Promise<BackupFile> {
  return database.transaction('r', database.transactions, database.closings, database.audit, async () => ({
    app: BACKUP_APP,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    backupId: crypto.randomUUID(),
    exportedAt: now.toISOString(),
    scope,
    transactions: (await database.transactions.toArray()).filter((t) => inScope(scope, t.ledger)),
    closings: (await database.closings.toArray()).filter((c) => inScope(scope, c.ledger)),
    audit: (await database.audit.toArray())
      .filter((a) => scope === 'all' || auditLedger(a) === scope)
      .map(({ seq: _seq, ...rest }) => rest),
  }))
}

export function backupFileName(now = new Date(), scope: BackupScope = 'all'): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const part = scope === 'all' ? '' : `${scope}-`
  return `mess-ledger-backup-${part}${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`
}

const AUDIT_ACTIONS = new Set(['create', 'update', 'delete', 'restore', 'import', 'close', 'undo-close', 'undo-import'])

/** Parses and validates a backup file's text. Never touches the database. */
export function checkBackup(text: string): BackupCheck {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, errors: ['The file is not valid JSON.'] }
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, errors: ['The file is not a Mess Ledger backup.'] }
  const b = raw as Partial<BackupFile>
  if (b.app !== BACKUP_APP) return { ok: false, errors: ['The file is not a Mess Ledger backup.'] }
  if (typeof b.schemaVersion !== 'number' || !Number.isInteger(b.schemaVersion) || b.schemaVersion < 1) {
    return { ok: false, errors: ['Unknown backup version.'] }
  }
  if (b.schemaVersion > BACKUP_SCHEMA_VERSION) {
    return { ok: false, errors: ['This backup was made by a newer version of the app. Update the app first.'] }
  }
  const scope: BackupScope = b.schemaVersion === 1 ? 'all' : (b.scope as BackupScope)
  if (scope !== 'all' && scope !== 'utilities' && scope !== 'bazar') return { ok: false, errors: ['Unknown backup scope.'] }
  if (!Array.isArray(b.transactions)) return { ok: false, errors: ['The backup has no transaction list.'] }
  const closingsRaw = b.schemaVersion === 1 ? [] : b.closings
  if (!Array.isArray(closingsRaw)) return { ok: false, errors: ['The backup has no closing list.'] }
  const audit = b.audit ?? []
  if (!Array.isArray(audit)) return { ok: false, errors: ['The audit log is malformed.'] }
  const backupId = b.schemaVersion === 1 ? `v1:${b.exportedAt ?? ''}:${b.transactions.length}` : b.backupId
  if (typeof backupId !== 'string' || backupId.length === 0 || backupId.length > 100) return { ok: false, errors: ['The backup id is missing.'] }

  const errors: string[] = []
  const ids = new Set<string>()
  b.transactions.forEach((t, i) => {
    const problems = validateTransaction(t)
    if (problems.length) errors.push(`Transaction ${i + 1}: ${problems.join(', ')}`)
    const tx = t as Transaction
    if (typeof tx?.id === 'string') {
      if (ids.has(tx.id)) errors.push(`Transaction ${i + 1}: duplicate id`)
      ids.add(tx.id)
    }
    if (scope !== 'all' && tx?.ledger !== scope) errors.push(`Transaction ${i + 1}: belongs to ${tx?.ledger}, but this is a ${scope} backup`)
  })
  const closingIds = new Set<string>()
  const activeKeys = new Set<string>()
  closingsRaw.forEach((c, i) => {
    const problems = validateClosing(c)
    if (problems.length) errors.push(`Closing ${i + 1}: ${problems.join(', ')}`)
    const mc = c as MonthClosing
    if (typeof mc?.id === 'string') {
      if (closingIds.has(mc.id)) errors.push(`Closing ${i + 1}: duplicate id`)
      closingIds.add(mc.id)
    }
    if (scope !== 'all' && mc?.ledger !== scope) errors.push(`Closing ${i + 1}: belongs to ${mc?.ledger}, but this is a ${scope} backup`)
    if (mc?.undoneAt === undefined) {
      const key = `${mc?.ledger}:${mc?.sourceMonth}`
      if (activeKeys.has(key)) errors.push(`Closing ${i + 1}: ${mc?.sourceMonth} is closed twice`)
      activeKeys.add(key)
    }
  })
  audit.forEach((a, i) => {
    const e = a as Partial<AuditEntry>
    if (
      typeof e !== 'object' ||
      e === null ||
      !Number.isFinite(e.at) ||
      !AUDIT_ACTIONS.has(e.action as string) ||
      typeof e.txId !== 'string' ||
      (e.ledger !== undefined && e.ledger !== 'utilities' && e.ledger !== 'bazar')
    ) {
      errors.push(`Audit entry ${i + 1} is malformed`)
    }
  })
  if (errors.length) return { ok: false, errors: errors.slice(0, 20).concat(errors.length > 20 ? [`…and ${errors.length - 20} more`] : []) }

  const txs = b.transactions as Transaction[]
  const closings = closingsRaw as MonthClosing[]
  const live = txs.filter((t) => t.deletedAt === undefined)
  const months = live.map((t) => t.month).sort()
  const exportedAt = typeof b.exportedAt === 'string' ? b.exportedAt : ''
  return {
    ok: true,
    data: {
      app: BACKUP_APP,
      schemaVersion: b.schemaVersion,
      backupId,
      exportedAt,
      scope,
      transactions: txs,
      closings,
      audit: (audit as AuditEntry[]).map(({ seq: _seq, ...rest }) => rest),
    },
    summary: {
      scope,
      backupId,
      exportedAt,
      transactions: live.length,
      deleted: txs.length - live.length,
      utilities: live.filter((t) => t.ledger === 'utilities').length,
      bazar: live.filter((t) => t.ledger === 'bazar').length,
      closings: closings.filter((c) => c.undoneAt === undefined).length,
      firstMonth: months[0] ?? null,
      lastMonth: months[months.length - 1] ?? null,
    },
  }
}

export interface ImportStatus {
  /** When this exact backup was restored before on this device, if ever. */
  alreadyImportedAt: number | null
  /** True when the device already holds exactly the backup's records for its scope. */
  identical: boolean
  /** Records in scope on this device that changed after the backup was made (they would be lost). */
  newerLocalChanges: number
  /** Live transactions in scope currently on this device (would be replaced). */
  localTransactions: number
}

interface ImportedRecord {
  backupId: string
  at: number
  scope: BackupScope
}

function canonical<T extends { id: string }>(rows: T[]): string {
  return JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id)))
}

export async function importStatus(data: BackupFile, database: MessDb = defaultDb): Promise<ImportStatus> {
  const imported = ((await database.meta.get('importedBackups'))?.value as ImportedRecord[] | undefined) ?? []
  const prior = imported.filter((r) => r.backupId === data.backupId).pop()
  const txs = (await database.transactions.toArray()).filter((t) => inScope(data.scope, t.ledger))
  const closings = (await database.closings.toArray()).filter((c) => inScope(data.scope, c.ledger))
  const exported = Date.parse(data.exportedAt)
  const newer = Number.isFinite(exported)
    ? txs.filter((t) => t.updatedAt > exported).length +
      closings.filter((c) => c.createdAt > exported || (c.undoneAt ?? 0) > exported).length
    : 0
  return {
    alreadyImportedAt: prior?.at ?? null,
    identical: canonical(txs) === canonical(data.transactions) && canonical(closings) === canonical(data.closings),
    newerLocalChanges: newer,
    localTransactions: txs.filter((t) => t.deletedAt === undefined).length,
  }
}

interface RestoreUndo {
  scope: BackupScope
  at: number
  backupId: string
  transactions: Transaction[]
  closings: MonthClosing[]
}

const auditKey = (a: AuditEntry) => `${a.at}|${a.action}|${a.txId}`

/**
 * Replaces the records in the backup's scope (both ledgers, or only that one ledger), atomically.
 * The other ledger is never touched by a single-ledger restore. The device's audit history is kept and
 * merged with the backup's; the replaced records are kept so the restore can be undone.
 */
export async function restoreBackup(data: BackupFile, database: MessDb = defaultDb, now = Date.now()): Promise<void> {
  const scope = data.scope
  for (const t of data.transactions) if (!inScope(scope, t.ledger)) throw new Error('Backup contains records outside its scope')
  for (const c of data.closings) if (!inScope(scope, c.ledger)) throw new Error('Backup contains records outside its scope')

  await database.transaction('rw', [database.transactions, database.closings, database.audit, database.meta], async () => {
    const oldTxs = (await database.transactions.toArray()).filter((t) => inScope(scope, t.ledger))
    const oldClosings = (await database.closings.toArray()).filter((c) => inScope(scope, c.ledger))
    const undo: RestoreUndo = { scope, at: now, backupId: data.backupId, transactions: oldTxs, closings: oldClosings }
    await database.meta.put({ key: 'lastRestoreUndo', value: undo })

    await database.transactions.bulkDelete(oldTxs.map((t) => t.id))
    await database.closings.bulkDelete(oldClosings.map((c) => c.id))
    // An id that exists in the other ledger cannot be restored here without touching that ledger.
    const clash = await database.transactions.bulkGet(data.transactions.map((t) => t.id))
    if (clash.some((t) => t !== undefined)) throw new Error('A record in this backup has the same id as a record in the other ledger.')
    await database.transactions.bulkAdd(data.transactions)
    await database.closings.bulkAdd(data.closings)

    const existing = new Set((await database.audit.toArray()).map(auditKey))
    await database.audit.bulkAdd(data.audit.filter((a) => !existing.has(auditKey(a))))
    await database.audit.add({
      at: now,
      action: 'import',
      txId: scope === 'all' ? '*' : `ledger:${scope}`,
      ledger: scope === 'all' ? undefined : scope,
      note: `backup ${data.backupId}`,
    })
    const imported = ((await database.meta.get('importedBackups'))?.value as ImportedRecord[] | undefined) ?? []
    await database.meta.put({ key: 'importedBackups', value: [...imported, { backupId: data.backupId, at: now, scope }].slice(-50) })
    await database.meta.put({ key: 'lastRestoreAt', value: now })
  })
}

export async function getRestoreUndo(database: MessDb = defaultDb): Promise<{ scope: BackupScope; at: number } | null> {
  const u = (await database.meta.get('lastRestoreUndo'))?.value as RestoreUndo | undefined
  return u ? { scope: u.scope, at: u.at } : null
}

/** Puts back the records replaced by the last restore (same scope only). */
export async function undoLastRestore(database: MessDb = defaultDb, now = Date.now()): Promise<BackupScope> {
  return database.transaction('rw', [database.transactions, database.closings, database.audit, database.meta], async () => {
    const u = (await database.meta.get('lastRestoreUndo'))?.value as RestoreUndo | undefined
    if (!u) throw new Error('There is no restore to undo.')
    const curTxs = (await database.transactions.toArray()).filter((t) => inScope(u.scope, t.ledger))
    const curClosings = (await database.closings.toArray()).filter((c) => inScope(u.scope, c.ledger))
    await database.transactions.bulkDelete(curTxs.map((t) => t.id))
    await database.closings.bulkDelete(curClosings.map((c) => c.id))
    await database.transactions.bulkAdd(u.transactions)
    await database.closings.bulkAdd(u.closings)
    await database.audit.add({
      at: now,
      action: 'undo-import',
      txId: u.scope === 'all' ? '*' : `ledger:${u.scope}`,
      ledger: u.scope === 'all' ? undefined : u.scope,
      note: `undid restore of backup ${u.backupId}`,
    })
    await database.meta.delete('lastRestoreUndo')
    return u.scope
  })
}

/** Deletes every record. Used by the guarded "erase all data" setting. */
export async function eraseAll(database: MessDb = defaultDb): Promise<void> {
  await database.transaction('rw', [database.transactions, database.closings, database.audit, database.meta], async () => {
    await database.transactions.clear()
    await database.closings.clear()
    await database.audit.clear()
    await database.meta.clear()
  })
}
