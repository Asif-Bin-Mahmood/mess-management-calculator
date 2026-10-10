import { App as CapApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { performBack } from './ui/backNav'
import { useEffect, type ReactNode } from 'react'
import { isValidMonth } from './domain/month'
import type { LedgerId } from './domain/types'
import { AppStateProvider } from './ui/appState'
import { useApp, useToast } from './ui/context'
import { ConfirmProvider, ToastProvider } from './ui/feedback'
import { navigate, useRoute } from './ui/hooks'
import { Icon, type IconName } from './ui/icons'
import { setupServiceWorker } from './ui/pwa'
import { Home } from './ui/screens/Home'
import { Ledger } from './ui/screens/Ledger'
import { CloseMonth } from './ui/screens/MonthClosing'
import { Reports } from './ui/screens/Reports'
import { Settings } from './ui/screens/Settings'
import { TxForm } from './ui/screens/TxForm'
import { BazarMethodScreen } from './ui/screens/BazarMethod'
import { CategoriesScreen, MembersScreen, Setup } from './ui/screens/Household'
import { UpdateProvider } from './update/UpdateProvider'

function isLedger(s: string | undefined): s is LedgerId {
  return s === 'utilities' || s === 'bazar'
}

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <UpdateProvider>
          <AppStateProvider>
            <Shell />
          </AppStateProvider>
        </UpdateProvider>
      </ConfirmProvider>
    </ToastProvider>
  )
}

function Shell() {
  const route = useRoute()
  const { txs, needsSetup } = useApp()
  const toast = useToast()

  useEffect(() => {
    // The Android app bundles its files; a service worker is only needed for the browser-installed PWA.
    if (import.meta.env.DEV || Capacitor.isNativePlatform()) return
    setupServiceWorker({
      onNeedRefresh: (reload) => toast({ message: 'A new version of the app is ready.', sticky: true, action: { label: 'Reload', run: reload } }),
      onOfflineReady: () => toast({ message: 'Ready to work offline' }),
    })
  }, [toast])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    const handle = CapApp.addListener('backButton', () => {
      void performBack('system').then((handled) => {
        if (!handled) void CapApp.minimizeApp() // Home: leave the app like any Android app
      })
    })
    return () => {
      void handle.then((h) => h.remove())
    }
  }, [])

  const [a, b, c] = route
  let screen: ReactNode
  let tab: string = a ?? ''
  if (isLedger(a) && b === 'new') screen = <TxForm ledger={a} kind={c === 'contribution' ? 'in' : c === 'purchase' || c === 'settlement' ? c : 'out'} />
  else if (isLedger(a) && b === 'edit' && c) screen = <TxForm ledger={a} editId={c} />
  else if (isLedger(a) && b === 'close' && c && isValidMonth(c)) screen = <CloseMonth ledger={a} month={c} />
  else if (isLedger(a) && b === 'report') screen = <Reports ledger={a} />
  else if (a === 'bazar' && b === 'method') screen = <BazarMethodScreen />
  else if (isLedger(a)) screen = <Ledger ledger={a} />
  // Old shared reports link: send to the ledger's own report.
  else if (a === 'reports') screen = <Reports ledger={isLedger(b) ? b : 'utilities'} />
  else if (a === 'settings' && b === 'members') screen = <MembersScreen />
  else if (a === 'settings' && b === 'categories') screen = <CategoriesScreen />
  else if (a === 'settings') screen = <Settings />
  else {
    screen = <Home />
    tab = ''
  }
  // A fresh installation sets up its household first (Backup & settings stays reachable to restore a backup).
  const setup = needsSetup && a !== 'settings'
  if (setup) screen = <Setup />
  const inForm = setup || b === 'new' || b === 'edit' || b === 'close' || b === 'method' || (a === 'settings' && !!b)

  // Scroll to top on screen change.
  const key = route.join('/')
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [key])

  return (
    <div className={`app ${inForm ? 'app-form' : ''}`}>
      <main id="main">{txs === undefined ? <div className="loading">Loading…</div> : screen}</main>
      {!inForm && (
        <nav className="bottom-nav" aria-label="Main">
          <NavItem to="" icon="home" label="Home" active={tab === ''} />
          <NavItem to="utilities" icon="bolt" label="Utilities" active={tab === 'utilities'} />
          <NavItem to="bazar" icon="basket" label="Bazar" active={tab === 'bazar'} />
          <NavItem to="settings" icon="shield" label="Backup" active={tab === 'settings'} />
        </nav>
      )}
    </div>
  )
}

function NavItem({ to, icon, label, active }: { to: string; icon: IconName; label: string; active: boolean }) {
  return (
    <a
      href={`#/${to}`}
      className={`nav-item ${active ? 'active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault()
        navigate(to, { replace: true })
      }}
    >
      <span className="nav-pill">
        <Icon name={icon} size={22} />
      </span>
      <span className="nav-label">{label}</span>
    </a>
  )
}
