/**
 * Household changes: setup, members and Utilities categories. Every change is validated, written atomically
 * together with an audit entry, and never alters transactions or closings.
 *
 * Membership changes are household-wide and month-based. A change may only affect months that are still open
 * in both ledgers (after the latest closed month); closed months are never recalculated. Changes that affect
 * open months are previewed first (planRosterChange) and confirmed by the user.
 */
import {
  bySeq,
  MAX_CATEGORIES,
  MAX_MEMBERS,
  nameProblem,
  newId,
  normalizeName,
  validatePeriods,
  validateNames,
  type Category,
  type CategoryId,
  type Member,
  type MemberId,
  type MembershipPeriod,
} from '../domain/household'
import { analyzeRosterChange, categoryIsReferenced, firstOpenMonth, memberIsReferenced, memberRemovable, type RosterChangeImpact } from '../domain/ledger'
import { currentMonth, isValidMonth, monthLabel } from '../domain/month'
import type { BazarMethod } from '../domain/bazarMethod'
import { MIN_MONTH } from '../domain/month'
import { db as defaultDb, type MessDb } from './db'
import { loadHousehold } from './repo'

export class HouseholdError extends Error {}

async function everything(database: MessDb) {
  const [transactions, closings, h, methodRow] = await Promise.all([
    database.transactions.toArray(),
    database.closings.toArray(),
    loadHousehold(database),
    database.meta.get('bazarMethod'),
  ])
  return { transactions, closings, ...h, method: (methodRow?.value as BazarMethod | undefined) ?? null }
}

const tables = (d: MessDb) => [d.members, d.categories, d.transactions, d.closings, d.audit, d.meta]

/* ───────────── First-launch setup ───────────── */

/**
 * Creates the household of a fresh installation: members (in the given order, sharing from the beginning)
 * and optional Utilities categories. Refused if a household already exists.
 */
export async function setupHousehold(memberNames: readonly string[], categoryNames: readonly string[], database: MessDb = defaultDb, now = Date.now()): Promise<void> {
  const m = validateNames(memberNames)
  if (m.names.length === 0) throw new HouseholdError('Add at least one member.')
  if (m.names.length > MAX_MEMBERS) throw new HouseholdError(`Add at most ${MAX_MEMBERS} members.`)
  const firstErr = m.errors.find((e) => e)
  if (firstErr) throw new HouseholdError(firstErr)
  const c = validateNames(categoryNames)
  const catErr = c.errors.find((e) => e)
  if (catErr) throw new HouseholdError(`Category: ${catErr}`)
  await database.transaction('rw', tables(database), async () => {
    if ((await database.members.count()) > 0) throw new HouseholdError('The household is already set up.')
    const members: Member[] = m.names.map((name, seq) => ({ id: newId('m'), name, seq, createdAt: now, periods: [{}] }))
    const existingCats = await database.categories.toArray()
    const catSeq = existingCats.reduce((a, x) => Math.max(a, x.seq + 1), 0)
    const taken = existingCats.map((x) => x.name.toLocaleLowerCase())
    const categories: Category[] = c.names
      .filter((name) => !taken.includes(name.toLocaleLowerCase()))
      .map((name, i) => ({ id: newId('c'), name, seq: catSeq + i, createdAt: now }))
    await database.members.bulkAdd(members)
    if (categories.length) await database.categories.bulkAdd(categories)
    // A new household has no Bazar history, so Bazar is recorded with the member-paid method from the start.
    const bazarRecords = (await database.transactions.where('ledger').equals('bazar').count()) + (await database.closings.where('ledger').equals('bazar').count())
    if (bazarRecords === 0 && !(await database.meta.get('bazarMethod'))) await database.meta.put({ key: 'bazarMethod', value: { memberPaidFrom: MIN_MONTH } })
    await database.audit.add({ at: now, action: 'household-setup', txId: 'household', note: JSON.stringify({ members: members.map((x) => x.name), categories: categories.map((x) => x.name) }) })
  })
}

/* ───────────── Members ───────────── */

export interface RosterPlan {
  before: Member[]
  after: Member[]
  impact: RosterChangeImpact
  /** Months (per ledger) that would have spending but nobody sharing it; such changes are refused. */
  unsharedMonths: string[]
}

