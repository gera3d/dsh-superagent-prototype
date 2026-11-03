/** Decisions view: Actionable Human-in-the-Loop decision inbox and real-time System One decision runner. */
import { useState, useEffect } from 'react'
import type { DecisionChoice, DecisionEvaluationResult, PendingDecisionItem } from '../core/decision.ts'
import { Button, Icon, Pill, Tag } from './controls.tsx'
import { DecisionCard } from './decision-card.tsx'
import { useAction, usePanel } from './provider.tsx'
import { usePoll } from './api.ts'
import { Hint, LoadState, Section, StatusHead } from './widgets.tsx'

export function DecisionsPage({ filter = 'pending' }: { filter?: 'pending' | 'resolved' | 'all' }) {
  const { t, call, navigate } = usePanel()
  const [tab, setTab] = useState<'inbox' | 'playground'>('inbox')
  const [filterMode, setFilterMode] = useState<'pending' | 'resolved' | 'all'>(filter)
  const [autoPilot, setAutoPilot] = useState<boolean>(() => {
    try { return localStorage.getItem('dsh_jev_autopilot') === 'true' } catch { return false }
  })

  // Poll inbox items
  const { data, error, reload } = usePoll(() => call('GET decisions/inbox'), [])

  // Playground state
  const [pgContext, setPgContext] = useState('Ticket #16: Worker completed the Decisions API integration (012). Tests passing. Supervisor active.')
  const [pgQuestion, setPgQuestion] = useState('What is the optimal next step to deploy and verify this feature?')
  const [pgChoices, setPgChoices] = useState('Hot-reload superagent profile and run live smoke test\nMerge PR to main branch\nRun extended vitest suite with full coverage')
  const [pgResult, setPgResult] = useState<DecisionEvaluationResult | null>(null)
  const [evaluating, setEvaluating] = useState(false)

  const resolveAction = useAction(async (id: string, choiceId: string) => {
    await call('POST decisions/:id/resolve', { id, body: { choiceId } })
    await reload()
  })

  const items = data?.items || []

  // Jev Auto-Pilot: automatically resolve pending items along Jev's recommended route
  useEffect(() => {
    if (!autoPilot) return
    const pendingWithRec = items.filter(i => i.status === 'pending' && i.recommendation?.recommendedValue)
    if (pendingWithRec.length > 0) {
      for (const item of pendingWithRec) {
        resolveAction.run(item.id, item.recommendation.recommendedValue)
      }
    }
  }, [autoPilot, items])

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
    if (filterMode === 'pending') return item.status === 'pending'
    if (filterMode === 'resolved') return item.status === 'resolved'
    return true
  })

  return <>
    <StatusHead hint="Actionable Decision Inbox: unblock autonomous workers with Jev's calibrated recommendations. One click resolves the question and pushes work forward." />

    <div className="dt-filters" style={{ display: 'flex', gap: '8px', marginBottom: '16px', alignItems: 'center' }}>
      <Pill active={tab === 'inbox' && filterMode === 'pending'} onClick={() => { setTab('inbox'); setFilterMode('pending') }}>
        Pending ({items.filter(i => i.status === 'pending').length})
      </Pill>
      <Pill active={tab === 'inbox' && filterMode === 'resolved'} onClick={() => { setTab('inbox'); setFilterMode('resolved') }}>
        Resolved ({items.filter(i => i.status === 'resolved').length})
      </Pill>
      <Pill active={tab === 'inbox' && filterMode === 'all'} onClick={() => { setTab('inbox'); setFilterMode('all') }}>
        All Decisions
      </Pill>
      <span className="dt-filter-gap" style={{ flex: 1 }} />
      <button
        style={{
          background: autoPilot ? '#238636' : '#21262d',
          color: autoPilot ? '#ffffff' : '#8b949e',
          border: autoPilot ? '1px solid #3fb950' : '1px solid #30363d',
          borderRadius: '6px',
          padding: '4px 10px',
          fontSize: '12px',
          fontWeight: 600,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '6px'
        }}
        onClick={() => {
          const next = !autoPilot
          setAutoPilot(next)
          try { localStorage.setItem('dsh_jev_autopilot', String(next)) } catch {}
        }}
        title="When active, automatically unblocks workers by choosing Jev's recommended route"
      >
        <span>{autoPilot ? '⚡' : '⚪'}</span>
        <span>Make Progress (Jev-Pilot: {autoPilot ? 'ON' : 'OFF'})</span>
      </button>
      <Pill active={tab === 'playground'} onClick={() => setTab('playground')}>
        ⚡ Live Model Evaluator
      </Pill>
    </div>

    {autoPilot && (
      <div style={{
        background: 'rgba(35, 134, 54, 0.15)',
        border: '1px solid rgba(63, 185, 80, 0.4)',
        borderRadius: '6px',
        padding: '10px 14px',
        marginBottom: '16px',
        color: '#3fb950',
        fontSize: '12px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <span><strong>⚡ Make Progress Active:</strong> Incoming decisions automatically advance along Jev's highest-confidence route.</span>
        <span style={{ fontSize: '11px', opacity: 0.8 }}>Calibrated Confidence &gt; 85%</span>
      </div>
    )}

    <LoadState error={error} loading={!data && tab === 'inbox'} />

    {tab === 'inbox' && <div className="dt-inbox-view">
      {shownItems.length === 0 ? <Hint>No decisions matching the selected filter.</Hint> : <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {shownItems.map(item => <div key={item.id} style={{
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
            <strong>Obstacle: </strong>{item.trigger}
          </div>

          {item.status === 'resolved' ? <div style={{ background: '#161b22', border: '1px solid #238636', borderRadius: '6px', padding: '10px 14px', color: '#3fb950', fontWeight: 600, fontSize: '12px' }}>
            ✅ Resolved: Option <strong>{item.resolvedChoice}</strong> accepted. Worker unblocked and task proceeding!
          </div> : <DecisionCard
            title={item.question}
            recommendation={item.recommendation}
            choices={item.choices}
            onExecute={choiceId => resolveAction.run(item.id, choiceId)}
          />}
        </div>)}
      </div>}
    </div>}

    {tab === 'playground' && <div style={{ background: '#1c2128', border: '1px solid #30363d', borderRadius: '8px', padding: '20px' }}>
      <h3 style={{ color: '#f0f6fc', marginBottom: '8px' }}>Real-Time System One Evaluator</h3>
      <p style={{ color: '#8b949e', fontSize: '12px', marginBottom: '16px' }}>
        Test decision scoring live against DeepSeek or Jev models. Pass state context and candidate options to calculate probability calibration.
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
        {evaluating ? '⏳ Evaluating via Jev System One...' : '⚡ Evaluate with Decision API'}
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
