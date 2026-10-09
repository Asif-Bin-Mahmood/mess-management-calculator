import type { CapacitorConfig } from '@capacitor/cli'

// Standalone Android app: the production web build (dist/) is bundled into the APK and served locally.
const config: CapacitorConfig = {
  appId: 'com.asifbinmahmood.messledger',
  appName: 'Mess Ledger',
  webDir: 'dist',
  plugins: {
    // Keep the WebView inside the status/navigation bars (the UI is not designed edge-to-edge).
    SystemBars: { insetsHandling: 'native', initialViewportFitValueHint: 'contain' },
  },
}

export default config
