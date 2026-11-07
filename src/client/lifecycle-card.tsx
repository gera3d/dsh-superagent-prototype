/** Quiet lifecycle controls, deliberately separate from staged chat decisions and model recommendations. */
import { useRef, useState } from 'react'
import type { PendingDecisionItem } from '../core/decision.ts'
import type { LifecycleAction, LifecycleResult } from '../app/lifecycle-decisions.ts'
import type { PublicationSnapshot } from '../app/publication.ts'
import { Button } from './controls.tsx'
import { publicationCompleted } from '../core/publication-queue.ts'

type Approval = { publicationId: string; requestId: string }
export function LifecycleCard({ item, onAction, onTicket, embedded = false }: {
  item: PendingDecisionItem
  embedded?: boolean
  onAction: (action: LifecycleAction, approval?: Approval) => Promise<LifecycleResult>
  onTicket?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const acting = useRef(false)
  const [error, setError] = useState<string>()
  const [response, setResponse] = useState<{ item: PendingDecisionItem; result: LifecycleResult }>()
  const result = response?.item.id === item.id ? response.result : undefined
  const [linkLabel, setLinkLabel] = useState('Open review')
  const stuck = item.lifecycle?.kind === 'stuck'
  const projectedPublication = item.lifecycle?.publication
  // Polling may advance a running operation before the original click returns, or briefly lag its response.
  const useResultPublication = !!result?.publication && (!projectedPublication
    || Date.parse(result.publication.updatedAt) > Date.parse(projectedPublication.updatedAt)
    || result.publication.updatedAt === projectedPublication.updatedAt && response?.item === item)
  const publication = useResultPublication ? result!.publication : projectedPublication
  const settled = publicationCompleted({ ...item, lifecycle: item.lifecycle && { ...item.lifecycle, publication } })
  const publicationStatus = publication?.status === 'published' && !publication.outcomes.some(outcome => outcome.stage === 'verify' && outcome.status === 'succeeded')
    ? 'verification unconfirmed' : publication?.status.replaceAll('_', ' ')
  const issueUrl = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/.test(item.lifecycle?.issueUrl ?? '') ? item.lifecycle!.issueUrl : undefined
  const recovery = !stuck && item.lifecycle?.recovery === true
  const continuation = recovery && item.lifecycle?.continuation === true && !!publication
  const available = !settled && (continuation || !recovery && item.status === 'pending' && !item.invalidation) && result?.execution !== 'retried'
  const rollbackAvailable = !settled && (available || recovery)
  const coordinating = publication?.coordination?.status === 'queued' || publication?.coordination?.status === 'running'
  const controlsBusy = busy || coordinating
  const choices = useResultPublication ? result?.choices ?? item.choices : item.choices
  const offered = (action: LifecycleAction) => choices.some(choice => choice.id === action)
  // A new manifest without projected choices fails closed until the inbox is refreshed.
  const allowed = (action: LifecycleAction) => offered(action) && (!useResultPublication || !!result?.choices)
  const act = async (action: LifecycleAction) => {
    if (acting.current || coordinating || !(action === 'rollback' ? rollbackAvailable : available)) return
    if (recovery && !['prepare_publication', 'publish', 'rollback'].includes(action)) return
    if (!stuck && !(action === 'prepare_publication' ? offered(action) : allowed(action))) return
    if ((action === 'publish' || action === 'rollback') && !publication) return
    acting.current = true
    setBusy(true); setError(undefined)
    try {
      const approval = action === 'publish' || action === 'rollback' ? { publicationId: publication!.id, requestId: crypto.randomUUID() } : undefined
      const next = approval ? await onAction(action, approval) : await onAction(action)
      setLinkLabel(action === 'open_issue' ? 'Open issue' : action === 'merge' ? 'Review merge on GitHub' : 'Open PR files')
      setResponse({ item, result: next })
      if (action === 'changes_needed') onTicket?.()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { acting.current = false; setBusy(false) }
  }
  return <section aria-label={`${settled ? 'Publication history' : stuck ? 'Stuck' : 'Done'} ticket: ${item.ticketTitle}`} className="dt-lifecycle-card" style={embedded ? undefined : {
    background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: '18px 20px', color: '#e6edf3',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div><small style={{ color: stuck ? '#a6adb7' : '#7bc99a', textTransform: 'uppercase', letterSpacing: '.08em' }}>{settled ? `Publication history · ${publicationStatus}` : stuck ? 'Stuck · needs a nudge' : `Done · ${publication ? `publication ${publicationStatus}` : 'publication not reviewed'}`}</small>
        <h3 style={{ margin: '6px 0 8px', fontSize: 16 }}>{item.ticketTitle}</h3></div>
      {onTicket && <Button variant="ghost" size="sm" onClick={onTicket}>View ticket</Button>}
    </div>
    <p style={{ margin: '4px 0 12px', color: '#a6adb7', lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.context.slice(0, 500)}</p>
    {!stuck && <>
      <PublicationEvidence publication={publication} />
      {settled && <p role="status">Publication history · {publicationStatus}. This attempt is settled; no approval or rollback is pending. Rollback is not feature acceptance.</p>}
      {!settled && publication && <p role="status" style={{ fontSize: 12 }}>{continuation ? 'Server-authorized continuation: inspect this pinned publication and explicitly approve only the actions offered by the server. The original decision remains closed; no chat actions.' : recovery ? 'Recovery only: the original decision is closed. Only server-authorized rollback is permitted; no new publication or chat actions.' : coordinating ? `Publication worker ${publication.coordination!.status}. Controls are locked while the explicit request is active.` : available && allowed('publish')
        ? 'Server offers approval for this manifest. Publication gates will be rechecked on your click.'
        : 'Approval is unavailable in the server-projected state. Inspect publication to refresh evidence.'}</p>}
      {!settled && !recovery && <p style={{ fontSize: 12, color: '#a6adb7' }}>Inspect the server-reviewed manifest first. Approval publishes only the pinned changes; rollback is a separate explicit action. No automatic approval or retry.</p>}
    </>}
    {!recovery && item.status !== 'pending' && <p role="status">No longer actionable. Refresh for the current ticket state.</p>}
    {item.invalidation && <p role="status">{recovery ? 'Original decision closed' : 'No longer actionable'}: {item.invalidation.reason}</p>}
    {!settled && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {!stuck && <>
        <Button variant="outline" size="sm" disabled={controlsBusy || !available || !offered('prepare_publication')} onClick={() => { void act('prepare_publication') }}>{busy ? 'Checking…' : 'Inspect publication'}</Button>
        <Button variant="primary" size="sm" disabled={controlsBusy || !available || !publication || !allowed('publish')} onClick={() => { void act('publish') }}>Approve + publish</Button>
        <Button variant="outline" size="sm" disabled={controlsBusy || !rollbackAvailable || !publication || !allowed('rollback')} onClick={() => { void act('rollback') }}>Rollback</Button>
      </>}
      {choices.filter(choice => !recovery && (choice.id !== 'changes_needed' || !!onTicket) && (stuck || ['try_it', 'changes_needed', 'merge'].includes(choice.id))).map(choice => choice.id === 'open_issue' && issueUrl
        ? <a key={choice.id} className="dt-btn dt-btn-outline dt-btn-sm" href={issueUrl} target="_blank" rel="noopener noreferrer">Open issue ↗</a>
        : <Button key={choice.id} variant={choice.id === 'retry' || choice.id === 'try_it' ? 'primary' : 'outline'} size="sm" disabled={controlsBusy || !available}
          onClick={() => { void act(choice.id as LifecycleAction) }}>{busy ? 'Checking…' : choice.label}</Button>)}
    </div>}
    {error && <p role="alert" style={{ marginBottom: 0 }}>{error}</p>}
    {result && <p role="status" style={{ marginBottom: 0, fontSize: 12 }}>{result.message}{result.url && <> <a href={result.url} target="_blank" rel="noopener noreferrer">{linkLabel} ↗</a></>}</p>}
  </section>
}

function PublicationEvidence({ publication: p }: { publication?: PublicationSnapshot }) {
  if (!p) return <p>Publication evidence unavailable. Inspect publication to request the server-reviewed manifest; publishing and rollback are blocked.</p>
  const blocked = p.audit.filter(entry => entry.event === 'gates_blocked').at(-1)
  return <div aria-label="Publication evidence" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
    <dl>
      <dt>Pinned repository / PR</dt><dd>{p.repository} #{p.prNumber}</dd>
      <dt>Pinned head</dt><dd><code>{p.headSha}</code></dd>
      <dt>Pinned patch SHA-256</dt><dd><code>{p.patchSha256}</code></dd>
      <dt>Manifest</dt><dd><code>{p.id}</code></dd>
    </dl>
    {p.coordination && <section aria-label="Publication coordination">
      <h4 style={{ marginBottom: 6 }}>Publication worker: {p.coordination.status}</h4>
      {p.coordination.detail && <p>{p.coordination.detail}</p>}
      <p>Queued: {p.coordination.createdAt} · Updated: {p.coordination.updatedAt}</p>
      {(p.coordination.status === 'queued' || p.coordination.status === 'running') && <p>Explicit request accepted. Waiting for server-reported phase outcomes; no additional approval or automatic retry.</p>}
      {['failed', 'interrupted', 'expired'].includes(p.coordination.status) && <p>Worker {p.coordination.status}. Review the recorded outcomes; no automatic replay.</p>}
    </section>}
    {p.evidence ? <p>Observed: {p.evidence.observedAt} · Checks: {p.evidence.checks} · Review: {p.evidence.review} · PR: {p.evidence.state} · Mergeable: {p.evidence.mergeable ? 'yes' : 'no'}</p>
      : <p>No repository evidence returned by the server. Readiness is unverified.</p>}
    {p.evidence?.local && <section aria-label="Local exact-head review">
      <h4 style={{ marginBottom: 6 }}>Local exact-head review</h4>
      <p>Reviewer: {p.evidence.local.reviewer} · Verdict: {p.evidence.review}</p>
      <p>Review report SHA-256: <code>{p.evidence.local.reportSha256}</code></p>
      {p.evidence.local.reviewExcerpt && <details aria-label="Review evidence">
        <summary>Review evidence</summary>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{p.evidence.local.reviewExcerpt}</pre>
      </details>}
      <h5 style={{ marginBottom: 6 }}>Recorded checks</h5>
      {p.evidence.local.checks.length ? <ul>{p.evidence.local.checks.map((check, index) => <li key={`${check.reportSha256}:${index}`}>
        <strong>{check.name}</strong> · Completed: {check.completedAt}<div>Report SHA-256: <code>{check.reportSha256}</code></div>
        {check.outputExcerpt && <details aria-label={`Check output: ${check.name}`}>
          <summary>Check output: {check.name}</summary>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{check.outputExcerpt}</pre>
        </details>}
      </li>)}</ul> : <p>No local check reports recorded.</p>}
      <h5 style={{ marginBottom: 6 }}>Limitations</h5>
      {p.evidence.local.limitations.length ? <ul>{p.evidence.local.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>
        : <p>No limitations recorded in the local evidence.</p>}
    </section>}
    {p.status === 'blocked' && <p role="status">Publication blocked: {blocked?.detail ?? 'Server has not authorized publication. Inspect publication for current evidence.'}</p>}
    {(p.status === 'failed' || p.status === 'interrupted') && <p role="status">Publication {p.status}. No automatic replay; review phase outcomes and server-authorized rollback.</p>}
    <h4 style={{ marginBottom: 6 }}>Phase outcomes</h4>
    {p.outcomes.length ? <ol>{p.outcomes.map((outcome, index) => <li key={`${outcome.operationId}:${index}`}>
      <strong>{outcome.stage}: {outcome.status}</strong>{outcome.detail && <> — {outcome.detail}</>}
      <div>Started: {outcome.startedAt}{outcome.finishedAt && <> · Finished: {outcome.finishedAt}</>}</div>
    </li>)}</ol> : <p>No publication phases executed.</p>}
  </div>
}
