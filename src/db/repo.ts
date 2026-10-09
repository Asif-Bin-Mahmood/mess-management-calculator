import { analyzeCorrection, type CorrectionImpact } from '../domain/ledger'
import { currentMonth, monthOf } from '../domain/month'
import type { Transaction } from '../domain/types'
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

/** Pure: computes the record that results from a mutation. Throws ValidationError on bad input. */
function build(m: Mutation, existing: Transaction | undefined, now: number): Transaction {
  if (m.kind === 'create' || m.kind === 'update') {
    const input = normalizeTxInput(m.input)
    const errors = validateTxInput(input)
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
  const after = build(m, existing, now)
  const ledgerTxs = await database.transactions.where('ledger').equals(after.ledger).toArray()
  const closings = await database.closings.where('ledger').equals(after.ledger).toArray()
  const nextTxs = existing ? ledgerTxs.map((t) => (t.id === after.id ? after : t)) : [...ledgerTxs, after]
  const changedMonth = existing && existing.month < after.month ? existing.month : after.month
  const impact = analyzeCorrection(after.ledger, ledgerTxs, nextTxs, changedMonth, currentMonth(new Date(now)), closings)
  return { before: existing, after, impact }
}

/** Writes the mutation and its audit entry atomically. */
export async function applyMutation(m: Mutation, database: MessDb = defaultDb, now = Date.now()): Promise<Transaction> {
  return database.transaction('rw', database.transactions, database.audit, async () => {
    const existing = m.kind === 'create' ? undefined : await database.transactions.get(m.id)
    const after = build(m, existing, now)
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
