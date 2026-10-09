import { validateClosing, validateTransaction } from '../domain/validate'
import {
  DEFAULT_MEMBER_NAMES,
  LEGACY_MEMBER_NAMES,
  sameMemberNames,
  validateMemberNames,
  type LedgerId,
  type MemberNames,
  type MonthClosing,
  type Transaction,
} from '../domain/types'
import { db as defaultDb, MEMBER_NAMES_KEY, type AuditEntry, type MessDb } from './db'

export const BACKUP_APP = 'mess-ledger'
/** v1: whole database, transactions + audit. v2: adds closings, scope and backupId. v3: adds member display names. */
export const BACKUP_SCHEMA_VERSION = 3

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
  /** Member display names (schema 3+). Ids in records never depend on them. */
  memberNames?: MemberNames
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
  memberNames?: MemberNames
}

export type BackupCheck = { ok: true; data: BackupFile; summary: BackupSummary } | { ok: false; errors: string[] }

const inScope = (scope: BackupScope, ledger: LedgerId | undefined) => scope === 'all' || ledger === scope

function auditLedger(a: AuditEntry): LedgerId | undefined {
  return a.ledger ?? a.after?.ledger ?? a.before?.ledger ?? a.closingAfter?.ledger ?? a.closingBefore?.ledger
}

export async function createBackup(database: MessDb = defaultDb, now = new Date(), scope: BackupScope = 'all'): Promise<BackupFile> {
  return database.transaction('r', [database.transactions, database.closings, database.audit, database.meta], async () => ({
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
    memberNames: { ...DEFAULT_MEMBER_NAMES, ...(((await database.meta.get(MEMBER_NAMES_KEY))?.value as MemberNames | undefined) ?? {}) },
  }))
}

export function backupFileName(now = new Date(), scope: BackupScope = 'all'): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const part = scope === 'all' ? '' : `${scope}-`
  return `mess-ledger-backup-${part}${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`
}

const AUDIT_ACTIONS = new Set(['create', 'update', 'delete', 'restore', 'import', 'close', 'undo-close', 'undo-import', 'rename-members'])

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
  let memberNames: MemberNames | undefined
  if (b.schemaVersion >= 3) {
    if (typeof b.memberNames !== 'object' || b.memberNames === null) return { ok: false, errors: ['The backup has no member names.'] }
    const v = validateMemberNames(b.memberNames as Record<string, unknown>)
    if (Object.keys(v.errors).length) return { ok: false, errors: ['The backup contains invalid member names.'] }
    memberNames = v.names
  }

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
      ...(memberNames ? { memberNames } : {}),
    },
    summary: {
      memberNames,
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
  /** Member names before the restore (only when the restore changed them). */
  memberNames?: MemberNames
}

/** Small companion record so the UI can show "Undo last restore" without loading the whole snapshot. */
const RESTORE_UNDO_KEY = 'lastRestoreUndo'
const RESTORE_UNDO_INFO_KEY = 'lastRestoreUndoInfo'

const auditKey = (a: AuditEntry) => `${a.at}|${a.action}|${a.txId}`

export interface RestoreProgress {
  phase: 'preparing' | 'entries' | 'history' | 'finishing'
  done: number
  total: number
}

/** Rows written per request batch. Between batches the browser can repaint, so the screen never freezes. */
const CHUNK = 200

async function addInChunks<T>(table: { bulkAdd(rows: T[]): Promise<unknown> }, rows: T[], onChunk: (n: number) => void) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK)
    await table.bulkAdd(part)
    onChunk(part.length)
  }
}

/**
 * Member names a full restore should apply: the backup's own names (schema 3), or — for backups made
 * before names were configurable — the original names, but only if this installation was never renamed.
 */
function namesForRestore(data: BackupFile, current: MemberNames, stored: boolean): MemberNames | null {
  if (data.scope !== 'all') return null
  if (data.memberNames) return data.memberNames
  const untouched = !stored || sameMemberNames(current, DEFAULT_MEMBER_NAMES)
  return untouched ? { ...LEGACY_MEMBER_NAMES } : null
}

/**
 * Replaces the records in the backup's scope (both ledgers, or only that one ledger) in ONE IndexedDB
 * transaction: if anything fails, nothing is changed. Rows are written in batches so the interface stays
 * responsive and progress can be shown. The other ledger is never touched by a single-ledger restore.
 * The device's audit history is kept and merged with the backup's; the replaced records are kept so the
 * restore can be undone.
 */
