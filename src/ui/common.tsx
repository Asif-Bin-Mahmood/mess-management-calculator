import { useRef, type ReactNode } from 'react'
import type { ClosingEffectChange, CorrectionImpact } from '../domain/ledger'
import { formatTaka } from '../domain/money'
import { addMonths, monthLabel, shortMonthLabel } from '../domain/month'
import { displayRoster, memberName, memberSeq } from '../domain/household'
import { closingMethodLabel, type LedgerId, type MemberId } from '../domain/types'
import { inRosterOrder, type MemberMap } from '../domain/ledger'
import { balanceStatus } from '../report/reportModel'
import { performBack } from './backNav'
import { navigate } from './hooks'
import { Icon, type IconName } from './icons'

export function Money({ value, sign, className }: { value: number; sign?: boolean; className?: string }) {
  return <span className={`num ${className ?? ''}`}>{formatTaka(value, { sign })}</span>
}

export function MonthSwitcher({
  month,
  onChange,
  min,
  max,
}: {
  month: string
  onChange: (m: string) => void
  min: string
  max: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const prev = addMonths(month, -1)
  const next = addMonths(month, 1)
  return (
    <div className="month-switcher" role="group" aria-label="Month">
      <button type="button" className="icon-btn" onClick={() => onChange(prev)} disabled={prev < min} aria-label={`Previous month, ${monthLabel(prev)}`}>
        <Icon name="left" />
      </button>
      <button
        type="button"
        className="month-label"
        onClick={() => {
          const el = input.current
          if (!el) return
          try {
            el.showPicker()
          } catch {
            el.focus()
          }
        }}
        aria-label={`${monthLabel(month)}. Choose month`}
      >
        <Icon name="calendar" size={18} />
        <span>{monthLabel(month)}</span>
      </button>
      <input
        ref={input}
        type="month"
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        value={month}
        min={min}
        max={max}
        onChange={(e) => {
          const v = e.target.value
          if (/^\d{4}-\d{2}$/.test(v) && v >= min && v <= max) onChange(v)
        }}
      />
      <button type="button" className="icon-btn" onClick={() => onChange(next)} disabled={next > max} aria-label={`Next month, ${monthLabel(next)}`}>
        <Icon name="right" />
      </button>
    </div>
  )
}

export function Avatar({ id, status }: { id: MemberId; status?: 'due' | 'receivable' | 'settled' }) {
  return (
    <span className={`avatar avatar-c${((memberSeq(id) % 8) + 8) % 8} ${status ? `ring-${status}` : ''}`} aria-hidden="true">
      {memberName(id).charAt(0).toLocaleUpperCase()}
    </span>
  )
}

export function BalanceTag({ value }: { value: number }) {
  const s = balanceStatus(value)
  return (
    <span className={`balance balance-${s}`}>
      <span className="balance-label">{s === 'due' ? 'Due' : s === 'receivable' ? 'Will receive' : 'Settled'}</span>
      {s !== 'settled' && <span className="num balance-amount">{formatTaka(Math.abs(value))}</span>}
    </span>
  )
}

export function TopBar({ title, back, actions, ledger }: { title: string; back?: string; actions?: ReactNode; ledger?: LedgerId }) {
  return (
    <header className={`topbar ${ledger ? `topbar-${ledger}` : ''}`}>
      {back !== undefined && (
        <button type="button" className="icon-btn" onClick={() => void performBack('button').then((handled) => handled || navigate(back, { replace: true }))} aria-label="Back">
          <Icon name="back" />
        </button>
      )}
      <h1 className="topbar-title">{title}</h1>
      <div className="topbar-actions">{actions}</div>
    </header>
  )
}

export function LedgerIcon({ ledger, size = 22 }: { ledger: LedgerId; size?: number }) {
  const name: IconName = ledger === 'utilities' ? 'bolt' : 'basket'
  return (
    <span className={`ledger-icon ledger-icon-${ledger}`} aria-hidden="true">
      <Icon name={name} size={size} />
    </span>
  )
}

export function ImpactView({ impact }: { impact: CorrectionImpact }) {
  const later = impact.laterMonths
  const range = later.length === 1 ? monthLabel(later[0]) : `${shortMonthLabel(later[0])} – ${shortMonthLabel(later[later.length - 1])}`
  const changed = impact.members.filter((m) => m.before !== m.after)
  return (
    <div className="impact">
      <p>
        This changes <strong>{monthLabel(impact.changedMonth)}</strong>. Opening balances carried into <strong>{range}</strong> ({later.length}{' '}
        {later.length === 1 ? 'month' : 'months'}) will be recalculated. Past transactions are not changed or counted twice.
      </p>
      <table className="impact-table">
        <caption>Closing balances in {monthLabel(impact.horizon)}</caption>
        <thead>
          <tr>
            <th scope="col"></th>
            <th scope="col">Now</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          <tr className={impact.cashBefore !== impact.cashAfter ? 'changed' : ''}>
            <th scope="row">Cash</th>
            <td className="num">{formatTaka(impact.cashBefore)}</td>
            <td className="num">{formatTaka(impact.cashAfter)}</td>
          </tr>
          {impact.members.map((m) => (
            <tr key={m.memberId} className={m.before !== m.after ? 'changed' : ''}>
              <th scope="row">{memberName(m.memberId)}</th>
              <td className="num">{formatTaka(m.before)}</td>
              <td className="num">{formatTaka(m.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {changed.length === 0 && impact.cashBefore === impact.cashAfter && <p className="muted">Later totals stay the same.</p>}
      {impact.closingEffects.map((e) => (
        <ClosedMonthEffect key={e.sourceMonth} e={e} />
      ))}
    </div>
  )
}

export function EmptyState({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <p className="empty-title">{title}</p>
      {children && <div className="empty-text">{children}</div>}
    </div>
  )
}

/** Members present in any of the maps, in roster order. */
function rowIds(...maps: MemberMap[]): MemberId[] {
  return inRosterOrder(displayRoster(), maps.flatMap((m) => Object.keys(m)))
}

export function OpeningTable({ before, after, cashBefore, cashAfter, beforeLabel, afterLabel }: { before: MemberMap; after: MemberMap; cashBefore: number; cashAfter: number; beforeLabel: string; afterLabel: string }) {
  return (
    <table className="impact-table">
      <thead>
        <tr>
          <th scope="col"></th>
          <th scope="col">{beforeLabel}</th>
          <th scope="col">{afterLabel}</th>
        </tr>
      </thead>
      <tbody>
        {rowIds(before, after).map((id) => (
          <tr key={id} className={(before[id] ?? 0) !== (after[id] ?? 0) ? 'changed' : ''}>
            <th scope="row">{memberName(id)}</th>
            <td className="num">{formatTaka(before[id] ?? 0)}</td>
            <td className="num">{formatTaka(after[id] ?? 0)}</td>
          </tr>
        ))}
        <tr className={cashBefore !== cashAfter ? 'changed' : ''}>
          <th scope="row">Cash</th>
          <td className="num">{formatTaka(cashBefore)}</td>
          <td className="num">{formatTaka(cashAfter)}</td>
        </tr>
      </tbody>
    </table>
  )
}

/** How a change affects one closed month: original vs current figures; the recorded decision is kept. */
function ClosedMonthEffect({ e }: { e: ClosingEffectChange }) {
  const src = monthLabel(e.sourceMonth)
  const next = monthLabel(e.closing.targetMonth)
  const counted = e.closing.method !== 'carry' && e.closing.cashMode === 'set'
  const kept =
    e.closing.method === 'carry'
      ? 'Balances are carried forward, so the change flows into the next month.'
      : `The ${e.closing.method === 'manual' ? 'verified opening' : e.closing.settlementKind === 'waived' ? 'waiver' : 'settlement'} recorded at closing stays as it was; the change is carried into ${next} on top of it.`
  const rows = [
    ...rowIds(e.original.balances, e.closingAfter.balances, e.openingAfter.balances, e.openingBefore.balances).map((id) => ({
      key: id,
      name: memberName(id),
      orig: e.original.balances[id] ?? 0,
      now: e.closingAfter.balances[id] ?? 0,
      open: e.openingAfter.balances[id] ?? 0,
      openBefore: e.openingBefore.balances[id] ?? 0,
    })),
    { key: 'cash', name: 'Cash', orig: e.original.cash, now: e.closingAfter.cash, open: e.openingAfter.cash, openBefore: e.openingBefore.cash },
  ]
  return (
    <div className="warn warn-block">
      <p>
        <Icon name="alert" size={18} /> <strong>{src} is closed</strong> ({closingMethodLabel(e.closing)}). {kept}
      </p>
      <table className="impact-table">
        <thead>
          <tr>
            <th scope="col"></th>
            <th scope="col">{shortMonthLabel(e.sourceMonth)} at closing</th>
            <th scope="col">{shortMonthLabel(e.sourceMonth)} after</th>
            <th scope="col">{shortMonthLabel(e.closing.targetMonth)} opening</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.open !== r.openBefore ? 'changed' : ''}>
              <th scope="row">{r.name}</th>
              <td className="num">{formatTaka(r.orig)}</td>
              <td className="num">{formatTaka(r.now)}</td>
              <td className="num">{formatTaka(r.open)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {counted && e.unexplainedAfter !== e.unexplainedBefore && (
        <p>
          The counted opening cash ({formatTaka(e.openingAfter.cash)}) is kept, but the corrected ledger cash for {src} is {formatTaka(e.closingAfter.cash)}. {next} will
          show an <strong>unreconciled cash difference after historical correction of {formatTaka(e.unexplainedAfter)}</strong> (review required) until it is resolved (check this entry, or undo and re-close {src} with a new count).
        </p>
      )}
    </div>
  )
}
