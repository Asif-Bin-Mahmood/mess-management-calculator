import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { db } from '../db/db'
import { addMonths, currentMonth, isValidMonth } from '../domain/month'
import { setHouseholdDisplay } from '../domain/household'
import { AppContext } from './context'
import { householdQuery } from './queries'
import { readLocal, useLive, writeLocal } from './hooks'

const MONTH_KEY = 'mess-ledger:month'
const allTransactions = () => db.transactions.toArray()
const allClosings = () => db.closings.toArray()

export function AppStateProvider({ children }: { children: ReactNode }) {
  const txs = useLive(allTransactions)
  const closingRows = useLive(allClosings)
  const household = useLive(householdQuery)
  const [month, setMonthState] = useState(() => {
    const saved = readLocal(MONTH_KEY)
    return saved && isValidMonth(saved) ? saved : currentMonth()
  })
  const setMonth = useCallback((m: string) => {
    setMonthState(m)
    writeLocal(MONTH_KEY, m)
  }, [])

  const { minMonth, maxMonth } = useMemo(() => {
    const now = currentMonth()
    let lo = now
    let hi = now
    for (const t of txs ?? []) {
      if (t.deletedAt !== undefined) continue
      if (t.month < lo) lo = t.month
      if (t.month > hi) hi = t.month
    }
    return { minMonth: addMonths(lo, -24), maxMonth: addMonths(hi, 1) }
  }, [txs])

  const clamped = month < minMonth ? minMonth : month > maxMonth ? maxMonth : month
  const closings = useMemo(() => closingRows ?? [], [closingRows])
  const ready = closingRows === undefined || household === undefined ? undefined : txs
  const { members, categories } = useMemo(() => {
    const h = household ?? { members: [], categories: [] }
    // Display names are read by memberName()/categoryName() during render (reports included); set them first.
    setHouseholdDisplay(h.members, h.categories)
    return h
  }, [household])
  const value = useMemo(
    () => ({ txs: ready, closings, members, categories, needsSetup: household !== undefined && members.length === 0, month: clamped, setMonth, minMonth, maxMonth }),
    [ready, closings, members, categories, household, clamped, setMonth, minMonth, maxMonth],
  )
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
