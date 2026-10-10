import { useMemo, useState } from 'react'
import { applyClosing, ClosingError } from '../../db/closing'
import { buildClosing, canClose, computeLedgerMonth, monthClosingStatus, previewClosing, type ClosingInput, type MemberMap, type MonthSummary } from '../../domain/ledger'
import { formatTaka, parseTaka, poishaToInput } from '../../domain/money'
import { addMonths, currentMonth, monthLabel, shortMonthLabel } from '../../domain/month'
import { closingMethodLabel, ledgerName, memberName, type ClosingMethod, type LedgerId, type MemberId, type SettlementKind } from '../../domain/types'
import { MAX_DESCRIPTION } from '../../domain/validate'
import { BalanceTag, EmptyState, Money, OpeningTable, TopBar } from '../common'
import { runUndo } from '../closingFlow'
import { useApp, useConfirm, useToast } from '../context'
import { goBack, navigate } from '../hooks'
import { useLeaveGuard } from '../backNav'
import { Icon } from '../icons'

const availableLabel = (date: string) =>
  new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })

/* ───────────── Month status row on the ledger dashboard ───────────── */

/** One compact row: closed (with Undo), Close month, the earlier month to close, or when closing opens. */
export function MonthStatusRow({ ledger, s }: { ledger: LedgerId; s: MonthSummary }) {
  const { txs, closings, setMonth } = useApp()
  const confirm = useConfirm()
  const toast = useToast()
  const st = monthClosingStatus(ledger, s.month, txs ?? [], closings, currentMonth())
  // Month name alone within the viewed year; with the year otherwise (e.g. “Dec 2025”).
  const name = (m: string) => (m.slice(0, 4) === s.month.slice(0, 4) ? monthLabel(m).split(' ')[0] : shortMonthLabel(m))

  if (st.kind === 'closed') {
    return (
      <div className="month-status month-status-closed">
        <span className="month-status-text">
          <Icon name="check" size={18} />
          <span>
            <strong>{name(s.month)} closed</strong>
            <span className="month-status-sub">{closingMethodLabel(st.closing)}</span>
          </span>
        </span>
        <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => runUndo(st.closing, confirm, toast, setMonth)}>
          <Icon name="restore" size={16} /> Undo
        </button>
      </div>
    )
  }
  if (st.kind === 'can-close' || st.kind === 'pending') {
    return (
      <div className="month-status">
        <span className="month-status-text">
          <Icon name="calendar" size={18} />
          <strong>{name(st.month)} not closed</strong>
        </span>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate(`${ledger}/close/${st.month}`)}>
          Close {name(st.month)}
        </button>
      </div>
    )
  }
  return (
    <p className="month-status month-status-muted">
      <Icon name="calendar" size={18} />
      {st.kind === 'not-yet'
        ? `${name(s.month)} can be closed from ${availableLabel(st.availableFrom)}`
        : st.kind === 'before-start'
          ? `Nothing to close: ${st.firstMonth ? `this ledger starts in ${monthLabel(st.firstMonth)}` : 'this ledger has no entries yet'}`
          : 'Close later months first (undo newest first)'}
    </p>
  )
}

/* ───────────── Close-month screen ───────────── */

type Sign = 1 | -1

function SignedAmount({
  id,
  label,
  value,
  sign,
  onValue,
  onSign,
  negLabel,
  posLabel,
  error,
}: {
  id: string
  label: string
  value: string
  sign: Sign
  onValue: (v: string) => void
  onSign: (s: Sign) => void
  negLabel: string
  posLabel: string
  error?: string
}) {
  return (
    <div className="signed-row">
      <label className="signed-label" htmlFor={id}>
        {label}
      </label>
      <div className="segmented segmented-sm signed-toggle" role="radiogroup" aria-label={`${label}: direction`}>
        <button type="button" role="radio" aria-checked={sign === -1} className={sign === -1 ? 'on' : ''} onClick={() => onSign(-1)}>
          {negLabel}
        </button>
        <button type="button" role="radio" aria-checked={sign === 1} className={sign === 1 ? 'on' : ''} onClick={() => onSign(1)}>
          {posLabel}
        </button>
      </div>
      <span className={`amount-input amount-sm ${error ? 'invalid' : ''}`}>
        <span className="amount-sign" aria-hidden="true">
          ৳
        </span>
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => onValue(e.target.value.replace(/[^\d.,]/g, ''))}
          aria-invalid={!!error}
        />
      </span>
      {error && <p className="field-error">{error}</p>}
    </div>
  )
}

