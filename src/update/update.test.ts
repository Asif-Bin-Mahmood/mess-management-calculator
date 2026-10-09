import { describe, expect, it } from 'vitest'
import { downloadAndInstall, isOnline, openInstaller, type ApkInstaller } from './installFlow'
import {
  AUTO_CHECK_INTERVAL_MS,
  checkForUpdate,
  compareVersions,
  evaluateRelease,
  installErrorCode,
  installErrorMessage,
  parseVersion,
  UPDATE_FEED,
  UpdateSchedule,
  type AvailableUpdate,
} from './update'

const SHA = 'a56ea0bed2b3db8d576214a9a539340f8fe78f757f5d34989d27613a14450868'
const REPO = 'https://github.com/Asif-Bin-Mahmood/mess-management-calculator'

/** Shape of GitHub's `GET /repos/{repo}/releases/latest` response (only the fields the app reads). */
function release(version: string, over: Record<string, unknown> = {}, asset: Record<string, unknown> = {}) {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    html_url: `${REPO}/releases/tag/v${version}`,
    assets: [
      { name: 'notes.txt', browser_download_url: `${REPO}/releases/download/v${version}/notes.txt`, state: 'uploaded', size: 10 },
      {
        name: `mess-ledger-v${version}.apk`,
        browser_download_url: `${REPO}/releases/download/v${version}/mess-ledger-v${version}.apk`,
        state: 'uploaded',
        size: 3421870,
        digest: `sha256:${SHA}`,
        ...asset,
      },
    ],
    ...over,
  }
}

describe('versions', () => {
  it('parses plain and v-prefixed versions only', () => {
    expect(parseVersion('1.1.0')).toEqual([1, 1, 0])
    expect(parseVersion('v10.2.33')).toEqual([10, 2, 33])
    for (const bad of ['1.1', '1.1.0.1', '1.2.0-beta.1', 'v1.2.0-rc1', 'latest', '', null, 110]) expect(parseVersion(bad)).toBeNull()
  })

  it('compares numerically, not as text', () => {
    const c = (a: string, b: string) => Math.sign(compareVersions(parseVersion(a)!, parseVersion(b)!))
    expect(c('1.10.0', '1.9.9')).toBe(1)
    expect(c('1.1.10', '1.1.9')).toBe(1)
    expect(c('2.0.0', '1.99.99')).toBe(1)
    expect(c('1.1.0', '1.1.0')).toBe(0)
    expect(c('1.0.9', '1.1.0')).toBe(-1)
  })
})

describe('evaluateRelease', () => {
  it('offers a newer stable release with its verified APK', () => {
    const r = evaluateRelease(release('1.2.0'), '1.1.0')
    expect(r).toEqual({
      kind: 'available',
      update: {
        version: '1.2.0',
        apkName: 'mess-ledger-v1.2.0.apk',
        apkUrl: `${REPO}/releases/download/v1.2.0/mess-ledger-v1.2.0.apk`,
        sha256: SHA,
        size: 3421870,
        pageUrl: `${REPO}/releases/tag/v1.2.0`,
      },
    })
  })

  it('no update for the same or an older version', () => {
    expect(evaluateRelease(release('1.1.0'), '1.1.0')).toEqual({ kind: 'current', latest: '1.1.0' })
    expect(evaluateRelease(release('1.0.9'), '1.1.0')).toEqual({ kind: 'current', latest: '1.0.9' })
  })

  it('ignores drafts and prereleases', () => {
    expect(evaluateRelease(release('1.2.0', { prerelease: true }), '1.1.0')).toEqual({ kind: 'current', latest: '1.1.0' })
    expect(evaluateRelease(release('1.2.0', { draft: true }), '1.1.0')).toEqual({ kind: 'current', latest: '1.1.0' })
    expect(evaluateRelease(release('1.2.0', { tag_name: 'v1.2.0-beta.1' }), '1.1.0')).toMatchObject({ kind: 'error', reason: 'invalid' })
  })

  it.each([
    ['not an object', 'oops'],
    ['missing flags', { tag_name: 'v1.2.0', assets: [] }],
    ['tag without v', release('1.2.0', { tag_name: '1.2.0' })],
    ['no assets', release('1.2.0', { assets: [] })],
    ['assets not a list', release('1.2.0', { assets: 'x' })],
    ['APK for another version', release('1.2.0', {}, { name: 'mess-ledger-v1.1.0.apk' })],
    ['download from another repository', release('1.2.0', {}, { browser_download_url: 'https://github.com/someone/else/releases/download/v1.2.0/mess-ledger-v1.2.0.apk' })],
    ['plain-HTTP download', release('1.2.0', {}, { browser_download_url: `${REPO.replace('https', 'http')}/releases/download/v1.2.0/mess-ledger-v1.2.0.apk` })],
    ['upload incomplete', release('1.2.0', {}, { state: 'starter' })],
    ['no digest', release('1.2.0', {}, { digest: null })],
    ['non-SHA-256 digest', release('1.2.0', {}, { digest: 'md5:abc' })],
    ['malformed digest', release('1.2.0', {}, { digest: 'sha256:XYZ' })],
    ['zero size', release('1.2.0', {}, { size: 0 })],
    ['huge size', release('1.2.0', {}, { size: 500 * 1024 * 1024 })],
  ])('rejects malformed metadata: %s', (_, raw) => {
    expect(evaluateRelease(raw, '1.1.0')).toMatchObject({ kind: 'error', reason: 'invalid' })
  })

  it('rejects two APKs with the expected name', () => {
    const r = release('1.2.0')
    r.assets.push({ ...r.assets[1] })
    expect(evaluateRelease(r, '1.1.0')).toMatchObject({ kind: 'error', reason: 'invalid' })
  })

  it('falls back to the tag page when html_url points elsewhere', () => {
    const r = evaluateRelease(release('1.2.0', { html_url: 'https://evil.example/x' }), '1.1.0')
    expect(r.kind === 'available' && r.update.pageUrl).toBe(`${REPO}/releases/tag/v1.2.0`)
  })
})

