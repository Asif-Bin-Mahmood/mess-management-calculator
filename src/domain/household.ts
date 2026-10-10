/**
 * Household configuration: the members who share expenses and the Utilities categories.
 *
 * Members
 * - `id` is permanent and never reused; transactions, closings and audit entries refer to it.
 * - `seq` is a permanent position (assigned when the member is created). It orders members on screen and
 *   decides who receives leftover poisha when a month's spending does not divide evenly.
 * - `periods` are the whole calendar months in which the member shares expenses (household-wide: both
 *   ledgers). `from`/`until` are inclusive YYYY-MM; a missing `from` means "since the beginning", a
 *   missing `until` means "still a member". Leaving and rejoining adds periods.
 *
 * Categories (Utilities only)
 * - `id` is permanent; renaming changes the name everywhere, including old entries and reports.
 * - Archived categories cannot be chosen for new entries but stay attached to existing ones.
 */
import { isValidMonth } from './month'

export type MemberId = string
export type CategoryId = string

export interface MembershipPeriod {
  /** First month shared (inclusive). Missing = since the beginning. */
  from?: string
  /** Last month shared (inclusive). Missing = still a member. */
  until?: string
}

export interface Member {
  id: MemberId
  name: string
  seq: number
  createdAt: number
  periods: MembershipPeriod[]
}

export interface Category {
  id: CategoryId
  name: string
  seq: number
  createdAt: number
  archivedAt?: number
}

/** All members ever registered (current and former). The accounting engine derives each month's sharers from it. */
export type Roster = readonly Member[]

export const MAX_NAME = 24
export const MAX_MEMBERS = 50
export const MAX_CATEGORIES = 50

/* ───────────── Legacy (≤ v1.1.1) compatibility ───────────── */

/** The four fixed member ids used by app versions up to 1.1.1, in their original rounding order. */
export const LEGACY_MEMBER_IDS: readonly MemberId[] = ['asif', 'dipu', 'yusha', 'ovi']
/** Names shown by installations and backups made before names were configurable (≤ 1.1.0, backup schema 1–2). */
export const LEGACY_MEMBER_NAMES: Readonly<Record<string, string>> = { asif: 'Asif', dipu: 'Dipu', yusha: 'Yusha', ovi: 'Ovi' }
/** Names a v1.1.1 installation showed before the user renamed anyone. */
export const LEGACY_DEFAULT_NAMES: Readonly<Record<string, string>> = { asif: 'Member 1', dipu: 'Member 2', yusha: 'Member 3', ovi: 'Member 4' }
/** The five fixed Utilities categories of app versions up to 1.1.1 (ids are kept so old entries keep their meaning). */
export const LEGACY_CATEGORIES: readonly { id: CategoryId; name: string }[] = [
  { id: 'service', name: 'Service Charge' },
  { id: 'current', name: 'Current Bill' },
  { id: 'gas', name: 'Gas Bill' },
  { id: 'wifi', name: 'Wi-Fi Bill' },
  { id: 'others', name: 'Others' },
]

/** The household of a v1.1.1 installation or backup: the four original members, sharing since the beginning. */
export function legacyMembers(names: Readonly<Record<string, string>> = LEGACY_MEMBER_NAMES, createdAt = 0): Member[] {
  return LEGACY_MEMBER_IDS.map((id, seq) => ({ id, name: names[id] ?? LEGACY_MEMBER_NAMES[id], seq, createdAt, periods: [{}] }))
}

export function legacyCategories(createdAt = 0): Category[] {
  return LEGACY_CATEGORIES.map((c, seq) => ({ ...c, seq, createdAt }))
}

/** Suggested Utilities categories offered during setup (optional; the user can change them). */
export const CATEGORY_TEMPLATES = LEGACY_CATEGORIES

/* ───────────── Membership ───────────── */

export function sharesIn(m: Member, month: string): boolean {
  return m.periods.some((p) => (p.from === undefined || p.from <= month) && (p.until === undefined || month <= p.until))
}

