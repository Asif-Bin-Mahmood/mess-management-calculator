/**
 * Household screens: first-launch setup, members, and Utilities categories.
 * Membership is household-wide (both ledgers) and counted in whole calendar months.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  addCategory,
  applyMemberChange,
  archiveCategory,
  categoryUsage,
  deleteCategory,
  deleteMember,
  HouseholdError,
  planMemberChange,
  renameCategory,
  renameMember,
  restoreCategory,
  rosterPlanProblem,
  setupHousehold,
  type MemberChange,
  type RosterPlan,
} from '../../db/household'
import { CATEGORY_TEMPLATES, isCurrentMember, MAX_MEMBERS, MAX_NAME, memberName, validateNames, type Category, type Member } from '../../domain/household'
import { firstOpenMonth, memberBalances, memberRemovable } from '../../domain/ledger'
import { formatTaka } from '../../domain/money'
import { addMonths, currentMonth, isValidMonth, MAX_MONTH, MIN_MONTH, monthLabel } from '../../domain/month'
import { ledgerName, type LedgerId } from '../../domain/types'
import { useLeaveGuard } from '../backNav'
import { Avatar, EmptyState, InfoButton, TopBar } from '../common'
import { useApp, useConfirm, useToast } from '../context'
import { navigate } from '../hooks'
import { Icon } from '../icons'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/* ───────────── First-launch setup ───────────── */

type Step = 'count' | 'names' | 'categories' | 'review'