export async function restoreBackup(
  data: BackupFile,
  database: MessDb = defaultDb,
  now = Date.now(),
  onProgress: (p: RestoreProgress) => void = () => {},
): Promise<void> {
  const scope = data.scope
  for (const t of data.transactions) if (!inScope(scope, t.ledger)) throw new Error('Backup contains records outside its scope')
  for (const c of data.closings) if (!inScope(scope, c.ledger)) throw new Error('Backup contains records outside its scope')

  await database.transaction('rw', [database.transactions, database.closings, database.audit, database.meta], async () => {
    onProgress({ phase: 'preparing', done: 0, total: data.transactions.length })
    const oldTxs = scope === 'all' ? await database.transactions.toArray() : await database.transactions.where('ledger').equals(scope).toArray()
    const oldClosings = scope === 'all' ? await database.closings.toArray() : await database.closings.where('ledger').equals(scope).toArray()
    const storedNames = (await database.meta.get(MEMBER_NAMES_KEY))?.value as MemberNames | undefined
    const currentNames = { ...DEFAULT_MEMBER_NAMES, ...(storedNames ?? {}) }
    const newNames = namesForRestore(data, currentNames, !!storedNames)
    const namesChange = newNames !== null && !sameMemberNames(newNames, currentNames)

    const undo: RestoreUndo = { scope, at: now, backupId: data.backupId, transactions: oldTxs, closings: oldClosings }
    if (namesChange) undo.memberNames = currentNames
    await database.meta.put({ key: RESTORE_UNDO_KEY, value: undo })
    await database.meta.put({ key: RESTORE_UNDO_INFO_KEY, value: { scope, at: now } })

    if (scope === 'all') {
      await database.transactions.clear()
      await database.closings.clear()
    } else {
      await database.transactions.where('ledger').equals(scope).delete()
      await database.closings.where('ledger').equals(scope).delete()
      // An id that exists in the other ledger cannot be restored here without touching that ledger.
      const otherIds = new Set(await database.transactions.toCollection().primaryKeys())
      if (data.transactions.some((t) => otherIds.has(t.id))) {
        throw new Error('A record in this backup has the same id as a record in the other ledger.')
      }
    }

    let done = 0
    await addInChunks(database.transactions, data.transactions, (n) => {
      done += n
      onProgress({ phase: 'entries', done, total: data.transactions.length })
    })
    await database.closings.bulkAdd(data.closings)

    const existingAudit = (await database.audit.count()) ? new Set((await database.audit.toArray()).map(auditKey)) : new Set<string>()
    const newAudit = data.audit.filter((a) => !existingAudit.has(auditKey(a)))
    let auditDone = 0
    await addInChunks(database.audit, newAudit, (n) => {
      auditDone += n
      onProgress({ phase: 'history', done: auditDone, total: newAudit.length })
    })

    onProgress({ phase: 'finishing', done: 0, total: 0 })
    if (namesChange) await database.meta.put({ key: MEMBER_NAMES_KEY, value: newNames })
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
  const info = (await database.meta.get(RESTORE_UNDO_INFO_KEY))?.value as { scope: BackupScope; at: number } | undefined
  if (info) return info
  // Restores made before the info record existed.
  const u = (await database.meta.get(RESTORE_UNDO_KEY))?.value as RestoreUndo | undefined
  return u ? { scope: u.scope, at: u.at } : null
}

/** Puts back the records replaced by the last restore (same scope only), and the member names if it changed them. */
export async function undoLastRestore(database: MessDb = defaultDb, now = Date.now()): Promise<BackupScope> {
  return database.transaction('rw', [database.transactions, database.closings, database.audit, database.meta], async () => {
    const u = (await database.meta.get(RESTORE_UNDO_KEY))?.value as RestoreUndo | undefined
    if (!u) throw new Error('There is no restore to undo.')
    if (u.scope === 'all') {
      await database.transactions.clear()
      await database.closings.clear()
    } else {
      await database.transactions.where('ledger').equals(u.scope).delete()
      await database.closings.where('ledger').equals(u.scope).delete()
    }
    await addInChunks(database.transactions, u.transactions, () => {})
    await database.closings.bulkAdd(u.closings)
    if (u.memberNames) await database.meta.put({ key: MEMBER_NAMES_KEY, value: u.memberNames })
    await database.audit.add({
      at: now,
      action: 'undo-import',
      txId: u.scope === 'all' ? '*' : `ledger:${u.scope}`,
      ledger: u.scope === 'all' ? undefined : u.scope,
      note: `undid restore of backup ${u.backupId}`,
    })
    await database.meta.delete(RESTORE_UNDO_KEY)
    await database.meta.delete(RESTORE_UNDO_INFO_KEY)
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
