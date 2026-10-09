import { App as CapApp } from '@capacitor/app'
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { canInterrupt, pushOverlay } from '../ui/backNav'
import { useConfirm, useToast } from '../ui/context'
import { UpdateContext, type UpdateApi } from './context'
import { ApkInstallerNative, downloadAndInstall, isOnline, openInstaller, type InstallStep } from './installFlow'
import { checkForUpdate, formatMb, installErrorMessage, UPDATE_REPO, UpdateSchedule, type AvailableUpdate, type CheckResult, type HttpGet } from './update'

/** The Android app checks GitHub Releases for updates; the browser PWA uses its service worker instead. */
export function UpdateProvider({ children }: { children: ReactNode }) {
  return Capacitor.isNativePlatform() ? <NativeUpdates>{children}</NativeUpdates> : <>{children}</>
}

const LAST_CHECK_KEY = 'mess-ledger:update-checked-at'
const lastCheckStore = {
  get: () => {
    try {
      return Number(localStorage.getItem(LAST_CHECK_KEY)) || 0
    } catch {
      return 0
    }
  },
  set: (v: number) => {
    try {
      localStorage.setItem(LAST_CHECK_KEY, String(v))
    } catch {
      /* per-device convenience only */
    }
  },
}

const httpGet: HttpGet = async (url) => {
  // Native HTTP: no CORS or mixed-content limits, and it runs off the WebView's main thread.
  const r = await CapacitorHttp.get({
    url,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    connectTimeout: 10000,
    readTimeout: 10000,
    responseType: 'json',
  })
  return { status: r.status, data: r.data }
}

const RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases`

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function manualMessage(r: Exclude<CheckResult, { kind: 'available' }>, installed: string): string {
  if (r.kind === 'current') return `Mess Ledger is up to date (version ${installed}).`
  switch (r.reason) {
    case 'offline':
      return 'You’re offline. Connect to the internet and try again.'
    case 'unavailable':
      return 'Updates can’t be checked right now. Try again later.'
    case 'network':
      return 'Couldn’t reach the update server. Check the connection and try again.'
    case 'invalid':
      return 'The latest release could not be verified, so it is not offered.'
  }
}

function NativeUpdates({ children }: { children: ReactNode }) {
  const confirm = useConfirm()
  const toast = useToast()
  const [checking, setChecking] = useState(false)
  const [download, setDownload] = useState<{ version: string; done: number; total: number } | null>(null)
  const schedule = useMemo(() => new UpdateSchedule(lastCheckStore), [])
  const installed = useMemo(() => CapApp.getInfo().then((i) => i.version, () => __APP_VERSION__), [])
  const native = ApkInstallerNative

  // Latest functions for the long-lived listeners below.
  const flow = useRef({
    busy: false,
    awaitingPermission: null as AvailableUpdate | null,
    installerOpened: null as AvailableUpdate | null,
  })

  const actions = useRef<{ check: (manual: boolean) => Promise<void>; handle: (u: AvailableUpdate, s: InstallStep) => Promise<void> }>(null!)

  const runInstall = async (u: AvailableUpdate): Promise<void> => {
    setDownload({ version: u.version, done: 0, total: u.size })
    const step = await downloadAndInstall(u, native, (done, total) => setDownload({ version: u.version, done, total }))
    setDownload(null)
    await handle(u, step)
  }

  const handle = async (u: AvailableUpdate, step: InstallStep): Promise<void> => {
    if (step.kind === 'installer-opened') {
      flow.current.installerOpened = u // if the app comes back, the user cancelled Android's installer
      return
    }
    if (step.kind === 'needs-permission') {
      const ok = await confirm({
        title: 'Allow app updates',
        body: (
          <p>
            Android needs your permission before Mess Ledger can open the installer. On the next screen, turn on <b>Allow from this source</b>, then
            return to the app.
          </p>
        ),
        confirmLabel: 'Open settings',
        cancelLabel: 'Not now',
      })
      if (!ok) return
      flow.current.awaitingPermission = u
      await native.openInstallSettings().catch(() => {
        flow.current.awaitingPermission = null
        toast({ message: 'Android settings could not be opened.', tone: 'error' })
      })
      return
    }
    if (step.code === 'CANCELLED') {
      toast({ message: 'Download cancelled' })
      return
    }
    const retry = await confirm({
      title: 'Update not installed',
      body: <p>{installErrorMessage(step.code)} Your records were not changed.</p>,
      confirmLabel: 'Try again',
      cancelLabel: 'Close',
    })
    if (retry) await runInstall(u)
  }

  const offer = async (u: AvailableUpdate, manual: boolean) => {
    if (!schedule.shouldPrompt(u.version, manual)) return
    const ok = await confirm({
      title: 'Update available',
      body: (
        <p>
          Version {u.version} is ready to install ({formatMb(u.size)}). Your records stay on this phone.
        </p>
      ),
      confirmLabel: 'Update',
      cancelLabel: 'Later',
    })
    if (!ok) {
      schedule.postpone(u.version)
      return
    }
    await runInstall(u)
  }

  const check = async (manual: boolean) => {
    const f = flow.current
    if (f.busy) {
      if (manual) toast({ message: 'An update is already in progress.' })
      return
    }
    f.busy = true
    if (manual) setChecking(true)
    try {
      const version = await installed
      const res = await checkForUpdate(version, httpGet, await isOnline(native))
      setChecking(false)
      if (res.kind === 'available') {
        // An automatic prompt waits until no sheet, form question or restore is on screen.
        for (let i = 0; !manual && i < 300 && !(canInterrupt() && document.visibilityState === 'visible'); i++) await sleep(2000)
        if (manual || canInterrupt()) await offer(res.update, manual)
      } else if (manual) {
        const reason = res.kind === 'error' ? res.reason : null
        toast({
          message: manualMessage(res, version),
          tone: reason === 'invalid' ? 'error' : 'info',
          action:
            reason === 'network'
              ? { label: 'Retry', run: () => void actions.current.check(true) }
              : reason === 'invalid'
                ? { label: 'Open releases', run: () => void native.openUrl({ url: RELEASES_PAGE }) }
                : undefined,
        })
      }
    } finally {
      f.busy = false
      setChecking(false)
    }
  }

  useEffect(() => {
    actions.current = { check, handle }
  })

  useEffect(() => {
    // Offline launches and resumes do nothing (and do not use up the hourly automatic check).
    const auto = async () => {
      if ((await isOnline(native)) && schedule.takeAutoCheck(Date.now())) void actions.current.check(false)
    }
    // Startup is never delayed: the first check runs a few seconds after the app is on screen.
    const t = setTimeout(() => void auto(), 4000)
    const onResume = async () => {
      const f = flow.current
      if (f.awaitingPermission) {
        const u = f.awaitingPermission
        f.awaitingPermission = null
        const step = await openInstaller(native)
        if (step.kind === 'needs-permission') {
          toast({
            message: 'Installing updates is still not allowed for Mess Ledger.',
            action: {
              label: 'Settings',
              run: () => {
                f.awaitingPermission = u
                void native.openInstallSettings()
              },
            },
          })
        } else await actions.current.handle(u, step)
        return
      }
      if (f.installerOpened) {
        const u = f.installerOpened
        f.installerOpened = null
        toast({
          message: `Update ${u.version} was not installed.`,
          action: { label: 'Install', run: () => void openInstaller(native).then((s) => actions.current.handle(u, s)) },
        })
        return
      }
      void auto()
    }
    const resume = CapApp.addListener('resume', () => void onResume())
    const onOnline = () => void auto()
    window.addEventListener('online', onOnline)
    return () => {
      clearTimeout(t)
      window.removeEventListener('online', onOnline)
      void resume.then((h) => h.remove())
    }
  }, [schedule, native, toast])

  // Back during a download cancels it.
  const downloading = download !== null
  useEffect(() => (downloading ? pushOverlay(() => void native.cancel()) : undefined), [downloading, native])

  const api = useMemo<UpdateApi>(() => ({ checking, checkNow: () => void actions.current.check(true) }), [checking])

  return (
    <UpdateContext.Provider value={api}>
      {children}
      {download && (
        <div className="busy-overlay" role="alertdialog" aria-modal="true" aria-labelledby="upd-title" aria-describedby="upd-detail">
          <div className="busy-card">
            <p id="upd-title" className="busy-title">
              Downloading update {download.version}
            </p>
            <div className="busy-bar" aria-hidden="true">
              <span style={{ width: `${Math.min(100, Math.round((download.done / download.total) * 100))}%` }} />
            </div>
            <p id="upd-detail" className="busy-detail" aria-live="polite">
              {formatMb(download.done)} of {formatMb(download.total)}
            </p>
            <button type="button" className="btn btn-tonal" onClick={() => void native.cancel()}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </UpdateContext.Provider>
  )
}
