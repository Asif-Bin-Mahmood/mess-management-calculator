# Mess Ledger — implementation specification

Offline-first PWA (Android-installable) for a shared household or mess of any size. Members and Utilities
categories are configurable records with permanent IDs (see *Household*).
One phone, no backend, no auth, no sync, no analytics.

## Stack

| Concern | Choice |
|---|---|
| UI | React 19 + TypeScript 6 + Vite 8 |
| Storage | IndexedDB via Dexie 4 (schema v4) |
| Offline/install | vite-plugin-pwa 2 (Workbox `generateSW`, `registerType: 'prompt'`) |
| Tests | Vitest 5 + fake-indexeddb |
| Lint | oxlint |
| Reports | Canvas renderer → PNG/JPEG; small in-repo PDF writer (JPEG pages) |

## Two independent ledgers

`utilities` (Utilities Manager) and `bazar` (Bazar Manager) share only the household (members), UI components
and infrastructure. Every transaction, closing record, audit entry, report and ledger backup carries one
ledger; every computation reads only that ledger's records. There are no combined totals, transfers or
cross-ledger reconciliation.

### Transaction types

| type | effect | needs |
|---|---|---|
| `contribution` | member pays cash in | member |
| `memberRefund` | actual cash returned to a member; the form warns (never blocks) when it exceeds the member's will-receive balance or makes the ledger's cash negative | member |
| `expense` | cash paid out | utilities: category |
| `expenseRefund` | money returned by a shop/biller | utilities: category |

Utilities expenses refer to a category from the household's category registry. Bazar has none.
Amounts are positive integer **poisha**; a transaction's month is derived from its date.
Supported calendar range: January 2000 – December 2100 (`MIN_MONTH`/`MAX_MONTH` in `src/domain/month.ts`). Entry
dates, closing months and membership months are validated against it, and the month selector offers exactly
this range: any month can be viewed (before the first entry, empty, or future) and viewing never changes data.
One selected month is shared by Home, both ledgers and Reports. Closing is not offered for empty months more than
one month before a ledger's first entry or closing.

## Accounting engine (`src/domain/ledger.ts`, pure)

Per ledger and month:

- cash: `closingCash = openingCash + Σcontributions − ΣmemberRefunds − Σexpenses + ΣexpenseRefunds`
- sharers: the members whose membership periods include the month, ordered by their permanent position `seq`
  (n of them).
- `share[m]`: `base = floor(totalSpent/n)`, the 0…n−1 leftover poisha go one each to consecutive sharers starting at
  position `monthIndex mod n`; shares always sum to totalSpent. Deterministic. With n = 0 nothing is allocated
  (the app never creates such a month: it refuses expenses and membership changes that would cause it).
- rows shown for a month: every sharer, plus anyone with a balance carried in or an entry that month (e.g. a member
  who left and still owes or is owed money). A non-sharing row has share 0.
- member balance: `closing[m] = opening[m] + netContribution[m] − share[m]`;
  positive = **Will receive**, negative = **Due**.

Cash held by the manager and member settlement balances are tracked separately. Within a month both move
by the same amounts, so `difference = Σ closing balances − closing cash` only changes at a month boundary.

### Monthly closing (independent per ledger, any month)

A `MonthClosing` record (ledger, source month, target month, method, opening values, note, snapshot of the
figures at confirmation, timestamps) sets the next month's opening:

| method | member openings | opening cash |
|---|---|---|
| A `carry` | previous closing balances | previous closing cash |
| B `settled` (`settled` outside app / `waived`) | 0 | previous closing cash, or a counted amount |
| C `manual` | entered verified values | entered value |

Months without a closing carry forward **provisionally** (same figures as A). Openings are derived from the
records, so no transactions are created or duplicated. For each boundary the engine reports the recorded
non-cash member adjustments (settlement/waiver/verified adjustment) and cash adjustment, plus any later
corrections to the closed month (see "Corrections after closing").

**Reconciliation.** `explainedDifference` = cumulative Σ(member adjustments) − Σ(cash adjustments).
`unexplained = difference − explainedDifference` must be 0; any other value is shown as an error, never hidden.

**Safeguards.** One active closing per ledger and source month (re-checked inside the IndexedDB
transaction); a month can be closed only after it has ended by the device's local date (the current month
is not closable); months close in order (a month cannot be closed while a later month of that ledger is closed).

**Corrections after closing.** The adjustment is fixed when the month is closed and stored on the record
(`adjustments` = decided opening − closing figures at closing time, i.e. the snapshot; older records derive it
from the snapshot with the same formula, and an imported value must match it). If a transaction in a closed
month is later added, edited or deleted: member opening = current closing + recorded adjustment, so the
correction is carried into the next month without rewriting the settlement or verified opening; carried cash
follows the correction; counted opening cash is preserved and the correction shows as an **unexplained**
difference until resolved. The correction preview and report show the figures at closing, now, the recorded
adjustment, the correction and the opening now.

