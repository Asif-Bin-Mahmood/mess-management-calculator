import { Capacitor } from '@capacitor/core'
import { buildPdf } from './pdf'
import { ensureReportFonts, renderReportImage, renderReportPages, type ReportOptions } from './render'
import { reportFileBase, type Report } from './reportModel'

export type ExportFormat = 'pdf' | 'png' | 'jpeg'

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality),
  )
}

export async function exportReport(r: Report, format: ExportFormat, opts: ReportOptions = {}): Promise<File> {
  await ensureReportFonts()
  const base = reportFileBase(r)
  if (format === 'pdf') {
    const pages = renderReportPages(r, opts)
    const encoded = await Promise.all(
      pages.map(async (c) => ({
        jpeg: new Uint8Array(await (await toBlob(c, 'image/jpeg', 0.9)).arrayBuffer()),
        width: c.width,
        height: c.height,
      })),
    )
    const bytes = buildPdf(encoded, `${r.ledgerName} report - ${r.monthLabel}`)
    return new File([bytes as BlobPart], `${base}.pdf`, { type: 'application/pdf' })
  }
  const canvas = renderReportImage(r, opts)
  const type = format === 'png' ? 'image/png' : 'image/jpeg'
  const blob = await toBlob(canvas, type, format === 'jpeg' ? 0.92 : undefined)
  return new File([blob], `${base}.${format === 'png' ? 'png' : 'jpg'}`, { type })
}

/** True inside the installed Android app (Capacitor), where the WebView supports neither downloads nor Web Share. */
export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform()
}

export function canShareFiles(file?: File): boolean {
  if (isNativeApp()) return true
  try {
    const probe = file ?? new File([new Uint8Array([1])], 'probe.png', { type: 'image/png' })
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [probe] })
  } catch {
    return false
  }
}

async function toBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/**
 * Android app: writes the file to the app's private cache (served to other apps through the FileProvider)
 * and opens the Android share sheet, which also offers saving to Files or Drive. Resolves false on cancel.
 */
async function nativeShare(file: File, title: string): Promise<boolean> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem')
  const { Share } = await import('@capacitor/share')
  const written = await Filesystem.writeFile({ path: `exports/${file.name}`, data: await toBase64(file), directory: Directory.Cache, recursive: true })
  try {
    await Share.share({ title, dialogTitle: title, files: [written.uri] })
    return true
  } catch (e) {
    if (String(e instanceof Error ? e.message : e).toLowerCase().includes('cancel')) return false
    throw e
  }
}

/** Opens the share sheet. Resolves false if the user cancelled. */
export async function shareFile(file: File, title: string): Promise<boolean> {
  if (isNativeApp()) return nativeShare(file, title)
  try {
    await navigator.share({ files: [file], title })
    return true
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return false
    throw e
  }
}

/**
 * Saves a file: a browser download on the web; in the Android app, the share sheet (choose Files, Drive, …).
 * Returns what happened so the caller can word its message.
 */
export async function saveFile(file: File, title: string): Promise<'downloaded' | 'shared' | 'cancelled'> {
  if (isNativeApp()) return (await nativeShare(file, title)) ? 'shared' : 'cancelled'
  downloadFile(file, file.name)
  return 'downloaded'
}

/** Browser download (web only). */
function downloadFile(file: Blob, name: string): void {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
