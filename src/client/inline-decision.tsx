/** Supported Session dock extension: end-of-turn alternatives, shared inbox, draft-only selection. */
import { useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AssistantBlock, ConversationNode, ConversationSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PendingDecisionItem } from '../core/decision.ts'
import type { DecisionSubmissionBridge } from './decision-submission.ts'
import { caller, usePoll } from './api.ts'
import { parseInlineAlternatives } from './inline-alternatives.ts'
import css from './inline-decision.css?raw'

export type InlineDecisionProps = PropsRuntime<'conversation.input.dock'> & { submissionBridge?: DecisionSubmissionBridge }
const call = caller(() => ({
  offline: 'Decision service is offline.', notRunning: 'Decision service is not running.',
  serverError: status => `Decision service error (${status}).`,
  requestFailed: status => `Decision request failed (${status}).`,
  setup: () => 'Decision service setup is incomplete.', user: failure => `Decision request rejected: ${failure.code}`,
}))
// StrictMode / multiple conversation occurrences share one creation flight, not duplicate evaluations.
const flights = new Map<string, Promise<void>>()

export function InlineDecision(props: InlineDecisionProps) {
  const [nextStepsOwnsDock, setNextStepsOwnsDock] = useState(() => typeof document !== 'undefined' && document.documentElement.dataset.dshDecisionDockOwner === 'next-steps')
  useEffect(() => {
    const sync = () => setNextStepsOwnsDock(document.documentElement.dataset.dshDecisionDockOwner === 'next-steps')
    sync(); window.addEventListener('dsh:decision-dock-owner', sync)
    return () => window.removeEventListener('dsh:decision-dock-owner', sync)
  }, [])
  // Companion clients honor decisionSubmission.dockOwner; retain compatibility with older Next steps owners.
  return nextStepsOwnsDock ? null : <SessionDecision key={props.session.sessionId} {...props} />
}
function SessionDecision({ session, input, inputActions, useConversation, submissionBridge }: InlineDecisionProps) {
  useEffect(() => submissionBridge?.watch(session.sessionId), [submissionBridge, session.sessionId])
  const chat: ChatSnapshot | undefined = useConversation((snapshot: ConversationSnapshot) => snapshot.views.get('chat'))
  const { data, error, reload } = usePoll(() => call('GET decisions/inbox'), [])
  const [failure, setFailure] = useState<string>()
  const [notice, setNotice] = useState<{ decisionId: string; message: string }>()
  const [creating, setCreating] = useState(false)
  const [retry, setRetry] = useState(0)
  const attempted = useRef<string>()
  const [selection, setSelection] = useState<string>()
  const choosing = useRef(false)
  const mounted = useRef(true)
  const stageAbort = useRef<AbortController>()
  useEffect(() => { mounted.current = true; stageAbort.current = new AbortController(); return () => { mounted.current = false; stageAbort.current?.abort() } }, [])
  const latest = chat?.legacy.nodes.reduce<ConversationNode | undefined>((last, node) => !last || node.seq > last.seq ? node : last, undefined)
  const assistant = latest?.kind === 'assistant' && !latest.interrupted ? latest : undefined
  const text = assistant?.blocks.flatMap((block: AssistantBlock) => block.kind === 'text' ? [block.text] : []).join('\n') ?? ''
  const parsed = parseInlineAlternatives(text)
  const closed = assistant && chat?.timeline.turns.get(assistant.turn)?.status === 'closed'
  const sourceMessageId = assistant ? String(assistant.messageId ?? assistant.seq) : undefined
  const id = sourceMessageId ? `inline:${session.sessionId}:${sourceMessageId}` : undefined
  const idle = !session.running && !session.removed && session.openState === 'open' && !session.pendingSubmissions.length

  useEffect(() => {
    if (!idle || !closed || !parsed || !id || !sourceMessageId || !data || error || attempted.current === `${id}:${retry}`) return
    attempted.current = `${id}:${retry}`
    const existing = data.items.find(item => item.id === id || (item.sessionId === session.sessionId && item.sourceMessageId === sourceMessageId))
    if (existing && (existing.status !== 'pending' || existing.recommendation.recommendedValue)) return
    setCreating(true); setFailure(undefined)
    let flight = flights.get(id)
    if (!flight) {
      flight = (async () => {
        const recommendation = await call('POST decisions/evaluate', { body: { context: text.slice(-24000), sessionId: session.sessionId, ...parsed } })
        // An unranked result is a deliberate fallback: keep the explicit alternatives in generator order rather than treating it as an evaluation failure.
        if (!recommendation.recommendedValue && !recommendation.provider.trim().toLowerCase().startsWith('unranked')) {
          throw new Error(recommendation.rationale || 'No model recommendation is available. Retry evaluation.')
        }
        const item: PendingDecisionItem = {
          id, sessionId: session.sessionId, sourceMessageId, sourceSeq: assistant!.seq, sourceTurn: assistant!.turn,
          ticketTitle: 'Conversation decision', trigger: 'Explicit end-of-turn alternatives',
          status: 'pending', urgency: 'low', createdAt: Date.now(), context: text.slice(-24000),
          ...parsed, recommendation,
        }
        await call('POST decisions/inbox', { body: item })
      })()
      flights.set(id, flight)
      void flight.finally(() => { if (flights.get(id) === flight) flights.delete(id) }).catch(() => {})
    }
    void flight.then(() => { if (mounted.current) void reload() }, reason => {
      if (mounted.current) setFailure(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (mounted.current) setCreating(false) })
    // Depend on stable source identity, not fresh parsing objects or streaming content.
  }, [id, idle, closed, data, error, retry, reload])

  const sessionItems = data?.items.filter(item => item.sessionId === session.sessionId) ?? []
  const pending = sessionItems.filter(item => item.status === 'pending')
  const emptySource = pending.find(item => item.sourceMessageId === sourceMessageId && !item.choices.length && !item.invalidation)
  const hydrated = useRef<string>()
  useEffect(() => {
    if (!idle || !closed || parsed || !emptySource || error || hydrated.current === `${emptySource.id}:${retry}`) return
    hydrated.current = `${emptySource.id}:${retry}`
    const key = `advisor:${emptySource.id}`
    setCreating(true); setFailure(undefined)
    let flight = flights.get(key)
    if (!flight) {
      flight = (async () => {
        const response = await fetch('/next-steps/api/suggest', { method: 'POST', headers: { 'content-type': 'application/json', 'x-next-steps-request': '1' }, body: JSON.stringify({ sessionId: session.sessionId }) })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || `Decision advisor returned ${response.status}`)
      })()
      flights.set(key, flight)
      void flight.finally(() => { if (flights.get(key) === flight) flights.delete(key) }).catch(() => {})
    }
    void flight.then(() => { if (mounted.current) void reload() }, reason => {
      if (mounted.current) setFailure(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (mounted.current) setCreating(false) })
  }, [idle, closed, !!parsed, emptySource?.id, error, retry, reload, session.sessionId])
  // Recorded alternatives stay selectable: a new linked decision preserves the original history.
  const latestResolved = sessionItems.filter(item => item.status === 'resolved').sort((a, b) => b.createdAt - a.createdAt)[0]
  const items = pending.length ? pending : latestResolved ? [latestResolved] : []
  const lastSubmitted = sessionItems.filter(item => item.status === 'resolved' && item.resolutionBasis === 'submitted')
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))[0]
  if (session.removed || session.openState !== 'open' || !chat) return null
  // Never draw an empty placeholder: a new/blank conversation or one with no decisions renders nothing,
  // so the dock cannot take over the composer's place in the layout.
  if (!items.length && !creating && !failure && !notice && !error) return null
  const choose = async (item: PendingDecisionItem, choiceId: string) => {
    const choice = item.choices.find(candidate => candidate.id === choiceId)
    if (!idle || !choice || !['pending', 'resolved'].includes(item.status) || choosing.current || input.phase !== 'plain'
      || (item.status === 'pending' && (item.invalidation || item.staging))) return
    const signal = stageAbort.current?.signal
    const active = () => mounted.current && !signal?.aborted
    choosing.current = true
    setSelection(item.id); setFailure(undefined); setNotice(undefined)
    let restarted = false
    try {
      if (!submissionBridge) throw new Error('Linked submission tracking is unavailable. Nothing was changed or sent.')
      let target = item
      if (item.status === 'resolved') {
        const result = await call('POST decisions/:id/restart', { id: item.id, body: { sessionId: session.sessionId } })
        if (!active()) return
        const child = result.item
        if (result.execution !== 'not_executed' || child.id === item.id || child.parentDecisionId !== item.id
          || child.sessionId !== session.sessionId || !Number.isSafeInteger(child.restartAfterSeq) || child.restartAfterSeq! < 0) throw new Error('Restart returned an unexpected decision. Nothing was sent.')
        restarted = true
        if (child.status !== 'pending' || child.invalidation) throw new Error('The previous follow-up is already closed. Refresh to choose from the latest decision.')
        const childChoice = child.choices.find(candidate => candidate.id === choiceId)
        if (!childChoice || childChoice.label !== choice.label || childChoice.prompt !== choice.prompt) throw new Error('These alternatives changed. Refresh before choosing again.')
        target = child
      }
      const prompt = choice.prompt ?? (choiceId === 'respond' ? `Regarding your question:\n${target.question}\n\nMy response: `
        : choiceId === 'continue' ? `Please continue with the next step you offered:\n${target.question}`
        : choiceId === 'discuss' ? `Before proceeding, please clarify:\n${target.question}` : `For the decision “${target.question}”, choose: ${choice.label}`)
      await submissionBridge.stage({ decisionId: target.id, sessionId: session.sessionId, choiceId, prompt, input, inputActions, signal })
      if (!active()) return
      setNotice({ decisionId: target.id, message: `${restarted ? 'New decision started; the previous recorded choice is preserved. ' : ''}Choice staged.` })
      await reload()
    } catch (reason) { if (active()) setFailure(reason instanceof Error ? reason.message : String(reason)) }
    finally {
      choosing.current = false
      if (active()) { setSelection(undefined); if (restarted) void reload() }
    }
  }
  // An empty/locked composer or a native submission identity is not proof of non-delivery.
  // Only the server's resolved/submitted record confirms the linked response was accepted.
  const awaitingSubmissionConfirmation = (item: PendingDecisionItem) => session.running || !!session.pendingSubmissions.length
    || input.phase !== 'plain' || !input.draft.trim() || !!item.staging?.submissionId || !!item.staging?.candidateSubmission
  return <section className="dsa-decisions" aria-label="Conversation decisions">
    <style>{css}</style>
    <header className="dsa-decisions__header">
      <strong>Agent-Mini · Choose a direction</strong>
      <span className="dsa-decisions__meta">Shared decision queue · {data?.items.filter(item => item.status === 'pending').length ?? 0} pending</span>
    </header>
    {lastSubmitted && !items.some(item => item.id === lastSubmitted.id) && <p className="dsa-decisions__status" role="status" data-decision-receipt={lastSubmitted.id}>
      Previous choice confirmed submitted: {lastSubmitted.choices.find(choice => choice.id === lastSubmitted.resolvedChoice)?.label ?? lastSubmitted.resolvedChoice}. This does not confirm downstream execution.
    </p>}
    {!idle && <p className="dsa-decisions__status" role="status">Conversation is running. Decision choices will be available when it finishes.</p>}
    {!items.length && !creating && !failure && !error && <p className="dsa-decisions__status">No saved decision in this conversation yet. Explicit alternatives will appear here with their rationale and evaluator details.</p>}
    {creating && <p className="dsa-decisions__status" role="status">Evaluating explicit alternatives…</p>}
    {(failure || error) && <p className="dsa-decisions__status" role="alert">{failure || error?.message} <button className="dsa-decisions__retry" type="button" onClick={() => { setRetry(value => value + 1); void reload() }}>Retry</button></p>}
    <div className="dsa-decisions__list">
      {items.map(item => <article key={item.id} className="dsa-decisions__item">
        {notice?.decisionId === item.id && item.status === 'pending' && item.staging && !item.invalidation && <p className="dsa-decisions__status" role="status">
          {notice.message} {awaitingSubmissionConfirmation(item)
            ? 'Awaiting confirmation of the linked submission. Delivery is not yet confirmed for this decision.'
            : 'The decision stays pending until its linked response is confirmed sent. Nothing has been sent.'}
        </p>}
        <p className="dsa-decisions__question">{item.question}</p>
        <p className="dsa-decisions__rationale">{creating && !item.recommendation.recommendedValue && item.sourceMessageId === sourceMessageId ? 'Evaluating explicit alternatives…' : item.recommendation.rationale}</p>
        <div className="dsa-decisions__choices">
          {item.choices.map(choice => {
            const dist = item.recommendation.distribution?.find(d => d.id === choice.id)
            const probability = dist ? dist.probability : (choice.id === item.recommendation.recommendedValue && item.recommendation.confidence ? item.recommendation.confidence : undefined)
            const percent = probability !== undefined && Number.isFinite(probability) && probability > 0 ? Math.round(probability * 100) : undefined

            return <button type="button" key={choice.id} className={`dsa-decisions__choice${choice.id === item.recommendation.recommendedValue ? ' dsa-decisions__choice--suggested' : ''}`} disabled={!idle || !['pending', 'resolved'].includes(item.status) || input.phase !== 'plain' || selection !== undefined || (item.status === 'pending' && (!!item.invalidation || !!item.staging))} onClick={() => choose(item, choice.id)}>
              <span>
                {choice.label}
                {percent !== undefined && <span className="dsa-decisions__badge" style={{ marginLeft: 6, fontWeight: 700 }}>{percent}%</span>}
                {choice.id === item.recommendation.recommendedValue && <span className="dsa-decisions__badge"> · Suggested</span>}
              </span>
              {choice.description && <span className="dsa-decisions__description">{choice.description}</span>}
            </button>
          })}
        </div>
        <div className="dsa-decisions__details">
          <p>Evaluator: {creating && !item.recommendation.recommendedValue && item.sourceMessageId === sourceMessageId ? 'Evaluation in progress' : item.recommendation.provider}. Recommendations are not authorization.</p>
          {item.status === 'pending' && item.staging && !item.invalidation && <p>
            {awaitingSubmissionConfirmation(item) ? 'Choice staged · awaiting submission confirmation. ' : 'Choice staged · awaiting confirmed Send. '}
            <button type="button" className="dsa-decisions__retry" disabled={!submissionBridge} onClick={() => {
              void submissionBridge?.discard(item.id, item.staging!.attemptId).then(async () => {
                if (!mounted.current) return
                setNotice(previous => previous?.decisionId === item.id ? undefined : previous)
                await reload()
              }).catch(reason => { if (mounted.current) setFailure(reason instanceof Error ? reason.message : String(reason)) })
            }}>Discard staged link</button>
          </p>}
          {item.status === 'resolved' && <p role="status">Recorded choice: {item.choices.find(choice => choice.id === item.resolvedChoice)?.label ?? item.resolvedChoice ?? 'Not specified'}. {item.resolutionBasis === 'submitted'
            ? 'Linked response confirmed submitted. This does not confirm downstream execution.'
            : 'Native submission is not confirmed for this historical record.'} Choose any option again to start a new decision; the previous choice is preserved. Selecting again only prepares a new draft.</p>}
        </div>
      </article>)}
    </div>
    {!!pending.length && <p className="dsa-decisions__footer">Insert one alternative into the composer — never execute automatically.</p>}
  </section>
}
