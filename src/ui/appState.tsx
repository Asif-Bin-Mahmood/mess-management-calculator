import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { db } from '../db/db'
import { addMonths, currentMonth, isValidMonth } from '../domain/month'
import { AppContext } from './context'
import { readLocal, useLive, writeLocal } from './hooks'

const MONTH_KEY = 'mess-ledger:month'
const allTransactions = () => db.transactions.toArray()
const allClosings = () => db.closings.toArray()

export function AppStateProvider({ children }: { children: ReactNode }) {
  const txs = useLive(allTransactions)
  const closingRows = useLive(allClosings)
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
  const ready = closingRows === undefined ? undefined : txs
  const value = useMemo(
    () => ({ txs: ready, closings, month: clamped, setMonth, minMonth, maxMonth }),
    [ready, closings, clamped, setMonth, minMonth, maxMonth],
  )
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
