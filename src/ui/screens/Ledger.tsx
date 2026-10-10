import { useMemo, useState } from 'react'
import { computeLedgerMonth, type MonthSummary } from '../../domain/ledger'
import { formatTaka } from '../../domain/money'
import { dayLabel, monthLabel } from '../../domain/month'
import type { Category, CategoryId } from '../../domain/household'
import { categoryName, isMemberPaidType, ledgerName, memberName, type LedgerId, type Transaction } from '../../domain/types'
import { balanceStatus, dashboardAlerts, txCashEffect, txTitle } from '../../report/reportModel'
import { useApp, useConfirm, type ConfirmOptions } from '../context'
import { Avatar, BalanceTag, EmptyState, InfoButton, Money, MonthSwitcher, TopBar } from '../common'
import { navigate } from '../hooks'
import { DetailsBody, type DetailsKind } from './LedgerDetails'
import { MonthStatusRow } from './MonthClosing'
import { BazarMethodNotice } from './BazarMethod'
import { Icon } from '../icons'

/** History filter; a category filter is `cat:<category id>`. */
type Filter = 'all' | 'in' | 'out' | `cat:${CategoryId}`

export function Ledger({ ledger }: { ledger: LedgerId }) {
  const { txs, closings, month, setMonth, members, categories, bazarMethod } = useApp()
  const method = ledger === 'bazar' ? bazarMethod : null
  const s = useMemo(() => computeLedgerMonth(ledger, members, txs ?? [], month, closings, method), [ledger, members, txs, month, closings, method])
  const monthTxs = useMemo(
    () =>
      (txs ?? [])
        .filter((t) => t.ledger === ledger && t.month === month && t.deletedAt === undefined)
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt),
    [txs, ledger, month],
  )
  const [filter, setFilter] = useState<Filter>('all')
  const confirm = useConfirm()
  const alerts = dashboardAlerts(s)
  const short = s.remainingCash < 0
  const showDetails = (kind: DetailsKind) => void confirm(detailsSheet(s, kind))
  // Member-paid Bazar: members pay for shared Bazar themselves; there is no shared cash to show.
  const memberPaid = s.method === 'memberPaid'

  return (
    <div className={`screen screen-${ledger}`}>
      <TopBar
        title={ledgerName(ledger)}
        ledger={ledger}
        actions={
          <button type="button" className="btn btn-tonal btn-sm" onClick={() => navigate(`${ledger}/report`)}>
            <Icon name="report" size={18} /> Report
          </button>
        }
      />
      <MonthSwitcher month={month} onChange={setMonth} />

      {ledger === 'bazar' && <BazarMethodNotice month={month} />}

      {memberPaid ? (
        <section className="hero hero-bazar" aria-label="Bazar total">
          <div className="hero-head">
            <p className="hero-label">Total Bazar</p>
            <button type="button" className="link-btn" onClick={() => showDetails('cash')}>
              View details
            </button>
          </div>
          <p className="hero-amount">
            <Money value={s.totalSpent} />
          </p>
          <p className="hero-sub">
            {s.sharers.length ? (
              <>
                Average per person <Money value={s.averagePerPerson} /> · {s.sharers.length} sharing
              </>
            ) : (
              'Nobody shares this month'
            )}
          </p>
          {alerts.length === 0 && s.reconciliation.balanced && (
            <p className="hero-ok">
              <Icon name="check" size={16} /> Balances add up
            </p>
          )}
        </section>
      ) : (
      <section className={`hero hero-${ledger} ${short ? 'hero-short' : ''}`} aria-label="Cash">
        <div className="hero-head">
          <p className="hero-label">{short ? 'Cash short' : 'Cash in hand'}</p>
          <button type="button" className="link-btn" onClick={() => showDetails('cash')}>
            View details
          </button>
        </div>
        <p className={`hero-amount ${short ? 'neg' : ''}`}>
          <Money value={Math.abs(s.remainingCash)} />
          {short && <span className="visually-hidden"> short (cash is {formatTaka(s.remainingCash)})</span>}
        </p>
        <p className="hero-sub">
          {short ? 'Spent more than collected · ' : ''}Opening <Money value={s.openingCash} />
        </p>
        {alerts.length === 0 && s.reconciliation.balanced && (
          <p className="hero-ok">
            <Icon name="check" size={16} /> Accounts match
          </p>
        )}
      </section>
      )}

      {alerts.filter((a) => a.kind !== 'cash-short').length > 0 && (
        <ul className="alerts" aria-label="Needs attention">
          {alerts
            .filter((a) => a.kind !== 'cash-short')
            .map((a) => (
              <li key={a.kind}>
                <button type="button" className={`alert alert-${a.tone}`} onClick={() => showDetails(a.kind)}>
                  <Icon name={a.tone === 'info' ? 'info' : 'alert'} size={20} />
                  <span className="alert-text">
                    <span className="alert-title">{a.title}</span>
                    <span className="alert-detail">{a.detail}</span>
                    <span className="alert-more">View details</span>
                  </span>
                </button>
              </li>
            ))}
        </ul>
      )}

      <MonthStatusRow ledger={ledger} s={s} />

      {!memberPaid && (
        <div className="stat-grid">
          <Stat label="Total collected" value={s.totalCollected} icon="arrowIn" />
          <Stat label="Total spent" value={s.totalSpent} icon="arrowOut" />
          <Stat label={`Share per sharing member (${s.sharers.length})`} value={s.averagePerPerson} icon="info" wide />
        </div>
      )}

      <Members s={s} />

      {s.categoryTotals && <Categories totals={s.categoryTotals} categories={categories} total={s.totalSpent} filter={filter} setFilter={setFilter} />}

      <History key={`${ledger}-${month}`} ledger={ledger} month={month} txs={monthTxs} filter={filter} setFilter={setFilter} memberPaid={memberPaid} />

      {memberPaid ? (
        <div className="action-bar">
          <button type="button" className="btn btn-ghost btn-lg" onClick={() => navigate('bazar/new/settlement')}>
            Settlement
          </button>
          <button type="button" className="btn btn-primary btn-lg" onClick={() => navigate('bazar/new/purchase')}>
            <Icon name="plus" /> Add Bazar amount
          </button>
        </div>
      ) : (
      <div className="action-bar">
        <button type="button" className="btn btn-tonal btn-lg" onClick={() => navigate(`${ledger}/new/contribution`)}>
          <Icon name="arrowIn" /> Contribution
        </button>
        <button type="button" className="btn btn-primary btn-lg" onClick={() => navigate(`${ledger}/new/expense`)}>
          <Icon name="arrowOut" /> Expense
        </button>
      </div>
      )}
    </div>
  )
}

