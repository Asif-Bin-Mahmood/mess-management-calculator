import { CATS5, R4 } from '../domain/testUtils'
import type { MessDb } from './db'

/** Test helper: the household of an upgraded v1.1.1 installation (four original members, five categories). */
export async function seedLegacyHousehold(db: MessDb): Promise<void> {
  await db.members.bulkAdd(R4.map((m) => ({ ...m, periods: m.periods.map((p) => ({ ...p })) })))
  await db.categories.bulkAdd(CATS5.map((c) => ({ ...c })))
}
