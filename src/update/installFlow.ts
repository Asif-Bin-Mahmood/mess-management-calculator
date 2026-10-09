import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { installErrorCode, type AvailableUpdate, type InstallErrorCode } from './update'

/** Native side: android/app/src/main/java/.../ApkInstallerPlugin.java */
export interface ApkInstaller {
  download(o: { url: string; sha256: string; size: number }): Promise<{ size: number }>
  cancel(): Promise<void>
  canInstall(): Promise<{ allowed: boolean }>
  openInstallSettings(): Promise<void>
  install(): Promise<void>
  openUrl(o: { url: string }): Promise<void>
  networkStatus(): Promise<{ online: boolean }>
  addListener(event: 'downloadProgress', cb: (p: { done: number; total: number }) => void): Promise<PluginListenerHandle>
}

export const ApkInstallerNative = registerPlugin<ApkInstaller>('ApkInstaller')

/** Real connectivity from Android; falls back to the browser flag if the native call fails. */
export async function isOnline(native: ApkInstaller): Promise<boolean> {
  try {
    return (await native.networkStatus()).online
  } catch {
    return navigator.onLine
  }
}

export type InstallStep = { kind: 'installer-opened' } | { kind: 'needs-permission' } | { kind: 'failed'; code: InstallErrorCode }

/** Opens Android's installer if this app is allowed to request installs. */
export async function openInstaller(native: ApkInstaller): Promise<InstallStep> {
  try {
    const { allowed } = await native.canInstall()
    if (!allowed) return { kind: 'needs-permission' }
    await native.install()
    return { kind: 'installer-opened' }
  } catch (e) {
    const code = installErrorCode(e)
    return { kind: 'failed', code: code === 'UNKNOWN' ? 'INSTALLER' : code }
  }
}

/** Downloads and verifies the APK, then opens the installer. Never installs silently. */
export async function downloadAndInstall(u: AvailableUpdate, native: ApkInstaller, onProgress: (done: number, total: number) => void): Promise<InstallStep> {
  const sub = await native.addListener('downloadProgress', (p) => onProgress(p.done, p.total))
  try {
    await native.download({ url: u.apkUrl, sha256: u.sha256, size: u.size })
  } catch (e) {
    return { kind: 'failed', code: installErrorCode(e) }
  } finally {
    void sub.remove()
  }
  return openInstaller(native)
}