/** Member-paid Bazar keeps no shared cash, so its closing choices are about balances only. */
const PAID_METHODS: { id: ClosingMethod; title: string; text: string }[] = [
  { id: 'carry', title: 'Carry forward', text: 'Balances carry over.' },
  { id: 'settled', title: 'Start settled at zero', text: 'Settled outside the app or waived. Everyone starts at ৳0.' },
  { id: 'manual', title: 'Enter verified balances', text: 'Enter each member’s agreed balance.' },
]

const METHODS: { id: ClosingMethod; title: string; text: string }[] = [
  { id: 'carry', title: 'Carry forward', text: 'Balances and cash carry over.' },
  {
    id: 'settled',
    title: 'Start settled at zero',
    text: 'Settled outside the app or waived. Everyone starts at ৳0.',
  },
  { id: 'manual', title: 'Enter verified balances', text: 'Enter each member’s agreed balance and the counted cash.' },
]

export function CloseMonth({ ledger, month }: { ledger: LedgerId; month: string }) {
  const { txs, closings, setMonth, members, bazarMethod } = useApp()
  const confirm = useConfirm()
  const toast = useToast()
  const lm = ledger === 'bazar' ? bazarMethod : null
  const source = useMemo(() => computeLedgerMonth(ledger, members, txs ?? [], month, closings, lm), [ledger, members, txs, month, closings, lm])
  const paid = source.method === 'memberPaid'
  // Members shown in the month being closed: each gets an opening balance in the next month.
  const rows = source.members.map((m) => ({ id: m.memberId, name: memberName(m.memberId) }))
  const next = addMonths(month, 1)

  const [method, setMethod] = useState<ClosingMethod | null>(null)
  const [kind, setKind] = useState<SettlementKind>('settled')
  const [cashMode, setCashMode] = useState<'carry' | 'set'>('carry')
  const [cash, setCash] = useState(() => poishaToInput(Math.abs(source.remainingCash)))
  const [cashSign, setCashSign] = useState<Sign>(source.remainingCash < 0 ? -1 : 1)
  const [bal, setBal] = useState(() => Object.fromEntries(source.members.map((m) => [m.memberId, poishaToInput(Math.abs(m.closing))])) as Record<MemberId, string>)
  const [balSign, setBalSign] = useState(() => Object.fromEntries(source.members.map((m) => [m.memberId, m.closing < 0 ? -1 : 1])) as Record<MemberId, Sign>)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  useLeaveGuard(!busy && (method !== null || note.trim() !== ''), 'this closing')

  const check = canClose(ledger, month, closings, currentMonth())

  const parsedCash = parseTaka(cash)
  const parsedBal = Object.fromEntries(rows.map((m) => [m.id, parseTaka(bal[m.id] ?? '')])) as Record<MemberId, number | null>
  // Member-paid months never enter cash: any cash left from the cash method is kept as it is.
  const needCash = !paid && (method === 'manual' || (method === 'settled' && cashMode === 'set'))
  const errors: { cash?: string; bal: Partial<Record<MemberId, string>> } = { bal: {} }
  if (needCash && parsedCash === null) errors.cash = 'Enter the counted cash'
  if (method === 'manual') for (const m of rows) if (parsedBal[m.id] === null) errors.bal[m.id] = 'Enter an amount (0 if settled)'
  const valid = method !== null && !errors.cash && Object.keys(errors.bal).length === 0

  const input: ClosingInput | null = valid
    ? {
        ledger,
        sourceMonth: month,
        method: method!,
        settlementKind: method === 'settled' ? kind : undefined,
        cashMode: paid ? (method === 'manual' ? 'set' : 'carry') : method === 'manual' ? 'set' : method === 'settled' ? cashMode : 'carry',
        openingCash: needCash ? cashSign * parsedCash! : paid && method === 'manual' ? source.remainingCash : undefined,
        openingBalances:
          method === 'manual' ? (Object.fromEntries(rows.map((m) => [m.id, (balSign[m.id] ?? 1) * parsedBal[m.id]!])) as MemberMap) : undefined,
        note: note.trim() || undefined,
      }
    : null

  const preview = input && txs ? previewClosing(buildClosing(input, members, txs, closings, 'preview', 0, lm), members, txs, closings, lm) : null

  if (!txs) return null
  if (source.closing) {
    return (
      <div className="screen">
        <TopBar title={`Close ${monthLabel(month)}`} back={ledger} ledger={ledger} />
        <EmptyState icon="check" title={`${monthLabel(month)} is already closed`}>
          Undo that closing on the {ledgerName(ledger)} screen first if you need to choose differently.
        </EmptyState>
      </div>
    )
  }

  const closingBalances = Object.fromEntries(source.members.map((m) => [m.memberId, m.closing])) as MemberMap

  async function submit() {
    if (!input || !preview) return
    const o = preview.target
    const ok = await confirm({
      title: `Close ${monthLabel(month)} — ${ledgerName(ledger)}?`,
      body: (
        <>
          <p>
            Method: <strong>{closingMethodLabel({ method: input.method, settlementKind: input.settlementKind })}</strong>. {monthLabel(next)} will open as shown. Only the{' '}
            {ledgerName(ledger)} ledger is affected. You can undo this later.
          </p>
          <p className="field-hint">
            Membership changes can then only start from {monthLabel(next)}.
          </p>
          <OpeningTable
            before={closingBalances}
            after={Object.fromEntries(o.members.map((m) => [m.memberId, m.opening])) as MemberMap}
            cashBefore={source.remainingCash}
            cashAfter={o.openingCash}
            beforeLabel={`${monthLabel(month)} closing`}
            afterLabel={`${monthLabel(next)} opening`}
            hideCash={paid}
          />
        </>
      ),
      confirmLabel: `Close ${monthLabel(month)}`,
    })
    if (!ok) return
    setBusy(true)
    try {
      const saved = await applyClosing(input)
      setMonth(next)
      goBack(ledger)
      toast({
        message: `${monthLabel(month)} closed. ${monthLabel(next)} opened.`,
        action: { label: 'Undo', run: () => void runUndo(saved, confirm, toast, setMonth) },
      })
    } catch (e) {
      toast({ message: e instanceof ClosingError || e instanceof Error ? e.message : String(e), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`screen screen-form screen-${ledger}`}>
      <TopBar title={`Close ${monthLabel(month)}`} back={ledger} ledger={ledger} />
      <p className="form-ledger">{ledgerName(ledger)} ledger only</p>

      {!check.ok && (
        <p className="warn" role="alert">
          <Icon name="alert" size={18} /> <span>{check.reason}</span>
        </p>
      )}

      <section className="card" aria-labelledby="ends-h">
        <div className="card-head">
          <h2 id="ends-h" className="card-title">
            Where {monthLabel(month)} ends
          </h2>
        </div>
        <div className="kv">
          {paid ? (
            <div>
              <dt>Total Bazar · {formatTaka(source.averagePerPerson)} per person</dt>
              <dd>
                <Money value={source.totalSpent} />
              </dd>
            </div>
          ) : (
            <div>
              <dt>Closing cash (held by manager)</dt>
              <dd>
                <Money value={source.remainingCash} />
              </dd>
            </div>
          )}
        </div>
        <ul className="member-list">
          {source.members.map((m) => (
            <li key={m.memberId} className="closing-member">
              <span className="member-name">{memberName(m.memberId)}</span>
              <BalanceTag value={m.closing} />
            </li>
          ))}
        </ul>
      </section>

      <fieldset className="field">
        <legend className="field-label">How should {monthLabel(next)} start?</legend>
        <div className="method-list">
          {(paid ? PAID_METHODS : METHODS).map((m) => (
            <label key={m.id} className={`method ${method === m.id ? 'on' : ''}`}>
              <input type="radio" name="method" value={m.id} checked={method === m.id} onChange={() => setMethod(m.id)} />
              <span className="method-title">{m.title}</span>
              <span className="method-text">{m.text}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {method === 'settled' && (
        <>
          <fieldset className="field">
            <legend className="field-label">What happened to the balances?</legend>
            <div className="choice-grid">
              {(['settled', 'waived'] as SettlementKind[]).map((k) => (
                <label key={k} className={`choice ${kind === k ? 'on' : ''}`}>
                  <input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} />
                  {k === 'settled' ? 'Settled outside the app' : 'Waived / written off'}
                </label>
              ))}
            </div>
            <p className="field-hint">Recorded as an adjustment, not as cash.</p>
          </fieldset>
          {!paid && (
          <fieldset className="field">
            <legend className="field-label">Opening cash for {monthLabel(next)}</legend>
            <div className="choice-grid">
              <label className={`choice ${cashMode === 'carry' ? 'on' : ''}`}>
                <input type="radio" name="cash" checked={cashMode === 'carry'} onChange={() => setCashMode('carry')} />
                Keep {formatTaka(source.remainingCash)}
              </label>
              <label className={`choice ${cashMode === 'set' ? 'on' : ''}`}>
                <input type="radio" name="cash" checked={cashMode === 'set'} onChange={() => setCashMode('set')} />
                Enter counted cash
              </label>
            </div>
          </fieldset>
          )}
        </>
      )}

      {needCash && (
        <SignedAmount
          id="cash"
          label="Opening cash"
          value={cash}
          sign={cashSign}
          onValue={setCash}
          onSign={setCashSign}
          negLabel="Overspent"
          posLabel="In hand"
          error={errors.cash}
        />
      )}

      {method === 'manual' && (
        <fieldset className="field">
          <legend className="field-label">Opening balance for each member</legend>
          {rows.map((m) => (
            <SignedAmount
              key={m.id}
              id={`bal-${m.id}`}
              label={m.name}
              value={bal[m.id] ?? ''}
              sign={balSign[m.id] ?? 1}
              onValue={(v) => setBal((b) => ({ ...b, [m.id]: v }))}
              onSign={(sg) => setBalSign((b) => ({ ...b, [m.id]: sg }))}
              negLabel="Due"
              posLabel="Will receive"
              error={errors.bal[m.id]}
            />
          ))}
        </fieldset>
      )}

      {method && (
        <label className="field">
          <span className="field-label">
            Note <span className="optional">optional</span>
          </span>
          <input className="input" value={note} maxLength={MAX_DESCRIPTION} onChange={(e) => setNote(e.target.value)} placeholder="e.g. settled in cash at the meeting on 30 Sep" />
        </label>
      )}

      {preview && (
        <section className="card" aria-labelledby="prev-h">
          <div className="card-head">
            <h2 id="prev-h" className="card-title">
              Preview
            </h2>
          </div>
          <OpeningTable
            before={closingBalances}
            after={Object.fromEntries(preview.target.members.map((m) => [m.memberId, m.opening])) as MemberMap}
            cashBefore={source.remainingCash}
            cashAfter={preview.target.openingCash}
            beforeLabel={`${monthLabel(month)} closing`}
            afterLabel={`${monthLabel(next)} opening`}
            hideCash={paid}
          />
          <p className="card-text">
            {paid
              ? preview.target.reconciliation.difference === 0
                ? 'Amounts due will equal amounts to receive.'
                : `Amounts due and to receive will differ by ${formatTaka(preview.target.reconciliation.difference)}. This adjustment is recorded with this closing, so the report can explain it.`
              : preview.target.reconciliation.difference === 0
              ? 'Member balances will equal the cash held.'
              : `Member balances will differ from the cash held by ${formatTaka(preview.target.reconciliation.difference)}. This difference is recorded with this closing, so the report can explain it.`}
          </p>
          {preview.laterTransactionCount > 0 && (
            <p className="warn">
              <Icon name="alert" size={18} />
              <span>
                {preview.laterTransactionCount} {preview.laterTransactionCount === 1 ? 'entry is' : 'entries are'} already recorded in {monthLabel(next)} or later. They stay as
                they are; balances are recalculated from these openings.
              </span>
            </p>
          )}
        </section>
      )}

      <div className="form-actions single">
        <button type="button" className="btn btn-primary btn-lg" disabled={!valid || !check.ok || busy} onClick={submit}>
          <Icon name="check" size={18} /> Review &amp; close {monthLabel(month)}
        </button>
      </div>
    </div>
  )
}