/** Why a membership change is not allowed, or null. */
export function rosterPlanProblem(plan: RosterPlan): string | null {
  if (plan.impact.blockedBy) {
    return `${monthLabel(plan.impact.blockedBy)} is closed, so who shared it cannot change. Choose a month from ${monthLabel(nextOf(plan.impact.blockedBy))} on, or undo the closing first.`
  }
  if (plan.unsharedMonths.length) {
    return `Nobody would share the expenses of ${plan.unsharedMonths.map(monthLabel).join(', ')}. Keep at least one member for those months.`
  }
  return null
}

function checkPlan(plan: RosterPlan) {
  const problem = rosterPlanProblem(plan)
  if (problem) throw new HouseholdError(problem)
}

function nextOf(m: string): string {
  const [y, mo] = m.split('-').map(Number)
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
}

/** Pure part of a membership change: impact on both ledgers and whether it is allowed. */
async function plan(database: MessDb, change: (members: Member[]) => Member[], now: number): Promise<RosterPlan> {
  const { transactions, closings, members, method } = await everything(database)
  const after = change(members.map((m) => ({ ...m, periods: m.periods.map((p) => ({ ...p })) }))).sort(bySeq)
  for (const m of after) {
    const pp = validatePeriods(m.periods)
    if (pp) throw new HouseholdError(`Invalid membership months: ${pp}.`)
  }
  const impact = analyzeRosterChange(members, after, transactions, closings, currentMonth(new Date(now)), method)
  // Months that have spending but would have nobody sharing it.
  const months = new Set<string>()
  for (const t of transactions) if (t.deletedAt === undefined && (t.type === 'expense' || t.type === 'expenseRefund' || t.type === 'purchase')) months.add(t.month)
  const unsharedMonths = [...months].filter((mo) => !after.some((m) => sharesInPeriods(m.periods, mo))).sort()
  return { before: members, after, impact, unsharedMonths }
}

function sharesInPeriods(periods: readonly MembershipPeriod[], month: string): boolean {
  return periods.some((p) => (p.from === undefined || p.from <= month) && (p.until === undefined || month <= p.until))
}

async function commit(database: MessDb, now: number, change: (members: Member[]) => Member[], audit: (before: Member | undefined, after: Member | undefined) => Parameters<MessDb['audit']['add']>[0]) {
  return database.transaction('rw', tables(database), async () => {
    const p = await plan(database, change, now)
    checkPlan(p)
    const ids = new Set([...p.before.map((m) => m.id), ...p.after.map((m) => m.id)])
    for (const id of ids) {
      const b = p.before.find((m) => m.id === id)
      const a = p.after.find((m) => m.id === id)
      if (JSON.stringify(b) === JSON.stringify(a)) continue
      if (a) await database.members.put(a)
      else await database.members.delete(id)
      await database.audit.add(audit(b, a))
    }
    return p
  })
}

/** Earliest month a membership change may take effect: the first month open in both ledgers (null = any). */
export async function earliestChangeMonth(database: MessDb = defaultDb): Promise<string | null> {
  return firstOpenMonth(await database.closings.toArray())
}

function nameCheck(name: string, members: Member[], exceptId?: MemberId) {
  const problem = nameProblem(
    name,
    members.filter((m) => m.id !== exceptId).map((m) => m.name),
  )
  if (problem) throw new HouseholdError(problem)
}

/** New member sharing from `from` (inclusive month). */
function withNewMember(name: string, from: string, now: number, id = newId('m')) {
  return (members: Member[]) => {
    const n = normalizeName(name)
    nameCheck(n, members)
    if (members.length >= MAX_MEMBERS * 4) throw new HouseholdError('Too many members.')
    if (!isValidMonth(from)) throw new HouseholdError('Choose the first month this member shares.')
    const seq = members.reduce((a, m) => Math.max(a, m.seq + 1), 0)
    return [...members, { id, name: n, seq, createdAt: now, periods: [{ from }] }]
  }
}