/** Members sharing `month`'s expenses, in rounding order. */
export function sharers(roster: Roster, month: string): Member[] {
  return roster.filter((m) => sharesIn(m, month)).sort(bySeq)
}

export function bySeq<T extends { seq: number }>(a: T, b: T): number {
  return a.seq - b.seq
}

/** True when the member shares now or from a later month (i.e. has not left for good). */
export function isCurrentMember(m: Member, month: string): boolean {
  return m.periods.some((p) => p.until === undefined || p.until >= month)
}

/** Earliest month in which the two period lists differ, '' when they differ "since the beginning", null when equal. */
export function firstDifferentMonth(a: readonly MembershipPeriod[], b: readonly MembershipPeriod[], horizon: string): string | null {
  // Membership can only change at a boundary (a `from`, or the month after an `until`); between boundaries,
  // and before the earliest one, every month behaves the same. Probing each boundary in order finds the first difference.
  const boundaries = new Set<string>()
  for (const p of [...a, ...b]) {
    if (p.from !== undefined) boundaries.add(p.from)
    if (p.until !== undefined) boundaries.add(nextMonth(p.until))
  }
  const pa = { periods: a } as Member
  const pb = { periods: b } as Member
  const points = [...boundaries].sort()
  const beforeAll = points.length ? prevMonth(points[0]) : horizon
  if (sharesIn(pa, beforeAll) !== sharesIn(pb, beforeAll)) return ''
  for (const m of points) if (sharesIn(pa, m) !== sharesIn(pb, m)) return m
  return null
}

function nextMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number)
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
}

function prevMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number)
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`
}

/** Periods must be valid months, from ≤ until, sorted and non-overlapping; only the first may start "since the beginning". */
export function validatePeriods(periods: unknown): string | null {
  if (!Array.isArray(periods)) return 'periods must be a list'
  let lastUntil: string | null | undefined = null // null = nothing yet
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i] as MembershipPeriod
    if (typeof p !== 'object' || p === null) return 'invalid period'
    const keys = Object.keys(p).filter((k) => k !== 'from' && k !== 'until')
    if (keys.length) return 'invalid period'
    if (p.from !== undefined && (typeof p.from !== 'string' || !isValidMonth(p.from))) return 'invalid start month'
    if (p.until !== undefined && (typeof p.until !== 'string' || !isValidMonth(p.until))) return 'invalid end month'
    if (p.from !== undefined && p.until !== undefined && p.from > p.until) return 'a period ends before it starts'
    if (i > 0 && p.from === undefined) return 'only the first period may start at the beginning'
    if (lastUntil === undefined) return 'a period follows an open-ended period'
    if (lastUntil !== null && p.from !== undefined && p.from <= lastUntil) return 'periods overlap'
    lastUntil = p.until
  }
  return null
}

/* ───────────── Names ───────────── */

export function normalizeName(v: unknown): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : ''
}

/** Problem with a display name, or null. `others` are the names it must differ from (case-insensitive). */
export function nameProblem(name: string, others: readonly string[]): string | null {
  if (!name) return 'Enter a name'
  if (name.length > MAX_NAME) return `Use at most ${MAX_NAME} characters`
  const key = name.toLocaleLowerCase()
  if (others.some((o) => o.toLocaleLowerCase() === key)) return 'This name is already used'
  return null
}

/** Validates a list of new names (setup wizard): each must be valid and different from the others. */
export function validateNames(raw: readonly unknown[], existing: readonly string[] = []): { names: string[]; errors: (string | null)[] } {
  const names = raw.map(normalizeName)
  const errors = names.map((n, i) => nameProblem(n, [...existing, ...names.filter((_, j) => j !== i)]))
  return { names, errors }
}

/** Structural validation of a member/category registry (stored or imported). */
export function validateRoster(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['members must be a list']
  const p: string[] = []
  const ids = new Set<string>()
  const seqs = new Set<number>()
  const names: string[] = []
  raw.forEach((m: Partial<Member>, i) => {
    const where = `member ${i + 1}`
    if (typeof m !== 'object' || m === null) return void p.push(`${where}: not an object`)
    if (typeof m.id !== 'string' || !m.id || m.id.length > 64) p.push(`${where}: invalid id`)
    else if (ids.has(m.id)) p.push(`${where}: duplicate id`)
    else ids.add(m.id)
    const name = normalizeName(m.name)
    if (m.name !== name || nameProblem(name, names)) p.push(`${where}: invalid or duplicate name`)
    names.push(name)
    if (!Number.isSafeInteger(m.seq) || (m.seq as number) < 0 || seqs.has(m.seq as number)) p.push(`${where}: invalid position`)
    else seqs.add(m.seq as number)
    if (!Number.isFinite(m.createdAt)) p.push(`${where}: invalid createdAt`)
    const pp = validatePeriods(m.periods)
    if (pp) p.push(`${where}: ${pp}`)
    for (const k of Object.keys(m)) if (!['id', 'name', 'seq', 'createdAt', 'periods'].includes(k)) p.push(`${where}: unexpected field "${k}"`)
  })
  if (raw.length > MAX_MEMBERS * 4) p.push('too many members')
  return p
}

export function validateCategories(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['categories must be a list']
  const p: string[] = []
  const ids = new Set<string>()
  const seqs = new Set<number>()
  const names: string[] = []
  raw.forEach((c: Partial<Category>, i) => {
    const where = `category ${i + 1}`
    if (typeof c !== 'object' || c === null) return void p.push(`${where}: not an object`)
    if (typeof c.id !== 'string' || !c.id || c.id.length > 64) p.push(`${where}: invalid id`)
    else if (ids.has(c.id)) p.push(`${where}: duplicate id`)
    else ids.add(c.id)
    const name = normalizeName(c.name)
    if (c.name !== name || nameProblem(name, names)) p.push(`${where}: invalid or duplicate name`)
    names.push(name)
    if (!Number.isSafeInteger(c.seq) || (c.seq as number) < 0 || seqs.has(c.seq as number)) p.push(`${where}: invalid position`)
    else seqs.add(c.seq as number)
    if (!Number.isFinite(c.createdAt)) p.push(`${where}: invalid createdAt`)
    if (c.archivedAt !== undefined && !Number.isFinite(c.archivedAt)) p.push(`${where}: invalid archivedAt`)
    for (const k of Object.keys(c)) if (!['id', 'name', 'seq', 'createdAt', 'archivedAt'].includes(k)) p.push(`${where}: unexpected field "${k}"`)
  })
  if (raw.length > MAX_CATEGORIES * 4) p.push('too many categories')
  return p
}

export function newId(prefix: string): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  return `${prefix}_${rand}`
}

/* ───────────── Display names (UI only; never used for accounting) ───────────── */

let displayMembers = new Map<MemberId, Member>()
let displayCategories = new Map<CategoryId, Category>()

/** Called by the app state before rendering. Display only. */
export function setHouseholdDisplay(members: readonly Member[], categories: readonly Category[]): void {
  displayMembers = new Map(members.map((m) => [m.id, m]))
  displayCategories = new Map(categories.map((c) => [c.id, c]))
}

export function memberName(id: MemberId): string {
  return displayMembers.get(id)?.name ?? 'Unknown member'
}

export function categoryName(id: CategoryId | undefined): string {
  if (id === undefined) return 'Uncategorized'
  return displayCategories.get(id)?.name ?? 'Unknown category'
}

/** Permanent position of a member (for its colour), or -1 when unknown. */
export function memberSeq(id: MemberId): number {
  return displayMembers.get(id)?.seq ?? -1
}

export function displayRoster(): Member[] {
  return [...displayMembers.values()].sort(bySeq)
}

export function displayCategoryList(): Category[] {
  return [...displayCategories.values()].sort(bySeq)
}
