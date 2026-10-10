import { useEffect, useRef, useState } from 'react'
import {
  backupFileName,
  checkBackup,
  createBackup,
  eraseAll,
  getRestoreUndo,
  importStatus,
  planRestore,
  restoreBackup,
  undoLastRestore,
  type BackupScope,
  type BackupSummary,
  type ImportStatus,
  type RegistryPlan,
  type RestoreProgress,
} from '../../db/backup'
import { lastBackupAtQuery, restoreUndoQuery } from '../queries'
import { requestPersistentStorage, setMeta } from '../../db/repo'
import { formatTaka } from '../../domain/money'
import { dayLabel, monthLabel } from '../../domain/month'
import { isCurrentMember } from '../../domain/household'
import { currentMonth } from '../../domain/month'
import { ledgerName } from '../../domain/types'
import { canShareFiles, isNativeApp, saveFile, shareFile } from '../../report/export'
import { txTitle } from '../../report/reportModel'
import { useApp } from '../context'
import { useMutate } from '../useMutate'
import { InfoButton, TopBar } from '../common'
import { useConfirm, useToast } from '../context'
import { navigate, useLive } from '../hooks'
import { Icon } from '../icons'
import { useInstallPrompt } from '../pwa'
import { blockBack } from '../backNav'
import { useUpdates } from '../../update/context'

const scopeName = (sc: BackupScope) => (sc === 'all' ? 'Utilities and Bazar' : `${ledgerName(sc)} only`)