function withPeriods(id: MemberId, periods: MembershipPeriod[]) {
  return (members: Member[]) => {
    const m = members.find((x) => x.id === id)
    if (!m) throw new HouseholdError('This member no longer exists.')
    m.periods = periods
    return members
  }
}

/** Ends the member's current period after `lastMonth` (the last month they share). */
export function endPeriods(m: Member, lastMonth: string): MembershipPeriod[] {
  const periods = m.periods.map((p) => ({ ...p }))
  const open = periods[periods.length - 1]
  if (!open || open.until !== undefined) throw new HouseholdError('This member has already left.')
  if (open.from !== undefined && lastMonth < open.from) throw new HouseholdError(`The last month cannot be before ${monthLabel(open.from)}, when this membership started.`)
  open.until = lastMonth
  return periods
}

/** Adds a new period starting at `from` (rejoining). */
export function rejoinPeriods(m: Member, from: string): MembershipPeriod[] {
  const periods = m.periods.map((p) => ({ ...p }))
  const last = periods[periods.length - 1]
  if (last && last.until === undefined) throw new HouseholdError('This member is still sharing.')
  if (last && last.until !== undefined && from <= last.until) throw new HouseholdError(`Choose a month after ${monthLabel(last.until)}, the last month this member shared.`)
  periods.push({ from })
  return periods
}

export type MemberChange =
  | { kind: 'add'; name: string; from: string }
  | { kind: 'end'; id: MemberId; lastMonth: string }
  | { kind: 'rejoin'; id: MemberId; from: string }

function changeFn(c: MemberChange, now: number): (members: Member[]) => Member[] {
  if (c.kind === 'add') return withNewMember(c.name, c.from, now)
  return (members) => {
    const m = members.find((x) => x.id === c.id)
    if (!m) throw new HouseholdError('This member no longer exists.')
    return withPeriods(c.id, c.kind === 'end' ? endPeriods(m, c.lastMonth) : rejoinPeriods(m, c.from))(members)
  }
}

/** Preview of a membership change (nothing is written). Throws HouseholdError if the input is invalid. */
export async function planMemberChange(c: MemberChange, database: MessDb = defaultDb, now = Date.now()): Promise<RosterPlan> {
  return plan(database, changeFn(c, now), now)
}

export async function applyMemberChange(c: MemberChange, database: MessDb = defaultDb, now = Date.now()): Promise<RosterPlan> {
  return commit(database, now, changeFn(c, now), (b, a) => ({ at: now, action: b ? 'member-update' : 'member-add', txId: `member:${(a ?? b)!.id}`, memberBefore: b, memberAfter: a }))
}

/** Display name only: balances, shares and history refer to the permanent id and do not change. */
export async function renameMember(id: MemberId, name: string, database: MessDb = defaultDb, now = Date.now()): Promise<Member> {
  return database.transaction('rw', tables(database), async () => {
    const members = await database.members.toArray()
    const m = members.find((x) => x.id === id)
    if (!m) throw new HouseholdError('This member no longer exists.')
    const n = normalizeName(name)
    nameCheck(n, members, id)
    if (n === m.name) return m
    const after = { ...m, name: n }
    await database.members.put(after)
    await database.audit.add({ at: now, action: 'member-update', txId: `member:${id}`, memberBefore: m, memberAfter: after })
    return after
  })
}

/** True when the member can be removed completely (nothing refers to them and no figure would change, e.g. a setup typo). */
export async function canDeleteMember(id: MemberId, database: MessDb = defaultDb, now = Date.now()): Promise<boolean> {
  const { transactions, closings, members, method } = await everything(database)
  return memberRemovable(id, members, transactions, closings, currentMonth(new Date(now)), method)
}

/** Removes a member that nothing refers to. Members with any history are ended (archived) instead. */
export async function deleteMember(id: MemberId, database: MessDb = defaultDb, now = Date.now()): Promise<void> {
  await database.transaction('rw', tables(database), async () => {
    const { transactions, closings, members, method } = await everything(database)
    if (memberIsReferenced(id, transactions, closings)) throw new HouseholdError('This member has entries or closings, so the history is kept. End the membership instead.')
    if (!memberRemovable(id, members, transactions, closings, currentMonth(new Date(now)), method)) {
      throw new HouseholdError('This member shared expenses already recorded, so removing them would change the other members’ shares. Record that they leave instead.')
    }
    await commit(
      database,
      now,
      (members) => members.filter((m) => m.id !== id),
      (b) => ({ at: now, action: 'member-delete', txId: `member:${id}`, memberBefore: b }),
    )
  })
}

