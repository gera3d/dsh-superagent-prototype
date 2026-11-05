/** Quiet lifecycle controls, deliberately separate from staged chat decisions and model recommendations. */
import { useState } from 'react'
import type { PendingDecisionItem } from '../core/decision.ts'
import type { LifecycleAction, LifecycleResult } from '../app/lifecycle-decisions.ts'
import { Button } from './controls.tsx'

export function LifecycleCard({ item, onAction, onTicket }: {
  item: PendingDecisionItem
  onAction: (action: LifecycleAction) => Promise<LifecycleResult>
  onTicket: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [result, setResult] = useState<LifecycleResult>()
  const [linkLabel, setLinkLabel] = useState('Open review')
  const stuck = item.lifecycle?.kind === 'stuck'
  const issueUrl = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/.test(item.lifecycle?.issueUrl ?? '') ? item.lifecycle!.issueUrl : undefined
  const available = item.status === 'pending' && !item.invalidation && result?.execution !== 'retried'
  const act = async (action: LifecycleAction) => {
    if (busy || !available) return
    setBusy(true); setError(undefined); setResult(undefined)
    try {
      const next = await onAction(action)
      setLinkLabel(action === 'open_issue' ? 'Open issue' : action === 'merge' ? 'Review merge on GitHub' : 'Open PR files')
      setResult(next)
      if (action === 'changes_needed') onTicket()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <section aria-label={`${stuck ? 'Stuck' : 'Done'} ticket: ${item.ticketTitle}`} className="dt-lifecycle-card" style={{
    background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: '18px 20px', color: '#e6edf3',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div><small style={{ color: stuck ? '#a6adb7' : '#7bc99a', textTransform: 'uppercase', letterSpacing: '.08em' }}>{stuck ? 'Stuck · needs a nudge' : 'Done · ready for review'}</small>
        <h3 style={{ margin: '6px 0 8px', fontSize: 16 }}>{item.ticketTitle}</h3></div>
      <Button variant="ghost" size="sm" onClick={onTicket}>View ticket</Button>
    </div>
    <p style={{ margin: '4px 0 12px', color: '#a6adb7', lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.context.slice(0, 500)}</p>
    {!stuck && <p style={{ fontSize: 12, margin: '0 0 14px', color: '#a6adb7' }}>{item.lifecycle?.docsOnly
      ? 'Documentation-only files verified by the server. Merge opens GitHub for your review.'
      : 'Try it first — code changes or unverified PR files. Merge is not available.'} Nothing is applied or restarted here.</p>}
    {item.status !== 'pending' && <p role="status">No longer actionable. Refresh for the current ticket state.</p>}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{item.choices.map(choice => choice.id === 'open_issue' && issueUrl
      ? <a key={choice.id} className="dt-btn dt-btn-outline dt-btn-sm" href={issueUrl} target="_blank" rel="noopener noreferrer">Open issue ↗</a>
      : <Button key={choice.id} variant={choice.id === 'retry' || choice.id === 'try_it' ? 'primary' : 'outline'} size="sm" disabled={busy || !available}
        onClick={() => { void act(choice.id as LifecycleAction) }}>{busy ? 'Checking…' : choice.label}</Button>)}</div>
    {error && <p role="alert" style={{ marginBottom: 0 }}>{error}</p>}
    {result && <p role="status" style={{ marginBottom: 0, fontSize: 12 }}>{result.message}{result.url && <> <a href={result.url} target="_blank" rel="noopener noreferrer">{linkLabel} ↗</a></>}</p>}
  </section>
}
