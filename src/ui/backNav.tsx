/**
 * Back navigation shared by the Android system Back button and the in-app back arrows.
 *
 * Priority:
 *  1. an open sheet/dialog closes (system Back only — the arrow is not reachable behind a sheet);
 *  2. while a restore is running, Back is ignored;
 *  3. a screen with unsaved changes asks before leaving;
 *  4. otherwise go to the previous in-app screen, or to the screen's parent when opened directly;
 *  5. only on Home does Back leave the app (the caller sends it to the background).
 */
import { useEffect, useRef } from 'react'
import { useConfirm } from './context'

export type BackAction = { kind: 'close-overlay' } | { kind: 'blocked' } | { kind: 'ask' } | { kind: 'history' } | { kind: 'navigate'; to: string } | { kind: 'exit' }

const isLedger = (s: string | undefined) => s === 'utilities' || s === 'bazar'

/** Parent of a route; null on Home (the root). Ledger child screens return to their own ledger. */
export function backTarget(route: readonly string[]): string | null {
  const [a, b] = route
  if (!a) return null
  if (isLedger(a) && b) return a // utilities/new/…, bazar/edit/…, bazar/close/…, utilities/report → same ledger
  if (a === 'reports') return isLedger(b) ? b! : ''
  if (a === 'settings' && b) return 'settings' // Members, Utilities categories → Backup & settings
  return '' // top-level tabs (Utilities, Bazar, Backup) → Home
}

export interface BackState {
  overlayOpen: boolean
  blocked: boolean
  guarded: boolean
  route: readonly string[]
  /** Number of in-app history entries pushed before this one. */
  depth: number
}

/** Pure decision, used by performBack and tested directly. */
export function decideBack(s: BackState, source: 'system' | 'button'): BackAction {
  if (s.blocked) return { kind: 'blocked' }
  if (source === 'system' && s.overlayOpen) return { kind: 'close-overlay' }
  if (s.guarded) return { kind: 'ask' }
  const target = backTarget(s.route)
  if (target === null) return { kind: 'exit' }
  if (s.depth > 0) return { kind: 'history' }
  return { kind: 'navigate', to: target }
}

/* ───────────── Registries (set by open sheets, running restores and dirty forms) ───────────── */

const overlays: (() => void)[] = []
let blockers = 0
let leaveGuard: (() => Promise<boolean>) | null = null

/** An open sheet registers how to close it; returns the unregister function. */
export function pushOverlay(close: () => void): () => void {
  overlays.push(close)
  return () => {
    const i = overlays.lastIndexOf(close)
    if (i >= 0) overlays.splice(i, 1)
  }
}

/** While a critical operation runs (backup restore), Back does nothing. */
export function blockBack(): () => void {
  blockers += 1
  let released = false
  return () => {
    if (!released) blockers -= 1
    released = true
  }
}

function currentRoute(): string[] {
  return window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
}

function historyDepth(): number {
  const d = (history.state as { depth?: number } | null)?.depth
  return typeof d === 'number' ? d : 0
}

export interface BackEnv {
  route: () => readonly string[]
  depth: () => number
  back: () => void
  navigate: (to: string) => void
}

const browserEnv: BackEnv = {
  route: currentRoute,
  depth: historyDepth,
  back: () => history.back(),
  navigate: (to) => {
    const target = '#/' + to
    history.replaceState({ depth: historyDepth() }, '', target)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  },
}

/**
 * Performs one Back step. Resolves true when the app handled it, false when the app is at its root
 * and the platform should leave the app.
 */
export async function performBack(source: 'system' | 'button', env: BackEnv = browserEnv): Promise<boolean> {
  const action = decideBack(
    { overlayOpen: overlays.length > 0, blocked: blockers > 0, guarded: leaveGuard !== null, route: env.route(), depth: env.depth() },
    source,
  )
  switch (action.kind) {
    case 'blocked':
      return true
    case 'close-overlay':
      overlays[overlays.length - 1]()
      return true
    case 'ask': {
      const guard = leaveGuard!
      if (!(await guard())) return true // stay
      leaveGuard = null
      // The confirm sheet may still be registered as an overlay until React re-renders; it is already
      // answered, so continue as a plain navigation step instead of "closing" it again.
      return performBack('button', env)
    }
    case 'history':
      env.back()
      return true
    case 'navigate':
      env.navigate(action.to)
      return true
    case 'exit':
      return false
  }
}

/** While `dirty`, leaving the screen (system Back or the back arrow) asks to discard the changes first. */
export function useLeaveGuard(dirty: boolean, what = 'changes') {
  const confirm = useConfirm()
  const confirmRef = useRef(confirm)
  useEffect(() => {
    confirmRef.current = confirm
  }, [confirm])
  useEffect(() => {
    if (!dirty) return
    const guard = () =>
      confirmRef.current({
        title: `Discard ${what}?`,
        body: <p>{what.charAt(0).toUpperCase() + what.slice(1)} {what.endsWith('changes') ? 'have' : 'has'} not been saved.</p>,
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        danger: true,
      })
    leaveGuard = guard
    return () => {
      if (leaveGuard === guard) leaveGuard = null
    }
  }, [dirty, what])
}

/** Test helper: install a leave guard without React; returns its remover. */
export function setGuardForTest(guard: () => Promise<boolean>): () => void {
  leaveGuard = guard
  return () => {
    if (leaveGuard === guard) leaveGuard = null
  }
}

/** Test helper: clear all registries. */
export function resetBackNav() {
  overlays.length = 0
  blockers = 0
  leaveGuard = null
}

/** True when no sheet is open and no critical operation runs, so an unsolicited prompt may appear. */
export function canInterrupt(): boolean {
  return overlays.length === 0 && blockers === 0
}
