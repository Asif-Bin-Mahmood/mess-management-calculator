/**
 * Draws a monthly report onto canvas. The same drawing code produces the in-app preview,
 * the PNG/JPEG image (one tall page) and the PDF (paginated A4 pages).
 */
import { formatTaka } from '../domain/money'
import { dayLabel } from '../domain/month'
import { categoryName, memberName, UTILITY_CATEGORIES } from '../domain/types'
import { balanceLabel, balanceStatus, txCashEffect, txTitle, type Report } from './reportModel'

export const PAGE_W = 1240
export const PAGE_H = 1754 // A4 at 150 dpi
const M = 84 // page margin
const CONTENT_W = PAGE_W - M * 2

export const REPORT_FONT = '"Manrope Variable", "Noto Sans Bengali", "Nirmala UI", "Segoe UI", Roboto, sans-serif'

const C = {
  ink: '#1c2620',
  muted: '#5f6a63',
  faint: '#8a938d',
  line: '#e4e1d8',
  band: '#f5f3ee',
  due: '#b3261e',
  review: '#8a5a00',
  attention: '#fdf3dc',
  attentionInk: '#6d4c00',
  receivable: '#1d7048',
  utilities: '#2c5a85',
  bazar: '#a9512a',
}

type Align = 'left' | 'right' | 'center'

/** The subset of HTMLCanvasElement the renderer uses; lets tests render with a recording fake. */
export interface CanvasLike {
  width: number
  height: number
  getContext(type: '2d'): CanvasRenderingContext2D | null
}

function domCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

class Painter<T extends CanvasLike> {
  pages: T[] = []
  ctx!: CanvasRenderingContext2D
  y = M
  readonly measuring: boolean
  readonly paginate: boolean
  readonly pageH: number
  private readonly scratch: CanvasRenderingContext2D
  private readonly create: (w: number, h: number) => T
  onNewPage: (() => void) | null = null

  constructor(opts: { measuring: boolean; paginate: boolean; pageH: number; create: (w: number, h: number) => T }) {
    this.measuring = opts.measuring
    this.paginate = opts.paginate
    this.pageH = opts.pageH
    this.create = opts.create
    this.scratch = opts.create(1, 1).getContext('2d')!
    this.newPage()
  }

  newPage() {
    if (this.measuring) {
      this.ctx = this.scratch
    } else {
      const c = this.create(PAGE_W, this.pageH)
      const ctx = c.getContext('2d')!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, PAGE_W, this.pageH)
      ctx.textBaseline = 'alphabetic'
      this.pages.push(c)
      this.ctx = ctx
    }
    this.y = M
    if (this.pages.length > 1) this.onNewPage?.()
  }

  /** Starts a new page when `h` more pixels do not fit (pagination mode only). */
  ensure(h: number) {
    if (this.paginate && this.y + h > this.pageH - M - 40) this.newPage()
  }

  font(size: number, weight = 500) {
    this.ctx.font = `${weight} ${size}px ${REPORT_FONT}`
  }

  text(s: string, x: number, y: number, o: { size?: number; weight?: number; color?: string; align?: Align; maxW?: number } = {}) {
    this.font(o.size ?? 24, o.weight ?? 500)
    let str = s
    if (o.maxW !== undefined) str = this.fit(str, o.maxW)
    if (this.measuring) return
    this.ctx.fillStyle = o.color ?? C.ink
    this.ctx.textAlign = o.align ?? 'left'
    this.ctx.fillText(str, x, y)
  }

  fit(s: string, maxW: number): string {
    if (this.ctx.measureText(s).width <= maxW) return s
    let lo = 0
    let hi = s.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (this.ctx.measureText(s.slice(0, mid) + '…').width <= maxW) lo = mid
      else hi = mid - 1
    }
    return s.slice(0, lo) + '…'
  }

  wrap(s: string, maxW: number, size: number, weight = 500): string[] {
    this.font(size, weight)
    const words = s.split(' ')
    const lines: string[] = []
    let line = ''
    for (const w of words) {
      const next = line ? `${line} ${w}` : w
      if (this.ctx.measureText(next).width > maxW && line) {
        lines.push(line)
        line = w
      } else line = next
    }
    if (line) lines.push(line)
    return lines
  }

  rect(x: number, y: number, w: number, h: number, color: string, r = 0) {
    if (this.measuring) return
    this.ctx.fillStyle = color
    this.ctx.beginPath()
    this.ctx.roundRect(x, y, w, h, r)
    this.ctx.fill()
  }

  hline(y: number, color = C.line, x = M, w = CONTENT_W) {
    this.rect(x, y, w, 2, color)
  }
}

