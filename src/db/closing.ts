import {
  analyzeUndo,
  buildClosing,
  canClose,
  previewClosing,
  type ClosingInput,
  type ClosingPreview,
  type UndoAnalysis,
} from '../domain/ledger'
import { currentMonth } from '../domain/month'
import type { LedgerId, MonthClosing } from '../domain/types'
import { validateClosingInput, type ClosingInputErrors } from '../domain/validate'
import { db as defaultDb, type MessDb } from './db'

export class ClosingError extends Error {
  readonly blockingMonth?: string
  readonly errors?: ClosingInputErrors
  constructor(message: string, opts: { blockingMonth?: string; errors?: ClosingInputErrors } = {}) {
    super(message)
    this.blockingMonth = opts.blockingMonth
    this.errors = opts.errors
  }
}

async function ledgerData(database: MessDb, ledger: LedgerId) {
  const [transactions, closings] = await Promise.all([
    database.transactions.where('ledger').equals(ledger).toArray(),
    database.closings.where('ledger').equals(ledger).toArray(),
  ])
  return { transactions, closings }
}

function check(input: ClosingInput, closings: MonthClosing[], now: number) {
  const errors = validateClosingInput(input)
  if (Object.keys(errors).length) throw new ClosingError('Please fix the highlighted fields.', { errors })
  const ok = canClose(input.ledger, input.sourceMonth, closings, currentMonth(new Date(now)))
  if (!ok.ok) throw new ClosingError(ok.reason, { blockingMonth: ok.blockingMonth })
}

/** Builds and previews a closing without writing anything. Throws ClosingError if it is not allowed. */
export async function planClosing(
  input: ClosingInput,
  database: MessDb = defaultDb,
  now = Date.now(),
): Promise<{ closing: MonthClosing; preview: ClosingPreview }> {
  const { transactions, closings } = await ledgerData(database, input.ledger)
  check(input, closings, now)
  const closing = buildClosing(input, transactions, closings, 'preview', now)
  return { closing, preview: previewClosing(closing, transactions, closings) }
}

/**
 * Records a closing decision atomically. Re-checks for duplicates inside the transaction, so a double
 * tap or a second open tab cannot create two closings for the same ledger and month.
 */
export async function applyClosing(input: ClosingInput, database: MessDb = defaultDb, now = Date.now()): Promise<MonthClosing> {
  return database.transaction('rw', database.transactions, database.closings, database.audit, async () => {
    const { transactions, closings } = await ledgerData(database, input.ledger)
    check(input, closings, now)
    const closing = buildClosing(input, transactions, closings, crypto.randomUUID(), now)
    await database.closings.add(closing)
    await database.audit.add({ at: now, action: 'close', txId: `closing:${closing.id}`, ledger: closing.ledger, closingAfter: closing })
    return closing
  })
}

export async function planUndoClosing(id: string, database: MessDb = defaultDb, now = Date.now()): Promise<UndoAnalysis> {
  const closing = await database.closings.get(id)
  if (!closing) throw new ClosingError('This closing no longer exists.')
  if (closing.undoneAt !== undefined) throw new ClosingError('This closing has already been undone.')
  const { transactions, closings } = await ledgerData(database, closing.ledger)
  return analyzeUndo(closing, transactions, closings, currentMonth(new Date(now)))
}

/**
 * Reverses a closing decision: the record is kept and marked undone (audit trail preserved); the
 * target month returns to a provisional carry-forward. Transactions are never touched. Refuses when a
 * later closing depends on it or when it was already undone.
 */
export async function undoClosing(id: string, database: MessDb = defaultDb, now = Date.now()): Promise<MonthClosing> {
  return database.transaction('rw', database.transactions, database.closings, database.audit, async () => {
    const closing = await database.closings.get(id)
    if (!closing) throw new ClosingError('This closing no longer exists.')
    if (closing.undoneAt !== undefined) throw new ClosingError('This closing has already been undone.')
    const { transactions, closings } = await ledgerData(database, closing.ledger)
    const analysis = analyzeUndo(closing, transactions, closings, currentMonth(new Date(now)))
    if (analysis.blockedBy.length) {
      throw new ClosingError('A later month is closed and depends on this one. Undo the later closing first.', {
        blockingMonth: analysis.blockedBy[0].sourceMonth,
      })
    }
    const undone: MonthClosing = { ...closing, undoneAt: now }
    await database.closings.put(undone)
    await database.audit.add({
      at: now,
      action: 'undo-close',
      txId: `closing:${closing.id}`,
      ledger: closing.ledger,
      closingBefore: closing,
      closingAfter: undone,
    })
    return undone
  })
}
