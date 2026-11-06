/** Decisions view: Actionable Human-in-the-Loop decision inbox and real-time System One decision runner. */
import { useState } from 'react'
import type { DecisionChoice, DecisionEvaluationResult, PendingDecisionItem } from '../core/decision.ts'
import { Button, Icon, Pill, Tag } from './controls.tsx'
import { DecisionCard } from './decision-card.tsx'
import { LifecycleCard } from './lifecycle-card.tsx'
import { decisionNeedsAttention, decisionInHistory } from '../core/publication-queue.ts'
import { parseInlineAlternatives } from './inline-alternatives.ts'
import { useAction, usePanel } from './provider.tsx'
import { usePoll } from './api.ts'
import { Hint, LoadState, Section, StatusHead } from './widgets.tsx'
import { DECISION_HANDOFF_KEY, DECISION_HANDOFF_EVENT } from './decision-handoff.tsx'

export function DecisionsPage({ filter = 'pending' }: { filter?: 'pending' | 'resolved' | 'all' }) {
  const { t, call, navigate, openSession } = usePanel()
  const [tab, setTab] = useState<'inbox' | 'playground'>('inbox')
  const [filterMode, setFilterMode] = useState<'pending' | 'resolved' | 'all'>(filter)
  // Poll inbox items
  const { data, error, reload } = usePoll(() => call('GET decisions/inbox'), [])

  // Playground state
  const [pgContext, setPgContext] = useState('Ticket #16: Worker completed the Decisions API integration (012). Tests passing. Supervisor active.')
  const [pgQuestion, setPgQuestion] = useState('What is the optimal next step to deploy and verify this feature?')
  const [pgChoices, setPgChoices] = useState('Hot-reload superagent profile and run live smoke test\nMerge PR to main branch\nRun extended vitest suite with full coverage')
  const [pgResult, setPgResult] = useState<DecisionEvaluationResult | null>(null)
  const [evaluating, setEvaluating] = useState(false)

  const resolveAction = useAction(async (item: PendingDecisionItem, choiceId: string) => {
    const choice = item.choices.find(choice => choice.id === choiceId)
    if (!choice || !item.sessionId || item.invalidation || item.staging || item.status !== 'pending') throw new Error('This decision cannot be staged. Refresh the inbox.')
    const prompt = choice.prompt ?? (choiceId === 'respond' ? `Regarding your question:\n${item.question}\n\nMy response: `
      : choiceId === 'continue' ? `Please continue with the next step you offered:\n${item.question}`
      : choiceId === 'discuss' ? `Before proceeding, please clarify:\n${item.question}` : `For the decision “${item.question}”, choose: ${choice.label}`)
    const handoff = JSON.stringify({ decisionId: item.id, sessionId: item.sessionId, choiceId, prompt })
    sessionStorage.setItem(DECISION_HANDOFF_KEY, handoff)
    window.dispatchEvent(new Event(DECISION_HANDOFF_EVENT))
    try { await openSession(item.sessionId) }
    catch (error) {
      if (sessionStorage.getItem(DECISION_HANDOFF_KEY) === handoff) sessionStorage.removeItem(DECISION_HANDOFF_KEY)
      throw error
    }
  })

  const items = data?.items || []
  // Evaluate any pending decision with candidate choices.
  const canEvaluate = (item: PendingDecisionItem) => {
    return !item.lifecycle && item.actionMode !== 'ticket_lifecycle' && item.status === 'pending' && !item.staging && !item.invalidation && (!!item.sessionId && (!!item.canonical || !!item.advisor) || item.choices.length >= 2)
  }
  const evaluateItem = async (item: PendingDecisionItem) => {
    if (item.sessionId && (item.canonical || item.advisor)) {
      const ready = await fetch('/next-steps/api/suggest', { method: 'POST', headers: { 'content-type': 'application/json', 'x-next-steps-request': '1' }, body: JSON.stringify({ sessionId: item.sessionId, force: true }) })
      const draft = await ready.json()
      if (!ready.ok) throw new Error(draft.error || 'Shared next steps unavailable. Nothing was changed.')
      if (draft.status === 'ready' && !draft.isScored) {
        await reload() // Show published cards before the optional evaluator finishes.
        await fetch('/next-steps/api/score', { method: 'POST', headers: { 'content-type': 'application/json', 'x-next-steps-request': '1' }, body: JSON.stringify({ sessionId: item.sessionId, key: draft.key }) })
      } else if (draft.status !== 'ready' && draft.reason !== 'drafting') throw new Error('Shared next steps unavailable. Nothing was changed.')
      await reload()
      return
    }
    const recommendation = await call('POST decisions/evaluate', { body: {
      context: item.context, question: item.question, choices: item.choices, sessionId: item.sessionId,
    } })
    if (!recommendation.recommendedValue) throw new Error(recommendation.rationale || 'Recommendation unavailable. No choice was made.')
    await call('POST decisions/inbox', { body: { ...item, recommendation } })
    await reload()
  }

  const runPlayground = async () => {
    setEvaluating(true)
    const choices: DecisionChoice[] = pgChoices.split('\n').filter(Boolean).map((line, i) => ({
      id: `choice_${i + 1}`,
      label: line.trim()
    }))
    try {
      const res = await call('POST decisions/evaluate', {
        body: { context: pgContext, question: pgQuestion, choices }
      })
      setPgResult(res)
    } finally {
      setEvaluating(false)
    }
  }

  const shownItems = items.filter(item => {
    if (filterMode === 'pending') return decisionNeedsAttention(item)
    if (filterMode === 'resolved') return decisionInHistory(item)
    return true
  })

  return <>
    <StatusHead hint="Shared decision inbox. Choose explicitly; recommendations never authorize actions automatically." />

    <div className="dt-filters" style={{ display: 'flex', gap: '8px', marginBottom: '16px', alignItems: 'center' }}>
      <Pill active={tab === 'inbox' && filterMode === 'pending'} onClick={() => { setTab('inbox'); setFilterMode('pending') }}>
        Pending ({items.filter(decisionNeedsAttention).length})
      </Pill>
      <Pill active={tab === 'inbox' && filterMode === 'resolved'} onClick={() => { setTab('inbox'); setFilterMode('resolved') }}>
        History ({items.filter(decisionInHistory).length})
      </Pill>
      <Pill active={tab === 'inbox' && filterMode === 'all'} onClick={() => { setTab('inbox'); setFilterMode('all') }}>
        All Decisions
      </Pill>
      <span className="dt-filter-gap" style={{ flex: 1 }} />
      <Pill active={tab === 'playground'} onClick={() => setTab('playground')}>
        ⚡ Live Model Evaluator
      </Pill>
    </div>

    <LoadState error={error} loading={!data && tab === 'inbox'} />

    {tab === 'inbox' && <div className="dt-inbox-view">
      {shownItems.length === 0 ? <Hint>No decisions matching the selected filter.</Hint> : <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {shownItems.map(item => item.lifecycle ? <LifecycleCard key={item.id} item={item}
          onTicket={() => navigate({ page: 'execution', id: item.ticketId!.replace('#', '') })}
          onAction={async (action, approval) => {
            const result = await call('POST decisions/:id/lifecycle', { id: item.id, body: { action, ...(approval ? { approval } : {}) } })
            if (result.execution === 'retried') await reload()
            return result
          }} /> : <div key={item.id} style={{
          background: '#1c2128',
          border: item.status === 'pending' ? '1px solid #30363d' : '1px solid #238636',
          borderLeft: item.status === 'pending' ? '4px solid #f85149' : '4px solid #238636',
          borderRadius: '8px',
          padding: '18px',
          opacity: item.status === 'resolved' ? 0.75 : 1
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#f0f6fc' }}>
                {item.ticketTitle}
              </span>
              <span style={{
                background: item.urgency === 'high' ? 'rgba(248, 81, 73, 0.15)' : 'rgba(210, 153, 34, 0.15)',
                color: item.urgency === 'high' ? '#f85149' : '#d29922',
                border: item.urgency === 'high' ? '1px solid rgba(248, 81, 73, 0.4)' : '1px solid rgba(210, 153, 34, 0.4)',
                padding: '1px 6px',
                borderRadius: '4px',
                fontSize: '10px',
                fontWeight: 700
              }}>
                {item.urgency === 'high' ? 'BLOCKER' : 'APPROVAL'}
              </span>
            </div>
            {item.ticketId && <Button variant="outline" size="sm" onClick={() => navigate({ page: 'execution', id: item.ticketId!.replace('#', '') })}>
              View Ticket
            </Button>}
          </div>

          <div style={{ background: '#161b22', border: '1px solid #30363d', padding: '10px 14px', borderRadius: '6px', fontSize: '12px', color: '#e6edf3', marginBottom: '12px' }}>
            <strong>Why this is here: </strong>{item.trigger}
          </div>

          {item.status === 'resolved' && <p role="status">Recorded choice: <strong>{item.choices.find(choice => choice.id === item.resolvedChoice)?.label ?? item.resolvedChoice}</strong>. This does not confirm downstream execution.</p>}
          {item.status === 'stale' && <p role="status">No longer actionable: {item.staleReason || 'The source has changed.'}</p>}
          <DecisionCard
            title={item.question}
            stageOnly
            context={item.context}
            recommendation={item.recommendation}
            choices={item.choices}
            character={item.character}
            onOverrideCharacter={item.canonical ? undefined : char => {
              void call('POST decisions/inbox', { body: { ...item, character: char } }).then(() => reload())
            }}
            unavailableReason={item.advisor?.status === 'pending' || item.advisor?.status === 'generating'
              ? 'The next-step advisor has not finished generating guidance.'
              : item.advisor?.status === 'error' ? `Advisor unavailable: ${item.advisor.error || 'Generation failed.'}`
              : !item.choices.length ? 'No candidate choices were provided for this decision.'
              : !item.recommendation.recommendedValue ? 'Click "Get recommendation" to evaluate these choices with the Decision API.' : undefined}
            onEvaluate={canEvaluate(item) ? () => evaluateItem(item) : undefined}
            onExecute={item.status === 'pending' && !item.staging && !item.invalidation && item.sessionId ? choiceId => resolveAction.run(item, choiceId) : undefined}
          />
        </div>)}
      </div>}
    </div>}

    {tab === 'playground' && <div style={{ background: '#1c2128', border: '1px solid #30363d', borderRadius: '8px', padding: '20px' }}>
      <h3 style={{ color: '#f0f6fc', marginBottom: '8px' }}>Decision Evaluator</h3>
      <p style={{ color: '#8b949e', fontSize: '12px', marginBottom: '16px' }}>
        Evaluate mutually exclusive alternatives using the configured provider. Scores are model-reported, not calibrated.
      </p>

      <div style={{ marginBottom: '12px' }}>
        <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px', color: '#c9d1d9', fontSize: '12px' }}>Context / State:</label>
        <textarea
          style={{ width: '100%', background: '#0d1117', border: '1px solid #30363d', color: '#f0f6fc', padding: '10px', borderRadius: '6px', fontSize: '12px', height: '80px', fontFamily: 'inherit' }}
          value={pgContext}
          onChange={e => setPgContext(e.target.value)}
        />
      </div>

      <div style={{ marginBottom: '12px' }}>
        <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px', color: '#c9d1d9', fontSize: '12px' }}>Decision Question:</label>
        <input
          type="text"
          style={{ width: '100%', background: '#0d1117', border: '1px solid #30363d', color: '#f0f6fc', padding: '8px 10px', borderRadius: '6px', fontSize: '12px', fontFamily: 'inherit' }}
          value={pgQuestion}
          onChange={e => setPgQuestion(e.target.value)}
        />
      </div>

      <div style={{ marginBottom: '16px' }}>
        <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px', color: '#c9d1d9', fontSize: '12px' }}>Candidate Choices (one per line):</label>
        <textarea
          style={{ width: '100%', background: '#0d1117', border: '1px solid #30363d', color: '#f0f6fc', padding: '10px', borderRadius: '6px', fontSize: '12px', height: '70px', fontFamily: 'inherit' }}
          value={pgChoices}
          onChange={e => setPgChoices(e.target.value)}
        />
      </div>

      <Button variant="primary" disabled={evaluating} onClick={runPlayground}>
        {evaluating ? 'Evaluating…' : '⚡ Evaluate with Decision API'}
      </Button>

      {pgResult && <div style={{ marginTop: '20px' }}>
        <DecisionCard
          title={pgQuestion}
          recommendation={pgResult}
          choices={pgChoices.split('\n').filter(Boolean).map((line, i) => ({ id: `choice_${i + 1}`, label: line.trim() }))}
          compact
        />
      </div>}
    </div>}
  </>
}
