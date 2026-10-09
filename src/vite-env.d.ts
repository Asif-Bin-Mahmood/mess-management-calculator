/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __APP_VERSION__: string

interface ImportMetaEnv {
  /** Test builds only: alternative release feed for the update checker. */
  readonly VITE_UPDATE_FEED?: string
}
