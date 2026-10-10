/**
 * Entry form for member-paid Bazar months: a Bazar amount (what one member personally paid for shared Bazar)
 * or a settlement (one member paying another to settle an old balance — never counted as Bazar spending).
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ValidationError } from '../../db/repo'
import { formatTaka, parseTaka, poishaToInput } from '../../domain/money'
import { currentMonth, dayLabel, isValidDate, lastDayOfMonth, MAX_DATE, MIN_DATE, monthLabel, monthOf, toDateKey } from '../../domain/month'
import { memberName, sharers } from '../../domain/household'
import { inRosterOrder } from '../../domain/ledger'
import { txTypeLabel, type MemberId, type Transaction } from '../../domain/types'
import { MAX_DESCRIPTION, type TxErrors, type TxInput } from '../../domain/validate'
import { useApp, useToast } from '../context'
import { useMutate } from '../useMutate'
import { Avatar, TopBar } from '../common'
import { goBack, navigate } from '../hooks'
import { useLeaveGuard } from '../backNav'
import { Icon } from '../icons'

export type PaidKind = 'purchase' | 'settlement'

function defaultDate(month: string): string {
  const today = toDateKey(new Date())
  if (monthOf(today) === month) return today
  return month < currentMonth() ? lastDayOfMonth(month) : `${month}-01`
}

export function BazarPaidForm({ kind, existing, month }: { kind: PaidKind; existing?: Transaction; month: string }) {
  const mutate = useMutate()
  const toast = useToast()
  const { members } = useApp()
  const amountRef = useRef<HTMLInputElement>(null)

  const [amount, setAmount] = useState(existing ? poishaToInput(existing.amount) : '')
  const [memberId, setMemberId] = useState<MemberId | undefined>(existing?.memberId)
  const [receiverId, setReceiverId] = useState<MemberId | undefined>(existing?.counterpartyId)
  const [date, setDate] = useState(existing?.date ?? defaultDate(month))
  const [description, setDescription] = useState(existing?.description ?? '')
  const [errors, setErrors] = useState<TxErrors>({})
  const [busy, setBusy] = useState(false)
  const [i0] = useState(() => ({ amount, memberId, receiverId, date, description }))
  const dirty = !busy && (amount !== i0.amount || memberId !== i0.memberId || receiverId !== i0.receiverId || date !== i0.date || description !== i0.description)
  useLeaveGuard(dirty, existing ? 'changes' : 'this entry')

  useEffect(() => {
    if (!existing) amountRef.current?.focus()
  }, [existing])

  const parsed = parseTaka(amount)
  const entryMonth = isValidDate(date) ? monthOf(date) : month
  const purchase = kind === 'purchase'

  // A Bazar amount is paid by a member sharing the month (plus the member an edited entry already has);
  // a settlement can involve any registered member, current or former.
  const existingMember = existing?.memberId
  const choices = useMemo(() => {
    const sharing = new Set(sharers(members, entryMonth).map((m) => m.id))
    const ids = purchase ? inRosterOrder(members, [...sharing, ...(existingMember ? [existingMember] : [])]) : members.map((m) => m.id)
    return ids.map((id) => ({ id, name: memberName(id), sharing: sharing.has(id) }))
  }, [members, entryMonth, purchase, existingMember])

  const title = existing ? `Edit ${txTypeLabel(existing.type).toLowerCase()}` : purchase ? 'Add Bazar amount' : 'Record settlement'

  async function submit(e: FormEvent, again = false) {
    e.preventDefault()
    const input: TxInput = { ledger: 'bazar', type: kind, amount: parsed ?? Number.NaN, date, memberId, description, ...(purchase ? {} : { counterpartyId: receiverId }) }
    const local: TxErrors = {}
    if (parsed === null) local.amount = amount.trim() ? 'Use numbers only, up to 2 decimals' : 'Enter an amount'
    if (!memberId) local.memberId = 'Choose who paid'
    if (!purchase && !receiverId) local.counterpartyId = 'Choose who received the payment'
    if (!isValidDate(date)) local.date = 'Choose a valid date'
    if (Object.keys(local).length) {
      setErrors(local)
      return
    }
    setBusy(true)
    try {
      const saved = await mutate(existing ? { kind: 'update', id: existing.id, input } : { kind: 'create', input }, {
        done: existing ? 'Changes saved' : `${txTypeLabel(kind)} of ${formatTaka(parsed!)} saved`,
      })
      if (!saved) return
      if (again) {
        setAmount('')
        setDescription('')
        setErrors({})
        amountRef.current?.focus()
      } else goBack('bazar')
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
      if (done) goBack('bazar')
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

  const picker = (legend: string, name: string, value: MemberId | undefined, set: (id: MemberId) => void, errKey: keyof TxErrors) => (
    <fieldset className="field">
      <legend className="field-label">{legend}</legend>
      {choices.length === 0 ? (
        <div className="empty-hint">
          <p>Nobody shares Bazar in {monthLabel(entryMonth)}.</p>
          <button type="button" className="btn btn-tonal" onClick={() => navigate('settings/members')}>
            Manage members
          </button>
        </div>
      ) : (
        <div className="choice-grid choice-members" aria-describedby={errors[errKey] ? `err-${errKey}` : undefined}>
          {choices.map((m) => (
            <label key={m.id} className={`choice ${value === m.id ? 'on' : ''}`}>
              <input type="radio" name={name} value={m.id} checked={value === m.id} onChange={() => set(m.id)} />
              <Avatar id={m.id} />
              <span className="choice-name">{m.name}</span>
              {!m.sharing && <span className="choice-note">{purchase ? 'not sharing' : 'former'}</span>}
            </label>
          ))}
        </div>
      )}
      {err(errKey)}
    </fieldset>
  )

  return (
    <div className="screen screen-form screen-bazar">
      <TopBar title={title} back="bazar" ledger="bazar" />
      <form className="form" onSubmit={(e) => submit(e)} noValidate>
        <p className="form-ledger">
          {purchase ? 'Bazar · paid by a member for shared Bazar' : 'Bazar · payment between members, not Bazar spending'}
        </p>

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

        {picker('Paid by', 'member', memberId, setMemberId, 'memberId')}
        {!purchase && picker('Received by', 'receiver', receiverId, setReceiverId, 'counterpartyId')}

        <label className="field">
          <span className="field-label">Date</span>
          <input
            type="date"
            className="input"
            min={MIN_DATE}
            max={MAX_DATE}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            aria-invalid={!!errors.date}
            aria-describedby="date-hint"
            required
          />
          <span className="field-hint" id="date-hint">
            {isValidDate(date) ? `Counts toward ${monthLabel(monthOf(date))}` : ''}
          </span>
          {err('date')}
          {err('type')}
        </label>

        <label className="field">
          <span className="field-label">
            Description <span className="optional">optional</span>
          </span>
          <input
            className="input"
            value={description}
            maxLength={MAX_DESCRIPTION}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={purchase ? 'e.g. rice, fish, vegetables' : 'e.g. old balance from March'}
          />
          {err('description')}
        </label>

        {!purchase && (
          <p className="field-hint">
            A settlement moves an old balance between two members (for example a former member paying what they owe). It changes their balances only and is not
            counted as Bazar spending.
          </p>
        )}

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
