import { useCallback, useRef } from 'react'
import { applyMutation, planMutation, requestPersistentStorage, type Mutation } from '../db/repo'
import type { Transaction } from '../domain/types'
import { ImpactView } from './common'
import { useConfirm, useToast, type ConfirmOptions } from './context'

/**
 * Runs a mutation through the safety flow: plan → (confirm, incl. carry-forward impact) → apply.
 * Returns the saved transaction, or null if the user cancelled. Validation errors are thrown.
 */
export function useMutate() {
  const confirm = useConfirm()
  const toast = useToast()
  const persistAsked = useRef(false)

  return useCallback(
    async (m: Mutation, opts: { ask?: ConfirmOptions; done?: string; undo?: Mutation } = {}): Promise<Transaction | null> => {
      const plan = await planMutation(m)
      if (plan.impact || opts.ask) {
        const ask: ConfirmOptions = opts.ask ?? { title: 'Recalculate later months?', confirmLabel: 'Recalculate & save' }
        const ok = await confirm({
          ...ask,
          body: (
            <>
              {ask.body}
              {plan.impact && <ImpactView impact={plan.impact} />}
            </>
          ),
        })
        if (!ok) return null
      }
      const saved = await applyMutation(m)
      if (!persistAsked.current) {
        persistAsked.current = true
        void requestPersistentStorage()
      }
      if (opts.done) {
        const undo = opts.undo
        toast({
          message: opts.done,
          action: undo
            ? {
                label: 'Undo',
                run: () => {
                  applyMutation(undo).catch((e) => toast({ message: String(e), tone: 'error' }))
                },
              }
            : undefined,
        })
      }
      return saved
    },
    [confirm, toast],
  )
}
