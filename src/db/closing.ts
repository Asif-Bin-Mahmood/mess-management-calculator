import {
  analyzeUndo,
  buildClosing,
  canClose,
  computeLedgerMonth,
  previewClosing,
  type ClosingInput,
  type ClosingPreview,
  type UndoAnalysis,
} from '../domain/ledger'
import { formatTaka } from '../domain/money'
import { addMonths, currentMonth, monthLabel } from '../domain/month'
import type { LedgerId, MonthClosing } from '../domain/types'
import { validateClosingInput, type ClosingInputErrors } from '../domain/validate'
import { isMemberPaidMonth, type BazarMethod } from '../domain/bazarMethod'
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
  const [transactions, closings, roster, methodRow] = await Promise.all([
    database.transactions.where('ledger').equals(ledger).toArray(),
    database.closings.where('ledger').equals(ledger).toArray(),
    database.members.toArray(),
    database.meta.get('bazarMethod'),
  ])
  const method = ledger === 'bazar' ? ((methodRow?.value as BazarMethod | undefined) ?? null) : null
  return { transactions, closings, roster, method }
}

function check(input: ClosingInput, d: Awaited<ReturnType<typeof ledgerData>>, now: number) {
  const { closings } = d
  const source = computeLedgerMonth(input.ledger, d.roster, d.transactions, input.sourceMonth, closings, d.method)
  const errors = validateClosingInput(input, source.members.map((m) => m.memberId))
  if (Object.keys(errors).length) throw new ClosingError('Please fix the highlighted fields.', { errors })
  // Member-paid Bazar has no shared cash: a closing may change balances but never introduces cash.
  if (isMemberPaidMonth(d.method, input.ledger, input.sourceMonth)) {
    const keepsCash = input.cashMode === 'carry' || input.openingCash === source.remainingCash
    if (!keepsCash) throw new ClosingError('Member-paid Bazar has no shared cash, so a closing cannot set an opening cash amount.')
  } else if (isMemberPaidMonth(d.method, input.ledger, addMonths(input.sourceMonth, 1))) {
    // The last cash-method month before the switch must hand over no cash: the member-paid method has no cash pool.
    const openingCash = input.method === 'carry' || input.cashMode !== 'set' ? source.remainingCash : (input.openingCash ?? 0)
    if (openingCash !== 0) {
      throw new ClosingError(
        `Bazar uses member-paid amounts from ${monthLabel(addMonths(input.sourceMonth, 1))}, which has no shared cash. Return or collect the remaining ${formatTaka(Math.abs(openingCash))} first, or close with ৳0 opening cash.`,
      )
    }
  }
  const ok = canClose(input.ledger, input.sourceMonth, closings, currentMonth(new Date(now)))
  if (!ok.ok) throw new ClosingError(ok.reason, { blockingMonth: ok.blockingMonth })
}

/** Builds and previews a closing without writing anything. Throws ClosingError if it is not allowed. */
export async function planClosing(
  input: ClosingInput,
  database: MessDb = defaultDb,
  now = Date.now(),
): Promise<{ closing: MonthClosing; preview: ClosingPreview }> {
  const d = await ledgerData(database, input.ledger)
  check(input, d, now)
  const closing = buildClosing(input, d.roster, d.transactions, d.closings, 'preview', now, d.method)
  return { closing, preview: previewClosing(closing, d.roster, d.transactions, d.closings, d.method) }
}

/**
 * Records a closing decision atomically. Re-checks for duplicates inside the transaction, so a double
 * tap or a second open tab cannot create two closings for the same ledger and month.
 */
export async function applyClosing(input: ClosingInput, database: MessDb = defaultDb, now = Date.now()): Promise<MonthClosing> {
  return database.transaction('rw', [database.transactions, database.closings, database.audit, database.members, database.meta], async () => {
    const d = await ledgerData(database, input.ledger)
    check(input, d, now)
    const closing = buildClosing(input, d.roster, d.transactions, d.closings, crypto.randomUUID(), now, d.method)
    await database.closings.add(closing)
    await database.audit.add({ at: now, action: 'close', txId: `closing:${closing.id}`, ledger: closing.ledger, closingAfter: closing })
    return closing
  })
}

export async function planUndoClosing(id: string, database: MessDb = defaultDb, now = Date.now()): Promise<UndoAnalysis> {
  const closing = await database.closings.get(id)
  if (!closing) throw new ClosingError('This closing no longer exists.')
  if (closing.undoneAt !== undefined) throw new ClosingError('This closing has already been undone.')
  const { transactions, closings, roster, method } = await ledgerData(database, closing.ledger)
  return analyzeUndo(closing, roster, transactions, closings, currentMonth(new Date(now)), method)
}

/**
 * Reverses a closing decision: the record is kept and marked undone (audit trail preserved); the
 * target month returns to a provisional carry-forward. Transactions are never touched. Refuses when a
 * later closing depends on it or when it was already undone.
 */
export async function undoClosing(id: string, database: MessDb = defaultDb, now = Date.now()): Promise<MonthClosing> {
  return database.transaction('rw', [database.transactions, database.closings, database.audit, database.members, database.meta], async () => {
    const closing = await database.closings.get(id)
    if (!closing) throw new ClosingError('This closing no longer exists.')
    if (closing.undoneAt !== undefined) throw new ClosingError('This closing has already been undone.')
    const { transactions, closings, roster, method } = await ledgerData(database, closing.ledger)
    const analysis = analyzeUndo(closing, roster, transactions, closings, currentMonth(new Date(now)), method)
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
