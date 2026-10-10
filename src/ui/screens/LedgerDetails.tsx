/** Details sheets opened from the ledger dashboard ("View details"). Full explanations live here. */
import type { ReactNode } from 'react'
import { displayRoster } from '../../domain/household'
import { inRosterOrder, type MonthSummary } from '../../domain/ledger'
import { formatTaka } from '../../domain/money'
import { addMonths, monthLabel, shortMonthLabel } from '../../domain/month'
import { closingMethodLabel, memberName } from '../../domain/types'
import { reconciliationLines, type DashboardAlert } from '../../report/reportModel'

const when = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

function Rows({ rows }: { rows: [string, ReactNode, boolean?][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v, strong]) => (
        <div key={k} className={strong ? 'total' : ''}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function openingSourceText(s: MonthSummary): string {
  const o = s.opening
  const prev = monthLabel(addMonths(s.month, -1))
  if (o.source === 'start') return 'First month of this ledger: started at ৳0.'
  if (o.source === 'carry') return `Carried from ${prev}. ${prev} is not closed yet, so this is provisional.`
  return `Set by the ${prev} closing on ${when(o.closing!.createdAt)}: ${closingMethodLabel(o.closing!)}.`
}

function AccountsCheck({ s }: { s: MonthSummary }) {
  const r = s.reconciliation
  return (
    <>
      <h3 className="sheet-h">Accounts check</h3>
      <Rows
        rows={[
          ['Member balances total', formatTaka(r.closingBalanceSum)],
          ['Cash', formatTaka(r.remainingCash)],
          ['Difference', formatTaka(r.difference)],
          ['From closing adjustments', formatTaka(r.explainedDifference)],
          ...(r.correctionDifference !== 0 ? ([['Needs review (correction)', formatTaka(r.correctionDifference), true]] as [string, ReactNode, boolean][]) : []),
          ...(r.unknownDifference !== 0 ? ([['Unknown', formatTaka(r.unknownDifference), true]] as [string, ReactNode, boolean][]) : []),
        ]}
      />
      {reconciliationLines(r).map((l) => (
        <p key={l.text} className={`sheet-status sheet-status-${l.tone}`}>
          {l.text}
        </p>
      ))}
    </>
  )
}

function CashDetails({ s }: { s: MonthSummary }) {
  const due = s.members.filter((m) => m.closing < 0)
  return (
    <>
      <Rows
        rows={[
          ['Opening cash', formatTaka(s.openingCash)],
          ['+ Collected', formatTaka(s.totalCollected)],
          ['− Spent', formatTaka(s.totalSpent)],
          [s.remainingCash < 0 ? '= Cash short' : '= Cash in hand', formatTaka(s.remainingCash), true],
        ]}
      />
      {s.remainingCash < 0 && <p>More was spent than collected. Members marked Due owe the mess; collecting from them covers the shortage.</p>}
      <h3 className="sheet-h">Member dues</h3>
      {due.length === 0 ? (
        <p>No member is due.</p>
      ) : (
        <Rows rows={due.map((m) => [memberName(m.memberId), formatTaka(-m.closing)] as [string, ReactNode])} />
      )}
      <h3 className="sheet-h">Opening</h3>
      <p>{openingSourceText(s)}</p>
      <AccountsCheck s={s} />
    </>
  )
}

function CorrectionDetails({ s }: { s: MonthSummary }) {
  const o = s.opening
  const c = o.closing
  if (!c) {
    // The review difference comes from an earlier month's correction carried forward.
    return (
      <>
        <p>An earlier closed month was corrected after its opening cash was counted. The difference is carried forward until it is resolved.</p>
        <AccountsCheck s={s} />
      </>
    )
  }
  const src = monthLabel(c.sourceMonth)
  const short = shortMonthLabel(c.sourceMonth)
  const counted = c.method !== 'carry' && c.cashMode === 'set'
  const snap = c.snapshot
  const decision = c.method === 'carry' ? 'carry-forward' : c.method === 'manual' ? 'verified opening' : c.settlementKind === 'waived' ? 'waiver' : 'settlement'
  return (
    <>
      <p>
        {src} was closed on {when(c.createdAt)} ({closingMethodLabel(c)}). An entry in {src} was added, changed or deleted after that. The {decision} recorded at closing
        has not been changed.
      </p>
      <table className="impact-table">
        <thead>
          <tr>
            <th scope="col"></th>
            <th scope="col">{short} at closing</th>
            <th scope="col">{short} now</th>
            <th scope="col">{shortMonthLabel(s.month)} opening</th>
          </tr>
        </thead>
        <tbody>
          {inRosterOrder(displayRoster(), [...Object.keys(snap.closingBalances), ...Object.keys(o.memberCorrections), ...s.members.map((x) => x.memberId)]).map((id) => (
            <tr key={id} className={(o.memberCorrections[id] ?? 0) !== 0 ? 'changed' : ''}>
              <th scope="row">{memberName(id)}</th>
              <td className="num">{formatTaka(snap.closingBalances[id] ?? 0)}</td>
              <td className="num">{formatTaka((snap.closingBalances[id] ?? 0) + (o.memberCorrections[id] ?? 0))}</td>
              <td className="num">{formatTaka(s.members.find((x) => x.memberId === id)?.opening ?? 0)}</td>
            </tr>
          ))}
          <tr className={o.cashCorrection !== 0 ? 'changed' : ''}>
            <th scope="row">Cash</th>
            <td className="num">{formatTaka(snap.closingCash)}</td>
            <td className="num">{formatTaka(snap.closingCash + o.cashCorrection)}</td>
            <td className="num">{formatTaka(s.openingCash)}</td>
          </tr>
        </tbody>
      </table>
      {counted && o.unappliedCashCorrection !== 0 && (
        <p>
          The cash counted at closing ({formatTaka(o.decidedCash)}) is kept, but {src} cash is now {formatTaka(snap.closingCash + o.cashCorrection)}. The{' '}
          {formatTaka(Math.abs(o.unappliedCashCorrection))} difference is not adjusted automatically.
        </p>
      )}
      <AccountsCheck s={s} />
      {o.unappliedCashCorrection !== 0 && (
        <>
          <h3 className="sheet-h">What to do</h3>
          <ol className="steps">
            <li>Check the {src} entry that was changed after closing.</li>
            <li>If it was a mistake, correct or delete it.</li>
            <li>
              If it is correct, undo the {src} closing and close it again with a new cash count.
            </li>
          </ol>
        </>
      )}
    </>
  )
}

function UnknownDetails({ s }: { s: MonthSummary }) {
  return (
    <>
      <p>Member balances and cash differ by an amount that no recorded closing adjustment or correction explains.</p>
      <AccountsCheck s={s} />
      <h3 className="sheet-h">What to do</h3>
      <ol className="steps">
        <li>Check any recent backup restore for this ledger.</li>
        <li>Compare this month’s entries with your own records.</li>
      </ol>
    </>
  )
}

export type DetailsKind = DashboardAlert['kind'] | 'cash'

/** Body of the details sheet for the hero card or an alert. */
export function DetailsBody({ s, kind }: { s: MonthSummary; kind: DetailsKind }) {
  if (kind === 'correction-review' || kind === 'correction-info') return <CorrectionDetails s={s} />
  if (kind === 'unknown-difference') return <UnknownDetails s={s} />
  return <CashDetails s={s} />
}