describe('checkForUpdate', () => {
  const ok = (data: unknown) => async () => ({ status: 200, data })

  it('asks the public latest-release endpoint', async () => {
    let asked = ''
    await checkForUpdate('1.1.0', async (u) => ((asked = u), { status: 200, data: release('1.1.0') }))
    expect(asked).toBe('https://api.github.com/repos/Asif-Bin-Mahmood/mess-management-calculator/releases/latest')
    expect(UPDATE_FEED).toBe(asked)
  })

  it('finds an update and accepts a JSON string body', async () => {
    expect((await checkForUpdate('1.1.0', ok(release('1.2.0')))).kind).toBe('available')
    expect((await checkForUpdate('1.1.0', ok(JSON.stringify(release('1.2.0'))))).kind).toBe('available')
  })

  it('does not contact the network while offline', async () => {
    let called = false
    const r = await checkForUpdate('1.1.0', async () => ((called = true), { status: 200, data: {} }), false)
    expect(r).toEqual({ kind: 'error', reason: 'offline' })
    expect(called).toBe(false)
  })

  it('reports network failures without throwing', async () => {
    const r = await checkForUpdate('1.1.0', async () => {
      throw new Error('timeout')
    })
    expect(r).toMatchObject({ kind: 'error', reason: 'network' })
  })

  it.each([404, 403, 429, 500, 503])('HTTP %i means updates are unavailable for now', async (status) => {
    expect(await checkForUpdate('1.1.0', async () => ({ status, data: { message: 'x' } }))).toMatchObject({ kind: 'error', reason: 'unavailable' })
  })

  it('rejects non-JSON and unexpected responses', async () => {
    expect(await checkForUpdate('1.1.0', ok('<html>'))).toMatchObject({ kind: 'error', reason: 'invalid' })
    expect(await checkForUpdate('1.1.0', async () => ({ status: 302, data: '' }))).toMatchObject({ kind: 'error', reason: 'network' })
  })

  it('cannot compare with an unreadable installed version', async () => {
    expect(await checkForUpdate('dev', ok(release('1.2.0')))).toMatchObject({ kind: 'error', reason: 'invalid' })
  })
})

