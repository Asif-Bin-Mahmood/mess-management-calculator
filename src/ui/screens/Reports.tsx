import { useEffect, useMemo, useState } from 'react'
import { formatTaka } from '../../domain/money'
import { ledgerName, type LedgerId } from '../../domain/types'
import { canShareFiles, exportReport, isNativeApp, saveFile, shareFile, type ExportFormat } from '../../report/export'
import { ensureReportFonts, renderReportImage } from '../../report/render'
import { buildReport } from '../../report/reportModel'
import { useApp } from '../context'
import { MonthSwitcher, TopBar } from '../common'
import { useToast } from '../context'
import { Icon } from '../icons'

export function Reports({ ledger }: { ledger: LedgerId }) {
  const { txs, closings, month, setMonth, minMonth, maxMonth } = useApp()
  const toast = useToast()
  const report = useMemo(() => buildReport(ledger, month, txs ?? [], closings), [ledger, month, txs, closings])
  const [withEntries, setWithEntries] = useState(false)
  const [rendered, setRendered] = useState<{ report: typeof report; withEntries: boolean; url: string } | null>(null)
  const preview = rendered?.report === report && rendered.withEntries === withEntries ? rendered.url : null
  const [busy, setBusy] = useState<ExportFormat | 'share' | null>(null)
  const [format, setFormat] = useState<ExportFormat>('pdf')
  // In the Android app, Save already opens the share sheet, so a separate Share button would duplicate it.
  const shareable = useMemo(() => canShareFiles() && !isNativeApp(), [])

  useEffect(() => {
    let url: string | null = null
    let cancelled = false
    ensureReportFonts().then(() => {
      if (cancelled) return
      renderReportImage(report, { includeTransactions: withEntries }).toBlob((b) => {
        if (!b || cancelled) return
        url = URL.createObjectURL(b)
        setRendered({ report, withEntries, url })
      }, 'image/png')
    })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [report, withEntries])

  async function run(action: 'share' | 'save') {
    setBusy(action === 'share' ? 'share' : format)
    try {
      const file = await exportReport(report, format, { includeTransactions: withEntries })
      const title = `${report.ledgerName} report (${report.ledgerName} only) — ${report.monthLabel}`
      if (action === 'share' && canShareFiles(file)) {
        await shareFile(file, title)
      } else if ((await saveFile(file, title)) === 'downloaded') {
        toast({ message: `Saved ${file.name} to Downloads` })
      }
    } catch (e) {
      toast({ message: `Export failed: ${String(e)}`, tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const s = report.summary
  return (
    <div className="screen">
      <TopBar title={`${ledgerName(ledger)} report`} back={ledger} ledger={ledger} />
      <p className="form-ledger">Contains {ledgerName(ledger)} data only</p>
      <MonthSwitcher month={month} onChange={setMonth} min={minMonth} max={maxMonth} />

      <p className="report-meta">
        {s.transactionCount} {s.transactionCount === 1 ? 'entry' : 'entries'} · spent {formatTaka(s.totalSpent)} · {s.reconciliation.balanced ? 'reconciled ✓' : s.reconciliation.status === 'review' ? 'unreconciled after correction — review required' : 'unexplained difference'}{s.closing ? ' · month closed' : ''}
      </p>

      <div className="export-bar">
        <div className="segmented segmented-sm" role="radiogroup" aria-label="File format">
          {(['pdf', 'png', 'jpeg'] as ExportFormat[]).map((f) => (
            <button key={f} type="button" role="radio" aria-checked={format === f} className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
        <label className="check-row">
          <input type="checkbox" checked={withEntries} onChange={(e) => setWithEntries(e.target.checked)} />
          Include all entries ({s.transactionCount})
        </label>
        <div className="export-actions">
          <button type="button" className="btn btn-tonal btn-lg" onClick={() => run('save')} disabled={busy !== null}>
            <Icon name="download" size={18} /> {busy && busy !== 'share' ? 'Preparing…' : 'Save'}
          </button>
          {shareable && (
            <button type="button" className="btn btn-primary btn-lg" onClick={() => run('share')} disabled={busy !== null}>
              <Icon name="share" size={18} /> {busy === 'share' ? 'Preparing…' : 'Share'}
            </button>
          )}
        </div>
      </div>
      <div className="report-preview" aria-busy={!preview}>
        {preview ? (
          <img src={preview} alt={`Preview of the ${report.ledgerName} report for ${report.monthLabel}`} />
        ) : (
          <div className="report-placeholder">Preparing preview…</div>
        )}
      </div>

    </div>
  )
}
