import { db } from '../db/db'
import { getRestoreUndo } from '../db/backup'

/** Stable live-query functions for useLive(). */
export const lastBackupAtQuery = async (): Promise<number> => ((await db.meta.get('lastBackupAt'))?.value as number | undefined) ?? 0

export const restoreUndoQuery = () => getRestoreUndo()
