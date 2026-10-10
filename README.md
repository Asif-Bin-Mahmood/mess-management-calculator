# Mess Ledger

Mess Ledger is an offline-first accounting app for a shared household or mess of any size. It
tracks shared spending in two separate ledgers, works out what each member is due to pay or will
receive, and produces monthly reports, all on the device and without an account or internet connection.

It is available as an Android app (APK) and can also run as an installable web app (PWA).

## Features

- **Two independent ledgers:** Utilities and Bazar each have their own entries, cash, balances,
  closings and reports. Nothing moves between them.
- **Your household:** any number of members, who can join, leave and rejoin; Utilities categories you
  define, rename and archive.
- **Balances:** each month's spending is shared equally among the members sharing that month. Every
  member's balance shows whether they are **Due** to pay or **Will receive** money back.
- **Monthly closing:** close a month to carry balances forward, start the next month settled at zero, or
  enter verified balances. Closings can be undone.
- **Reports:** concise monthly reports per ledger as PDF, PNG or JPEG, saved or shared from the device.
- **Backup and restore:** JSON backups of both ledgers or a single one. Files are checked before they
  replace anything, and the last restore can be undone.
- **Offline:** everything works without an internet connection.

## Privacy and data storage

All records are stored only on the device where the app is installed. There is no server, account,
synchronization or analytics, and separate installations (for example a phone and a browser) do not
share data.

Local data is lost if the app is uninstalled, its storage is cleared, or the device is lost or reset.
Save backups regularly and keep a copy somewhere else, such as cloud storage. The app reminds you when
the last backup is more than 14 days old.

## Getting started

### Android app (recommended)

1. On the phone, open the
   [Releases](https://github.com/Asif-Bin-Mahmood/mess-management-calculator/releases) page and
   download the latest `mess-ledger-vX.Y.Z.apk`.
2. Open the file and allow installing apps from that source when Android asks.
3. Open **Mess Ledger**. Android 7.0 or later is required.

New versions install over the existing app and keep its records. From version 1.1.1, the app can check
GitHub Releases for updates (**Backup → Check for updates**); Android always asks you to confirm an
installation. Earlier versions must be updated manually once by installing the new APK.

### Web app (alternative)

The same app can be built and served from any static HTTPS host (see [Development](#development)).
Open it in Chrome, choose **Install app**, and open it once while online so it is available offline.
The web app keeps its own records, separate from the Android app.

## Household setup

On first launch, the app asks how many members share the expenses, their names, and which Utilities
categories to use (suggestions are offered; all are optional). An existing installation keeps its members,
names and categories when it is updated.

- **Members** (**Backup → Household → Members**): add a member, rename one, or record that someone leaves
  or rejoins. Membership counts in whole calendar months and applies to both ledgers. Closed months are
  never changed, so a change starts from the first month that is still open, and a preview shows its effect
  before you confirm. A member who leaves keeps their balance until it is settled; it is never moved onto
  the others. Renaming changes only the displayed name.
- **Utilities categories** (**Backup → Household → Utilities categories**): add, rename or archive.
  Archived categories are no longer offered for new entries but stay on existing entries and in reports.

## Backup and restore

- **Save a backup:** go to **Backup**, choose **Both ledgers**, **Utilities** or **Bazar**, then
  **Save backup**.
- **Restore:** **Backup → Choose backup file**. The app checks the file and shows what it contains;
  nothing changes until you confirm **Replace data**. A Utilities backup only replaces Utilities data,
  and a Bazar backup only Bazar data. **Undo last restore** brings back the previous data.
- **Move between the web app and the Android app:** save a **Both ledgers** backup in one, then restore
  it in the other.

After a restore, check the balances and recent entries before uninstalling or clearing the previous
installation. Backups contain private financial records, so store and share them carefully.

## Development

Requires Node.js 22 or later. The Android build also requires JDK 21 and the Android SDK (platform 36).

```bash
npm install          # install dependencies
npm run dev          # start the development server
npm test             # run unit tests
npm run typecheck    # check TypeScript types
npm run lint         # run the linter
npm run build        # production web build in dist/
npm run check        # typecheck, lint, test and build
```

Build a debug Android APK:

```bash
npm run android:sync
cd android && ./gradlew assembleDebug
```

Accounting rules and architecture: [docs/SPEC.md](docs/SPEC.md).
Versioning, signing and publishing releases: [docs/RELEASING.md](docs/RELEASING.md).

## License

Mess Ledger is released under the [MIT License](LICENSE).
