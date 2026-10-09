/**
 * In-app update check for the Android app (the PWA updates itself through its service worker).
 *
 * The latest stable GitHub Release is read from the public REST API. A release is offered only when it is
 * published (not a draft or prerelease), its tag is a plain version newer than the installed app, and it
 * has exactly one APK asset named `mess-ledger-vX.Y.Z.apk` with a GitHub-computed SHA-256 digest. The APK
 * is downloaded and verified natively (see ApkInstallerPlugin.java) and Android's installer does the rest.
 */

export const UPDATE_REPO = 'Asif-Bin-Mahmood/mess-management-calculator'

/** Test builds can point at a local copy of the API (`VITE_UPDATE_FEED`); release builds never set it. */
const FEED_OVERRIDE: string | undefined = import.meta.env.VITE_UPDATE_FEED
export const UPDATE_FEED = FEED_OVERRIDE || `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`
const DOWNLOAD_PREFIX = FEED_OVERRIDE ? new URL(FEED_OVERRIDE).origin + '/' : `https://github.com/${UPDATE_REPO}/releases/download/`
const PAGE_PREFIX = FEED_OVERRIDE ? new URL(FEED_OVERRIDE).origin + '/' : `https://github.com/${UPDATE_REPO}/releases/`
const MAX_APK_BYTES = 100 * 1024 * 1024

export type Version = readonly [number, number, number]

/** Parses `1.2.3` or `v1.2.3`. Anything else (pre-release suffixes, extra parts) is rejected. */
export function parseVersion(s: unknown): Version | null {
  if (typeof s !== 'string') return null
  const m = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(s.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

export interface AvailableUpdate {
  version: string
  apkUrl: string
  apkName: string
  sha256: string
  size: number
  pageUrl: string
}

export type CheckResult =
  | { kind: 'available'; update: AvailableUpdate }
  | { kind: 'current'; latest: string }
  | { kind: 'error'; reason: 'offline' | 'unavailable' | 'network' | 'invalid'; detail?: string }

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Validates release metadata and decides whether it is an update for `installed`. */
export function evaluateRelease(raw: unknown, installed: string): CheckResult {
  const invalid = (detail: string): CheckResult => ({ kind: 'error', reason: 'invalid', detail })
  const mine = parseVersion(installed)
  if (!mine) return invalid(`installed version "${installed}" is not readable`)
  if (!isObj(raw)) return invalid('release is not an object')
  // Drafts and prereleases are never offered (GitHub's "latest" endpoint does not return them anyway).
  if (raw.draft === true || raw.prerelease === true) return { kind: 'current', latest: mine.join('.') }
  if (raw.draft !== false || raw.prerelease !== false) return invalid('release status is missing')
  const tag = raw.tag_name
  const v = parseVersion(tag)
  if (!v || typeof tag !== 'string' || !tag.startsWith('v')) return invalid('release tag is not vX.Y.Z')
  const version = v.join('.')
  if (compareVersions(v, mine) <= 0) return { kind: 'current', latest: version }

  const apkName = `mess-ledger-v${version}.apk`
  const assets = Array.isArray(raw.assets) ? raw.assets.filter(isObj) : []
  const apks = assets.filter((a) => a.name === apkName)
  if (apks.length !== 1) return invalid(`release has no single ${apkName}`)
  const a = apks[0]
  const url = a.browser_download_url
  if (typeof url !== 'string' || url !== `${DOWNLOAD_PREFIX}v${version}/${apkName}`) return invalid('unexpected download address')
  if (a.state !== 'uploaded') return invalid('APK upload is not complete')
  const digest = typeof a.digest === 'string' ? /^sha256:([0-9a-f]{64})$/.exec(a.digest) : null
  if (!digest) return invalid('APK has no SHA-256 digest')
  const size = a.size
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_APK_BYTES) return invalid('APK size is not valid')
  const page = typeof raw.html_url === 'string' && raw.html_url.startsWith(PAGE_PREFIX) ? raw.html_url : `${PAGE_PREFIX}tag/v${version}`
  return { kind: 'available', update: { version, apkUrl: url, apkName, sha256: digest[1], size, pageUrl: page } }
}

export type HttpGet = (url: string) => Promise<{ status: number; data: unknown }>

/** One check. Never throws; offline and server problems come back as `error` results. */
export async function checkForUpdate(installed: string, get: HttpGet, online = true): Promise<CheckResult> {
  if (!online) return { kind: 'error', reason: 'offline' }
  let res: { status: number; data: unknown }
  try {
    res = await get(UPDATE_FEED)
  } catch (e) {
    return { kind: 'error', reason: 'network', detail: String(e) }
  }
  // 404: no published release (or the repository is not public); 403/429: rate limited.
  if (res.status === 404 || res.status === 403 || res.status === 429 || res.status >= 500) return { kind: 'error', reason: 'unavailable', detail: `HTTP ${res.status}` }
  if (res.status !== 200) return { kind: 'error', reason: 'network', detail: `HTTP ${res.status}` }
  let data = res.data
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      return { kind: 'error', reason: 'invalid', detail: 'response is not JSON' }
    }
  }
  return evaluateRelease(data, installed)
}

