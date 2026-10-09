import { useEffect, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as BeforeInstallPromptEvent
    listeners.forEach((l) => l())
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    listeners.forEach((l) => l())
  })
}

/** Returns a function that shows the browser's install prompt, or null when not available. */
export function useInstallPrompt(): (() => void) | null {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  if (!deferred) return null
  return () => {
    const ev = deferred
    if (!ev) return
    void ev.prompt()
    void ev.userChoice.finally(() => {
      deferred = null
      listeners.forEach((l) => l())
    })
  }
}

/**
 * Registers the service worker. New versions wait until the user taps "Reload";
 * IndexedDB data is untouched by updates.
 */
export function setupServiceWorker(hooks: { onNeedRefresh: (reload: () => void) => void; onOfflineReady: () => void }) {
  const update = registerSW({
    onNeedRefresh: () => hooks.onNeedRefresh(() => void update(true)),
    onOfflineReady: hooks.onOfflineReady,
    // An installed app can stay open for days; check for a new version whenever it comes back to the
    // foreground (only when online, so offline use never waits on the network).
    onRegisteredSW: (_url, registration) => {
      if (!registration) return
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && navigator.onLine) void registration.update().catch(() => {})
      })
    },
  })
}
