import { createContext, useContext } from 'react'

export interface UpdateApi {
  checking: boolean
  checkNow: () => void
}

export const UpdateContext = createContext<UpdateApi | null>(null)

/** Update controls for Settings; null outside the Android app. */
export function useUpdates(): UpdateApi | null {
  return useContext(UpdateContext)
}
