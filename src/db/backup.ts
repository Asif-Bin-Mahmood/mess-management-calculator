import {
  bySeq,
  LEGACY_CATEGORIES,
  LEGACY_MEMBER_IDS,
  LEGACY_MEMBER_NAMES,
  legacyCategories,
  legacyMembers,
  nameProblem,
  normalizeName,
  sharers,
  validateCategories,
  validateRoster,
  type Category,
  type Member,
  type Roster,
} from '../domain/household'
import { categoryIsReferenced, computeHistory, memberRemovable, type MonthSummary } from '../domain/ledger'
import { currentMonth } from '../domain/month'
import type { LedgerId, MonthClosing, Transaction } from '../domain/types'
import { validateClosing, validateTransaction } from '../domain/validate'
import { db as defaultDb, MEMBER_NAMES_KEY, type AuditEntry, type MessDb } from './db'

export const BACKUP_APP = 'mess-ledger'
/**
 * v1: whole database, transactions + audit. v2: adds closings, scope and backupId. v3: adds the four member
 * display names. v4: adds the member and Utilities category registries (any household size).
 */
export const BACKUP_SCHEMA_VERSION = 4

/** 'all' = both ledgers; otherwise a single ledger, which can only be restored into that ledger. */
export type BackupScope = 'all' | LedgerId

export interface BackupFile {
  app: typeof BACKUP_APP
  schemaVersion: number
  backupId: string
  exportedAt: string
  scope: BackupScope
  /** The household's members (schema 4; derived from the four original members for older backups). */
  members: Member[]
  /** The Utilities categories (schema 4; the five original categories for older backups). */
  categories: Category[]
  transactions: Transaction[]
  closings: MonthClosing[]
  audit: AuditEntry[]
  /**
   * Older backups (schema ≤ 3) have no registry. True when member names were not part of the backup either
   * (schema 1–2): a full restore then keeps the names this device already shows for those members.
   */
  legacyNames?: boolean
}

export interface BackupSummary {
  scope: BackupScope
  backupId: string
  exportedAt: string
  schemaVersion: number
  transactions: number
  deleted: number
  utilities: number
  bazar: number
  closings: number
  firstMonth: string | null
  lastMonth: string | null
  memberNames: string[]
  categoryCount: number
}

export type BackupCheck = { ok: true; data: BackupFile; summary: BackupSummary } | { ok: false; errors: string[] }

const inScope = (scope: BackupScope, ledger: LedgerId | undefined) => scope === 'all' || ledger === scope

function auditLedger(a: AuditEntry): LedgerId | undefined {
  return a.ledger ?? a.after?.ledger ?? a.before?.ledger ?? a.closingAfter?.ledger ?? a.closingBefore?.ledger
}