export function Setup() {
  const toast = useToast()
  const [step, setStep] = useState<Step>('count')
  const [count, setCount] = useState(4)
  const [names, setNames] = useState<string[]>(() => Array.from({ length: 4 }, () => ''))
  const [nameErrors, setNameErrors] = useState<(string | null)[]>([])
  const [cats, setCats] = useState<{ name: string; on: boolean }[]>(() => CATEGORY_TEMPLATES.map((c) => ({ name: c.name, on: true })))
  const [newCat, setNewCat] = useState('')
  const [catError, setCatError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const started = step !== 'count' || names.some((n) => n.trim())
  useLeaveGuard(started && !busy, 'the household setup')

  const resize = (n: number) => {
    const c = Math.max(1, Math.min(MAX_MEMBERS, n))
    setCount(c)
    setNames((xs) => Array.from({ length: c }, (_, i) => xs[i] ?? ''))
    setNameErrors([])
  }
  const checkNames = () => {
    const v = validateNames(names)
    setNameErrors(v.errors)
    if (v.errors.some((e) => e)) return false
    setNames(v.names)
    return true
  }
  const addCat = () => {
    const v = validateNames([newCat], cats.map((c) => c.name))
    if (v.errors[0]) return setCatError(v.errors[0])
    setCats((c) => [...c, { name: v.names[0], on: true }])
    setNewCat('')
    setCatError(null)
  }
  const chosenCats = cats.filter((c) => c.on).map((c) => c.name)

  async function save() {
    setBusy(true)
    try {
      await setupHousehold(names, chosenCats)
      toast({ message: 'Household saved' })
      navigate('', { replace: true })
    } catch (e) {
      toast({ message: message(e), tone: 'error' })
      setBusy(false)
    }
  }

  const stepNo = { count: 1, names: 2, categories: 3, review: 4 }[step]
  return (
    <div className="screen screen-form">
      <TopBar title="Set up your household" />
      <p className="eyebrow setup-step">Step {stepNo} of 4</p>

      {step === 'count' && (
        <section className="card">
          <h2 className="card-title">How many members share the expenses?</h2>
          <p className="card-text">Expenses are split equally. You can change members later.</p>
          <div className="stepper" role="group" aria-label="Number of members">
            <button type="button" className="icon-btn" onClick={() => resize(count - 1)} disabled={count <= 1} aria-label="One fewer member">
              <Icon name="minus" />
            </button>
            <input
              className="input stepper-value"
              inputMode="numeric"
              value={count}
              aria-label="Number of members"
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, ''))
                if (n) resize(n)
              }}
            />
            <button type="button" className="icon-btn" onClick={() => resize(count + 1)} disabled={count >= MAX_MEMBERS} aria-label="One more member">
              <Icon name="plus" />
            </button>
          </div>
          <div className="card-actions">
            <button type="button" className="btn btn-ghost" onClick={() => navigate('settings')}>
              <Icon name="upload" size={18} /> Restore a backup
            </button>
            <button type="button" className="btn btn-primary btn-lg" onClick={() => setStep('names')}>
              Continue
            </button>
          </div>
        </section>
      )}

      {step === 'names' && (
        <section className="card">
          <h2 className="card-title">Member names</h2>
          <p className="card-text">Each name must be different.</p>
          <div className="member-names">
            {names.map((n, i) => (
              <label key={i} className="field">
                <span className="field-label">Member {i + 1}</span>
                <input
                  className="input"
                  value={n}
                  maxLength={MAX_NAME}
                  autoComplete="off"
                  onChange={(e) => setNames((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))}
                  aria-invalid={!!nameErrors[i]}
                  aria-describedby={nameErrors[i] ? `setup-err-${i}` : undefined}
                />
                {nameErrors[i] && (
                  <span className="field-error" id={`setup-err-${i}`}>
                    {nameErrors[i]}
                  </span>
                )}
              </label>
            ))}
          </div>
          <div className="card-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setStep('count')}>
              Back
            </button>
            <button type="button" className="btn btn-primary btn-lg" onClick={() => checkNames() && setStep('categories')}>
              Continue
            </button>
          </div>
        </section>
      )}

      {step === 'categories' && (
        <section className="card">
          <h2 className="card-title">Utilities categories</h2>
          <p className="card-text">Optional. Used to group Utilities expenses; you can change them later.</p>
          <ul className="check-list">
            {cats.map((c, i) => (
              <li key={c.name}>
                <label className="check-row">
                  <input type="checkbox" checked={c.on} onChange={(e) => setCats((xs) => xs.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                  <span>{c.name}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="inline-add">
            <input
              className="input"
              value={newCat}
              maxLength={MAX_NAME}
              placeholder="Another category"
              onChange={(e) => setNewCat(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addCat()
                }
              }}
              aria-label="New category name"
              aria-invalid={!!catError}
            />
            <button type="button" className="btn btn-tonal" onClick={addCat} disabled={!newCat.trim()}>
              <Icon name="plus" size={18} /> Add
            </button>
          </div>
          {catError && <p className="field-error">{catError}</p>}
          <div className="card-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setStep('names')}>
              Back
            </button>
            <button type="button" className="btn btn-primary btn-lg" onClick={() => setStep('review')}>
              Continue
            </button>
          </div>
        </section>
      )}

      {step === 'review' && (
        <section className="card">
          <h2 className="card-title">Review</h2>
          <dl className="kv">
            <div>
              <dt>Members ({names.length})</dt>
              <dd>{names.join(', ')}</dd>
            </div>
            <div>
              <dt>Utilities categories</dt>
              <dd>{chosenCats.length ? chosenCats.join(', ') : 'None yet'}</dd>
            </div>
          </dl>
          <p className="card-text">Everyone shares from the start, in both ledgers.</p>
          <div className="card-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setStep('categories')} disabled={busy}>
              Back
            </button>
            <button type="button" className="btn btn-primary btn-lg" onClick={save} disabled={busy}>
              <Icon name="check" size={18} /> Save household
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

/* ───────────── Members ───────────── */

type Panel = { kind: 'add' } | { kind: 'rename'; m: Member } | { kind: 'end'; m: Member } | { kind: 'rejoin'; m: Member } | null

function periodText(m: Member): string {
  return m.periods
    .map((p) => {
      const from = p.from ? monthLabel(p.from) : 'the start'
      return p.until ? `${from} – ${monthLabel(p.until)}` : `since ${from}`
    })
    .join(', ')
}

/** One line for a current member: sharing now (and until when), or the month they start. */
function currentStatus(m: Member, now: string): string {
  const p = m.periods.find((x) => (x.from === undefined || x.from <= now) && (x.until === undefined || now <= x.until))
  if (p) return p.until ? `Sharing until ${monthLabel(p.until)}` : `Sharing since ${p.from ? monthLabel(p.from) : 'the start'}`
  const next = m.periods.find((x) => x.from !== undefined && x.from > now)
  return next?.from ? `Starts ${monthLabel(next.from)}` : periodText(m)
}

export function MembersScreen() {
  const { members, txs, closings } = useApp()
  const confirm = useConfirm()
  const toast = useToast()
  const [panel, setPanel] = useState<Panel>(null)
  const [now] = useState(currentMonth)
  const open = firstOpenMonth(closings)
  const current = members.filter((m) => isCurrentMember(m, now))
  const former = members.filter((m) => !isCurrentMember(m, now))
  const balances = useMemo(() => memberBalances(members, txs ?? [], closings, now), [members, txs, closings, now])

  const outstanding = (m: Member) =>
    (['utilities', 'bazar'] as LedgerId[])
      .map((l) => [l, balances[l][m.id] ?? 0] as const)
      .filter(([, v]) => v !== 0)

  async function review(change: MemberChange, title: string, confirmLabel: string, intro: ReactNode) {
    let plan: RosterPlan
    try {
      plan = await planMemberChange(change)
      const problem = rosterPlanProblem(plan)
      if (problem) {
        toast({ message: problem, tone: 'error' })
        return
      }
    } catch (e) {
      toast({ message: message(e), tone: 'error' })
      return
    }
    const ok = await confirm({ title, body: <ImpactPreview plan={plan} intro={intro} />, confirmLabel })
    if (!ok) return
    try {
      await applyMemberChange(change)
      setPanel(null)
      toast({ message: 'Members updated' })
    } catch (e) {
      toast({ message: message(e), tone: 'error' })
    }
  }

  async function remove(m: Member) {
    const ok = await confirm({
      title: `Remove ${m.name}?`,
      body: <p>{m.name} has no entries or closings, so the member is removed completely. This cannot be undone, but you can add the member again.</p>,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    try {
      await deleteMember(m.id)
      toast({ message: `${m.name} removed` })
    } catch (e) {
      toast({ message: message(e), tone: 'error' })
    }
  }

  return (
    <div className="screen">
      <TopBar title="Members" back="settings" />
      <section className="card" aria-labelledby="cur-h">
        <div className="card-head">
          <span className="card-title-row">
            <h2 id="cur-h" className="card-title">
              Current members
            </h2>
            <InfoButton topic="members" />
          </span>
          <span className="card-hint">{current.length}</span>
        </div>
        {current.length === 0 && <EmptyState icon="users" title="No current members">Add a member to record new expenses.</EmptyState>}
        <ul className="row-list">
          {current.map((m) => (
            <li key={m.id} className="row-item">
              <Avatar id={m.id} />
              <span className="row-main">
                <span className="row-title">{m.name}</span>
                <span className="row-sub">{currentStatus(m, now)}</span>
              </span>
              <span className="row-actions">
                <button type="button" className="icon-btn" aria-label={`Rename ${m.name}`} onClick={() => setPanel({ kind: 'rename', m })}>
                  <Icon name="edit" size={18} />
                </button>
                {m.periods[m.periods.length - 1]?.until === undefined ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPanel({ kind: 'end', m })}>
                    Leaves
                  </button>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPanel({ kind: 'rejoin', m })}>
                    Rejoins
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
        <button type="button" className="btn btn-tonal" onClick={() => setPanel({ kind: 'add' })}>
          <Icon name="plus" size={18} /> Add member
        </button>
      </section>

      {panel && (
        <MemberPanel
          key={`${panel.kind}-${'m' in panel ? panel.m.id : ''}`}
          panel={panel}
          open={open}
          now={now}
          onCancel={() => setPanel(null)}
          onRename={async (m, name) => {
            try {
              await renameMember(m.id, name)
              setPanel(null)
              toast({ message: 'Name saved. Amounts and history are unchanged.' })
            } catch (e) {
              toast({ message: message(e), tone: 'error' })
            }
          }}
          onReview={(change) => {
            if (change.kind === 'add') {
              void review(change, `Add ${change.name}?`, 'Add member', <p>{change.name} shares expenses from {monthLabel(change.from)} in both ledgers.</p>)
            } else if (change.kind === 'end') {
              const m = members.find((x) => x.id === change.id)!
              const owe = outstanding(m)
              void review(
                change,
                `${m.name} leaves after ${monthLabel(change.lastMonth)}?`,
                'Confirm',
                <>
                  <p>
                    {m.name} shares expenses up to and including {monthLabel(change.lastMonth)}. From {monthLabel(addMonths(change.lastMonth, 1))} the others share them. Past
                    entries and reports keep {m.name}.
                  </p>
                  {owe.length > 0 && (
                    <p className="warn">
                      <Icon name="alert" size={18} />
                      <span>
                        {m.name} still has a balance: {owe.map(([l, v]) => `${ledgerName(l)} ${v < 0 ? `due ${formatTaka(-v)}` : `will receive ${formatTaka(v)}`}`).join(', ')}. It stays on{' '}
                        {m.name} (it is not moved to anyone else) until it is settled with a contribution, a return, or a month closing.
                      </span>
                    </p>
                  )}
                </>,
              )
            } else {
              const m = members.find((x) => x.id === change.id)!
              void review(change, `${m.name} rejoins from ${monthLabel(change.from)}?`, 'Confirm', <p>{m.name} shares expenses again from {monthLabel(change.from)}.</p>)
            }
          }}
        />
      )}

      {former.length > 0 && (
        <section className="card" aria-labelledby="former-h">
          <div className="card-head">
            <h2 id="former-h" className="card-title">
              Former members
            </h2>
            <span className="card-hint">{former.length}</span>
          </div>
          <p className="card-text">Kept in history and reports.</p>
          <ul className="row-list">
            {former.map((m) => {
              const owe = outstanding(m)
              const deletable = memberRemovable(m.id, members, txs ?? [], closings, now)
              return (
                <li key={m.id} className="row-item">
                  <Avatar id={m.id} />
                  <span className="row-main">
                    <span className="row-title">{m.name}</span>
                    <span className="row-sub">Shared {periodText(m)}</span>
                    {owe.length > 0 && (
                      <span className="row-sub row-warn">
                        {owe.map(([l, v]) => `${ledgerName(l)}: ${v < 0 ? `due ${formatTaka(-v)}` : `will receive ${formatTaka(v)}`}`).join(' · ')}
                      </span>
                    )}
                  </span>
                  <span className="row-actions">
                    <button type="button" className="icon-btn" aria-label={`Rename ${m.name}`} onClick={() => setPanel({ kind: 'rename', m })}>
                      <Icon name="edit" size={18} />
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPanel({ kind: 'rejoin', m })}>
                      Rejoins
                    </button>
                    {deletable && (
                      <button type="button" className="icon-btn" aria-label={`Remove ${m.name}`} onClick={() => void remove(m)}>
                        <Icon name="trash" size={18} />
                      </button>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}

function MemberPanel({
  panel,
  open,
  now,
  onCancel,
  onRename,
  onReview,
}: {
  panel: NonNullable<Panel>
  open: string | null
  now: string
  onCancel: () => void
  onRename: (m: Member, name: string) => Promise<void>
  onReview: (c: MemberChange) => void
}) {
  const m = 'm' in panel ? panel.m : undefined
  const lastPeriod = m?.periods[m.periods.length - 1]
  // Sensible defaults within what is allowed (the first month open in both ledgers).
  const minMonth = open ?? undefined
  const atLeast = (x: string) => (open && x < open ? open : x)
  const defaultMonth =
    panel.kind === 'end'
      ? (() => {
          const d = now
          const floor = lastPeriod?.from && lastPeriod.from > d ? lastPeriod.from : d
          return open && floor < addMonths(open, -1) ? addMonths(open, -1) : floor
        })()
      : panel.kind === 'rejoin'
        ? atLeast(lastPeriod?.until && lastPeriod.until >= now ? addMonths(lastPeriod.until, 1) : now)
        : atLeast(now)
  const [name, setName] = useState(panel.kind === 'rename' ? panel.m.name : '')
  const [month, setMonth] = useState(defaultMonth)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [])
  useLeaveGuard(panel.kind === 'add' ? name.trim() !== '' : panel.kind === 'rename' ? name.trim() !== panel.m.name : false, 'this change')

  const title = { add: 'Add a member', rename: `Rename ${m?.name}`, end: `${m?.name} leaves`, rejoin: `${m?.name} rejoins` }[panel.kind]
  const monthLabelText = { add: 'Shares expenses from', end: 'Last month shared', rejoin: 'Shares again from', rename: '' }[panel.kind]

  function submit() {
    if (panel.kind === 'rename' || panel.kind === 'add') {
      const v = validateNames([name])
      if (v.errors[0]) return setError(v.errors[0])
    }
    if (panel.kind !== 'rename' && !isValidMonth(month)) return setError('Choose a month')
    setError(null)
    if (panel.kind === 'rename') return void onRename(panel.m, name)
    if (panel.kind === 'add') return onReview({ kind: 'add', name, from: month })
    if (panel.kind === 'end') return onReview({ kind: 'end', id: panel.m.id, lastMonth: month })
    onReview({ kind: 'rejoin', id: panel.m.id, from: month })
  }

  return (
    <section ref={ref} className="card card-panel" aria-labelledby="panel-h">
      <div className="card-head">
        <h2 id="panel-h" className="card-title">
          {title}
        </h2>
      </div>
      {(panel.kind === 'add' || panel.kind === 'rename') && (
        <label className="field">
          <span className="field-label">Name</span>
          <input className="input" value={name} maxLength={MAX_NAME} autoComplete="off" autoFocus onChange={(e) => setName(e.target.value)} aria-invalid={!!error} />
          {panel.kind === 'rename' && <span className="field-hint">Amounts and history stay the same.</span>}
        </label>
      )}
      {panel.kind !== 'rename' && (
        <label className="field">
          <span className="field-label">{monthLabelText}</span>
          <input
            type="month"
            className="input"
            value={month}
            min={panel.kind === 'end' ? (open ? addMonths(open, -1) : MIN_MONTH) : (minMonth ?? MIN_MONTH)}
            max={MAX_MONTH}
            onChange={(e) => setMonth(e.target.value)}
            aria-describedby={open ? 'panel-month-hint' : undefined}
          />
          {open && (
            <span className="field-hint" id="panel-month-hint">
              Months up to {monthLabel(addMonths(open, -1))} are closed and cannot change.
            </span>
          )}
        </label>
      )}
      {error && <p className="field-error">{error}</p>}
      <div className="card-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={submit}>
          {panel.kind === 'rename' ? 'Save name' : 'Review'}
        </button>
      </div>
    </section>
  )
}

/** Effect of a membership change on both ledgers, shown before confirming. */
function ImpactPreview({ plan, intro }: { plan: RosterPlan; intro: ReactNode }) {
  const changed = plan.impact.ledgers.filter((l) => l.changedMonths.length > 0)
  return (
    <>
      {intro}
      {changed.length === 0 ? (
        <p className="field-hint">No recorded amounts change: there are no entries in the affected months yet.</p>
      ) : (
        changed.map((l) => (
          <div key={l.ledger}>
            <p>
              <strong>{ledgerName(l.ledger)}</strong>: shares are recalculated for {l.changedMonths.length === 1 ? monthLabel(l.changedMonths[0]) : `${monthLabel(l.changedMonths[0])} – ${monthLabel(l.changedMonths[l.changedMonths.length - 1])}`}{' '}
              (open months only).
            </p>
            {l.members.length > 0 && (
              <table className="impact-table">
                <thead>
                  <tr>
                    <th scope="col"></th>
                    <th scope="col">Balance now</th>
                    <th scope="col">After</th>
                  </tr>
                </thead>
                <tbody>
                  {l.members.map((c) => (
                    <tr key={c.memberId} className="changed">
                      <th scope="row">{plan.after.find((m) => m.id === c.memberId)?.name ?? memberName(c.memberId)}</th>
                      <td className="num">{formatTaka(c.before)}</td>
                      <td className="num">{formatTaka(c.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))
      )}
      <p className="field-hint">Closed months are never recalculated.</p>
    </>
  )
}

/* ───────────── Utilities categories ───────────── */

export function CategoriesScreen() {
  const { categories, txs } = useApp()
  const confirm = useConfirm()
  const toast = useToast()
  const [newName, setNewName] = useState('')
  const [editing, setEditing] = useState<{ c: Category; name: string } | null>(null)
  const active = categories.filter((c) => c.archivedAt === undefined)
  const archived = categories.filter((c) => c.archivedAt !== undefined)
  const used = useMemo(() => {
    const n = new Map<string, number>()
    for (const t of txs ?? []) if (t.category && t.deletedAt === undefined) n.set(t.category, (n.get(t.category) ?? 0) + 1)
    return n
  }, [txs])
  const referenced = useMemo(() => new Set((txs ?? []).map((t) => t.category).filter(Boolean)), [txs])
  useLeaveGuard(newName.trim() !== '' || (editing !== null && editing.name.trim() !== editing.c.name), 'this change')

  const run = async (f: () => Promise<unknown>, done: string) => {
    try {
      await f()
      toast({ message: done })
      return true
    } catch (e) {
      toast({ message: e instanceof HouseholdError ? e.message : message(e), tone: 'error' })
      return false
    }
  }

  async function archive(c: Category) {
    const n = (await categoryUsage(c.id)).entries
    const ok = await confirm({
      title: `Archive ${c.name}?`,
      body: (
        <p>
          {c.name} can no longer be chosen for new entries. {n ? `The ${n} existing ${n === 1 ? 'entry keeps' : 'entries keep'} this category in history and reports.` : ''} You can restore it
          later.
        </p>
      ),
      confirmLabel: 'Archive',
    })
    if (ok) await run(() => archiveCategory(c.id), `${c.name} archived`)
  }

  async function remove(c: Category) {
    const ok = await confirm({ title: `Delete ${c.name}?`, body: <p>No entry has ever used {c.name}, so it is deleted completely.</p>, confirmLabel: 'Delete', danger: true })
    if (ok) await run(() => deleteCategory(c.id), `${c.name} deleted`)
  }

  const row = (c: Category, isArchived: boolean) =>
    editing?.c.id === c.id ? (
      <li key={c.id} className="row-item">
        <input
          className="input"
          value={editing.name}
          maxLength={MAX_NAME}
          autoFocus
          aria-label={`New name for ${c.name}`}
          onChange={(e) => setEditing({ c, name: e.target.value })}
        />
        <span className="row-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={async () => {
              if (await run(() => renameCategory(c.id, editing.name), 'Category renamed everywhere, including past entries')) setEditing(null)
            }}
          >
            Save
          </button>
        </span>
      </li>
    ) : (
      <li key={c.id} className="row-item">
        <span className="row-main">
          <span className="row-title">{c.name}</span>
          <span className="row-sub">{used.get(c.id) ? `${used.get(c.id)} ${used.get(c.id) === 1 ? 'entry' : 'entries'}` : 'Not used yet'}</span>
        </span>
        <span className="row-actions">
          <button type="button" className="icon-btn" aria-label={`Rename ${c.name}`} onClick={() => setEditing({ c, name: c.name })}>
            <Icon name="edit" size={18} />
          </button>
          {isArchived ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void run(() => restoreCategory(c.id), `${c.name} restored`)}>
              Restore
            </button>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void archive(c)}>
              Archive
            </button>
          )}
          {!referenced.has(c.id) && (
            <button type="button" className="icon-btn" aria-label={`Delete ${c.name}`} onClick={() => void remove(c)}>
              <Icon name="trash" size={18} />
            </button>
          )}
        </span>
      </li>
    )

  return (
    <div className="screen">
      <TopBar title="Utilities categories" back="settings" />
      <section className="card" aria-labelledby="cats-h">
        <div className="card-head">
          <span className="card-title-row">
            <h2 id="cats-h" className="card-title">
              In use
            </h2>
            <InfoButton topic="categories" />
          </span>
          <span className="card-hint">{active.length}</span>
        </div>
        {active.length === 0 && <EmptyState icon="tag" title="No categories yet">Add one to record Utilities expenses.</EmptyState>}
        <ul className="row-list">{active.map((c) => row(c, false))}</ul>
        <div className="inline-add">
          <input
            className="input"
            value={newName}
            maxLength={MAX_NAME}
            placeholder="New category"
            aria-label="New category name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && newName.trim()) {
                e.preventDefault()
                if (await run(() => addCategory(newName), 'Category added')) setNewName('')
              }
            }}
          />
          <button
            type="button"
            className="btn btn-tonal"
            disabled={!newName.trim()}
            onClick={async () => {
              if (await run(() => addCategory(newName), 'Category added')) setNewName('')
            }}
          >
            <Icon name="plus" size={18} /> Add
          </button>
        </div>
      </section>
      {archived.length > 0 && (
        <section className="card" aria-labelledby="arch-h">
          <div className="card-head">
            <h2 id="arch-h" className="card-title">
              Archived
            </h2>
            <span className="card-hint">{archived.length}</span>
          </div>
          <p className="card-text">Not offered for new entries.</p>
          <ul className="row-list">{archived.map((c) => row(c, true))}</ul>
        </section>
      )}
    </div>
  )
}
