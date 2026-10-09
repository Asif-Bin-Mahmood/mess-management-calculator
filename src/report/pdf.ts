/**
 * Minimal PDF 1.4 writer: one full-page JPEG image per page (A4 portrait).
 * The report is rendered to canvas first so the ৳ sign and fonts match the preview exactly.
 */
export interface PdfPage {
  jpeg: Uint8Array
  width: number
  height: number
}

const A4_W = 595.28
const A4_H = 841.89

function pdfString(s: string): string {
  const ascii = s.replace(/[—–]/g, '-').replace(/[^\x20-\x7e]/g, '')
  return '(' + ascii.replace(/[\\()]/g, (c) => '\\' + c) + ')'
}

export function buildPdf(pages: PdfPage[], title: string): Uint8Array {
  if (pages.length === 0) throw new Error('PDF needs at least one page')
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? enc.encode(part) : part
    chunks.push(bytes)
    length += bytes.length
  }
  const obj = (n: number, body: string) => {
    offsets[n] = length
    push(`${n} 0 obj\n${body}\nendobj\n`)
  }

  push('%PDF-1.4\n')
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])) // binary marker comment

  const pageObj = (i: number) => 4 + i * 3
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  obj(3, `<< /Title ${pdfString(title)} /Producer (Mess Ledger) >>`)

  pages.forEach((p, i) => {
    const pn = pageObj(i)
    const content = `q ${A4_W} 0 0 ${A4_H} 0 0 cm /Im${i} Do Q`
    obj(pn, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_W} ${A4_H}] /Resources << /XObject << /Im${i} ${pn + 2} 0 R >> >> /Contents ${pn + 1} 0 R >>`)
    obj(pn + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
    offsets[pn + 2] = length
    push(`${pn + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`)
    push(p.jpeg)
    push('\nendstream\nendobj\n')
  })

  const size = 4 + pages.length * 3
  const xrefAt = length
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`
  for (let n = 1; n < size; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
  push(xref)
  push(`trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`)

  const out = new Uint8Array(length)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
