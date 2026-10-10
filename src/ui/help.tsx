/**
 * Optional explanations, shown on request in a help sheet (progressive disclosure). Screens show the action,
 * status and essential information; warnings that matter for a decision stay next to that decision and are
 * never moved in here.
 */
import type { ReactNode } from 'react'
import type { ConfirmFn } from './context'

export type HelpTopic = 'backup' | 'restore' | 'balances' | 'members' | 'categories'

interface HelpEntry {
  /** Accessible name of the icon-only button. */
  label: string
  /** Title of the help sheet. */
  title: string
  body: ReactNode
}

export const HELP: Record<HelpTopic, HelpEntry> = {
  backup: {
    label: 'Backup information',
    title: 'About backups',
    body: (
      <>
        <p>
          <strong>Where your records are:</strong> only on this phone, inside the app. They are not stored online and are not copied anywhere
          automatically.
        </p>
        <p>
          <strong>What can delete them:</strong> uninstalling the app, clearing its data or the browser’s data, or losing, resetting or breaking the phone.
        </p>
        <p>
          <strong>How a backup helps:</strong> it saves everything to a file. Keep a copy somewhere else, for example cloud storage or your own chat, and
          restore it here or on a new phone. Save one regularly; the app reminds you after 14 days.
        </p>
      </>
    ),
  },
  restore: {
    label: 'Restore information',
    title: 'About restoring',
    body: (
      <>
        <p>The file is checked completely and summarized first. Nothing changes until you confirm, and you can undo the last restore.</p>
        <p>A Utilities backup replaces only Utilities, and a Bazar backup only Bazar. A full backup replaces both ledgers and the household.</p>
        <p>
          Members are shared by both ledgers, so a single-ledger backup can only be restored while this phone’s members match it. An older one, made before a
          member joined or left, is refused and nothing changes. Restore a full backup in that case.
        </p>
      </>
    ),
  },
  balances: {
    label: 'How balances work',
    title: 'How balances work',
    body: (
      <>
        <ul className="help-list">
          <li>Each month’s spending is shared equally by the members sharing that month.</li>
          <li>
            <strong>Due</strong> means the member owes money to the mess. <strong>Will receive</strong> means they paid more than their share.
          </li>
          <li>Utilities and Bazar are separate: each has its own cash, balances and closings.</li>
          <li>Balances carry into the next month. Closing a month can instead start it settled at ৳0 or with verified balances.</li>
        </ul>
        <p className="help-example">Example: ৳1,200 spent by 3 members is ৳400 each. A member who paid ৳500 will receive ৳100.</p>
        <details className="help-more">
          <summary>More details</summary>
          <ul className="help-list">
            <li>Shares are exact to the poisha. If spending does not divide evenly, the extra poisha go one each to members in turn, rotating every month.</li>
            <li>A member who leaves keeps their balance until it is settled; it is never moved onto the others.</li>
            <li>Months that are closed never change when members join or leave.</li>
          </ul>
        </details>
      </>
    ),
  },
  members: {
    label: 'Members information',
    title: 'About members',
    body: (
      <>
        <p>Members share expenses in whole calendar months, in both ledgers.</p>
        <p>When someone leaves, choose the last month they share. Their balance stays with them until it is settled. They can rejoin later.</p>
        <p>Closed months never change, so a change can start only after the latest closed month. You see the effect before confirming.</p>
        <p>Renaming changes only the name shown. Only a member who never shared any expenses can be removed completely.</p>
      </>
    ),
  },
  categories: {
    label: 'Categories information',
    title: 'About categories',
    body: (
      <>
        <p>Categories group Utilities expenses.</p>
        <p>Renaming changes the name everywhere, including past entries and reports. Amounts never change.</p>
        <p>Archived categories are not offered for new entries but stay on existing entries. Only a category that was never used can be deleted.</p>
      </>
    ),
  },
}

/** Opens the help sheet for a topic. Resolves when it is closed (Close button, Escape, backdrop or Back). */
export function openHelp(confirm: ConfirmFn, topic: HelpTopic): Promise<boolean> {
  const h = HELP[topic]
  return confirm({ title: h.title, body: h.body, confirmLabel: 'Close', cancelLabel: null, help: true })
}
