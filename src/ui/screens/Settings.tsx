import { useEffect, useRef, useState } from 'react'
import { backupFileName, checkBackup, createBackup, eraseAll, getRestoreUndo, importStatus, restoreBackup, undoLastRestore, type BackupScope } from '../../db/backup'
import { lastBackupAtQuery, restoreUndoQuery } from '../queries'
import { requestPersistentStorage, setMeta } from '../../db/repo'
import { formatTaka } from '../../domain/money'
import { dayLabel, monthLabel } from '../../domain/month'
import { ledgerName } from '../../domain/types'
import { canShareFiles, isNativeApp, saveFile, shareFile } from '../../report/export'
import { txTitle } from '../../report/reportModel'
import { useApp } from '../context'
import { useMutate } from '../useMutate'
import { TopBar } from '../common'
import { useConfirm, useToast } from '../context'
import { useLive } from '../hooks'
import { Icon } from '../icons'
import { useInstallPrompt } from '../pwa'

export function Settings() {
  const { txs } = useApp()
  const toast = useToast()
  const confirm = useConfirm()
  const mutate = useMutate()
  const fileInput = useRef<HTMLInputElement>(null)
  const lastBackupAt = useLive(lastBackupAtQuery)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [usage, setUsage] = useState<string | null>(null)
  const install = useInstallPrompt()
  const [scope, setScope] = useState<BackupScope>('all')
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

  const scopeName = (sc: BackupScope) => (sc === 'all' ? 'Utilities and Bazar' : `${ledgerName(sc)} only`)

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
      body: (
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
      ),
      confirmLabel: status.alreadyImportedAt !== null ? 'Restore again anyway' : 'Replace data',
      danger: true,
    })
    if (!ok) return
    try {
      await restoreBackup(check.data)
      toast({ message: `Restored ${s.transactions} entries (${scopeName(s.scope)})`, action: { label: 'Undo', run: () => void undoRestore() } })
    } catch (e) {
      toast({ message: `Restore failed, nothing changed: ${e instanceof Error ? e.message : String(e)}`, tone: 'error' })
    }
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

      <section className="card" aria-labelledby="bk-h">
        <div className="card-head">
          <h2 id="bk-h" className="card-title">
            Backup
          </h2>
          <span className="card-hint">{lastBackupAt ? `Last: ${new Date(lastBackupAt).toLocaleDateString('en-GB')}` : 'Never backed up'}</span>
        </div>
        <p className="card-text">
          Records are saved on this phone and stay after restarts and offline use, but that is not a backup: clearing the browser data, uninstalling, or losing or breaking
          the phone deletes them. Save a backup file regularly and keep a copy elsewhere (for example Google Drive or your own chat). Month closing never needs a backup file.
        </p>
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
          <h2 id="rs-h" className="card-title">
            Restore
          </h2>
        </div>
        <p className="card-text">
          Choose a Mess Ledger backup (.json). It is checked before anything changes. A Utilities backup can only replace Utilities, and a Bazar backup only Bazar.
        </p>
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
        <button type="button" className="btn btn-tonal" onClick={() => fileInput.current?.click()}>
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
        </dl>
        {install && (
          <button type="button" className="btn btn-primary" onClick={install}>
            <Icon name="download" size={18} /> Install app
          </button>
        )}
      </section>

      <section className="card" aria-labelledby="how-h">
        <div className="card-head">
          <h2 id="how-h" className="card-title">
            How balances work
          </h2>
        </div>
        <ul className="how">
          <li>Utilities and Bazar are separate ledgers with their own cash and balances.</li>
          <li>Each month’s spending is split equally by four. Leftover poisha go to one member at a time, rotating monthly.</li>
          <li>Balance = last month’s balance + paid this month − share. Positive means the member will receive money back; negative means the member is due to pay.</li>
          <li>Closing balances and cash carry into the next month automatically. The four balances always add up to the cash in hand.</li>
        </ul>
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