export function Settings() {
  const { txs } = useApp()
  const toast = useToast()
  const confirm = useConfirm()
  const mutate = useMutate()
  const updates = useUpdates()
  const fileInput = useRef<HTMLInputElement>(null)
  const lastBackupAt = useLive(lastBackupAtQuery)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [usage, setUsage] = useState<string | null>(null)
  const install = useInstallPrompt()
  const [scope, setScope] = useState<BackupScope>('all')
  const [restoring, setRestoring] = useState<RestoreProgress | { phase: 'checking'; done: number; total: number } | null>(null)
  const restoringRef = useRef(false)
  const restoringNow = restoring !== null
  useEffect(() => (restoringNow ? blockBack() : undefined), [restoringNow])
  const restoreUndo = useLive(restoreUndoQuery)

  useEffect(() => {
    navigator.storage?.persisted?.().then(setPersisted, () => setPersisted(null))
    navigator.storage?.estimate?.().then(
      (e) => e.usage !== undefined && setUsage(`${(e.usage / 1024 / 1024).toFixed(1)} MB used`),
      () => {},
    )
  }, [])

  const deleted = (txs ?? []).filter((t) => t.deletedAt !== undefined).sort((a, b) => b.deletedAt! - a.deletedAt!)
  const live = (txs ?? []).length - deleted.length


  async function makeBackupFile(): Promise<File> {
    const now = new Date()
    const data = await createBackup(undefined, now, scope)
    return new File([JSON.stringify(data, null, 1)], backupFileName(now, scope), { type: 'application/json' })
  }

  async function backup(share: boolean) {
    try {
      const file = await makeBackupFile()
      const viaShare = share && canShareFiles(file)
      let result: 'downloaded' | 'shared' | 'cancelled'
      if (viaShare) result = (await shareFile(file, 'Mess Ledger backup')) ? 'shared' : 'cancelled'
      else result = await saveFile(file, 'Save Mess Ledger backup')
      if (result === 'cancelled') return
      if (scope === 'all') await setMeta('lastBackupAt', Date.now())
      toast({
        message:
          result === 'shared'
            ? `Backup ${file.name} sent`
            : share
              ? `This phone cannot share backup files directly, so ${file.name} was saved to Downloads instead.`
              : `Saved ${file.name} to Downloads`,
      })
    } catch (e) {
      toast({ message: `Backup failed: ${String(e)}`, tone: 'error' })
    }
  }

  async function restoreFrom(file: File) {
    if (restoringRef.current) return // one restore at a time
    restoringRef.current = true
    setRestoring({ phase: 'checking', done: 0, total: 0 })
    try {
      await restoreFlow(file)
    } catch (e) {
      await confirm({
        title: 'Restore failed',
        body: (
          <p>
            Your existing data was not changed. {e instanceof Error ? e.message : String(e)}
          </p>
        ),
        confirmLabel: 'OK',
        cancelLabel: null,
      })
    } finally {
      restoringRef.current = false
      setRestoring(null)
    }
  }

  async function restoreFlow(file: File) {
    await nextFrame() // let the overlay paint before reading and validating the file
    const text = await file.text()
    const check = checkBackup(text)
    if (!check.ok) {
      await confirm({
        title: 'This backup cannot be restored',
        body: (
          <ul className="error-list">
            {check.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ),
        confirmLabel: 'OK',
        cancelLabel: null,
      })
      return
    }
    const s = check.summary
    const status = await importStatus(check.data)
    const reg = await planRestore(check.data)
    if (reg.problem) {
      await confirm({ title: 'This backup cannot be restored here', body: <p>{reg.problem}</p>, confirmLabel: 'OK', cancelLabel: null })
      return
    }
    if (status.identical) {
      await confirm({
        title: 'Nothing to restore',
        body: <p>The {scopeName(s.scope)} data on this phone already matches this backup exactly. Nothing was changed.</p>,
        confirmLabel: 'OK',
        cancelLabel: null,
      })
      return
    }
    const ok = await confirm({
      title: s.scope === 'all' ? 'Replace all data with this backup?' : `Replace ${ledgerName(s.scope)} data with this backup?`,
      body: <RestoreConfirmBody s={s} status={status} reg={reg} />,
      confirmLabel: status.alreadyImportedAt !== null ? 'Restore again anyway' : 'Replace data',
      danger: true,
    })
    if (!ok) return
    setRestoring({ phase: 'preparing', done: 0, total: s.transactions })
    await nextFrame()
    // One transaction: on any failure nothing is written and the error is shown by restoreFrom.
    await restoreBackup(check.data, undefined, Date.now(), (p) => setRestoring(p))
    toast({ message: `Restored ${s.transactions} entries (${scopeName(s.scope)})`, action: { label: 'Undo', run: () => void undoRestore() } })
  }

  async function undoRestore() {
    const u = await getRestoreUndo()
    if (!u) return
    const ok = await confirm({
      title: 'Undo the last restore?',
      body: (
        <p>
          Puts back the {scopeName(u.scope)} records that were on this phone before the restore on {new Date(u.at).toLocaleString('en-GB')}. Changes made in{' '}
          {scopeName(u.scope)} since then are replaced.
        </p>
      ),
      confirmLabel: 'Undo restore',
      danger: true,
    })
    if (!ok) return
    try {
      await undoLastRestore()
      toast({ message: 'Restore undone' })
    } catch (e) {
      toast({ message: e instanceof Error ? e.message : String(e), tone: 'error' })
    }
  }

  async function erase() {
    const ok = await confirm({
      title: 'Erase all data?',
      body: <p>Every Utilities and Bazar entry, deleted entry and audit record on this phone will be permanently removed. This cannot be undone.</p>,
      confirmLabel: 'Erase everything',
      danger: true,
      requireText: 'ERASE',
    })
    if (!ok) return
    await eraseAll()
    toast({ message: 'All data erased' })
  }

  return (
    <div className="screen">
      <TopBar title="Backup & settings" />
      {restoring && <RestoreOverlay p={restoring} />}

      <HouseholdCard />

      <section className="card" aria-labelledby="bk-h">
        <div className="card-head">
          <span className="card-title-row">
            <h2 id="bk-h" className="card-title">
              Backup
            </h2>
            <InfoButton topic="backup" />
          </span>
          <span className="card-hint">{lastBackupAt ? `Last: ${new Date(lastBackupAt).toLocaleDateString('en-GB')}` : 'Never backed up'}</span>
        </div>
        <p className="card-text">Records are only on this phone. Save a backup file and keep a copy elsewhere.</p>
        <div className="segmented segmented-sm" role="radiogroup" aria-label="What to back up">
          {(['all', 'utilities', 'bazar'] as BackupScope[]).map((sc) => (
            <button key={sc} type="button" role="radio" aria-checked={scope === sc} className={scope === sc ? 'on' : ''} onClick={() => setScope(sc)}>
              {sc === 'all' ? 'Both ledgers' : ledgerName(sc)}
            </button>
          ))}
        </div>
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={() => backup(false)}>
            <Icon name="download" size={18} /> Save backup
          </button>
          {canShareFiles() && !isNativeApp() && (
            <button type="button" className="btn btn-tonal" onClick={() => backup(true)}>
              <Icon name="share" size={18} /> Share
            </button>
          )}
        </div>
      </section>

      <section className="card" aria-labelledby="rs-h">
        <div className="card-head">
          <span className="card-title-row">
            <h2 id="rs-h" className="card-title">
              Restore
            </h2>
            <InfoButton topic="restore" />
          </span>
        </div>
        <p className="card-text">Choose a backup file. You see what it contains before anything changes.</p>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void restoreFrom(f)
          }}
        />
        <button type="button" className="btn btn-tonal" onClick={() => fileInput.current?.click()} disabled={!!restoring}>
          <Icon name="upload" size={18} /> Choose backup file
        </button>
        {restoreUndo && (
          <button type="button" className="btn btn-ghost" onClick={() => void undoRestore()}>
            <Icon name="restore" size={18} /> Undo last restore ({scopeName(restoreUndo.scope)}, {new Date(restoreUndo.at).toLocaleDateString('en-GB')})
          </button>
        )}
      </section>

      <section className="card" aria-labelledby="del-h">
        <div className="card-head">
          <h2 id="del-h" className="card-title">
            Recently deleted
          </h2>
          <span className="card-hint">{deleted.length}</span>
        </div>
        {deleted.length === 0 ? (
          <p className="card-text muted">Deleted entries appear here and can be restored.</p>
        ) : (
          <ul className="deleted-list">
            {deleted.slice(0, 50).map((t) => (
              <li key={t.id}>
                <span className="tx-main">
                  <span className="tx-title">{txTitle(t)}</span>
                  <span className="tx-note">
                    {ledgerName(t.ledger)} · {dayLabel(t.date)} {t.date.slice(0, 4)} · {formatTaka(t.amount)}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => mutate({ kind: 'restore', id: t.id }, { done: 'Entry restored' }).catch((e) => toast({ message: String(e), tone: 'error' }))}
                >
                  <Icon name="restore" size={16} /> Restore
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="dev-h">
        <div className="card-head">
          <h2 id="dev-h" className="card-title">
            This device
          </h2>
        </div>
        <dl className="kv">
          <div>
            <dt>Entries stored</dt>
            <dd>{live}</dd>
          </div>
          <div>
            <dt>Protected storage</dt>
            <dd>
              {persisted === true ? (
                'On'
              ) : (
                <button
                  type="button"
                  className="link-btn"
                  onClick={async () => {
                    const r = await requestPersistentStorage()
                    setPersisted(r)
                    toast({ message: r ? 'Storage protected from automatic clean-up' : 'The browser declined. Install the app and try again.' })
                  }}
                >
                  {persisted === null ? 'Unknown — request' : 'Off — request'}
                </button>
              )}
            </dd>
          </div>
          {usage && (
            <div>
              <dt>Storage</dt>
              <dd>{usage}</dd>
            </div>
          )}
          <div>
            <dt>Version</dt>
            <dd>{__APP_VERSION__}</dd>
          </div>
          {updates && (
            <div>
              <dt>Updates</dt>
              <dd>
                <button type="button" className="link-btn" disabled={updates.checking} onClick={updates.checkNow}>
                  {updates.checking ? 'Checking…' : 'Check for updates'}
                </button>
              </dd>
            </div>
          )}
        </dl>
        {install && (
          <button type="button" className="btn btn-primary" onClick={install}>
            <Icon name="download" size={18} /> Install app
          </button>
        )}
      </section>

      <section className="card card-danger" aria-labelledby="dz-h">
        <div className="card-head">
          <h2 id="dz-h" className="card-title">
            Erase data
          </h2>
        </div>
        <p className="card-text">Removes everything from this phone. Save a backup first.</p>
        <button type="button" className="btn btn-danger-ghost" onClick={erase}>
          <Icon name="trash" size={18} /> Erase all data
        </button>
      </section>
    </div>
  )
}

// A short timer (not requestAnimationFrame, which never fires while the screen is off or the app is in the
// background) lets the overlay paint before heavy work starts.
const nextFrame = () => new Promise<void>((r) => setTimeout(r, 32))

const PHASE_LABEL: Record<string, string> = {
  checking: 'Checking backup…',
  preparing: 'Preparing…',
  entries: 'Restoring entries',
  history: 'Restoring history',
  finishing: 'Finishing…',
}

/** Blocks the screen during a restore so nothing else can change the data meanwhile. */
function RestoreOverlay({ p }: { p: { phase: string; done: number; total: number } }) {
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : null
  return (
    <div className="busy-overlay" role="alertdialog" aria-modal="true" aria-labelledby="busy-title" aria-describedby="busy-detail">
      <div className="busy-card">
        <p id="busy-title" className="busy-title">
          {PHASE_LABEL[p.phase] ?? 'Working…'}
        </p>
        <div className="busy-bar" aria-hidden="true">
          <span style={{ width: pct === null ? '30%' : `${pct}%` }} className={pct === null ? 'indeterminate' : ''} />
        </div>
        <p id="busy-detail" className="busy-detail" aria-live="polite">
          {pct !== null ? `${p.done.toLocaleString('en-IN')} of ${p.total.toLocaleString('en-IN')}` : 'Keep the app open.'}
        </p>
      </div>
    </div>
  )
}

/** Entry point to the household screens: members and Utilities categories. */
function HouseholdCard() {
  const { members, categories } = useApp()
  const now = currentMonth()
  const current = members.filter((m) => isCurrentMember(m, now))
  const former = members.length - current.length
  const activeCats = categories.filter((c) => c.archivedAt === undefined)
  return (
    <section className="card" aria-labelledby="hh-h">
      <div className="card-head">
        <h2 id="hh-h" className="card-title">
          Household
        </h2>
      </div>
      <ul className="link-list">
        <li>
          <button type="button" className="link-row" onClick={() => navigate('settings/members')}>
            <span className="link-row-main">
              <span className="link-row-title">Members</span>
              <span className="link-row-sub">
                {current.length} current{former ? ` · ${former} former` : ''}
                {current.length ? ` · ${current.map((m) => m.name).slice(0, 4).join(', ')}${current.length > 4 ? '…' : ''}` : ''}
              </span>
            </span>
            <Icon name="right" size={18} />
          </button>
        </li>
        <li>
          <button type="button" className="link-row" onClick={() => navigate('settings/categories')}>
            <span className="link-row-main">
              <span className="link-row-title">Utilities categories</span>
              <span className="link-row-sub">{activeCats.length ? `${activeCats.length} in use · ${activeCats.map((c) => c.name).slice(0, 3).join(', ')}${activeCats.length > 3 ? '…' : ''}` : 'None yet'}</span>
            </span>
            <Icon name="right" size={18} />
          </button>
        </li>
      </ul>
    </section>
  )
}

/** What a restore will do, shown before confirming. The data-loss warnings here are always visible. */
export function RestoreConfirmBody({ s, status, reg }: { s: BackupSummary; status: ImportStatus; reg: RegistryPlan }) {
  return (
    <>
      <dl className="kv">
        <div>
          <dt>Contains</dt>
          <dd>{scopeName(s.scope)}</dd>
        </div>
        <div>
          <dt>Backup made</dt>
          <dd>{s.exportedAt ? new Date(s.exportedAt).toLocaleString('en-GB') : 'unknown'}</dd>
        </div>
        <div>
          <dt>Entries</dt>
          <dd>
            {s.transactions} ({s.utilities} Utilities, {s.bazar} Bazar)
          </dd>
        </div>
        {s.deleted > 0 && (
          <div>
            <dt>Deleted entries</dt>
            <dd>{s.deleted}</dd>
          </div>
        )}
        <div>
          <dt>Month closings</dt>
          <dd>{s.closings}</dd>
        </div>
        <div>
          <dt>Months</dt>
          <dd>{s.firstMonth ? `${monthLabel(s.firstMonth)} – ${monthLabel(s.lastMonth!)}` : '—'}</dd>
        </div>
        {s.scope === 'all' && (
          <div>
            <dt>Members</dt>
            <dd>{reg.members.map((m) => m.name).join(', ') || '—'}</dd>
          </div>
        )}
        {s.scope === 'all' && reg.renamed.length > 0 && (
          <div>
            <dt>Renamed</dt>
            <dd>{reg.renamed.map((r) => `${r.from} → ${r.to}`).join(', ')}</dd>
          </div>
        )}
        {s.scope !== 'all' && reg.membersAdded.length > 0 && (
          <div>
            <dt>Members added</dt>
            <dd>{reg.membersAdded.join(', ')}</dd>
          </div>
        )}
        {reg.categoriesAdded.length > 0 && (
          <div>
            <dt>{s.scope === 'all' ? 'Categories' : 'Categories added'}</dt>
            <dd>{s.scope === 'all' ? reg.categories.map((c) => c.name).join(', ') : reg.categoriesAdded.join(', ')}</dd>
          </div>
        )}
      </dl>
      {status.alreadyImportedAt !== null && (
        <p className="warn">
          <Icon name="alert" size={18} />
          <span>This same backup was already restored on {new Date(status.alreadyImportedAt).toLocaleString('en-GB')}. Restoring it again is usually a mistake.</span>
        </p>
      )}
      {status.newerLocalChanges > 0 && (
        <p className="warn">
          <Icon name="alert" size={18} />
          <span>
            {status.newerLocalChanges} {status.newerLocalChanges === 1 ? 'record was' : 'records were'} changed on this phone after this backup was made and would be lost.
          </span>
        </p>
      )}
      <p className="warn">
        <Icon name="alert" size={18} />
        <span>
          The {status.localTransactions} {scopeName(s.scope)} entries on this phone will be replaced.
          {s.scope !== 'all' && ` ${ledgerName(s.scope === 'utilities' ? 'bazar' : 'utilities')} is not touched.`} You can undo this restore afterwards.
        </span>
      </p>
    </>
  )
}
