import { afterEach, describe, expect, it } from 'vitest'
import { backTarget, blockBack, decideBack, performBack, pushOverlay, resetBackNav, setGuardForTest, type BackEnv } from './backNav'

afterEach(() => resetBackNav())

/** Minimal in-memory navigation for performBack. */
function env(route: string, depth: number) {
  const log: string[] = []
  const e: BackEnv = {
    route: () => route.split('/').filter(Boolean),
    depth: () => depth,
    back: () => log.push('history.back'),
    navigate: (to) => log.push(`navigate:${to}`),
  }
  return { e, log }
}

const base = { overlayOpen: false, blocked: false, guarded: false, depth: 0 }

describe('backTarget: each screen returns to its own parent', () => {
  it.each([
    ['', null], // Home is the root
    ['utilities', ''],
    ['bazar', ''],
    ['settings', ''],
    ['utilities/new/expense', 'utilities'],
    ['utilities/edit/abc', 'utilities'],
    ['bazar/new/contribution', 'bazar'],
    ['bazar/edit/abc', 'bazar'],
    ['bazar/close/2026-09', 'bazar'],
    ['utilities/close/2026-09', 'utilities'],
    ['bazar/report', 'bazar'],
    ['utilities/report', 'utilities'],
    ['reports/bazar', 'bazar'],
  ])('%s → %s', (route, target) => {
    expect(backTarget(route.split('/').filter(Boolean))).toBe(target)
  })

  it('never crosses ledgers: Bazar child screens go to Bazar, Utilities to Utilities', () => {
    for (const child of ['new/expense', 'edit/x', 'close/2026-09', 'report']) {
      expect(backTarget(['bazar', ...child.split('/')])).toBe('bazar')
      expect(backTarget(['utilities', ...child.split('/')])).toBe('utilities')
    }
  })
})

describe('decideBack priority', () => {
  it('closes an open sheet first (system Back)', () => {
    expect(decideBack({ ...base, overlayOpen: true, guarded: true, route: ['bazar', 'new', 'expense'], depth: 2 }, 'system')).toEqual({ kind: 'close-overlay' })
  })
  it('ignores Back while a restore is running', () => {
    expect(decideBack({ ...base, blocked: true, overlayOpen: true, route: ['settings'] }, 'system')).toEqual({ kind: 'blocked' })
  })
  it('asks before leaving a screen with unsaved changes', () => {
    expect(decideBack({ ...base, guarded: true, route: ['bazar', 'new', 'expense'], depth: 1 }, 'system')).toEqual({ kind: 'ask' })
    expect(decideBack({ ...base, guarded: true, route: ['bazar', 'new', 'expense'], depth: 1 }, 'button')).toEqual({ kind: 'ask' })
  })
  it('returns to the previous in-app screen when there is one', () => {
    expect(decideBack({ ...base, route: ['bazar', 'report'], depth: 1 }, 'system')).toEqual({ kind: 'history' })
  })
  it('goes to the parent screen when opened directly (no in-app history)', () => {
    expect(decideBack({ ...base, route: ['utilities', 'edit', 'x'], depth: 0 }, 'system')).toEqual({ kind: 'navigate', to: 'utilities' })
    expect(decideBack({ ...base, route: ['settings'], depth: 0 }, 'system')).toEqual({ kind: 'navigate', to: '' })
  })
  it('only leaves the app from Home', () => {
    expect(decideBack({ ...base, route: [], depth: 0 }, 'system')).toEqual({ kind: 'exit' })
    for (const r of ['utilities', 'bazar', 'settings', 'bazar/report', 'bazar/close/2026-09', 'utilities/new/expense']) {
      expect(decideBack({ ...base, route: r.split('/'), depth: 0 }, 'system').kind).not.toBe('exit')
    }
  })
})

describe('performBack', () => {
  it('closes the top sheet only, then navigates on the next press', async () => {
    const closed: string[] = []
    pushOverlay(() => closed.push('first'))
    const unregister = pushOverlay(() => closed.push('second'))
    const { e, log } = env('bazar/report', 1)
    expect(await performBack('system', e)).toBe(true)
    expect(closed).toEqual(['second'])
    unregister()
    resetBackNav()
    expect(await performBack('system', e)).toBe(true)
    expect(log).toEqual(['history.back'])
  })

  it('does nothing while blocked, and works again after release', async () => {
    const release = blockBack()
    const { e, log } = env('settings', 0)
    expect(await performBack('system', e)).toBe(true)
    expect(log).toEqual([])
    release()
    expect(await performBack('system', e)).toBe(true)
    expect(log).toEqual(['navigate:'])
  })

  it('Discard leaves the screen even while the answered confirm sheet is still registered', async () => {
    const { e, log } = env('bazar/new/expense', 1)
    const guard = setGuardForTest(async () => {
      pushOverlay(() => log.push('stale-close')) // sheet unregisters only after the next render
      return true // user chose Discard
    })
    expect(await performBack('system', e)).toBe(true)
    expect(log).toEqual(['history.back'])
    guard()
  })

  it('Keep editing stays and keeps asking next time', async () => {
    const { e, log } = env('bazar/new/expense', 1)
    let asked = 0
    setGuardForTest(async () => (asked++, false))
    await performBack('system', e)
    await performBack('system', e)
    expect(asked).toBe(2)
    expect(log).toEqual([])
  })

  it('reports "not handled" on Home so the app can go to the background', async () => {
    const { e, log } = env('', 0)
    expect(await performBack('system', e)).toBe(false)
    expect(log).toEqual([])
  })
})