/* ───────────── When to check and prompt ───────────── */

/** Automatic checks (launch / return to the app) run at most this often; the manual check always runs. */
export const AUTO_CHECK_INTERVAL_MS = 60 * 60 * 1000

export class UpdateSchedule {
  private lastAuto: number
  private readonly later = new Set<string>()
  private readonly store?: { get(): number; set(v: number): void }

  constructor(store?: { get(): number; set(v: number): void }) {
    this.store = store
    this.lastAuto = store?.get() ?? 0
  }

  /** True when an automatic check is due now; records the attempt. */
  takeAutoCheck(now: number): boolean {
    if (now - this.lastAuto < AUTO_CHECK_INTERVAL_MS && now >= this.lastAuto) return false
    this.lastAuto = now
    this.store?.set(now)
    return true
  }

  /** "Later" hides the prompt for that version until the app is restarted (manual checks still show it). */
  postpone(version: string) {
    this.later.add(version)
  }

  shouldPrompt(version: string, manual: boolean): boolean {
    return manual || !this.later.has(version)
  }
}

/* ───────────── Download / install outcome messages ───────────── */

export type InstallErrorCode = 'NETWORK' | 'CHECKSUM' | 'PACKAGE' | 'SIGNATURE' | 'VERSION' | 'STORAGE' | 'INSTALLER' | 'CANCELLED' | 'UNKNOWN'

export function installErrorCode(e: unknown): InstallErrorCode {
  const code = isObj(e) && typeof e.code === 'string' ? e.code : ''
  const known: InstallErrorCode[] = ['NETWORK', 'CHECKSUM', 'PACKAGE', 'SIGNATURE', 'VERSION', 'STORAGE', 'INSTALLER', 'CANCELLED']
  return (known as string[]).includes(code) ? (code as InstallErrorCode) : 'UNKNOWN'
}

export function installErrorMessage(code: InstallErrorCode): string {
  switch (code) {
    case 'NETWORK':
      return 'The download did not complete. Check the internet connection and try again.'
    case 'CHECKSUM':
      return 'The downloaded file did not match the published checksum, so it was deleted. Try again.'
    case 'PACKAGE':
      return 'The downloaded file is not a Mess Ledger update, so it was not installed.'
    case 'SIGNATURE':
      return 'The update is not signed with the same key as this app, so it was not installed.'
    case 'VERSION':
      return 'The downloaded file is not newer than the installed app.'
    case 'STORAGE':
      return 'There is not enough free space to download the update.'
    case 'INSTALLER':
      return 'Android’s installer could not be opened.'
    case 'CANCELLED':
      return 'Download cancelled.'
    default:
      return 'The update could not be completed.'
  }
}

export function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