/* ───────────── Utilities categories ───────────── */

function catNameCheck(name: string, categories: Category[], exceptId?: CategoryId) {
  const problem = nameProblem(
    name,
    categories.filter((c) => c.id !== exceptId).map((c) => c.name),
  )
  if (problem) throw new HouseholdError(problem)
}

export async function addCategory(name: string, database: MessDb = defaultDb, now = Date.now()): Promise<Category> {
  return database.transaction('rw', tables(database), async () => {
    const categories = await database.categories.toArray()
    const n = normalizeName(name)
    catNameCheck(n, categories)
    if (categories.filter((c) => c.archivedAt === undefined).length >= MAX_CATEGORIES) throw new HouseholdError(`Use at most ${MAX_CATEGORIES} categories.`)
    const c: Category = { id: newId('c'), name: n, seq: categories.reduce((a, x) => Math.max(a, x.seq + 1), 0), createdAt: now }
    await database.categories.add(c)
    await database.audit.add({ at: now, action: 'category-add', txId: `category:${c.id}`, categoryAfter: c })
    return c
  })
}

async function updateCategory(id: CategoryId, database: MessDb, now: number, f: (c: Category, all: Category[]) => Category): Promise<Category> {
  return database.transaction('rw', tables(database), async () => {
    const categories = await database.categories.toArray()
    const c = categories.find((x) => x.id === id)
    if (!c) throw new HouseholdError('This category no longer exists.')
    const after = f({ ...c }, categories)
    if (JSON.stringify(after) === JSON.stringify(c)) return c
    await database.categories.put(after)
    await database.audit.add({ at: now, action: 'category-update', txId: `category:${id}`, categoryBefore: c, categoryAfter: after })
    return after
  })
}

/** Renaming changes the name shown everywhere, including existing entries and reports. Amounts never change. */
export function renameCategory(id: CategoryId, name: string, database: MessDb = defaultDb, now = Date.now()) {
  return updateCategory(id, database, now, (c, all) => {
    const n = normalizeName(name)
    catNameCheck(n, all, id)
    return { ...c, name: n }
  })
}

/** Archived categories cannot be chosen for new entries; existing entries keep them. */
export function archiveCategory(id: CategoryId, database: MessDb = defaultDb, now = Date.now()) {
  return updateCategory(id, database, now, (c) => (c.archivedAt === undefined ? { ...c, archivedAt: now } : c))
}

export function restoreCategory(id: CategoryId, database: MessDb = defaultDb, now = Date.now()) {
  return updateCategory(id, database, now, (c, all) => {
    if (all.filter((x) => x.archivedAt === undefined).length >= MAX_CATEGORIES) throw new HouseholdError(`Use at most ${MAX_CATEGORIES} categories.`)
    const r = { ...c }
    delete r.archivedAt
    return r
  })
}

export async function categoryUsage(id: CategoryId, database: MessDb = defaultDb): Promise<{ entries: number; referenced: boolean }> {
  const transactions = await database.transactions.toArray()
  return { entries: transactions.filter((t) => t.category === id && t.deletedAt === undefined).length, referenced: categoryIsReferenced(id, transactions) }
}

/** Removes a category no entry (including deleted ones) has ever used. Used categories are archived instead. */
export async function deleteCategory(id: CategoryId, database: MessDb = defaultDb, now = Date.now()): Promise<void> {
  await database.transaction('rw', tables(database), async () => {
    const c = await database.categories.get(id)
    if (!c) return
    if (categoryIsReferenced(id, await database.transactions.toArray())) throw new HouseholdError('Entries use this category, so it is kept. Archive it instead.')
    await database.categories.delete(id)
    await database.audit.add({ at: now, action: 'category-delete', txId: `category:${id}`, categoryBefore: c })
  })
}
