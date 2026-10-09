// Generates the PWA PNG icons (no dependencies). Run: node scripts/generate-icons.mjs
// Motif: a coin split into four equal shares (the four members), one share highlighted.
import { existsSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const BG = [0x1f, 0x4d, 0x3a]
const COIN = [0xf4, 0xf2, 0xec]
const ACCENT = [0xe0, 0xa2, 0x3b]

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Returns [r,g,b,a] for a point in unit coordinates (0..1).
 * opts.bg: 'rounded' (rounded square), 'full' (full bleed), 'circle', or 'none' (transparent, adaptive foreground).
 */
function sample(x, y, { bg, radius = 0.31, gap = 0.03 }) {
  const cx = x - 0.5
  const cy = y - 0.5
  if (bg === 'rounded') {
    const r = 0.22
    const dx = Math.max(r - x, 0, x - (1 - r))
    const dy = Math.max(r - y, 0, y - (1 - r))
    if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0]
  } else if (bg === 'circle' && cx * cx + cy * cy > 0.25) {
    return [0, 0, 0, 0]
  }
  const inCoin = cx * cx + cy * cy <= radius * radius
  if (inCoin && Math.abs(cx) > gap / 2 && Math.abs(cy) > gap / 2) {
    return cx > 0 && cy < 0 ? [...ACCENT, 255] : [...COIN, 255]
  }
  return bg === 'none' ? [0, 0, 0, 0] : [...BG, 255]
}

function render(size, opts) {
  const ss = 4
  const buf = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0, 0]
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, opts)
          acc[0] += c[0] * c[3]
          acc[1] += c[1] * c[3]
          acc[2] += c[2] * c[3]
          acc[3] += c[3]
        }
      const i = (py * size + px) * 4
      const a = acc[3]
      buf[i] = a ? Math.round(acc[0] / a) : 0
      buf[i + 1] = a ? Math.round(acc[1] / a) : 0
      buf[i + 2] = a ? Math.round(acc[2] / a) : 0
      buf[i + 3] = Math.round(a / (ss * ss))
    }
  }
  return png(size, buf)
}

const out = new URL('../public/', import.meta.url)
writeFileSync(new URL('pwa-192.png', out), render(192, { bg: 'rounded' }))
writeFileSync(new URL('pwa-512.png', out), render(512, { bg: 'rounded' }))
writeFileSync(new URL('pwa-maskable-512.png', out), render(512, { bg: 'full', radius: 0.27, gap: 0.026 }))
writeFileSync(new URL('apple-touch-icon.png', out), render(180, { bg: 'full', radius: 0.27, gap: 0.026 }))
console.log('PWA icons written to public/')

// Android launcher icons (Capacitor project). Adaptive foreground: 108dp canvas, art inside the 72dp safe zone.
const res = new URL('../android/app/src/main/res/', import.meta.url)
if (existsSync(res)) {
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
  for (const [d, k] of Object.entries(densities)) {
    const dir = new URL(`mipmap-${d}/`, res)
    writeFileSync(new URL('ic_launcher.png', dir), render(Math.round(48 * k), { bg: 'rounded' }))
    writeFileSync(new URL('ic_launcher_round.png', dir), render(Math.round(48 * k), { bg: 'circle', radius: 0.27, gap: 0.028 }))
    writeFileSync(new URL('ic_launcher_foreground.png', dir), render(Math.round(108 * k), { bg: 'none', radius: 0.21, gap: 0.02 }))
  }
  writeFileSync(
    new URL('values/ic_launcher_background.xml', res),
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#1F4D3A</color>
</resources>
`,
  )
  console.log('Android launcher icons written to android/app/src/main/res/')
}
