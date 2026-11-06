/** Decisions-page selection is handed to the native composer; only native Send resolves it. */
import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { DecisionSubmissionBridge } from './decision-submission.ts'

export const DECISION_HANDOFF_KEY = 'dsh-superagent:decision-handoff'
export const DECISION_HANDOFF_EVENT = 'dsh:decision-handoff'
export interface DecisionHandoff { decisionId: string; choiceId: string; sessionId: string; prompt: string }

export function DecisionHandoffDock({ session, input, inputActions, bridge }: PropsRuntime<'conversation.input.dock'> & { bridge?: DecisionSubmissionBridge }) {
  const readHandoff = () => {
    try {
      const value = JSON.parse(sessionStorage.getItem(DECISION_HANDOFF_KEY) || 'null')
      return value?.sessionId === session.sessionId ? value as DecisionHandoff : undefined
    } catch { return undefined }
  }
  const [handoff, setHandoff] = useState<DecisionHandoff | undefined>(readHandoff)
  const [notice, setNotice] = useState('')
  const [done, setDone] = useState(false)
  useEffect(() => {
    const sync = () => { setHandoff(readHandoff()); setDone(false); setNotice('') }
    sync()
    window.addEventListener(DECISION_HANDOFF_EVENT, sync)
    return () => window.removeEventListener(DECISION_HANDOFF_EVENT, sync)
  }, [session.sessionId])
  useEffect(() => bridge?.watch(session.sessionId), [bridge, session.sessionId])
  useEffect(() => {
    if (!handoff || handoff.sessionId !== session.sessionId || done || input.phase !== 'plain' || session.running) return
    const controller = new AbortController()
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return
      if (!bridge) throw new Error('Linked submission service unavailable. Your draft was not changed.')
      await bridge.stage({ ...handoff, input, inputActions, signal: controller.signal })
      if (controller.signal.aborted) return
      if (sessionStorage.getItem(DECISION_HANDOFF_KEY) === JSON.stringify(handoff)) sessionStorage.removeItem(DECISION_HANDOFF_KEY)
      setDone(true)
      setNotice('Choice staged in the composer. Review it and press Send to record your decision.')
    }).catch(error => {
      if (!controller.signal.aborted) { setDone(true); setNotice(error instanceof Error ? error.message : String(error)) }
    })
    return () => controller.abort()
  // The bridge owns revision-aware input checks. Composer object identity changes
  // (including insertion's own render) must not cancel an in-flight staging call.
  }, [handoff, done, input.phase, session.running, bridge])
  return notice ? <p role="status">{notice}</p> : null
}
