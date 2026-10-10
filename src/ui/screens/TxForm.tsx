import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ValidationError } from '../../db/repo'
import { formatTaka, parseTaka, poishaToInput } from '../../domain/money'
import { currentMonth, dayLabel, isValidDate, lastDayOfMonth, monthLabel, monthOf, toDateKey } from '../../domain/month'
import { memberName, sharers, type CategoryId } from '../../domain/household'
import { ledgerName, txTypeLabel, type LedgerId, type MemberId, type Transaction, type TxType } from '../../domain/types'
import { MAX_DESCRIPTION, type TxErrors, type TxInput } from '../../domain/validate'
import { checkMemberReturn, computeLedgerMonth, inRosterOrder, type MemberReturnCheck } from '../../domain/ledger'
import { useApp } from '../context'
import { useMutate } from '../useMutate'
import { Avatar, EmptyState, TopBar } from '../common'
import { useToast, type ConfirmOptions } from '../context'
import { goBack, navigate } from '../hooks'
import { useLeaveGuard } from '../backNav'
import { Icon } from '../icons'

type Kind = 'in' | 'out'

function defaultDate(month: string): string {
  const today = toDateKey(new Date())
  if (monthOf(today) === month) return today
  return month < currentMonth() ? lastDayOfMonth(month) : `${month}-01`
}

export function TxForm({ ledger, kind: initialKind, editId }: { ledger: LedgerId; kind?: Kind; editId?: string }) {
  const { txs, month } = useApp()
  if (editId) {
    if (!txs) return null
    const existing = txs.find((t) => t.id === editId)
    if (!existing || existing.ledger !== ledger) {
      return (
        <div className="screen">
          <TopBar title="Entry not found" back={ledger} />
          <EmptyState icon="alert" title="This entry no longer exists." />
        </div>
      )
    }
    return <FormBody key={existing.id} ledger={ledger} existing={existing} month={existing.month} />
  }
  return <FormBody key={initialKind} ledger={ledger} initialKind={initialKind ?? 'out'} month={month} />
}