export async function createBackup(database: MessDb = defaultDb, now = new Date(), scope: BackupScope = 'all'): Promise<BackupFile> {
  return database.transaction('r', [database.transactions, database.closings, database.audit, database.members, database.categories], async () => ({
    app: BACKUP_APP,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    backupId: crypto.randomUUID(),
    exportedAt: now.toISOString(),
    scope,
    // The whole registry is included even in a single-ledger backup: its entries and closings refer to it.
    members: (await database.members.toArray()).sort(bySeq),
    categories: (await database.categories.toArray()).sort(bySeq),
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

const AUDIT_ACTIONS = new Set([
  'create',
  'update',
  'delete',
  'restore',
  'import',
  'close',
  'undo-close',
  'undo-import',
  'rename-members',
  'household-setup',
  'member-add',
  'member-update',
  'member-delete',
  'category-add',
  'category-update',
  'category-delete',
])

const fail = (...errors: string[]): BackupCheck => ({ ok: false, errors })

/** Registry for a backup made before the registry existed (schema ≤ 3): the four original members and five categories. */
function legacyRegistry(b: Partial<BackupFile> & { memberNames?: unknown }): { members: Member[] } | { error: string } {
  if (b.schemaVersion !== 3) return { members: legacyMembers(LEGACY_MEMBER_NAMES) }
  const raw = b.memberNames
  if (typeof raw !== 'object' || raw === null) return { error: 'The backup has no member names.' }
  const names: Record<string, string> = {}
  const seen: string[] = []
  for (const id of LEGACY_MEMBER_IDS) {
    const n = normalizeName((raw as Record<string, unknown>)[id])
    if (nameProblem(n, seen)) return { error: 'The backup contains invalid member names.' }
    seen.push(n)
    names[id] = n
  }
  if (Object.keys(raw).some((k) => !LEGACY_MEMBER_IDS.includes(k))) return { error: 'The backup contains invalid member names.' }
  return { members: legacyMembers(names) }
}

/** Parses and validates a backup file's text completely. Never touches the database. */
export function checkBackup(text: string): BackupCheck {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail('The file is not valid JSON.')
  }
  if (typeof raw !== 'object' || raw === null) return fail('The file is not a Mess Ledger backup.')
  const b = raw as Partial<BackupFile> & { memberNames?: unknown }
  if (b.app !== BACKUP_APP) return fail('The file is not a Mess Ledger backup.')
  if (typeof b.schemaVersion !== 'number' || !Number.isInteger(b.schemaVersion) || b.schemaVersion < 1) return fail('Unknown backup version.')
  if (b.schemaVersion > BACKUP_SCHEMA_VERSION) return fail('This backup was made by a newer version of the app. Update the app first.')
  const scope: BackupScope = b.schemaVersion === 1 ? 'all' : (b.scope as BackupScope)
  if (scope !== 'all' && scope !== 'utilities' && scope !== 'bazar') return fail('Unknown backup scope.')
  if (!Array.isArray(b.transactions)) return fail('The backup has no transaction list.')
  const closingsRaw = b.schemaVersion === 1 ? [] : b.closings
  if (!Array.isArray(closingsRaw)) return fail('The backup has no closing list.')
  const audit = b.audit ?? []
  if (!Array.isArray(audit)) return fail('The audit log is malformed.')
  const backupId = b.schemaVersion === 1 ? `v1:${b.exportedAt ?? ''}:${b.transactions.length}` : b.backupId
  if (typeof backupId !== 'string' || backupId.length === 0 || backupId.length > 100) return fail('The backup id is missing.')

  let members: Member[]
  let categories: Category[]
  if (b.schemaVersion >= 4) {
    const rp = validateRoster(b.members)
    if (rp.length) return fail(...rp.slice(0, 5).map((x) => `Members: ${x}`))
    const cp = validateCategories(b.categories)
    if (cp.length) return fail(...cp.slice(0, 5).map((x) => `Categories: ${x}`))
    members = (b.members as Member[]).map((m) => ({ ...m, periods: m.periods.map((p) => ({ ...p })) }))
    categories = (b.categories as Category[]).map((c) => ({ ...c }))
  } else {
    const legacy = legacyRegistry(b)
    if ('error' in legacy) return fail(legacy.error)
    members = legacy.members
    categories = legacyCategories()
  }

  const errors: string[] = []
  const ids = new Set<string>()
  const ctx = { roster: members, categories }
  b.transactions.forEach((t, i) => {
    const problems = validateTransaction(t, ctx)
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
    const problems = validateClosing(c, members)
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
  if (errors.length === 0) {
    // Every month with spending must have somebody sharing it (the app never creates anything else).
    const unshared = new Set<string>()
    for (const t of b.transactions as Transaction[]) {
      if (t.deletedAt === undefined && (t.type === 'expense' || t.type === 'expenseRefund') && sharers(members, t.month).length === 0) unshared.add(t.month)
    }
    if (unshared.size) errors.push(`Nobody shares the expenses of ${[...unshared].sort().join(', ')}.`)
  }
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
      members: members.sort(bySeq),
      categories: categories.sort(bySeq),
      transactions: txs,
      closings,
      audit: (audit as AuditEntry[]).map(({ seq: _seq, ...rest }) => rest),
      ...(b.schemaVersion <= 2 ? { legacyNames: true } : {}),
    },
    summary: {
      scope,
      backupId,
      exportedAt,
      schemaVersion: b.schemaVersion,
      transactions: live.length,
      deleted: txs.length - live.length,
      utilities: live.filter((t) => t.ledger === 'utilities').length,
      bazar: live.filter((t) => t.ledger === 'bazar').length,
      closings: closings.filter((c) => c.undoneAt === undefined).length,
      firstMonth: months[0] ?? null,
      lastMonth: months[months.length - 1] ?? null,
      memberNames: members.map((m) => m.name),
      categoryCount: categories.filter((c) => c.archivedAt === undefined).length,
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

/* ───────────── What a restore does to the household registry ───────────── */

export interface RegistryPlan {
  members: Member[]
  categories: Category[]
  /** Names of members / categories the restore adds to this device. */
  membersAdded: string[]
  categoriesAdded: string[]
  /** Full restores: members whose shown name changes. */
  renamed: { from: string; to: string }[]
  /** Set when a single-ledger restore cannot be done without changing figures; nothing is written. */
  problem: string | null
  /**
   * Why: 'other-ledger' = the backup's members would change the other ledger's balances; 'this-ledger' = this
   * device's members share different months than the backup assumed (e.g. an older backup made before a member
   * joined or left), so the restored ledger's balances would come out differently.
   */
  problemKind: 'other-ledger' | 'this-ledger' | null
}

const ledgerTitle = (l: LedgerId) => (l === 'utilities' ? 'Utilities' : 'Bazar')

/** The explanation shown when a single-ledger restore is refused (nothing is changed). */
export function singleLedgerRestoreProblem(kind: 'other-ledger' | 'this-ledger', scope: LedgerId): string {
  const other: LedgerId = scope === 'utilities' ? 'bazar' : 'utilities'
  const why =
    kind === 'other-ledger'
      ? `This ${ledgerTitle(scope)} backup comes from a household with different members. Restoring it would also change the ${ledgerTitle(other)} balances.`
      : `The members on this phone share different months than when this ${ledgerTitle(scope)} backup was made (for example, a member joined or left since then), so its balances would come out differently.`
  return `${why} Members are shared by both ledgers, so a single-ledger backup can only be restored while the members match. Nothing was changed. Restore a full backup (both ledgers) instead.`
}

function figures(ledger: LedgerId, roster: Roster, txs: readonly Transaction[], closings: readonly MonthClosing[], until: string): string {
  const last = [...txs.filter((t) => t.ledger === ledger).map((t) => t.month), ...closings.filter((c) => c.ledger === ledger).map((c) => c.targetMonth), until].sort().pop()!
  // Amounts only: a member shown with a ৳0 share and ৳0 balance is the same as a member not shown.
  const pick = (s: MonthSummary) => [s.month, s.remainingCash, s.unallocatedSpend, s.members.filter((m) => m.share !== 0 || m.closing !== 0).map((m) => [m.memberId, m.share, m.closing]).sort()]
  return JSON.stringify(computeHistory(ledger, roster, txs, last, closings).map(pick))
}

function uniqueName(name: string, taken: string[]): string {
  if (!nameProblem(name, taken)) return name
  for (let i = 2; ; i++) {
    const suffix = ` (${i})`
    const n = name.slice(0, 24 - suffix.length).trimEnd() + suffix
    if (!nameProblem(n, taken)) return n
  }
}

/**
 * Members and categories after restoring `data`:
 * - Full restore: the backup's registry replaces this device's. For backups without names (schema 1–2), the
 *   names this device shows for the original members are kept.
 * - Single-ledger restore: only records missing on this device are added; existing ones are never renamed
 *   or changed. Because membership is household-wide, the restore is refused if it would change any figure of
 *   either ledger (e.g. a backup from a household with different members) — restore a full backup instead.
 */
export function planRegistry(
  data: BackupFile,
  local: { members: Member[]; categories: Category[]; transactions: Transaction[]; closings: MonthClosing[] },
  until: string,
): RegistryPlan {
  if (data.scope === 'all') {
    const members = data.members.map((m) => {
      const mine = local.members.find((x) => x.id === m.id)
      return data.legacyNames && mine ? { ...m, name: mine.name } : m
    })
    const categories = data.categories.map((c) => {
      const mine = local.categories.find((x) => x.id === c.id)
      return data.schemaVersion < 4 && mine && LEGACY_CATEGORIES.some((l) => l.id === c.id) ? { ...c, name: mine.name, ...(mine.archivedAt ? { archivedAt: mine.archivedAt } : {}) } : c
    })
    // Keep names unique if a device-side name was kept.
    const renamed = members
      .map((m) => ({ m, mine: local.members.find((x) => x.id === m.id) }))
      .filter(({ m, mine }) => mine && mine.name !== m.name)
      .map(({ m, mine }) => ({ from: mine!.name, to: m.name }))
    return {
      members,
      categories,
      membersAdded: members.filter((m) => !local.members.some((x) => x.id === m.id)).map((m) => m.name),
      categoriesAdded: categories.filter((c) => !local.categories.some((x) => x.id === c.id)).map((c) => c.name),
      renamed,
      problem: null,
      problemKind: null,
    }
  }
  const members = local.members.map((m) => ({ ...m }))
  const memberNames = members.map((m) => m.name)
  const membersAdded: string[] = []
  let seq = members.reduce((a, m) => Math.max(a, m.seq + 1), 0)
  for (const m of data.members) {
    if (members.some((x) => x.id === m.id)) continue
    const name = uniqueName(m.name, memberNames)
    memberNames.push(name)
    membersAdded.push(name)
    members.push({ ...m, name, seq: seq++ })
  }
  const categories = local.categories.map((c) => ({ ...c }))
  const catNames = categories.map((c) => c.name)
  const categoriesAdded: string[] = []
  let cseq = categories.reduce((a, c) => Math.max(a, c.seq + 1), 0)
  for (const c of data.categories) {
    // Only categories the restored entries use; existing ones are kept as they are on this device.
    if (categories.some((x) => x.id === c.id) || !data.transactions.some((t) => t.category === c.id)) continue
    const name = uniqueName(c.name, catNames)
    catNames.push(name)
    categoriesAdded.push(name)
    categories.push({ ...c, name, seq: cseq++ })
  }
  const scope = data.scope
  const other: LedgerId = scope === 'utilities' ? 'bazar' : 'utilities'
  const otherTx = local.transactions.filter((t) => t.ledger === other)
  const otherCl = local.closings.filter((c) => c.ledger === other)
  let problem: string | null = null
  let problemKind: RegistryPlan['problemKind'] = null
  if (figures(other, local.members, otherTx, otherCl, until) !== figures(other, members, otherTx, otherCl, until)) {
    problemKind = 'other-ledger'
  } else if (figures(scope, data.members, data.transactions, data.closings, until) !== figures(scope, members, data.transactions, data.closings, until)) {
    problemKind = 'this-ledger'
  }
  if (problemKind) problem = singleLedgerRestoreProblem(problemKind, scope)
  return { members: members.sort(bySeq), categories: categories.sort(bySeq), membersAdded, categoriesAdded, renamed: [], problem, problemKind }
}

async function localState(database: MessDb) {
  const [members, categories, transactions, closings] = await Promise.all([
    database.members.toArray(),
    database.categories.toArray(),
    database.transactions.toArray(),
    database.closings.toArray(),
  ])
  return { members: members.sort(bySeq), categories: categories.sort(bySeq), transactions, closings }
}

/** What restoring the backup would do to members and categories (shown before confirming). */
export async function planRestore(data: BackupFile, database: MessDb = defaultDb, now = Date.now()): Promise<RegistryPlan> {
  return planRegistry(data, await localState(database), currentMonth(new Date(now)))
}

export async function importStatus(data: BackupFile, database: MessDb = defaultDb): Promise<ImportStatus> {
  const imported = ((await database.meta.get('importedBackups'))?.value as ImportedRecord[] | undefined) ?? []
  const prior = imported.filter((r) => r.backupId === data.backupId).pop()
  const txs = (await database.transactions.toArray()).filter((t) => inScope(data.scope, t.ledger))
  const closings = (await database.closings.toArray()).filter((c) => inScope(data.scope, c.ledger))
  const exported = Date.parse(data.exportedAt)
  const newer = Number.isFinite(exported)
    ? txs.filter((t) => t.updatedAt > exported).length + closings.filter((c) => c.createdAt > exported || (c.undoneAt ?? 0) > exported).length
    : 0
  const sameRegistry =
    data.scope !== 'all' ||
    (canonical(await database.members.toArray()) === canonical(data.members) && canonical(await database.categories.toArray()) === canonical(data.categories))
  return {
    alreadyImportedAt: prior?.at ?? null,
    identical: sameRegistry && canonical(txs) === canonical(data.transactions) && canonical(closings) === canonical(data.closings),
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
  /** Registry before the restore. */
  members?: Member[]
  categories?: Category[]
  /** Single-ledger restores: ids of members/categories the restore added (candidates for removal on undo). */
  addedMemberIds?: string[]
  addedCategoryIds?: string[]
  /** Restores made by app 1.1.1 stored the four names here when the restore changed them. */
  memberNames?: Record<string, string>
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

async function replaceRegistry(database: MessDb, members: Member[], categories: Category[]) {
  await database.members.clear()
  await database.categories.clear()
  if (members.length) await database.members.bulkAdd(members)
  if (categories.length) await database.categories.bulkAdd(categories)
}

/**
 * Replaces the records in the backup's scope (both ledgers, or only that one ledger) in ONE IndexedDB
 * transaction: if anything fails, nothing is changed. Rows are written in batches so the interface stays
 * responsive and progress can be shown. The other ledger is never touched by a single-ledger restore.
 * The device's audit history is kept and merged with the backup's; the replaced records (and the previous
 * members and categories) are kept so the restore can be undone.
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

  await database.transaction('rw', [database.transactions, database.closings, database.audit, database.meta, database.members, database.categories], async () => {
    onProgress({ phase: 'preparing', done: 0, total: data.transactions.length })
    const local = await localState(database)
    const reg = planRegistry(data, local, currentMonth(new Date(now)))
    if (reg.problem) throw new Error(reg.problem)
    const oldTxs = scope === 'all' ? local.transactions : local.transactions.filter((t) => t.ledger === scope)
    const oldClosings = scope === 'all' ? local.closings : local.closings.filter((c) => c.ledger === scope)

    const undo: RestoreUndo = {
      scope,
      at: now,
      backupId: data.backupId,
      transactions: oldTxs,
      closings: oldClosings,
      members: local.members,
      categories: local.categories,
      addedMemberIds: reg.members.filter((m) => !local.members.some((x) => x.id === m.id)).map((m) => m.id),
      addedCategoryIds: reg.categories.filter((c) => !local.categories.some((x) => x.id === c.id)).map((c) => c.id),
    }
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
    await replaceRegistry(database, reg.members, reg.categories)

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

/** Puts back the records replaced by the last restore (same scope only), with the previous members and categories. */
export async function undoLastRestore(database: MessDb = defaultDb, now = Date.now()): Promise<BackupScope> {
  return database.transaction('rw', [database.transactions, database.closings, database.audit, database.meta, database.members, database.categories], async () => {
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
    if (u.members && u.categories && u.scope === 'all') {
      // Everything returns to the state before the restore (records and household together).
      await replaceRegistry(database, u.members, u.categories)
    } else if (u.members && u.categories) {
      // Single ledger: the other ledger was not part of the restore and may now use members or categories created
      // since. Keep every record still needed; bring back any the restored records need; drop only what the
      // restore itself added, when nothing uses it any more and removing it changes no figure.
      const txsNow = await database.transactions.toArray()
      const closingsNow = await database.closings.toArray()
      let members = (await database.members.toArray()).sort(bySeq)
      let categories = (await database.categories.toArray()).sort(bySeq)
      for (const m of u.members) if (!members.some((x) => x.id === m.id)) members.push(m)
      for (const c of u.categories) if (!categories.some((x) => x.id === c.id) && categoryIsReferenced(c.id, txsNow)) categories.push(c)
      const horizon = currentMonth(new Date(now))
      for (const id of u.addedMemberIds ?? []) {
        if (memberRemovable(id, members, txsNow, closingsNow, horizon)) members = members.filter((m) => m.id !== id)
      }
      for (const id of u.addedCategoryIds ?? []) {
        if (!categoryIsReferenced(id, txsNow)) categories = categories.filter((c) => c.id !== id)
      }
      // Members restored from the snapshot that nothing needs (and that change no figure) are not kept either.
      for (const m of u.members) {
        if (!(await database.members.get(m.id)) && memberRemovable(m.id, members, txsNow, closingsNow, horizon)) members = members.filter((x) => x.id !== m.id)
      }
      await replaceRegistry(database, members.sort(bySeq), categories.sort(bySeq))
    } else if (u.memberNames) {
      // Undo snapshot written by app 1.1.1: it changed only the four display names.
      for (const m of await database.members.toArray()) {
        const name = u.memberNames[m.id]
        if (name && name !== m.name) await database.members.put({ ...m, name })
      }
    }
    await database.audit.add({
      at: now,
      action: 'undo-import',
      txId: u.scope === 'all' ? '*' : `ledger:${u.scope}`,
      ledger: u.scope === 'all' ? undefined : u.scope,
      note: `undid restore of backup ${u.backupId}`,
    })
    await database.meta.delete(RESTORE_UNDO_KEY)
    await database.meta.delete(RESTORE_UNDO_INFO_KEY)
    await database.meta.delete(MEMBER_NAMES_KEY)
    return u.scope
  })
}

/** Deletes every record, including the household (the setup is shown again). Used by "erase all data". */
export async function eraseAll(database: MessDb = defaultDb): Promise<void> {
  await database.transaction('rw', [database.transactions, database.closings, database.audit, database.meta, database.members, database.categories], async () => {
    await database.transactions.clear()
    await database.closings.clear()
    await database.audit.clear()
    await database.meta.clear()
    await database.members.clear()
    await database.categories.clear()
  })
}
