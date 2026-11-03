/** Supported Session dock extension: end-of-turn alternatives, shared inbox, draft-only selection. */
import { useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AssistantBlock, ConversationNode, ConversationSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PendingDecisionItem } from '../core/decision.ts'
import { caller, usePoll } from './api.ts'
import { parseInlineAlternatives } from './inline-alternatives.ts'

export type InlineDecisionProps = PropsRuntime<'conversation.input.dock'>
const call = caller(() => ({
  offline: 'Decision service is offline.', notRunning: 'Decision service is not running.',
  serverError: status => `Decision service error (${status}).`,
  requestFailed: status => `Decision request failed (${status}).`,
  setup: () => 'Decision service setup is incomplete.', user: failure => `Decision request rejected: ${failure.code}`,
}))
// StrictMode / multiple conversation occurrences share one creation flight, not duplicate evaluations.
const flights = new Map<string, Promise<void>>()

export function InlineDecision(props: InlineDecisionProps) {
  return <SessionDecision key={props.session.sessionId} {...props} />
}
function SessionDecision({ session, input, inputActions, useConversation }: InlineDecisionProps) {
  const chat: ChatSnapshot | undefined = useConversation((snapshot: ConversationSnapshot) => snapshot.views.get('chat'))
  const { data, error, reload } = usePoll(() => call('GET decisions/inbox'), [])
  const [failure, setFailure] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [retry, setRetry] = useState(0)
  const attempted = useRef<string>()
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
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
    if (data.items.some(item => item.id === id)) return
    setCreating(true); setFailure(undefined)
    let flight = flights.get(id)
    if (!flight) {
      flight = (async () => {
        const recommendation = await call('POST decisions/evaluate', { body: { context: text.slice(-24000), ...parsed } })
        const item: PendingDecisionItem = {
          id, sessionId: session.sessionId, sourceMessageId,
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

  const items = data?.items.filter(item => item.sessionId === session.sessionId && item.status === 'pending') ?? []
  if (!idle || (!items.length && !creating && !failure && !notice)) return null
  const choose = (item: PendingDecisionItem, choiceId: string) => {
    const choice = item.choices.find(candidate => candidate.id === choiceId)
    if (!choice || input.phase !== 'plain') return
    const span = inputActions.captureInsertion()
    const prompt = `${input.draft ? '\n\n' : ''}For the decision “${item.question}”, choose: ${choice.label}`
    if (!inputActions.insertText(prompt, span)) { setFailure('The draft changed or is locked. Try again.'); return }
    inputActions.persistDraft()
    setNotice('Choice inserted into the composer. Review it and press Send; nothing has been sent.')
    // Selection resolves only this inline decision; this ID cannot trigger a ticket retry.
    void call('POST decisions/:id/resolve', { id: item.id, body: { choiceId } }).then(reload).catch(reason => {
      setFailure(`Draft inserted, but the shared queue could not be updated: ${reason instanceof Error ? reason.message : String(reason)}`)
    })
  }
  return <section aria-label="Conversation decisions" style={{ padding: 12, border: '1px solid currentColor', borderRadius: 8, marginBottom: 8, color: 'inherit', background: 'var(--background, transparent)' }}>
    <strong>Choose a direction</strong>
    <small style={{ display: 'block', margin: '4px 0 8px' }}>Shared decision queue · {data?.items.filter(item => item.status === 'pending').length ?? 0} pending</small>
    {creating && <p role="status">Evaluating explicit alternatives…</p>}
    {(failure || error) && <p role="alert">{failure || error?.message} <button type="button" onClick={() => { setRetry(value => value + 1); void reload() }}>Retry</button></p>}
    {notice && <p role="status">{notice}</p>}
    {items.map(item => <article key={item.id} style={{ marginTop: 8 }}>
      <p style={{ margin: '4px 0' }}><strong>{item.question}</strong></p>
      <p style={{ fontSize: 12, margin: '4px 0' }}>{item.recommendation.rationale}</p>
      <small>Evaluator: {item.recommendation.provider}. Recommendations are not authorization.</small>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {item.choices.map(choice => <button type="button" key={choice.id} disabled={input.phase !== 'plain'} onClick={() => choose(item, choice.id)} style={{ textAlign: 'left', padding: 8, color: 'inherit', background: 'transparent', border: '1px solid currentColor', borderRadius: 6 }}>
          {choice.label}{choice.id === item.recommendation.recommendedValue ? ' · Suggested' : ''}
          {choice.description && <small style={{ display: 'block' }}>{choice.description}</small>}
        </button>)}
      </div>
      <small>Insert one alternative into the composer — never execute automatically.</small>
    </article>)}
  </section>
}