function Stat({ label, value, icon, wide }: { label: string; value: number; icon: 'arrowIn' | 'arrowOut' | 'info'; wide?: boolean }) {
  return (
    <div className={`stat ${wide ? 'stat-wide' : ''}`}>
      <span className="stat-label">
        <Icon name={icon} size={16} /> {label}
      </span>
      <Money value={value} className="stat-value" />
    </div>
  )
}

function Members({ s }: { s: MonthSummary }) {
  return (
    <section className="card" aria-labelledby="members-h">
      <div className="card-head">
        <h2 id="members-h" className="card-title">
          Members
        </h2>
        <span className="card-hint">{s.sharers.length ? `${s.method === 'memberPaid' ? 'Average' : 'Share'} ${formatTaka(s.averagePerPerson)} each` : 'Nobody shares this month'}</span>
      </div>
      {s.members.length === 0 && (
        <EmptyState icon="info" title="No members this month">
          <button type="button" className="btn btn-tonal" onClick={() => navigate('settings/members')}>
            Manage members
          </button>
        </EmptyState>
      )}
      <ul className="member-list">
        {s.members.map((m) => (
          <li key={m.memberId}>
            <details className="member">
              <summary>
                <Avatar id={m.memberId} status={balanceStatus(m.closing)} />
                <span className="member-main">
                  <span className="member-name">{memberName(m.memberId)}</span>
                  <span className="member-sub">
                    Paid <Money value={s.method === 'memberPaid' ? m.contributed : m.netContribution} />
                    {s.method === 'memberPaid' && s.sharers.includes(m.memberId) && (
                      <>
                        {' '}
                        · share <Money value={m.share} />
                      </>
                    )}
                    {!s.sharers.includes(m.memberId) && <> · left, not sharing</>}
                  </span>
                </span>
                <BalanceTag value={m.closing} />
              </summary>
              <dl className="member-detail">
                <div>
                  <dt>Opening balance</dt>
                  <dd>
                    <Money value={m.opening} />
                  </dd>
                </div>
                <div>
                  <dt>{s.method === 'memberPaid' ? '+ Paid for Bazar' : '+ Contributed'}</dt>
                  <dd>
                    <Money value={m.contributed} />
                  </dd>
                </div>
                {m.settled !== 0 && (
                  <div>
                    <dt>{m.settled > 0 ? '+ Settlement paid' : '− Settlement received'}</dt>
                    <dd>
                      <Money value={Math.abs(m.settled)} />
                    </dd>
                  </div>
                )}
                {m.returned > 0 && (
                  <div>
                    <dt>− Returned to {memberName(m.memberId)}</dt>
                    <dd>
                      <Money value={m.returned} />
                    </dd>
                  </div>
                )}
                <div>
                  <dt>{s.method === 'memberPaid' ? '− Bazar share' : '− Expense share'}</dt>
                  <dd>
                    <Money value={m.share} />
                  </dd>
                </div>
                <div className="total">
                  <dt>Closing balance</dt>
                  <dd>
                    <Money value={m.closing} />
                  </dd>
                </div>
              </dl>
            </details>
          </li>
        ))}
      </ul>
      <InfoButton topic="balances" text="How balances work" />
    </section>
  )
}

