# Mess Ledger — implementation specification

Offline-first PWA (Android-installable) for a four-member mess: **Asif, Dipu, Yusha, Ovi**.
One phone, no backend, no auth, no sync, no analytics.

## Stack

| Concern | Choice |
|---|---|
| UI | React 19 + TypeScript 6 + Vite 8 |
| Storage | IndexedDB via Dexie 4 (schema v2) |
| Offline/install | vite-plugin-pwa 2 (Workbox `generateSW`, `registerType: 'prompt'`) |
| Tests | Vitest 5 + fake-indexeddb |
| Lint | oxlint |
| Reports | Canvas renderer → PNG/JPEG; small in-repo PDF writer (JPEG pages) |

## Two independent ledgers

`utilities` (Utilities Manager) and `bazar` (Bazar Manager) share only member identities, UI components
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

Utilities categories: Service Charge, Current Bill, Gas Bill, Wi-Fi Bill, Others. Bazar has none.
Amounts are positive integer **poisha**; a transaction's month is derived from its date.

## Accounting engine (`src/domain/ledger.ts`, pure)

Per ledger and month:

- cash: `closingCash = openingCash + Σcontributions − ΣmemberRefunds − Σexpenses + ΣexpenseRefunds`
- `share[m]`: `base = floor(totalSpent/4)`, the 0–3 leftover poisha go one each in the order Asif → Dipu → Yusha → Ovi
  starting at `monthIndex mod 4`; shares always sum to totalSpent.
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

Deletion is a soft delete, restorable. Every create/update/delete/restore/close/undo/import is in the audit log.
Historical edits show their carry-forward impact and require confirmation.

## Backup & restore (optional, not needed for month closing)

JSON v2: `{ app, schemaVersion: 2, backupId, exportedAt, scope: 'all'|'utilities'|'bazar', transactions, closings, audit }`.
v1 files are accepted as full backups. Validation covers schema version, ledger identity (every record must
match a single-ledger scope), member ids, amounts, dates, closings, duplicate ids and duplicate closings.
Restore previews the content, detects an identical state, a previously restored backup (by `backupId`) and
local changes newer than the backup; it replaces only the records in scope, merges audit history, and keeps
the replaced records so the last restore can be undone.

## Reports

Built per ledger from the same engine output; contains only that ledger. Includes opening source and
adjustments, members' opening/contribution/share/closing and Due/Will receive, Utilities category totals,
the month's closing decision, a cash reconciliation and a member-balance reconciliation with explained /
unexplained difference, and the month's transactions. PDF (A4, paginated), PNG, JPEG; share or download.
Generated at `#/<ledger>/report` from within each ledger.
