# Mess Ledger

Offline-first Android app (APK) and installable web app (PWA) for a four-member mess — **Asif, Dipu, Yusha, Ovi** —
with two independent ledgers, **Utilities** and **Bazar**, monthly carry-forward, and PDF/PNG/JPEG reports.
All records stay on the manager's phone (IndexedDB). No backend, accounts, sync or analytics.

See [docs/SPEC.md](docs/SPEC.md) for the accounting rules and architecture.

## Commands

```bash
npm install          # once
npm run dev          # development server at http://localhost:5173
npm test             # unit tests (accounting, rounding, carry-forward, isolation, DB, backup, reports)
npm run typecheck    # TypeScript
npm run lint         # oxlint
npm run build        # production build + service worker into dist/
npm run preview      # serve dist/ at http://localhost:4173 (offline/PWA testing)
npm run check        # typecheck + lint + test + build
npm run icons        # regenerate PWA icons (public/) and Android launcher icons
npm run android:sync # web build + copy into the Android project (Capacitor)
```

## Project layout

```
src/domain/   accounting engine (pure, tested): types, money, months, validation, ledger.ts
src/db/       Dexie database, mutations with audit log, backup/restore
src/report/   report model, canvas renderer, minimal PDF writer, export/share
src/ui/       React screens and components
android/      Capacitor Android project (bundles dist/ into the APK)
.github/      GitHub Actions: checks + signed APK build + releases
```

## Android app (APK)

The APK is a standalone app: the web build is bundled inside it and served locally by Capacitor
(`https://localhost` inside the app). It needs no website, tunnel or internet connection; it works in
airplane mode. Data is stored in the app's own IndexedDB on the phone.

- Application ID: `com.asifbinmahmood.messledger` (never change it — updates depend on it)
- Version: `versionName` = `package.json` version; `versionCode` = major·10000 + minor·100 + patch
- Reports and backups open the Android share sheet (Save to Files / Drive / WhatsApp …).
  Restore uses the Android file picker.

### Install / update
1. Download `mess-ledger-vX.Y.Z.apk` from the repository's **Releases** page on the phone.
2. Open it and allow installing from this source when Android asks.
3. Later versions install over the old one and keep the data, because every release is signed with the
   same key. (Uninstalling the app deletes its data — save a backup first.)

### Moving data from the Chrome app (PWA) to the APK
The Chrome-installed app and the APK have separate storage. To move your records:
1. In the **Chrome app**: Backup → What to back up: **Both ledgers** → **Save backup**
   (saves `mess-ledger-backup-….json` to Downloads).
2. Install and open the **APK**: Backup → **Choose backup file** → pick that file.
3. Check the summary and confirm **Replace data**. Nothing is overwritten without this confirmation;
   **Undo last restore** puts the APK's previous data back.
Keep using one of the two apps afterwards; they do not sync.

### Building the APK locally
Requires Node 22+, JDK 21 (Android Studio's bundled `jbr` works) and the Android SDK (platform 36).
```bash
npm run android:sync
```
```bash
cd android && ./gradlew assembleDebug
```
Signed release builds: see *Release signing* below. On Windows, if Gradle fails with
"Unable to establish loopback connection", set `JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:/gtmp`
(the JDK's socket path must not contain spaces).

### Releases (GitHub Actions)
`.github/workflows/android.yml` runs tests, typecheck, lint and the web build, syncs Capacitor and builds
the APK on every push. Pushing a tag `vX.Y.Z` (matching `package.json`) builds a **signed** APK, checks its
certificate against the release key's SHA-256, and attaches it to a GitHub Release. Builds without signing
secrets produce a debug APK artifact only and are never released.

To release: bump `version` in `package.json`, commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`.

### Release signing
The release key is kept **outside the repository** (on the maintainer's PC in `MessLedger-signing/`) and in
GitHub Actions secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`. Certificate SHA-256:
`EE:AE:07:16:75:19:A0:98:48:65:49:1B:8F:66:9D:F8:99:1D:BA:35:65:D5:FC:72:0C:7E:45:53:9E:76:4D:3B`.
Keystores, `keystore.properties` and passwords are gitignored and must never be committed. If the key is
lost, installed apps cannot be updated — keep an offline backup (see `README-BACKUP.txt` next to the key).

## Installing the web app (PWA) on Android

A PWA must be served over **HTTPS** (or `localhost`) to install and to work offline.

1. Deploy the `dist/` folder to any static HTTPS host (e.g. GitHub Pages, Netlify, Cloudflare Pages).
   The build uses relative paths, so a sub-path such as `https://<user>.github.io/<repo>/` works.
2. Open the URL in **Chrome on Android**, wait for the page to load fully once.
3. Chrome menu ⋮ → **Install app** (or **Add to Home screen**). The app also shows an *Install app*
   button under **Backup → This device** when Chrome offers it.
4. Open the installed app once while online so everything is cached; after that it works in airplane mode.
5. In **Backup → This device**, tap *Protected storage → request* so Android does not clear the data
   under storage pressure.

Updates: when a new version is deployed, the app shows *“A new version is ready · Reload”*.
Updating never touches the stored records.

## Backup and restore

- **Backup → Save backup** (both ledgers, or Utilities / Bazar only) writes `mess-ledger-backup-…json` to Downloads
  (or **Share** to send it to Drive / a chat where the phone supports sharing files).
  Do this at least monthly; the home screen reminds you after 14 days.
- **Backup → Choose backup file** validates the file first (structure, amounts, dates, ledger rules,
  duplicate ids), shows what it contains, warns about a backup that was already restored or about newer
  data on the phone, and only after confirmation replaces the records in the backup's scope atomically.
  A Utilities backup never changes Bazar and vice versa. **Undo last restore** puts the replaced records back.
- Deleted entries go to **Backup → Recently deleted** and can be restored.
- Backups and exported reports contain private financial data. They are excluded by `.gitignore`;
  never commit them.

## Monthly closing (per ledger)

Open **Utilities** or **Bazar**, pick the month, and use **Month closing → Close <month>…**. Choose how the
next month starts: **Carry forward**, **Start settled at zero** (settled outside the app or waived; cash is
kept or a counted amount entered), or **Enter verified balances**. A preview shows closing → opening for each
member and the cash before you confirm. Each ledger is closed separately; no backup file is needed.

**Undo this closing** on the closed month reverses the decision (transactions are never deleted). If a later
month of that ledger is also closed, undo the newest closing first; the app guides you.

## Reports

Each ledger has its own **Report** button (top right). Choose the month → preview → PDF / PNG / JPEG →
**Save** (download) or **Share** (Android share sheet, when the browser supports sharing files).
A Utilities report contains only Utilities data and a Bazar report only Bazar data. Reports are generated
on the device and work offline.