describe('UpdateSchedule', () => {
  it('runs automatic checks at most once per interval', () => {
    let stored = 0
    const s = new UpdateSchedule({ get: () => stored, set: (v) => (stored = v) })
    const t0 = 10 * AUTO_CHECK_INTERVAL_MS
    expect(s.takeAutoCheck(t0)).toBe(true)
    expect(s.takeAutoCheck(t0 + 1000)).toBe(false)
    expect(s.takeAutoCheck(t0 + AUTO_CHECK_INTERVAL_MS)).toBe(true)
    expect(stored).toBe(t0 + AUTO_CHECK_INTERVAL_MS)
    // A restarted app remembers the last check; a clock moved backwards does not block checks.
    expect(new UpdateSchedule({ get: () => stored, set: () => {} }).takeAutoCheck(stored + 5)).toBe(false)
    expect(new UpdateSchedule({ get: () => stored, set: () => {} }).takeAutoCheck(stored - 5)).toBe(true)
  })

  it('"Later" silences automatic prompts for that version only, until restart', () => {
    const s = new UpdateSchedule()
    s.postpone('1.2.0')
    expect(s.shouldPrompt('1.2.0', false)).toBe(false)
    expect(s.shouldPrompt('1.2.0', true)).toBe(true) // manual check still offers it
    expect(s.shouldPrompt('1.3.0', false)).toBe(true)
    expect(new UpdateSchedule().shouldPrompt('1.2.0', false)).toBe(true)
  })
})

describe('download and install flow', () => {
  const update: AvailableUpdate = {
    version: '1.2.0',
    apkName: 'mess-ledger-v1.2.0.apk',
    apkUrl: `${REPO}/releases/download/v1.2.0/mess-ledger-v1.2.0.apk`,
    sha256: SHA,
    size: 3421870,
    pageUrl: `${REPO}/releases/tag/v1.2.0`,
  }

  function fake(o: { downloadError?: string; allowed?: boolean; installError?: string } = {}) {
    const calls: string[] = []
    let progress: ((p: { done: number; total: number }) => void) | null = null
    const native: ApkInstaller = {
      async download(a) {
        calls.push(`download ${a.url} ${a.sha256} ${a.size}`)
        progress?.({ done: 1000, total: a.size })
        if (o.downloadError) throw Object.assign(new Error('x'), { code: o.downloadError })
        return { size: a.size }
      },
      async cancel() {},
      async canInstall() {
        calls.push('canInstall')
        return { allowed: o.allowed ?? true }
      },
      async openInstallSettings() {},
      async install() {
        calls.push('install')
        if (o.installError) throw Object.assign(new Error('x'), { code: o.installError })
      },
      async openUrl() {},
      async networkStatus() {
        return { online: true }
      },
      async addListener(_e, cb) {
        progress = cb
        return { remove: async () => void (progress = null) }
      },
    }
    return { native, calls }
  }

  it('downloads with the published checksum, then opens Android’s installer', async () => {
    const { native, calls } = fake()
    const seen: number[] = []
    expect(await downloadAndInstall(update, native, (d) => seen.push(d))).toEqual({ kind: 'installer-opened' })
    expect(calls).toEqual([`download ${update.apkUrl} ${SHA} 3421870`, 'canInstall', 'install'])
    expect(seen).toEqual([1000])
  })

  it.each(['NETWORK', 'CHECKSUM', 'SIGNATURE', 'PACKAGE', 'VERSION', 'STORAGE', 'CANCELLED'])('download failure %s never opens the installer', async (code) => {
    const { native, calls } = fake({ downloadError: code })
    expect(await downloadAndInstall(update, native, () => {})).toEqual({ kind: 'failed', code })
    expect(calls).not.toContain('install')
  })

  it('asks for the unknown-apps permission instead of installing', async () => {
    const { native, calls } = fake({ allowed: false })
    expect(await downloadAndInstall(update, native, () => {})).toEqual({ kind: 'needs-permission' })
    expect(calls).not.toContain('install')
  })

  it('reports an installer that cannot be opened', async () => {
    expect(await openInstaller(fake({ installError: 'INSTALLER' }).native)).toEqual({ kind: 'failed', code: 'INSTALLER' })
    expect(await openInstaller(fake({ installError: 'weird' }).native)).toEqual({ kind: 'failed', code: 'INSTALLER' })
  })

  it('uses Android connectivity, falling back to the browser flag', async () => {
    const { native } = fake()
    expect(await isOnline({ ...native, networkStatus: async () => ({ online: false }) })).toBe(false)
    expect(await isOnline({ ...native, networkStatus: async () => ({ online: true }) })).toBe(true)
    expect(await isOnline({ ...native, networkStatus: async () => Promise.reject(new Error('no plugin')) })).toBe(navigator.onLine)
  })

  it('maps native errors to clear messages', () => {
    expect(installErrorCode({ code: 'CHECKSUM' })).toBe('CHECKSUM')
    expect(installErrorCode(new Error('boom'))).toBe('UNKNOWN')
    expect(installErrorMessage('CHECKSUM')).toMatch(/checksum/)
    expect(installErrorMessage('SIGNATURE')).toMatch(/same key/)
  })
})