function FormBody({ ledger, existing, initialKind, month }: { ledger: LedgerId; existing?: Transaction; initialKind?: Kind; month: string }) {
  const mutate = useMutate()
  const toast = useToast()
  const { txs, closings, members, categories } = useApp()
  const amountRef = useRef<HTMLInputElement>(null)

  const [kind, setKind] = useState<Kind>(existing ? (existing.type === 'contribution' || existing.type === 'memberRefund' ? 'in' : 'out') : initialKind!)
  const [refund, setRefund] = useState(existing ? existing.type === 'memberRefund' || existing.type === 'expenseRefund' : false)
  const [amount, setAmount] = useState(existing ? poishaToInput(existing.amount) : '')
  const [memberId, setMemberId] = useState<MemberId | undefined>(existing?.memberId)
  const [category, setCategory] = useState<CategoryId | undefined>(existing?.category)
  const [date, setDate] = useState(existing?.date ?? defaultDate(month))
  const [description, setDescription] = useState(existing?.description ?? '')
  const [errors, setErrors] = useState<TxErrors>({})
  const [busy, setBusy] = useState(false)
  const [i0] = useState(() => ({ kind, refund, amount, memberId, category, date, description }))
  const dirty =
    !busy &&
    (kind !== i0.kind || refund !== i0.refund || amount !== i0.amount || memberId !== i0.memberId || category !== i0.category || date !== i0.date || description !== i0.description)
  useLeaveGuard(dirty, existing ? 'changes' : 'this entry')

  useEffect(() => {
    if (!existing) amountRef.current?.focus()
  }, [existing])

  const type: TxType = kind === 'in' ? (refund ? 'memberRefund' : 'contribution') : refund ? 'expenseRefund' : 'expense'
  const needsCategory = kind === 'out' && ledger === 'utilities'
  const parsed = parseTaka(amount)
  const entryMonth = isValidDate(date) ? monthOf(date) : month

  // Who can be chosen: members sharing the entry's month, plus anyone shown in that month of this ledger
  // (e.g. a former member who still has a balance to settle), plus the member an edited entry already has.
  const existingMember = existing?.memberId
  const memberChoices = useMemo(() => {
    const sharing = new Set(sharers(members, entryMonth).map((m) => m.id))
    const shown = computeLedgerMonth(ledger, members, (txs ?? []).filter((t) => t.ledger === ledger), entryMonth, closings).members.map((m) => m.memberId)
    const ids = inRosterOrder(members, [...sharing, ...shown, ...(existingMember ? [existingMember] : [])])
    return ids.map((id) => ({ id, name: memberName(id), sharing: sharing.has(id) }))
  }, [members, entryMonth, ledger, txs, closings, existingMember])
  const nobodyShares = sharers(members, entryMonth).length === 0
  const categoryChoices = categories.filter((c) => c.archivedAt === undefined || c.id === existing?.category)

  const title = existing ? `Edit ${txTypeLabel(existing.type).toLowerCase()}` : kind === 'in' ? 'New contribution' : 'New expense'

  async function submit(e: FormEvent, again = false) {
    e.preventDefault()
    const input: TxInput = { ledger, type, amount: parsed ?? Number.NaN, date, memberId, category, description }
    const local: TxErrors = {}
    if (parsed === null) local.amount = amount.trim() ? 'Use numbers only, up to 2 decimals' : 'Enter an amount'
    if (kind === 'in' && !memberId) local.memberId = 'Choose who paid'
    if (needsCategory && !category) local.category = 'Choose a category'
    if (!isValidDate(date)) local.date = 'Choose a valid date'
    if (Object.keys(local).length) {
      setErrors(local)
      return
    }
    const ask =
      type === 'memberRefund' && memberId ? returnWarning(checkMemberReturn(ledger, members, txs ?? [], closings, { memberId, amount: parsed!, month: monthOf(date) }, existing?.id)) : undefined
    setBusy(true)
    try {
      const saved = await mutate(existing ? { kind: 'update', id: existing.id, input } : { kind: 'create', input }, {
        done: existing ? 'Changes saved' : `${txTypeLabel(type)} of ${formatTaka(parsed!)} saved`,
        ask,
      })
      if (!saved) return
      if (again) {
        setAmount('')
        setDescription('')
        setErrors({})
        amountRef.current?.focus()
      } else goBack(ledger)
    } catch (err) {
      if (err instanceof ValidationError) setErrors(err.errors)
      else toast({ message: `Could not save: ${String(err)}`, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!existing) return
    setBusy(true)
    try {
      const done = await mutate(
        { kind: 'delete', id: existing.id },
        {
          ask: {
            title: `Delete this ${txTypeLabel(existing.type).toLowerCase()}?`,
            body: (
              <p>
                {formatTaka(existing.amount)} on {dayLabel(existing.date)} {existing.date.slice(0, 4)}
                {existing.memberId ? ` · ${memberName(existing.memberId)}` : ''}. It moves to <strong>Backup → Recently deleted</strong>, where you can restore it.
              </p>
            ),
            confirmLabel: 'Delete',
            danger: true,
          },
          done: 'Entry deleted',
          undo: { kind: 'restore', id: existing.id },
        },
      )
      if (done) goBack(ledger)
    } catch (err) {
      toast({ message: `Could not delete: ${String(err)}`, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const err = (k: keyof TxErrors) =>
    errors[k] ? (
      <p className="field-error" id={`err-${k}`}>
        {errors[k]}
      </p>
    ) : null

  return (
    <div className={`screen screen-form screen-${ledger}`}>
      <TopBar title={title} back={ledger} ledger={ledger} />
      <form className="form" onSubmit={(e) => submit(e)} noValidate>
        <p className="form-ledger">{ledgerName(ledger)} ledger</p>

        {!existing && (
          <div className="segmented" role="radiogroup" aria-label="Entry type">
            {(['in', 'out'] as Kind[]).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                className={kind === k ? 'on' : ''}
                onClick={() => {
                  setKind(k)
                  setErrors({})
                }}
              >
                <Icon name={k === 'in' ? 'arrowIn' : 'arrowOut'} size={18} />
                {k === 'in' ? 'Contribution' : 'Expense'}
              </button>
            ))}
          </div>
        )}

        <label className="field amount-field">
          <span className="field-label">Amount</span>
          <span className={`amount-input ${errors.amount ? 'invalid' : ''}`}>
            <span className="amount-sign" aria-hidden="true">
              ৳
            </span>
            <input
              ref={amountRef}
              inputMode="decimal"
              autoComplete="off"
              enterKeyHint="done"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))}
              aria-invalid={!!errors.amount}
              aria-describedby={errors.amount ? 'err-amount' : undefined}
            />
          </span>
          {err('amount')}
        </label>

        {kind === 'in' ? (
          <fieldset className="field">
            <legend className="field-label">{refund ? 'Returned to' : 'Paid by'}</legend>
            {memberChoices.length === 0 ? (
              <EmptyHint text={`Nobody is a member in ${monthLabel(entryMonth)}.`} action="Manage members" to="settings/members" />
            ) : (
              <div className="choice-grid choice-members" aria-describedby={errors.memberId ? 'err-memberId' : undefined}>
                {memberChoices.map((m) => (
                  <label key={m.id} className={`choice ${memberId === m.id ? 'on' : ''}`}>
                    <input type="radio" name="member" value={m.id} checked={memberId === m.id} onChange={() => setMemberId(m.id)} />
                    <Avatar id={m.id} />
                    <span className="choice-name">{m.name}</span>
                    {!m.sharing && <span className="choice-note">left</span>}
                  </label>
                ))}
              </div>
            )}
            {err('memberId')}
          </fieldset>
        ) : (
          needsCategory && (
            <fieldset className="field">
              <legend className="field-label">Category</legend>
              {categoryChoices.length === 0 ? (
                <EmptyHint text="There are no Utilities categories yet." action="Add categories" to="settings/categories" />
              ) : (
                <div className="choice-grid" aria-describedby={errors.category ? 'err-category' : undefined}>
                  {categoryChoices.map((c) => (
                    <label key={c.id} className={`choice ${category === c.id ? 'on' : ''}`}>
                      <input type="radio" name="category" value={c.id} checked={category === c.id} onChange={() => setCategory(c.id)} />
                      {c.name}
                      {c.archivedAt !== undefined && <span className="choice-note">archived</span>}
                    </label>
                  ))}
                </div>
              )}
              {err('category')}
            </fieldset>
          )
        )}

        <label className="field">
          <span className="field-label">Date</span>
          <input
            type="date"
            className="input"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            aria-invalid={!!errors.date}
            aria-describedby="date-hint"
            required
          />
          <span className="field-hint" id="date-hint">
            {isValidDate(date) ? `Counts toward ${monthLabel(monthOf(date))}` : ''}
          </span>
          {kind === 'out' && isValidDate(date) && nobodyShares && !errors.date && (
            <p className="field-error">Nobody shares expenses in {monthLabel(entryMonth)}. Add or restore a member for that month first.</p>
          )}
          {err('date')}
        </label>

        <label className="field">
          <span className="field-label">
            Note <span className="optional">optional</span>
          </span>
          <input
            className="input"
            value={description}
            maxLength={MAX_DESCRIPTION}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={kind === 'in' ? 'e.g. paid by bKash' : ledger === 'bazar' ? 'e.g. rice, fish, vegetables' : 'e.g. DESCO prepaid'}
          />
          {err('description')}
        </label>

        <label className="switch-row">
          <input type="checkbox" checked={refund} onChange={(e) => setRefund(e.target.checked)} />
          <span>
            <strong>{kind === 'in' ? 'Money returned to member' : 'Refund received'}</strong>
            <span className="field-hint">
              {kind === 'in' ? 'Cash given back to a member. Reduces their contribution.' : 'A shop or biller returned money. Reduces total spent.'}
            </span>
          </span>
        </label>

        <div className="form-actions">
          {existing ? (
            <button type="button" className="btn btn-danger-ghost" onClick={remove} disabled={busy}>
              <Icon name="trash" size={18} /> Delete
            </button>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={(e) => submit(e, true)} disabled={busy}>
              Save & add another
            </button>
          )}
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
            <Icon name="check" size={18} /> Save
          </button>
        </div>
      </form>
    </div>
  )
}

/** Confirmation shown when a cash return to a member exceeds what they will receive or makes cash negative. */
function returnWarning(c: MemberReturnCheck): ConfirmOptions | undefined {
  if (!c.exceedsBalance && !c.makesCashNegative) return undefined
  const name = memberName(c.memberId)
  const bal = (v: number) => (v > 0 ? `will receive ${formatTaka(v)}` : v < 0 ? `due ${formatTaka(-v)}` : 'settled')
  return {
    title: `Check this return to ${name}`,
    body: (
      <>
        <p>
          You are recording <strong>{formatTaka(c.amount)}</strong> of cash given back to {name} in {monthLabel(c.month)}. This is a real cash return, not a payment
          between members.
        </p>
        <dl className="kv">
          <div>
            <dt>{name} before</dt>
            <dd>{bal(c.balanceBefore)}</dd>
          </div>
          <div>
            <dt>{name} after</dt>
            <dd>{bal(c.balanceAfter)}</dd>
          </div>
          <div>
            <dt>Cash before</dt>
            <dd>{formatTaka(c.cashBefore)}</dd>
          </div>
          <div>
            <dt>Cash after</dt>
            <dd>{formatTaka(c.cashAfter)}</dd>
          </div>
        </dl>
        {c.exceedsBalance && (
          <p className="warn">
            <Icon name="alert" size={18} />
            <span>
              This is {formatTaka(c.amount - Math.max(c.balanceBefore, 0))} more than {name} will receive, so {name} will be due {formatTaka(Math.max(-c.balanceAfter, 0))}.
            </span>
          </p>
        )}
        {c.makesCashNegative && (
          <p className="warn">
            <Icon name="alert" size={18} />
            <span>The ledger’s cash would be {formatTaka(c.cashAfter)}: more money would have gone out than came in.</span>
          </p>
        )}
      </>
    ),
    confirmLabel: 'Record return anyway',
  }
}

function EmptyHint({ text, action, to }: { text: string; action: string; to: string }) {
  return (
    <div className="empty-hint">
      <p>{text}</p>
      <button type="button" className="btn btn-tonal" onClick={() => navigate(to)}>
        {action}
      </button>
    </div>
  )
}