function Categories({
  totals,
  categories,
  total,
  filter,
  setFilter,
}: {
  totals: Record<CategoryId, number>
  categories: Category[]
  total: number
  filter: Filter
  setFilter: (f: Filter) => void
}) {
  // Active categories, plus archived (or unknown) ones that have entries this month.
  const known = new Set(categories.map((c) => c.id))
  const rows = [
    ...categories.filter((c) => c.archivedAt === undefined || c.id in totals).map((c) => ({ id: c.id, name: c.name })),
    ...Object.keys(totals)
      .filter((id) => !known.has(id))
      .map((id) => ({ id, name: categoryName(id) })),
  ]
  const max = Math.max(1, ...Object.values(totals))
  if (rows.length === 0) {
    return (
      <section className="card" aria-labelledby="cat-h">
        <div className="card-head">
          <h2 id="cat-h" className="card-title">
            By category
          </h2>
        </div>
        <EmptyState icon="info" title="No Utilities categories yet">
          <button type="button" className="btn btn-tonal" onClick={() => navigate('settings/categories')}>
            Add categories
          </button>
        </EmptyState>
      </section>
    )
  }
  return (
    <section className="card" aria-labelledby="cat-h">
      <div className="card-head">
        <h2 id="cat-h" className="card-title">
          By category
        </h2>
        <span className="card-hint">
          Total <Money value={total} />
        </span>
      </div>
      <ul className="cat-list">
        {rows.map((c) => {
          const v = totals[c.id] ?? 0
          const key: Filter = `cat:${c.id}`
          const active = filter === key
          return (
            <li key={c.id}>
              <button
                type="button"
                className={`cat ${active ? 'active' : ''}`}
                aria-pressed={active}
                onClick={() => setFilter(active ? 'all' : key)}
              >
                <span className="cat-row">
                  <span className="cat-name">{c.name}</span>
                  <Money value={v} className="cat-amount" />
                </span>
                <span className="bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(0, (v / max) * 100)}%` }} />
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function History({
  ledger,
  month,
  txs,
  filter,
  setFilter,
  memberPaid,
}: {
  ledger: LedgerId
  month: string
  txs: Transaction[]
  filter: Filter
  setFilter: (f: Filter) => void
  memberPaid: boolean
}) {
  const shown = txs.filter((t) => {
    if (filter === 'all') return true
    // Member-paid months: "in" = Bazar amounts, "out" = settlements.
    if (memberPaid) return filter === 'in' ? t.type === 'purchase' : filter === 'out' ? t.type === 'settlement' : false
    if (filter === 'in') return t.type === 'contribution' || t.type === 'memberRefund'
    if (filter === 'out') return t.type === 'expense' || t.type === 'expenseRefund'
    return `cat:${t.category}` === filter
  })
  // Long months render the latest entries first; the rest on request (keeps month switching fast).
  const [all, setAll] = useState(false)
  const visible = all ? shown : shown.slice(0, HISTORY_PAGE)
  const groups: [string, Transaction[]][] = []
  for (const t of visible) {
    const last = groups[groups.length - 1]
    if (last && last[0] === t.date) last[1].push(t)
    else groups.push([t.date, [t]])
  }
  const chips: [Filter, string][] = memberPaid
    ? [
        ['all', 'All'],
        ['in', 'Bazar amounts'],
        ['out', 'Settlements'],
      ]
    : [
        ['all', 'All'],
        ['in', 'Contributions'],
        ['out', 'Expenses'],
      ]
  if (filter.startsWith('cat:')) chips.push([filter, categoryName(filter.slice(4))])

  return (
    <section className="card" aria-labelledby="hist-h">
      <div className="card-head">
        <h2 id="hist-h" className="card-title">
          History
        </h2>
      </div>
      <div className="chips" role="group" aria-label="Filter history">
        {chips.map(([f, label]) => (
          <button key={f} type="button" className={`chip ${filter === f ? 'chip-on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {label}
          </button>
        ))}
      </div>
      {txs.length === 0 ? (
        <EmptyState icon="calendar" title={`No entries in ${monthLabel(month)}`}>
          {memberPaid ? 'Add what a member paid for Bazar below.' : 'Add a contribution or expense below.'}
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState icon="info" title="Nothing matches this filter" />
      ) : (
        groups.map(([date, list]) => (
          <div key={date} className="tx-group">
            <h3 className="tx-date">{dayLabel(date)}</h3>
            <ul className="tx-list">
              {list.map((t) => {
                if (isMemberPaidType(t.type)) return <PaidRow key={t.id} t={t} />
                const eff = txCashEffect(t)
                return (
                  <li key={t.id}>
                    <button type="button" className="tx" onClick={() => navigate(`${ledger}/edit/${t.id}`)} aria-label={`${txTitle(t)}, ${formatTaka(eff, { sign: true })}. Edit`}>
                      <span className={`tx-icon ${eff >= 0 ? 'tx-in' : 'tx-out'}`} aria-hidden="true">
                        <Icon name={eff >= 0 ? 'arrowIn' : 'arrowOut'} size={18} />
                      </span>
                      <span className="tx-main">
                        <span className="tx-title">{txTitle(t)}</span>
                        {t.description && <span className="tx-note">{t.description}</span>}
                      </span>
                      <Money value={eff} sign className={`tx-amount ${eff >= 0 ? 'pos' : ''}`} />
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ))
      )}
      {visible.length < shown.length && (
        <button type="button" className="btn btn-ghost" onClick={() => setAll(true)}>
          Show all {shown.length} entries
        </button>
      )}
    </section>
  )
}

const HISTORY_PAGE = 20

/** A member-paid entry: no cash moves, so the amount is shown unsigned. */
function PaidRow({ t }: { t: Transaction }) {
  const purchase = t.type === 'purchase'
  return (
    <li>
      <button type="button" className="tx" onClick={() => navigate(`bazar/edit/${t.id}`)} aria-label={`${txTitle(t)}, ${formatTaka(t.amount)}. Edit`}>
        <span className={`tx-icon ${purchase ? 'tx-out' : 'tx-in'}`} aria-hidden="true">
          <Icon name={purchase ? 'basket' : 'arrowIn'} size={18} />
        </span>
        <span className="tx-main">
          <span className="tx-title">{txTitle(t)}</span>
          {t.description && <span className="tx-note">{t.description}</span>}
        </span>
        <Money value={t.amount} className="tx-amount" />
      </button>
    </li>
  )
}

const DETAIL_TITLES: Record<DetailsKind, string> = {
  cash: 'Cash',
  'cash-short': 'Cash short',
  'legacy-cash': 'Cash left from the cash method',
  'correction-review': 'Cash needs review',
  'correction-info': 'Changed after closing',
  'unknown-difference': 'Cash does not match records',
}

function detailsSheet(s: MonthSummary, kind: DetailsKind): ConfirmOptions {
  const title = kind === 'cash' ? (s.method === 'memberPaid' ? 'Bazar' : s.remainingCash < 0 ? 'Cash short' : 'Cash') : DETAIL_TITLES[kind]
  return { title: `${title} — ${monthLabel(s.month)}`, body: <DetailsBody s={s} kind={kind} />, confirmLabel: 'Done', cancelLabel: null }
}
