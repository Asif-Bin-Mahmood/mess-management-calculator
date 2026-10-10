import 'fake-indexeddb/auto'
import { createElement as h, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { BackupSummary, ImportStatus, RegistryPlan } from '../db/backup'
import { legacyCategories, legacyMembers, setHouseholdDisplay } from '../domain/household'
import { CATS5, R4, tx } from '../domain/testUtils'
import { InfoButton } from './common'
import { AppContext, type AppState, type ConfirmOptions } from './context'
import { ConfirmProvider } from './feedback'
import { HELP, openHelp, type HelpTopic } from './help'
import { Home } from './screens/Home'
import { Ledger } from './screens/Ledger'
import { RestoreConfirmBody, Settings } from './screens/Settings'

// The service-worker helper needs a build-time virtual module; Settings only uses its install prompt.
vi.mock('./pwa', () => ({ useInstallPrompt: () => null, setupServiceWorker: () => {} }))

setHouseholdDisplay(legacyMembers(), legacyCategories())
const app: AppState = {
  txs: [tx('bazar', 'expense', 300, '2026-10-02'), tx('bazar', 'contribution', 500, '2026-10-01', { memberId: 'asif' })],
  closings: [],
  members: R4,
  categories: CATS5,
  needsSetup: false,
  month: '2026-10',
  setMonth: () => {},
}
const render = (el: ReturnType<typeof h>) => renderToStaticMarkup(h(AppContext.Provider, { value: app }, h(ConfirmProvider, null, el)))
const text = (node: ReactNode) => renderToStaticMarkup(h('div', null, node)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const topics = Object.keys(HELP) as HelpTopic[]

describe('information controls', () => {
  it.each(topics)('%s: an icon-only button with an accessible name that opens a dialog', (topic) => {
    const html = renderToStaticMarkup(h(InfoButton, { topic }))
    expect(html).toContain('type="button"')
    expect(html).toContain(`aria-label="${HELP[topic].label}"`)
    expect(html).toContain('aria-haspopup="dialog"')
    expect(HELP[topic].title.length).toBeGreaterThan(3)
  })

  it('a text link uses its visible text as its name (no duplicate label)', () => {
    const html = renderToStaticMarkup(h(InfoButton, { topic: 'balances', text: 'How balances work' }))
    expect(html).toContain('How balances work')
    expect(html).not.toContain('aria-label')
    expect(html).toContain('aria-haspopup="dialog"')
  })

  it('opens an information sheet with a title and a single Close action, and resolves when it is closed', async () => {
    let shown: ConfirmOptions | null = null
    let close: (v: boolean) => void = () => {}
    const confirm = (o: ConfirmOptions) => {
      shown = o
      return new Promise<boolean>((r) => (close = r))
    }
    const pending = openHelp(confirm, 'backup')
    expect(shown).toMatchObject({ title: 'About backups', confirmLabel: 'Close', cancelLabel: null, help: true })
    expect((shown as unknown as ConfirmOptions).danger).toBeUndefined()
    close(true)
    await expect(pending).resolves.toBe(true)
  })

  it('the sheet is a labelled dialog', () => {
    const html = renderToStaticMarkup(h(ConfirmProvider, null, h('span')))
    expect(html).toMatch(/<dialog[^>]*aria-labelledby="confirm-title"/)
  })
})

describe('help content', () => {
  it('backup help explains where data is, what deletes it and how a backup helps; never calls local storage a backup', () => {
    const t = text(HELP.backup.body)
    expect(t).toMatch(/only on this phone/)
    expect(t).toMatch(/uninstalling the app, clearing its data/)
    expect(t).toMatch(/saves everything to a file/)
    expect(t).toMatch(/Keep a copy somewhere else/)
    expect(t).not.toMatch(/(phone|storage)[^.]* is (a|your) backup/i)
  })

  it('balances help covers the four essentials, with rounding and member changes only behind “More details”', () => {
    const html = renderToStaticMarkup(h('div', null, HELP.balances.body))
    const [main, more] = html.split('<details')
    for (const essential of ['shared equally by the members sharing that month', 'owes money to the mess', 'paid more than their share', 'Utilities and Bazar are separate', 'Balances carry into the next month'])
      expect(main).toContain(essential)
    expect(main).not.toMatch(/poisha/)
    expect(more).toContain('<summary>More details</summary>')
    expect(more).toMatch(/poisha/)
    expect(more).toMatch(/never moved onto the others/)
  })
})

describe('compact screens', () => {
  it('Settings is materially shorter: no balances card, short Backup and Restore text, info buttons beside the headings', () => {
    const html = render(h(Settings))
    const visible = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    expect(html).not.toContain('How balances work')
    expect(visible).not.toMatch(/Month closing never needs a backup file/)
    expect(visible).toContain('Records are only on this phone. Save a backup file and keep a copy elsewhere.')
    expect(visible).toContain('Choose a backup file. You see what it contains before anything changes.')
    expect(html).toContain('aria-label="Backup information"')
    expect(html).toContain('aria-label="Restore information"')
    // Critical warning next to its action stays visible.
    expect(visible).toContain('Removes everything from this phone. Save a backup first.')
    // Explanations moved into help sheets are not shown on the page.
    expect(visible).not.toMatch(/Members are shared by both ledgers/)
    expect(visible.length).toBeLessThan(2400)
  })

  it('“How balances work” appears once, on the ledger’s Members card, and not on Home', () => {
    const ledger = render(h(Ledger, { ledger: 'bazar' }))
    expect(ledger.split('How balances work').length - 1).toBe(1)
    expect(render(h(Home))).not.toContain('How balances work')
  })
})

describe('restore confirmation keeps its warnings visible', () => {
  const s: BackupSummary = { scope: 'bazar', backupId: 'b', exportedAt: '2026-01-01T00:00:00Z', schemaVersion: 4, transactions: 12, deleted: 0, utilities: 0, bazar: 12, closings: 1, firstMonth: '2025-11', lastMonth: '2026-01', memberNames: [], categoryCount: 0 }
  const reg: RegistryPlan = { members: [], categories: [], membersAdded: ['Cy'], categoriesAdded: [], renamed: [], problem: null, problemKind: null }

  it('shows replacement, newer-change loss, repeated-restore and other-ledger notes', () => {
    const status: ImportStatus = { alreadyImportedAt: Date.UTC(2026, 0, 2), identical: false, newerLocalChanges: 3, localTransactions: 40 }
    const t = text(h(RestoreConfirmBody, { s, status, reg }))
    expect(t).toMatch(/The 40 Bazar only entries on this phone will be replaced/)
    expect(t).toMatch(/Utilities is not touched/)
    expect(t).toMatch(/3 records were changed on this phone after this backup was made and would be lost/)
    expect(t).toMatch(/already restored/)
    expect(t).toMatch(/You can undo this restore afterwards/)
    expect(t).toMatch(/Members added Cy/)
  })
})
