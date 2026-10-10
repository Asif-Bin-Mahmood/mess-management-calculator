/**
 * Switching Bazar to member-paid entries (the cutover), and the notice shown on the Bazar screen.
 * The switch takes effect from a chosen open month; earlier months keep their recorded cash-method figures.
 */
import { useEffect, useState } from 'react'
import { applyBazarSwitch, bazarSwitchUndoProblem, planBazarSwitch, suggestBazarSwitchMonth, undoBazarSwitch, type BazarSwitchPlan } from '../../db/bazarMethod'
import { MAX_MONTH, MIN_MONTH, monthLabel, parseMonthInput } from '../../domain/month'
import { memberName } from '../../domain/household'
import { formatTaka } from '../../domain/money'
import { useApp, useConfirm, useToast } from '../context'
import { TopBar } from '../common'
import { navigate } from '../hooks'
import { Icon } from '../icons'

/** Short notice on the Bazar screen about which method the viewed month uses. */
export function BazarMethodNotice({ month }: { month: string }) {
  const { bazarMethod } = useApp()
  if (bazarMethod && month >= bazarMethod.memberPaidFrom) {
    if (month !== bazarMethod.memberPaidFrom || bazarMethod.memberPaidFrom === MIN_MONTH) return null
    return (
      <button type="button" className="notice notice-neutral" onClick={() => navigate('bazar/method')}>
        <Icon name="info" />
        <span>
          <strong>Member-paid Bazar starts this month.</strong> Earlier months keep their contributions and expenses.
        </span>
        <Icon name="right" size={18} />
      </button>
    )
  }
  return (
    <button type="button" className="notice notice-neutral" onClick={() => navigate('bazar/method')}>
      <Icon name="info" />
      <span>
        {bazarMethod ? (
          <>
            <strong>Recorded with contributions and expenses.</strong> Bazar uses member-paid amounts from {monthLabel(bazarMethod.memberPaidFrom)}.
          </>
        ) : (
          <>
            <strong>Switch to member-paid Bazar.</strong> Record what each member paid, without separate expenses.
          </>
        )}
      </span>
      <Icon name="right" size={18} />
    </button>
  )
}

export function BazarMethodScreen() {
  const { bazarMethod, txs, closings, members } = useApp()
  const confirm = useConfirm()
  const toast = useToast()
  const [month, setMonth] = useState<string | null>(null)
  const [plan, setPlan] = useState<BazarSwitchPlan | null>(null)
  const [undoProblem, setUndoProblem] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  // Re-plan whenever the chosen month or any record changes.
  useEffect(() => {
    let live = true
    if (bazarMethod) {
      void bazarSwitchUndoProblem().then((p) => live && setUndoProblem(p))
    } else if (month === null) {
      void suggestBazarSwitchMonth().then((m) => live && setMonth(m))
    } else {
      void planBazarSwitch(month).then((p) => live && setPlan(p))
    }
    return () => {
      live = false
    }
  }, [bazarMethod, month, txs, closings, members])

  async function apply() {
    if (!plan || plan.problems.length) return
    const ok = await confirm({
      title: `Use member-paid Bazar from ${monthLabel(plan.from)}?`,
      body: (
        <p>
          From {monthLabel(plan.from)}, each Bazar entry records what one member paid. Months before stay exactly as recorded. You can undo this until a member-paid
          entry is recorded or a member-paid month is closed.
        </p>
      ),
      confirmLabel: 'Switch',
    })
    if (!ok) return
    setBusy(true)
    try {
      await applyBazarSwitch(plan.from)
      toast({ message: `Bazar uses member-paid amounts from ${monthLabel(plan.from)}` })
      navigate('bazar', { replace: true })
    } catch (e) {
      toast({ message: String(e instanceof Error ? e.message : e), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  async function undo() {
    const ok = await confirm({
      title: 'Undo the switch?',
      body: <p>Bazar goes back to contributions and expenses for every month. Nothing else changes.</p>,
      confirmLabel: 'Undo switch',
    })
    if (!ok) return
    setBusy(true)
    try {
      await undoBazarSwitch()
      toast({ message: 'Bazar uses contributions and expenses again' })
    } catch (e) {
      toast({ message: String(e instanceof Error ? e.message : e), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  if (bazarMethod) {
    const fromStart = bazarMethod.memberPaidFrom === MIN_MONTH
    return (
      <div className="screen screen-form screen-bazar">
        <TopBar title="Bazar method" back="bazar" ledger="bazar" />
        <section className="card">
          <p>
            {fromStart ? (
              <>Bazar records what each member paid, from the start.</>
            ) : (
              <>
                Bazar records what each member paid from <strong>{monthLabel(bazarMethod.memberPaidFrom)}</strong>. Months before keep their contributions and
                expenses exactly as recorded.
              </>
            )}
          </p>
          <p className="field-hint">Each month: total Bazar ÷ members sharing = average per person. Paid above the average: will receive. Below: due.</p>
          {!fromStart && undoProblem === null && (
            <button type="button" className="btn btn-tonal" onClick={undo} disabled={busy}>
              Undo switch
            </button>
          )}
          {!fromStart && undoProblem && <p className="field-hint">{undoProblem}</p>}
        </section>
      </div>
    )
  }

  const t = (v: number) => formatTaka(v, { decimals: 'always' })
  return (
    <div className="screen screen-form screen-bazar">
      <TopBar title="Switch Bazar method" back="bazar" ledger="bazar" />
      <div className="form">
        <p>
          Member-paid Bazar records what each member personally paid for shared Bazar. There are no separate expenses and no shared cash. Earlier months keep their
          contributions, expenses, closings and balances exactly as recorded — nothing is converted.
        </p>
        <label className="field">
          <span className="field-label">Start month</span>
          <input
            type="month"
            className="input"
            value={month ?? ''}
            min={plan?.firstOpenMonth ?? MIN_MONTH}
            max={MAX_MONTH}
            onChange={(e) => {
              const v = parseMonthInput(e.target.value)
              if (v) setMonth(v)
            }}
          />
        </label>
        {plan && plan.from === month && (
          <>
            {plan.problems.length > 0 ? (
              <ul className="steps">
                {plan.problems.map((p) => (
                  <li key={p} className="warn">
                    <Icon name="alert" size={18} />
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <section className="card" aria-label="Preview">
                <h2 className="card-title">Carried into {monthLabel(plan.from)}</h2>
                <p className="field-hint">Shared cash at the end of the month before: {t(plan.cashBefore)}. Balances carry over unchanged.</p>
                {plan.balances.length === 0 ? (
                  <p>Everyone starts settled.</p>
                ) : (
                  <dl className="kv">
                    {plan.balances.map((b) => (
                      <div key={b.memberId}>
                        <dt>{memberName(b.memberId)}</dt>
                        <dd>{b.after < 0 ? `Due ${t(-b.after)}` : `Will receive ${t(b.after)}`}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </section>
            )}
            <div className="form-actions single">
              <button type="button" className="btn btn-primary btn-lg" onClick={apply} disabled={busy || plan.problems.length > 0}>
                <Icon name="check" size={18} /> Switch from {monthLabel(plan.from)}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
