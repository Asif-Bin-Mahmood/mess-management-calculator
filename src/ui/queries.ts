import { db, MEMBER_NAMES_KEY } from '../db/db'
import { getRestoreUndo } from '../db/backup'
import { loadMemberNames } from '../db/repo'

/** Stable live-query functions for useLive(). */
export const lastBackupAtQuery = async (): Promise<number> => ((await db.meta.get('lastBackupAt'))?.value as number | undefined) ?? 0

export const restoreUndoQuery = () => getRestoreUndo()

/** Display names, and whether they were ever set on this device (false on a fresh installation). */
export const memberNamesQuery = async () => ({ names: await loadMemberNames(), stored: !!(await db.meta.get(MEMBER_NAMES_KEY)) })
