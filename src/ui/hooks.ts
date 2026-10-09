import { liveQuery } from 'dexie'
import { useEffect, useState, useSyncExternalStore } from 'react'

/**
 * Subscribes to a Dexie live query; re-renders whenever the queried tables change.
 * `query` must be stable (define it at module level or memoize it).
 */
export function useLive<T>(query: () => Promise<T>): T | undefined {
  const [value, setValue] = useState<T>()
  useEffect(() => {
    const sub = liveQuery(query).subscribe({ next: setValue, error: (e) => console.error(e) })
    return () => sub.unsubscribe()
  }, [query])
  return value
}

function subscribeHash(cb: () => void) {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

/** Current route as path segments, e.g. "#/bazar/edit/abc" → ["bazar", "edit", "abc"]. */
export function useRoute(): string[] {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash)
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean)
}

function depth(): number {
  const d = (history.state as { depth?: number } | null)?.depth
  return typeof d === 'number' ? d : 0
}

/** In-app navigation. Each push records its depth so goBack() knows whether "back" stays in the app. */
export function navigate(path: string, opts: { replace?: boolean } = {}) {
  const target = '#/' + path.replace(/^\//, '')
  if (target === window.location.hash) return
  if (opts.replace) history.replaceState({ depth: depth() }, '', target)
  else history.pushState({ depth: depth() + 1 }, '', target)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

/** Goes back one in-app step (like the Android back gesture), or to `fallback` when opened directly. */
export function goBack(fallback: string) {
  if (depth() > 0) history.back()
  else navigate(fallback, { replace: true })
}

export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage blocked; the value simply is not remembered.
  }
}
