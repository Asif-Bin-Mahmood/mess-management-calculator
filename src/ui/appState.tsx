import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { db } from '../db/db'
import { parseMonthInput } from '../domain/month'
import { initialMonth } from './monthState'
import { setHouseholdDisplay } from '../domain/household'
import { AppContext } from './context'
import { bazarMethodQuery, householdQuery } from './queries'
import { readLocal, useLive, writeLocal } from './hooks'

const MONTH_KEY = 'mess-ledger:month'
const allTransactions = () => db.transactions.toArray()
const allClosings = () => db.closings.toArray()

export function AppStateProvider({ children }: { children: ReactNode }) {
  const txs = useLive(allTransactions)
  const closingRows = useLive(allClosings)
  const household = useLive(householdQuery)
  const methodRow = useLive(bazarMethodQuery)
  // One selected month shared by Home, both ledgers and Reports. Any month of the supported range can be viewed
  // (before the first entry, empty months, future months); viewing never changes data.
  const [month, setMonthState] = useState(() => initialMonth(readLocal(MONTH_KEY)))
  const setMonth = useCallback((m: string) => {
    const next = parseMonthInput(m)
    if (next === null) return // invalid or outside the supported range: keep the current selection
    setMonthState(next)
    writeLocal(MONTH_KEY, next)
  }, [])
  const closings = useMemo(() => closingRows ?? [], [closingRows])
  const ready = closingRows === undefined || household === undefined || methodRow === undefined ? undefined : txs
  const bazarMethod = methodRow?.method ?? null
  const { members, categories } = useMemo(() => {
    const h = household ?? { members: [], categories: [] }
    // Display names are read by memberName()/categoryName() during render (reports included); set them first.
    setHouseholdDisplay(h.members, h.categories)
    return h
  }, [household])
  const value = useMemo(
    () => ({ txs: ready, closings, members, categories, bazarMethod, needsSetup: household !== undefined && members.length === 0, month, setMonth }),
    [ready, closings, members, categories, bazarMethod, household, month, setMonth],
  )
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
