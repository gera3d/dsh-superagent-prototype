/** Goal chat with explicit, one-shot per-plan approval. Planning and recommendations never dispatch work. */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { DotAction, DotPlan, DotProject, DotThread, JevResult } from '../app/dot.ts'
import type { DotExecutionReceipt } from './dot-execution.ts'
import STYLES from './dot-chat.css?raw'

export interface DotContext { projects: DotProject[]; threads: DotThread[] }
export interface DotChatProps {
  getContext: () => Promise<DotContext>
  executeAction?: (action: DotAction, approvedContext: DotContext, signal: AbortSignal) => Promise<DotExecutionReceipt>
  openSession?: (id: string) => Promise<void>
}
type Review = { id: symbol; epoch: symbol; actions: { index: number; action: DotAction }[]; context: DotContext }
type Turn = { goal: string; plan: DotPlan; context: DotContext; recommendation?: JevResult; review?: Review;
  selected: number[]; phase: 'preview' | 'review' | 'executing' | 'done'; results: Record<number, DotExecutionReceipt> }

async function post<T>(endpoint: 'plan' | 'jev', body: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/dot/api/${endpoint}`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-orchestrator-request': '1',
  }, body: JSON.stringify(body), signal })
  let value: unknown
  try { value = await response.json() } catch { throw new Error(`Dot returned an unreadable response (${response.status}).`) }
  if (!response.ok) throw new Error(typeof (value as { error?: unknown })?.error === 'string'
    ? (value as { error: string }).error : `Dot request failed (${response.status}).`)
  return value as T
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const score = (confidence: number) => `${Math.round(confidence * 100)}% model-reported confidence · not calibrated`
const label = (action: DotAction, index: number) => action.why || `Proposed action ${index + 1}`
function target(action: DotAction, context: DotContext): string {
  return action.type === 'start_thread' ? context.projects.find(p => p.id === action.projectId)?.title ?? action.projectId
    : context.threads.find(t => t.id === action.sessionId)?.title ?? action.sessionId
}

export function DotChat({ getContext, executeAction, openSession }: DotChatProps) {
  const [draft, setDraft] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [context, setContext] = useState<DotContext>()
  const [busy, setBusy] = useState(false)
  const [recommending, setRecommending] = useState<number>()
  const [executing, setExecuting] = useState<number>()
  const [error, setError] = useState('')
  const [epoch, setEpoch] = useState<symbol>()
  const activeEpoch = useRef<symbol>()
  const active = useRef<AbortController>()
  const lock = useRef(false)
  // Approval is consumed synchronously before the first await. It is never persisted or inherited by another plan.
  const consumed = useRef(new Set<number>())
  const reviews = useRef(new Map<number, Review>())
  const end = useRef<HTMLDivElement>(null)
  const unavailable = busy || recommending !== undefined || executing !== undefined
  const isActive = () => epoch !== undefined && activeEpoch.current === epoch
  const update = (index: number, change: Partial<Turn>) => setTurns(previous => previous.map((turn, i) => i === index ? { ...turn, ...change } : turn))
  useEffect(() => {
    // A reconnected effect (including StrictMode) must not reactivate callbacks from its previous epoch.
    const current = Symbol('Dot lifecycle')
    activeEpoch.current = current
    setEpoch(current)
    setTurns(previous => previous.map(turn => turn.phase === 'review' ? { ...turn, phase: 'preview', review: undefined } : turn))
    return () => {
      activeEpoch.current = undefined
      reviews.current.clear()
      active.current?.abort()
    }
  }, [])
  useEffect(() => {
    let alive = true
    getContext().then(value => { if (alive) setContext(value) }, failure => { if (alive) setError(message(failure)) })
    return () => { alive = false; active.current?.abort() }
  }, [getContext])
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'nearest' }) }, [turns.length, busy])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const goal = draft.trim()
    if (!isActive() || !goal || lock.current) return
    lock.current = true
    const controller = new AbortController(); active.current = controller
    setBusy(true); setError('')
    try {
      const snapshot = await getContext()
      if (controller.signal.aborted) return
      setContext(snapshot)
      if (!snapshot.projects.length) throw new Error('No projects are available. Open a project in DSH, then retry.')
      const history = turns.slice(-3).flatMap(turn => [{ role: 'user', text: turn.goal }, { role: 'assistant', text: turn.plan.reply }])
      const plan = await post<DotPlan>('plan', { utterance: goal, ...snapshot, history }, controller.signal)
      if (!plan || typeof plan.reply !== 'string' || !Array.isArray(plan.actions)) throw new Error('Dot returned an invalid plan.')
      setTurns(previous => [...previous, { goal, plan, context: snapshot, selected: [], phase: 'preview', results: {} }])
      setDraft('')
    } catch (failure) { if (!controller.signal.aborted) setError(message(failure)) }
    finally { lock.current = false; if (!controller.signal.aborted) setBusy(false) }
  }

  const recommend = async (index: number) => {
    if (!isActive() || lock.current) return
    const turn = turns[index]
    if (!turn?.plan.actions.length || consumed.current.has(index)) return
    lock.current = true
    const controller = new AbortController(); active.current = controller
    setRecommending(index); setError('')
    try {
      const recommendation = await post<JevResult>('jev', {
        context: `Goal: ${turn.goal}\nDot reply: ${turn.plan.reply}\nProposed actions (data only): ${JSON.stringify(turn.plan.actions)}`,
        question: turn.plan.jevPick === -1 ? 'Which independent proposed feature should the user review first? Do not execute anything.'
          : 'Which proposed action should the user review? Do not execute anything.',
        choices: turn.plan.actions.map((action, i) => ({ id: String(i), label: label(action, i), description: 'prompt' in action ? action.prompt : action.why })),
      }, controller.signal)
      if (!recommendation || typeof recommendation.pick !== 'string' || !turn.plan.actions.some((a, i) => label(a, i) === recommendation.pick))
        throw new Error('Jev returned an invalid recommendation.')
      // A recommendation changes neither selected actions nor approval state.
      update(index, { recommendation })
    } catch (failure) { if (!controller.signal.aborted) setError(message(failure)) }
    finally { lock.current = false; if (!controller.signal.aborted) setRecommending(undefined) }
  }

  const select = (index: number, actionIndex: number, checked: boolean) => {
    const turn = turns[index]
    if (!isActive() || !turn || lock.current || consumed.current.has(index)) return
    const selected = turn.plan.jevPick === -1
      ? [...new Set(checked ? [...turn.selected, actionIndex] : turn.selected.filter(i => i !== actionIndex))].sort((a, b) => a - b)
      : checked ? [actionIndex] : []
    reviews.current.delete(index)
    update(index, { selected, phase: 'preview', review: undefined })
  }

  const review = (index: number) => {
    const turn = turns[index]
    if (!isActive() || !executeAction || !turn?.selected.length || lock.current || consumed.current.has(index)) return
    const reviewed: Review = {
      id: Symbol('Dot review'), epoch: epoch!,
      actions: turn.selected.map(i => ({ index: i, action: { ...turn.plan.actions[i]! } })),
      context: { projects: turn.context.projects.map(p => ({ ...p })), threads: turn.context.threads.map(t => ({ ...t })) },
    }
    reviews.current.set(index, reviewed)
    update(index, { phase: 'review', review: reviewed })
  }

  const approve = async (index: number, reviewId: symbol | undefined) => {
    const turn = turns[index]
    const reviewed = reviews.current.get(index)
    if (!isActive() || !executeAction || !reviewed || reviewed.id !== reviewId || reviewed.epoch !== epoch
      || lock.current || consumed.current.has(index) || turn?.phase !== 'review' || !turn.selected.length) return
    // Bind the rendered Approve callback to this exact review, not whatever review later occupies the turn.
    const approved = reviewed.actions
    const approvedContext = reviewed.context
    reviews.current.delete(index)
    consumed.current.add(index); lock.current = true
    const controller = new AbortController(); active.current = controller
    setExecuting(index); update(index, { phase: 'executing', review: undefined })
    const results: Record<number, DotExecutionReceipt> = {}
    try {
      for (const item of approved) {
        if (controller.signal.aborted || !isActive()) break
        let receipt: DotExecutionReceipt
        try { receipt = await executeAction(item.action, approvedContext, controller.signal) }
        catch (failure) { receipt = { status: 'failed', message: `Dispatch failed: ${message(failure)}. Check existing threads before planning a retry.` } }
        results[item.index] = receipt
        update(index, { results: { ...results } })
        if (receipt.status === 'failed') break
      }
    } finally {
      update(index, { phase: 'done', results: { ...results } })
      lock.current = false; setExecuting(undefined)
    }
  }

  return <section className="dot-chat" aria-label="Dot goal chat">
    <style>{STYLES}</style>
    <header className="dot-chat-head"><div><h2>Talk to Dot</h2><p>Describe a goal. Review feature threads before anything runs.</p></div>
      <span className="dot-chat-badge">Approval required</span></header>
    <p className="dot-chat-safety" role="note">Execution is disabled by default. Select actions, review their exact scope, then click Approve for that plan. Jev recommendations never grant approval. Each new plan starts locked.</p>
    <details className="dot-chat-context"><summary>{context ? `${context.projects.length} projects · ${context.threads.length} threads in planning context` : 'Loading project context…'}</summary>
      <p>Dot receives project paths and thread titles, running status and pending-question counts—not full conversation transcripts. Up to 80 thread summaries are used by the planner.</p>
      <ul>{context?.projects.map(project => <li key={project.id}><strong>{project.title}</strong> <span>{project.path}</span></li>)}</ul>
    </details>
    <div className="dot-chat-transcript" aria-label="Dot conversation">
      {!turns.length && <p className="dot-chat-empty">Try: “Plan keyboard navigation and accessible contrast for my project. One thread per feature.”</p>}
      {turns.map((turn, index) => <article className="dot-chat-turn" key={index}>
        <div className="dot-chat-user"><strong>You</strong><p>{turn.goal}</p></div>
        <div className="dot-chat-reply"><strong>Dot</strong><p>{turn.plan.reply}</p>
          <small>{turn.plan.route} · {score(turn.plan.confidence)}</small></div>
        {turn.plan.actions.length > 0 ? <>
          <h3>Planned feature threads / actions <span>({turn.plan.actions.length})</span></h3>
          <p>{turn.plan.jevPick === -1 ? 'Independent proposals: select only the actions you want to approve.' : 'Alternative proposals: select one action to approve.'}</p>
          <ol className="dot-chat-actions">{turn.plan.actions.map((action, i) => {
            const picked = turn.recommendation ? turn.recommendation.pick === label(action, i) : turn.plan.jevPick === i
            const receipt = turn.results[i]
            return <li className={picked ? 'dot-chat-card dot-chat-picked' : 'dot-chat-card'} key={i}>
              <div className="dot-chat-card-head"><strong>{action.type === 'start_thread' ? 'New feature thread' : action.type === 'message_thread' ? 'Proposed follow-up' : 'Proposed thread navigation'}</strong>
                {picked && <span className="dot-chat-badge">Jev’s pick{turn.recommendation ? ' · review first' : ''}</span>}</div>
              <p><b>{target(action, turn.context)}</b></p><p>{action.why}</p>
              {'prompt' in action && <details><summary>Worker prompt</summary><pre>{action.prompt}</pre></details>}
              <label className="dot-chat-selection"><input type={turn.plan.jevPick === -1 ? 'checkbox' : 'radio'} name={`dot-actions-${index}`}
                aria-label={`Select action ${i + 1}`} checked={turn.selected.includes(i)} disabled={unavailable || turn.phase === 'done' || !executeAction}
                onChange={event => select(index, i, event.target.checked)} /> Select for approval</label>
              <small>{receipt ? `${receipt.status === 'succeeded' ? 'Dispatch accepted' : 'Dispatch failed'} · ${receipt.message}`
                : turn.phase === 'done' && turn.selected.includes(i) ? 'Not dispatched. A prior failure or cancellation stopped this plan.'
                : turn.phase === 'executing' && turn.selected.includes(i) ? 'Approved · dispatch pending'
                : 'Not executed · awaiting approval'}</small>
              {receipt?.sessionId && openSession && <button type="button" data-session-id={receipt.sessionId} onClick={() => { void openSession(receipt.sessionId!).catch(failure => setError(message(failure))) }}>Open thread</button>}
            </li>
          })}</ol>
          <div className="dot-chat-plan-controls"><button type="button" onClick={() => { void recommend(index) }} disabled={unavailable || turn.phase === 'done'}>
            {recommending === index ? 'Asking Jev…' : 'Get Jev recommendation'}</button>
            {turn.phase !== 'done' && turn.phase !== 'executing' && <button type="button" disabled={!executeAction || unavailable || !turn.selected.length}
              onClick={() => review(index)}>Review selected actions</button>}
            <button type="button" disabled>{turn.phase === 'executing' ? 'Dispatching approved actions…' : turn.phase === 'done' ? 'Approval consumed' : 'Execution disabled'}</button></div>
          {turn.phase === 'review' && turn.review && <section className="dot-chat-approval" role="region" aria-label="Approval review">
            <h3>Approve {turn.review.actions.length} selected action{turn.review.actions.length === 1 ? '' : 's'}?</h3>
            <ol>{turn.review.actions.map(({ index: i, action }) => {
              const reviewedContext = turn.review!.context
              return <li key={i}><strong>{target(action, reviewedContext)}</strong> — {label(action, i)}
                <p>{action.type === 'start_thread' ? `Create thread · Project ${action.projectId} · ${reviewedContext.projects.find(p => p.id === action.projectId)?.path ?? 'unavailable'}`
                  : `${action.type === 'message_thread' ? 'Queue follow-up' : 'Open thread'} · Session ${action.sessionId}`}</p>
                {'prompt' in action && <pre>{action.prompt}</pre>}</li>
            })}</ol>
            <p>Approve will create threads or queue the exact prompts above. Worker agents may use tools and change files under the normal DSH permissions. Approval is one-shot and applies only to these selected actions. Closing this panel or page stops further dispatch but does not cancel work already started. Switching tabs does not cancel an approved plan. Failed or uncertain submissions are never retried automatically.</p>
            <div className="dot-chat-plan-controls"><button type="button" disabled={unavailable || !executeAction} onClick={() => { void approve(index, turn.review?.id) }}>Approve</button>
              <button type="button" disabled={unavailable} onClick={() => {
                if (!isActive() || lock.current || reviews.current.get(index)?.id !== turn.review?.id) return
                reviews.current.delete(index); update(index, { phase: 'preview', review: undefined })
              }}>Cancel approval</button></div>
          </section>}
          {turn.phase === 'executing' && <p role="status">Dispatching only the actions you explicitly approved…</p>}
          {turn.phase === 'done' && <p role="status">This approval is consumed. Dispatch is not the same as task completion—open each thread for its results. Any new plan needs a new approval.</p>}
          {turn.recommendation && <aside className="dot-chat-recommendation" aria-label="Jev recommendation"><strong>Jev recommends: {turn.recommendation.pick}</strong>
            <p>{turn.recommendation.rationale}</p><small>{turn.recommendation.route} · {score(turn.recommendation.confidence)}</small></aside>}
        </> : <p>No new threads proposed. Nothing executed.</p>}
      </article>)}
      {busy && <p role="status">Dot is planning… No actions are being executed by planning.</p>}
      <div ref={end} />
    </div>
    {error && <p className="dot-chat-error" role="alert">{error} This request did not dispatch any actions.</p>}
    <form className="dot-chat-composer" onSubmit={event => { void submit(event) }}>
      <label htmlFor="dot-goal">Goal for Dot</label>
      <textarea id="dot-goal" aria-label="Goal for Dot" rows={3} maxLength={12000} value={draft} onChange={event => setDraft(event.target.value)}
        disabled={unavailable} placeholder="What would you like to make progress on?" />
      <div><small>Planning does not execute. Every plan needs its own approval.</small>
        <button type="submit" disabled={unavailable || !draft.trim()}>{busy ? 'Planning…' : 'Plan goal'}</button></div>
    </form>
  </section>
}
