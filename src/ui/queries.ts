import { db } from '../db/db'
import { getRestoreUndo } from '../db/backup'
import { loadBazarMethod } from '../db/bazarMethod'
import { loadHousehold } from '../db/repo'

/** Stable live-query functions for useLive(). */
export const lastBackupAtQuery = async (): Promise<number> => ((await db.meta.get('lastBackupAt'))?.value as number | undefined) ?? 0

export const restoreUndoQuery = () => getRestoreUndo()

/** Members and Utilities categories (empty on a fresh installation until the household is set up). */
export const householdQuery = () => loadHousehold()

/** The Bazar method, wrapped so "cash method" (null) is distinguishable from "still loading" (undefined). */
export const bazarMethodQuery = async () => ({ method: await loadBazarMethod() })
