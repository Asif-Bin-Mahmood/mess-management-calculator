# Mess Ledger

Offline-first accounting app for a shared four-member mess, available as an Android app (APK) and an
installable web app (PWA). It keeps two independent ledgers — **Utilities** and **Bazar** — with monthly
closing, carry-forward and shareable reports. All data stays on the device (IndexedDB); there is no
backend, account, sync or analytics.

Accounting rules and architecture: [docs/SPEC.md](docs/SPEC.md).

## Features

- Two fully independent ledgers: entries, balances, closings, reports and restores never cross over.
- Exact integer (poisha) arithmetic; equal shares with a rotating, documented remainder.
- Monthly closing per ledger: carry forward, start settled at zero, or enter verified balances — each undoable.
- Reports as PDF, PNG or JPEG, saved or shared from the device.
- Customizable member names (Backup → Members). Renaming never changes any amount or history.
- JSON backup and restore of both ledgers or one, validated before anything is replaced, with undo.
- Works fully offline, including in airplane mode.

## Development

Requires Node 22+.

```bash
npm install
npm run dev          # development server
npm test             # unit tests
npm run typecheck    # TypeScript
npm run lint         # oxlint
npm run build        # production build + service worker into dist/
npm run preview      # serve dist/ (offline / PWA testing)
npm run check        # typecheck + lint + test + build
npm run icons        # regenerate web and Android icons
npm run android:sync # web build + copy into the Android project (Capacitor)
```

```
src/domain/   accounting engine (pure, tested)
src/db/       Dexie database, audited mutations, backup/restore
src/report/   report model, renderer, PDF writer, export/share
src/ui/       React screens and components
android/      Capacitor Android project (bundles dist/ into the APK)
.github/      CI: checks, APK build, releases
```

## Android app

The web build is bundled into the APK and served locally, so the app needs no server or internet
connection. Reports and backups use the Android share sheet; restore uses the system file picker.

- Application ID: `com.asifbinmahmood.messledger` (fixed — updates depend on it).
- `versionName` is the `package.json` version; `versionCode` = major·10000 + minor·100 + patch.

**Install or update:** download `mess-ledger-vX.Y.Z.apk` from the repository's Releases page, open it,
and allow installation from that source when asked. Newer versions install over older ones and keep
the data. Uninstalling deletes the app's data, so save a backup first.

**Build locally:** requires JDK 21 (Android Studio's bundled JBR works) and the Android SDK (platform 36).

```bash
npm run android:sync
```

```bash
cd android && ./gradlew assembleDebug
```

On Windows, if Gradle reports *"Unable to establish loopback connection"*, set
`JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:/gtmp` (that socket path must not contain spaces).

### Releases and signing

`.github/workflows/android.yml` runs the tests, typecheck, lint and build and produces an APK on every
push. Pushing a tag `vX.Y.Z` that matches `package.json` builds a signed APK, verifies its certificate,
and attaches it to a GitHub Release. Builds without signing secrets produce only a debug artifact.

The release keystore is never stored in the repository. CI reads it from the Actions secrets
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`.
Keystores, `keystore.properties` and passwords are gitignored. Keep an offline backup of the key: without
it, installed apps cannot be updated. Release certificate SHA-256:
`EE:AE:07:16:75:19:A0:98:48:65:49:1B:8F:66:9D:F8:99:1D:BA:35:65:D5:FC:72:0C:7E:45:53:9E:76:4D:3B`.

## Web app (PWA)

Deploy `dist/` to any static HTTPS host (relative paths, so a sub-path works). Open it once in Chrome on
Android, then use **Install app**. After the first load it works offline. Under **Backup → This device**,
request protected storage so the browser does not evict the data. New versions show a *Reload* prompt;
updating never touches stored records.

The PWA and the APK keep separate storage. To move data, save a backup in one and restore it in the other.

## Using the app

- **Members:** Backup → Members sets the four display names. Names are stored with the data and included
  in backups.
- **Backup:** Backup → Save backup (both ledgers, or one). The home screen reminds you after 14 days.
- **Restore:** Backup → Choose backup file. The file is fully validated and summarized first, and nothing
  changes until you confirm. Restoring one ledger never touches the other. **Undo last restore** brings
  back the replaced data.
- **Monthly closing:** in a ledger, Month closing → Close *month*. A preview shows each member's closing
  and opening balance before you confirm. Undo the newest closing first if several are closed.
- **Reports:** each ledger's **Report** button → choose a month → PDF / PNG / JPEG → Save or Share.
- **Deleted entries** can be recovered from Backup → Recently deleted.

Backups and reports contain private financial data and are excluded by `.gitignore`. Never commit them.
