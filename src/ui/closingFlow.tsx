import { planUndoClosing, undoClosing } from '../db/closing'
import { monthLabel } from '../domain/month'
import { closingMethodLabel, ledgerName, type MonthClosing } from '../domain/types'
import { OpeningTable } from './common'
import type { ConfirmFn, ToastFn } from './context'
import { navigate } from './hooks'
import { Icon } from './icons'

const when = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/** Confirms and undoes a closing; guides the manager when a later closing must be undone first. */
export async function runUndo(c: MonthClosing, confirm: ConfirmFn, toast: ToastFn, goToMonth: (m: string) => void): Promise<void> {
  let plan
  try {
    plan = await planUndoClosing(c.id)
  } catch (e) {
    toast({ message: String(e instanceof Error ? e.message : e), tone: 'error' })
    return
  }
  const target = monthLabel(c.targetMonth)
  if (plan.blockedBy.length) {
    const latest = plan.blockedBy[0]
    const go = await confirm({
      title: `Undo ${monthLabel(latest.sourceMonth)} first`,
      body: (
        <p>
          {monthLabel(latest.sourceMonth)} was closed after {monthLabel(c.sourceMonth)} and its opening depends on it. To keep the accounts consistent, undo closings from the newest
          month backwards: {plan.blockedBy.map((b) => monthLabel(b.sourceMonth)).join(', then ')}, then {monthLabel(c.sourceMonth)}. Nothing has been changed.
        </p>
      ),
      confirmLabel: `Go to ${monthLabel(latest.sourceMonth)}`,
    })
    if (go) goToMonth(latest.sourceMonth)
    return
  }
  const ok = await confirm({
    title: `Undo the ${monthLabel(c.sourceMonth)} closing?`,
    body: (
      <>
        <p>
          This reverses <strong>{closingMethodLabel(c)}</strong> for {ledgerName(c.ledger)}, made on {when(c.createdAt)}. {target} will open with the balances carried forward
          from {monthLabel(c.sourceMonth)} (provisional) until you close it again. No transactions are deleted; the decision and its reversal stay in the history.
        </p>
        <OpeningTable
          before={plan.openingNow.balances}
          after={plan.openingAfter.balances}
          cashBefore={plan.openingNow.cash}
          cashAfter={plan.openingAfter.cash}
          beforeLabel={`${target} opening now`}
          afterLabel="After undo"
        />
        {plan.dependentTransactionCount > 0 && (
          <p className="warn">
            <Icon name="alert" size={18} />
            <span>
              {plan.dependentTransactionCount} {plan.dependentTransactionCount === 1 ? 'entry is' : 'entries are'} already recorded in {target} or later. They stay unchanged;
              members’ balances are recalculated from the new opening.
            </span>
          </p>
        )}
      </>
    ),
    confirmLabel: 'Undo closing',
    danger: true,
  })
  if (!ok) return
  try {
    await undoClosing(c.id)
    toast({
      message: `${monthLabel(c.sourceMonth)} closing undone. ${target} is provisional again.`,
      action: { label: 'Close again', run: () => navigate(`${c.ledger}/close/${c.sourceMonth}`) },
    })
  } catch (e) {
    toast({ message: e instanceof Error ? e.message : String(e), tone: 'error' })
  }
}