interface Col {
  label: string
  w: number
  align: Align
}

export interface ReportOptions {
  /** Append the month's entries (optional; off by default to keep the report short). */
  includeTransactions?: boolean
}

function layout<T extends CanvasLike>(p: Painter<T>, r: Report, opts: ReportOptions) {
  const s = r.summary
  const accent = r.ledger === 'utilities' ? C.utilities : C.bazar
  const t = (v: number) => formatTaka(v, { decimals: 'always' })

  const section = (title: string, needed: number) => {
    p.ensure(needed + 70)
    p.y += 30
    p.text(title.toUpperCase(), M, p.y + 26, { size: 22, weight: 800, color: C.muted })
    p.y += 48
  }
  const header = (cols: Col[]) => {
    p.rect(M, p.y, CONTENT_W, 52, C.band, 10)
    let x = M + 20
    for (const c of cols) {
      const w = c === cols[cols.length - 1] ? c.w - 40 : c.w
      p.text(c.label, c.align === 'right' ? x + w : x, p.y + 34, { size: 21, weight: 700, color: C.muted, align: c.align })
      x += c.w
    }
    p.y += 52
  }
  const row = (cols: Col[], cells: { s: string; color?: string; weight?: number }[], h = 68) => {
    let x = M + 20
    cols.forEach((c, i) => {
      const w = i === cols.length - 1 ? c.w - 40 : c.w
      const cell = cells[i]
      p.text(cell.s, c.align === 'right' ? x + w : x, p.y + h / 2 + 10, { size: 26, weight: cell.weight ?? 500, color: cell.color, align: c.align, maxW: w - 12 })
      x += c.w
    })
    p.y += h
    p.hline(p.y - 1)
  }

  // ── Header
  p.rect(M, p.y, 10, 104, accent, 5)
  p.text(`${r.ledgerName} — ${r.monthLabel}`, M + 34, p.y + 60, { size: 54, weight: 800 })
  const gen = r.generatedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  p.text(`Mess Ledger · Asif, Dipu, Yusha, Ovi · Prepared ${gen}`, M + 34, p.y + 100, { size: 22, color: C.muted })
  p.y += 140

  // ── Financial summary
  const short = s.remainingCash < 0
  const tiles: [string, string, string?][] = [
    ['Total collected', t(s.totalCollected)],
    ['Total spent', t(s.totalSpent)],
    [short ? 'Cash short' : 'Cash in hand', t(Math.abs(s.remainingCash)), short ? C.due : undefined],
  ]
  const gap = 20
  const tileW = (CONTENT_W - gap * 2) / 3
  const tileH = 130
  p.ensure(tileH)
  tiles.forEach(([label, value, color], i) => {
    const x = M + i * (tileW + gap)
    p.rect(x, p.y, tileW, tileH, C.band, 16)
    p.text(label, x + 26, p.y + 44, { size: 24, weight: 700, color: color ?? C.muted, maxW: tileW - 52 })
    p.text(value, x + 26, p.y + 100, { size: 40, weight: 800, color: color ?? C.ink, maxW: tileW - 52 })
  })
  p.y += tileH

  // ── Attention (only for issues that need action; the shortage is already in the summary)
  const issues = r.alerts.filter((a) => a.kind !== 'cash-short' && a.tone !== 'info')
  if (issues.length) {
    // Wrapped, never truncated: a warning must always be readable in full.
    const lines = issues.flatMap((a) => p.wrap(`Attention: ${a.title} — ${a.detail.charAt(0).toLowerCase()}${a.detail.slice(1)}.`, CONTENT_W - 48, 24, 700))
    p.ensure(lines.length * 36 + 40)
    p.y += 24
    p.rect(M, p.y, CONTENT_W, lines.length * 36 + 32, C.attention, 14)
    p.y += 16
    for (const line of lines) {
      p.text(line, M + 24, p.y + 28, { size: 24, weight: 700, color: C.attentionInk })
      p.y += 36
    }
    p.y += 16
  }

  // ── Members
  const memberCols: Col[] = [
    { label: 'Member', w: 300, align: 'left' },
    { label: 'Contributed', w: 340, align: 'right' },
    { label: 'Due / will receive', w: CONTENT_W - 640, align: 'right' },
  ]
  section('Members', 52 + 4 * 68 + 40)
  header(memberCols)
  for (const m of s.members) {
    const status = balanceStatus(m.closing)
    row(memberCols, [
      { s: memberName(m.memberId), weight: 700 },
      { s: t(m.netContribution) },
      { s: balanceLabel(m.closing), weight: 700, color: status === 'due' ? C.due : status === 'receivable' ? C.receivable : C.muted },
    ])
  }
  p.y += 34
  p.text(`Each member’s share of spending: ${t(s.averagePerPerson)}`, M, p.y, { size: 21, color: C.muted, maxW: CONTENT_W })

  // ── Utilities categories (compact, two columns)
  if (s.categoryTotals) {
    const totals = s.categoryTotals
    section('By category', 3 * 60)
    const colW = (CONTENT_W - 40) / 2
    UTILITY_CATEGORIES.forEach((c, i) => {
      const col = i % 2
      const x = M + col * (colW + 40)
      if (col === 0 && i > 0) p.y += 60
      p.text(categoryName(c.id), x, p.y + 30, { size: 25, weight: 600 })
      p.text(t(totals[c.id]), x + colW, p.y + 30, { size: 25, weight: 700, align: 'right' })
      p.hline(p.y + 48, C.line, x, colW)
    })
    p.y += 60
  }

  // ── Optional entries
  if (opts.includeTransactions) {
    const txCols: Col[] = [
      { label: 'Date', w: 200, align: 'left' },
      { label: 'Entry', w: 380, align: 'left' },
      { label: 'Note', w: CONTENT_W - 830, align: 'left' },
      { label: 'Amount', w: 250, align: 'right' },
    ]
    section(`Entries (${r.transactions.length})`, 52 + 60 * Math.min(3, Math.max(1, r.transactions.length)))
    if (r.transactions.length === 0) {
      p.text('No entries this month.', M, p.y + 30, { size: 24, color: C.muted })
      p.y += 50
    } else {
      header(txCols)
      p.onNewPage = () => {
        p.text(`${r.ledgerName} — ${r.monthLabel} (continued)`, M, p.y + 30, { size: 24, weight: 700, color: C.muted })
        p.y += 56
        header(txCols)
      }
      for (const tx of r.transactions) {
        p.ensure(60)
        const eff = txCashEffect(tx)
        row(
          txCols,
          [
            { s: dayLabel(tx.date), color: C.muted },
            { s: txTitle(tx), weight: 600 },
            { s: tx.description ?? '', color: C.muted },
            { s: formatTaka(eff, { decimals: 'always', sign: true }), weight: 700, color: eff < 0 ? C.ink : C.receivable },
          ],
          60,
        )
      }
      p.onNewPage = null
    }
  }
  p.y += M
}

