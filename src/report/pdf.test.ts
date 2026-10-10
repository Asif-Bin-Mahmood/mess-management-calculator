import { describe, expect, it } from 'vitest'
import { pdfString } from './pdf'

describe('PDF text strings', () => {
  it('keeps plain ASCII titles as before and encodes Bengali as UTF-16BE', () => {
    expect(pdfString('Bazar report (Bazar only) — October 2026')).toBe('(Bazar report \\(Bazar only\\) - October 2026)')
    expect(pdfString('কড়া')).toBe('<FEFF099509A109BC09BE>')
  })
})
