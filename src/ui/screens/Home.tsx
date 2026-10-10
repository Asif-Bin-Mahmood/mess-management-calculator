import { useMemo, useState } from 'react'
import { lastBackupAtQuery } from '../queries'
import { computeLedgerMonth } from '../../domain/ledger'
import { monthLabel } from '../../domain/month'
import type { BazarMethod } from '../../domain/bazarMethod'
import { sharers, type Roster } from '../../domain/household'
import { LEDGERS, memberName, type LedgerId, type MonthClosing, type Transaction } from '../../domain/types'
import { balanceStatus, dashboardAlerts } from '../../report/reportModel'
import { useApp } from '../context'
import { Avatar, LedgerIcon, Money, MonthSwitcher } from '../common'
import { navigate, useLive } from '../hooks'
import { Icon } from '../icons'

const DAY = 86_400_000

export function Home() {
  const { txs, closings, month, setMonth, members, bazarMethod } = useApp()
  const lastBackupAt = useLive(lastBackupAtQuery)
  const [now] = useState(() => Date.now())
  const liveCount = txs?.filter((t) => t.deletedAt === undefined).length ?? 0
  const backupStale = liveCount > 0 && lastBackupAt !== undefined && now - lastBackupAt > 14 * DAY

  return (
    <div className="screen">
      <header className="home-head">
        <div>
          <p className="eyebrow">Mess Ledger</p>
          <h1 className="home-title">{householdTitle(members, month)}</h1>
        </div>
      </header>
      <MonthSwitcher month={month} onChange={setMonth} />

      <div className="stack">
        {LEDGERS.map((l) => (
          <LedgerCard key={l.id} ledger={l.id} roster={members} month={month} txs={txs ?? []} closings={closings} method={l.id === 'bazar' ? bazarMethod : null} />
        ))}
      </div>

      {backupStale && (
        <button type="button" className="notice" onClick={() => navigate('settings')}>
          <Icon name="shield" />
          <span>
            <strong>{lastBackupAt ? 'Backup is over two weeks old.' : 'No backup yet.'}</strong> Records live only on this phone — save a backup file.
          </span>
          <Icon name="right" size={18} />
        </button>
      )}
    </div>
  )
}

/** Members sharing the viewed month: their names for a small household, otherwise a count. */
function householdTitle(roster: Roster, month: string): string {
  const names = sharers(roster, month).map((m) => m.name)
  if (names.length === 0) return 'No members this month'
  return names.length <= 4 ? names.join(' · ') : `${names.length} members`
}

function LedgerCard({
  ledger,
  roster,
  month,
  txs,
  closings,
  method,
}: {
  ledger: LedgerId
  roster: Roster
  month: string
  txs: Transaction[]
  closings: MonthClosing[]
  method: BazarMethod | null
}) {
  const s = useMemo(() => computeLedgerMonth(ledger, roster, txs, month, closings, method), [ledger, roster, txs, month, closings, method])
  // Member-paid Bazar has no shared cash: the card shows the month's Bazar total and the equal share.
  const memberPaid = s.method === 'memberPaid'
  const name = ledger === 'utilities' ? 'Utilities' : 'Bazar'
  const due = s.members.filter((m) => m.closing < 0)
  const recv = s.members.filter((m) => m.closing > 0)
  const statusLine =
    due.length === 0 && recv.length === 0
      ? 'Everyone is settled'
      : [due.length ? `${due.map((m) => memberName(m.memberId)).join(', ')} due` : '', recv.length ? `${recv.length} will receive` : '']
          .filter(Boolean)
          .join(' · ')

  return (
    <section className={`ledger-card ledger-card-${ledger}`} aria-labelledby={`card-${ledger}`}>
      <button type="button" className="ledger-card-main" onClick={() => navigate(ledger)}>
        <div className="ledger-card-head">
          <LedgerIcon ledger={ledger} />
          <h2 id={`card-${ledger}`} className="ledger-card-name">
            {name}
          </h2>
          <Icon name="right" size={20} className="ledger-card-chevron" />
        </div>
        {s.transactionCount === 0 && <p className="ledger-card-empty">No entries in {monthLabel(month)}{s.openingCash || s.members.some((m) => m.opening) ? ' · figures carried in' : ''}</p>}
        {memberPaid ? (
          <>
            <p className="ledger-card-label">Total Bazar</p>
            <p className="ledger-card-amount">
              <Money value={s.totalSpent} />
            </p>
            <dl className="ledger-card-stats">
              <div>
                <dt>Per person</dt>
                <dd>
                  <Money value={s.averagePerPerson} />
                </dd>
              </div>
              <div>
                <dt>Sharing</dt>
                <dd>{s.sharers.length}</dd>
              </div>
            </dl>
          </>
        ) : (
          <>
        <p className={`ledger-card-label ${s.remainingCash < 0 ? 'neg' : ''}`}>{s.remainingCash < 0 ? 'Cash short' : 'Cash in hand'}</p>
        <p className={`ledger-card-amount ${s.remainingCash < 0 ? 'neg' : ''}`}>
          <Money value={Math.abs(s.remainingCash)} />
          {s.remainingCash < 0 && <span className="visually-hidden"> short</span>}
        </p>
        <dl className="ledger-card-stats">
          <div>
            <dt>Collected</dt>
            <dd>
              <Money value={s.totalCollected} />
            </dd>
          </div>
          <div>
            <dt>Spent</dt>
            <dd>
              <Money value={s.totalSpent} />
            </dd>
          </div>
          <div>
            <dt>Per person</dt>
            <dd>
              <Money value={s.averagePerPerson} />
            </dd>
          </div>
        </dl>
          </>
        )}
        {dashboardAlerts(s)
          .filter((a) => a.kind !== 'cash-short' && a.tone !== 'info')
          .map((a) => (
            <p key={a.kind} className={`ledger-card-issue ledger-card-issue-${a.tone}`}>
              <Icon name="alert" size={16} /> {a.title}
            </p>
          ))}
        <div className="ledger-card-members">
          <span className="avatars">
            {s.members.map((m) => (
              <Avatar key={m.memberId} id={m.memberId} status={balanceStatus(m.closing)} />
            ))}
          </span>
          <span className="ledger-card-status">{statusLine}</span>
        </div>
      </button>
      {memberPaid ? (
        <div className="ledger-card-actions">
          <button type="button" className="btn btn-tonal" onClick={() => navigate('bazar/new/purchase')}>
            <Icon name="plus" size={18} /> Add Bazar amount
          </button>
        </div>
      ) : (
      <div className="ledger-card-actions">
        <button type="button" className="btn btn-tonal" onClick={() => navigate(`${ledger}/new/contribution`)}>
          <Icon name="arrowIn" size={18} /> Contribution
        </button>
        <button type="button" className="btn btn-tonal" onClick={() => navigate(`${ledger}/new/expense`)}>
          <Icon name="arrowOut" size={18} /> Expense
        </button>
      </div>
      )}
    </section>
  )
}