function drawFooters(pages: CanvasLike[], r: Report) {
  pages.forEach((c, i) => {
    const ctx = c.getContext('2d')!
    ctx.font = `500 18px ${REPORT_FONT}`
    ctx.fillStyle = C.faint
    ctx.textAlign = 'left'
    ctx.fillText(`Mess Ledger · ${r.ledgerName} only · ${r.monthLabel}`, M, c.height - 44)
    ctx.textAlign = 'right'
    ctx.fillText(`Page ${i + 1} of ${pages.length}`, PAGE_W - M, c.height - 44)
  })
}

export async function ensureReportFonts(): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load(`500 24px "Manrope Variable"`),
      document.fonts.load(`800 24px "Manrope Variable"`),
    ])
  } catch {
    // Fall back to system fonts.
  }
}

/** Draws the report onto canvases from `create`: one continuous page, or A4 pages when `paginate`. */
export function layoutReport<T extends CanvasLike>(r: Report, create: (w: number, h: number) => T, paginate: boolean, opts: ReportOptions = {}): T[] {
  if (paginate) {
    const p = new Painter({ measuring: false, paginate: true, pageH: PAGE_H, create })
    layout(p, r, opts)
    drawFooters(p.pages, r)
    return p.pages
  }
  const measure = new Painter({ measuring: true, paginate: false, pageH: PAGE_H, create })
  layout(measure, r, opts)
  const height = Math.ceil(measure.y + 60)
  const p = new Painter({ measuring: false, paginate: false, pageH: height, create })
  layout(p, r, opts)
  drawFooters(p.pages, r)
  return p.pages
}

/** One continuous page, for PNG/JPEG export and preview. */
export function renderReportImage(r: Report, opts: ReportOptions = {}): HTMLCanvasElement {
  return layoutReport(r, domCanvas, false, opts)[0]
}

/** A4-sized pages for PDF export. */
export function renderReportPages(r: Report, opts: ReportOptions = {}): HTMLCanvasElement[] {
  return layoutReport(r, domCanvas, true, opts)
}