### Undo of a closing

Undo marks the record `undoneAt` (kept for history), writes an `undo-close` audit entry, and the target month
returns to provisional carry-forward. Transactions are never touched. Undo is refused while a later closing
of the same ledger exists (guided: undo newest first). When the target month already has transactions the
preview shows how opening and current balances change before confirming. Persisted, so undo works after restart.

## Persistence (`src/db`)

Dexie database `mess-ledger`:
- v1: `transactions`, `audit`, `meta`
- v2: adds `closings` (`id, ledger, [ledger+sourceMonth], createdAt`). Upgrade keeps all v1 data.
- v3: no schema change; an install that already has records keeps its original member names (stored in `meta`).
- v4: adds `members` (`id`) and `categories` (`id`). An existing installation gets member records for the four
  original ids (`asif`, `dipu`, `yusha`, `ovi`, positions 0–3, sharing since the beginning, with the names it showed)
  and the five original categories under their original ids (`service`, `current`, `gas`, `wifi`, `others`).
  No transaction, closing or audit record is modified, so every figure is identical (proven by
  `legacyGolden.test.ts` against v1.1.1 results). A fresh installation starts empty and shows the household setup.

Deletion is a soft delete, restorable. Every create/update/delete/restore/close/undo/import is in the audit log.
Historical edits show their carry-forward impact and require confirmation.

## Backup & restore (optional, not needed for month closing)

JSON v4: `{ app, schemaVersion: 4, backupId, exportedAt, scope: 'all'|'utilities'|'bazar', members, categories, transactions, closings, audit }`
(the whole registry is included in single-ledger backups too). v1–v3 files are still accepted; they are read with
the four original members (v3: with its names) and the five original categories. Validation covers schema version,
ledger identity, the registry, every member/category reference, amounts, dates, closings, duplicate ids, duplicate
closings, and that every month with spending has somebody sharing it.
Restore previews the content, detects an identical state, a previously restored backup (by `backupId`) and
local changes newer than the backup. Nothing is deleted before validation passes and the user confirms.

The restore runs in one IndexedDB transaction: it clears only the records in scope, adds the backup's
records in batches of 200 (reporting progress so the UI stays responsive), merges audit history, and keeps
the replaced records so the last restore can be undone. Any failure rolls the whole transaction back.
A full restore replaces the members and categories with the backup's (for v1–v2 backups, the names this device
already shows for the original members are kept). A single-ledger restore only adds members/categories that are
missing; it never renames or changes existing ones, and it is refused (nothing written) if it would change any
figure of either ledger — e.g. a backup from a household with different members. Undo restores the previous
members and categories too.

## Household

**Members** `{ id, name, seq, createdAt, periods: [{ from?, until? }] }`
- `id` is permanent and never reused; `seq` is a permanent position (display order and leftover-poisha order).
- Periods are whole calendar months, inclusive, household-wide (both ledgers). Missing `from` = since the
  beginning, missing `until` = still a member. Leaving sets `until` (the last month shared); rejoining adds a period.
- A membership change may only take effect from the first month that is open in both ledgers (after the latest
  active closing of either ledger); closed months are never recalculated. The Members screen previews the effect
  on both ledgers' open months before confirming.
- A member who leaves keeps their balance in each ledger. It stays visible (marked "left", share 0) and carries
  forward until it is settled with a contribution or "Returned to member" entry, or by a month closing
  (settled / waived / verified balances). It is never moved onto other members.
- A member referenced by any transaction (including deleted ones) or closing cannot be removed, only ended.
  An unreferenced member (e.g. a setup mistake) can be removed completely.
- Names: trimmed, 1–24 characters, unique (case-insensitive). Renaming only changes the displayed name.

**Utilities categories** `{ id, name, seq, createdAt, archivedAt? }`
- Renaming changes the name shown everywhere, including old entries and reports; amounts never change.
- Archived categories cannot be chosen for new entries (an edited entry may keep its archived category) but stay on
  existing entries, in totals and reports. A category used by any transaction (including deleted ones) cannot be
  deleted, only archived.

Every household change is written atomically with an audit entry (`household-setup`, `member-add`,
`member-update`, `member-delete`, `category-add`, `category-update`, `category-delete`).

## Reports

Built per ledger from the same engine output; contains only that ledger. Includes opening source and
adjustments, members' opening/contribution/share/closing and Due/Will receive (former members marked "left"),
the Utilities categories used that month,
the month's closing decision, a cash reconciliation and a member-balance reconciliation with explained /
unexplained difference, and the month's transactions. PDF (A4, paginated), PNG, JPEG; share or download.
Generated at `#/<ledger>/report` from within each ledger.
