import { isMemberPaidMonth, type BazarMethod } from '../domain/bazarMethod'
import { bySeq, sharers, type Category, type Member } from '../domain/household'
import { analyzeCorrection, type CorrectionImpact } from '../domain/ledger'
import { currentMonth, monthLabel, monthOf } from '../domain/month'
import { isMemberPaidType, type Transaction } from '../domain/types'
import { normalizeTxInput, validateTxInput, type TxErrors, type TxInput } from '../domain/validate'
import { db as defaultDb, type MessDb } from './db'

export type Mutation =
  | { kind: 'create'; input: TxInput }
  | { kind: 'update'; id: string; input: TxInput }
  | { kind: 'delete'; id: string }
  | { kind: 'restore'; id: string }

export class ValidationError extends Error {
  readonly errors: TxErrors
  constructor(errors: TxErrors) {
    super(Object.values(errors).join('; '))
    this.errors = errors
  }
}

export interface MutationPlan {
  before?: Transaction
  after: Transaction
  /** Non-null when the change alters a month that later months carry forward from. */
  impact: CorrectionImpact | null
}

function newId(): string {
  return crypto.randomUUID()
}

export interface Household {
  members: Member[]
  categories: Category[]
}

/** Household plus the Bazar method: everything an entry is validated against. */
interface EntryContext extends Household {
  bazarMethod: BazarMethod | null
}

async function entryContext(database: MessDb): Promise<EntryContext> {
  const [h, m] = await Promise.all([loadHousehold(database), database.meta.get('bazarMethod')])
  return { ...h, bazarMethod: (m?.value as BazarMethod | undefined) ?? null }
}

/** The household registry (members and Utilities categories), in display order. */
export async function loadHousehold(database: MessDb = defaultDb): Promise<Household> {
  const [members, categories] = await Promise.all([database.members.toArray(), database.categories.toArray()])
  return { members: members.sort(bySeq), categories: categories.sort(bySeq) }
}

/** Pure: computes the record that results from a mutation. Throws ValidationError on bad input. */
function build(m: Mutation, existing: Transaction | undefined, now: number, h: EntryContext): Transaction {
  if (m.kind === 'create' || m.kind === 'update') {
    const input = normalizeTxInput(m.input)
    const errors = validateTxInput(input, { roster: h.members, categories: h.categories, entry: true, keepCategory: existing?.category, bazarMethod: h.bazarMethod })
    if (Object.keys(errors).length) throw new ValidationError(errors)
    if (m.kind === 'create') {
      return { ...input, id: newId(), month: monthOf(input.date), createdAt: now, updatedAt: now }
    }
    if (!existing) throw new Error('Transaction not found')
    if (existing.ledger !== input.ledger) throw new Error('A transaction cannot move between ledgers')
    return {
      ...input,
      id: existing.id,
      month: monthOf(input.date),
      createdAt: existing.createdAt,
      updatedAt: now,
      ...(existing.deletedAt !== undefined ? { deletedAt: existing.deletedAt } : {}),
    }
  }
  if (!existing) throw new Error('Transaction not found')
  if (m.kind === 'delete') return { ...existing, deletedAt: now, updatedAt: now }
  if (isMemberPaidMonth(h.bazarMethod, existing.ledger, existing.month) !== isMemberPaidType(existing.type)) {
    throw new ValidationError({ type: `This entry belongs to the other Bazar method for ${monthLabel(existing.month)}, so it cannot be restored there.` })
  }
  if ((existing.type === 'expense' || existing.type === 'expenseRefund' || existing.type === 'purchase') && sharers(h.members, existing.month).length === 0) {
    throw new ValidationError({ date: `No member shares expenses in ${monthLabel(existing.month)}. Add or restore a member for that month first.` })
  }
  if (existing.type === 'purchase' && !sharers(h.members, existing.month).some((m) => m.id === existing.memberId)) {
    throw new ValidationError({ memberId: `This member does not share ${monthLabel(existing.month)}, so the Bazar amount cannot be restored. Record a settlement for an old balance instead.` })
  }
  const restored = { ...existing, updatedAt: now }
  delete restored.deletedAt
  return restored
}

/**
 * Works out what a mutation would do, including its carry-forward impact, without writing anything.
 * The UI shows `impact` and asks for confirmation before calling applyMutation.
 */
export async function planMutation(m: Mutation, database: MessDb = defaultDb, now = Date.now()): Promise<MutationPlan> {
  const existing = m.kind === 'create' ? undefined : await database.transactions.get(m.id)
  const h = await entryContext(database)
  const after = build(m, existing, now, h)
  const ledgerTxs = await database.transactions.where('ledger').equals(after.ledger).toArray()
  const closings = await database.closings.where('ledger').equals(after.ledger).toArray()
  const nextTxs = existing ? ledgerTxs.map((t) => (t.id === after.id ? after : t)) : [...ledgerTxs, after]
  const changedMonth = existing && existing.month < after.month ? existing.month : after.month
  const impact = analyzeCorrection(after.ledger, h.members, ledgerTxs, nextTxs, changedMonth, currentMonth(new Date(now)), closings, h.bazarMethod)
  return { before: existing, after, impact }
}

/** Writes the mutation and its audit entry atomically. */
export async function applyMutation(m: Mutation, database: MessDb = defaultDb, now = Date.now()): Promise<Transaction> {
  return database.transaction('rw', [database.transactions, database.audit, database.members, database.categories, database.meta], async () => {
    const existing = m.kind === 'create' ? undefined : await database.transactions.get(m.id)
    const after = build(m, existing, now, await entryContext(database))
    await database.transactions.put(after)
    await database.audit.add({ at: now, action: m.kind, txId: after.id, ledger: after.ledger, before: existing, after })
    return after
  })
}

export async function getMeta<T>(key: string, database: MessDb = defaultDb): Promise<T | undefined> {
  return (await database.meta.get(key))?.value as T | undefined
}

export async function setMeta(key: string, value: unknown, database: MessDb = defaultDb): Promise<void> {
  await database.meta.put({ key, value })
}

/** Asks the browser not to evict our storage under pressure. Safe to call repeatedly. */
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return null
  }
}
