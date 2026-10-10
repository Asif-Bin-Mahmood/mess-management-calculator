import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Checks repository files, so it runs with Node types (tsconfig.node.json), not the app's.
// The display name and icons must agree on every platform; technical identifiers must not change.
const NAME = 'কড়া হিসাব'
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const png = (p: string) => {
  const b = readFileSync(new URL(`../${p}`, import.meta.url))
  expect(b.subarray(1, 4).toString('ascii')).toBe('PNG')
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

describe('branding', () => {
  it('uses the same display name on Android, the PWA and the web page', () => {
    expect(NAME.normalize('NFC')).toBe(NAME)
    expect(read('android/app/src/main/res/values/strings.xml')).toContain(`<string name="app_name">${NAME}</string>`)
    expect(read('android/app/src/main/res/values/strings.xml')).toContain(`<string name="title_activity_main">${NAME}</string>`)
    expect(read('capacitor.config.ts')).toContain(`appName: '${NAME}'`)
    expect(read('vite.config.ts')).toContain(`short_name: '${NAME}'`)
    expect(read('index.html')).toContain(`<title>${NAME}</title>`)
  })

  it('keeps the package identity, update asset name and data identifiers', () => {
    expect(read('capacitor.config.ts')).toContain("appId: 'com.asifbinmahmood.messledger'")
    expect(read('android/app/build.gradle')).toContain('applicationId "com.asifbinmahmood.messledger"')
    expect(read('src/update/update.ts')).toContain('`mess-ledger-v${version}.apk`')
    expect(read('src/db/db.ts')).toContain("export const DB_NAME = 'mess-ledger'")
    expect(read('src/db/backup.ts')).toContain("export const BACKUP_APP = 'mess-ledger'")
  })

  it('has every generated icon at the size its platform expects', () => {
    const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 }
    for (const [d, px] of Object.entries(densities)) {
      const base = `android/app/src/main/res/mipmap-${d}`
      expect(png(`${base}/ic_launcher.png`)).toEqual({ w: px, h: px })
      expect(png(`${base}/ic_launcher_round.png`)).toEqual({ w: px, h: px })
      expect(png(`${base}/ic_launcher_foreground.png`)).toEqual({ w: (px * 108) / 48, h: (px * 108) / 48 })
    }
    expect(png('public/pwa-192.png')).toEqual({ w: 192, h: 192 })
    expect(png('public/pwa-512.png')).toEqual({ w: 512, h: 512 })
    expect(png('public/pwa-maskable-512.png')).toEqual({ w: 512, h: 512 })
    expect(png('public/apple-touch-icon.png')).toEqual({ w: 180, h: 180 })
    expect(png('public/favicon.png')).toEqual({ w: 64, h: 64 })
    const vite = read('vite.config.ts')
    for (const f of ['pwa-192.png', 'pwa-512.png', 'pwa-maskable-512.png', 'favicon.png', 'apple-touch-icon.png']) expect(vite).toContain(f)
  })
})
