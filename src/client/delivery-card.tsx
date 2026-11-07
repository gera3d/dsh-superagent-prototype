/** Canonical delivery presentation on every surface. Confirmation is typed, never chat. */
import { useRef, useState } from 'react'
import type { PendingDecisionItem } from '../core/decision.ts'
import { Button } from './controls.tsx'

export interface DeliveryConfirmation { revision: number; actionId: string }
export function DeliveryCard({ item, onConfirm, onRecheck, onReconcile }: { item: PendingDecisionItem; onConfirm: (request: DeliveryConfirmation) => Promise<unknown>; onRecheck?: (request: { revision: number }) => Promise<unknown>; onReconcile?: (request: DeliveryConfirmation) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  const acting = useRef(false)
  const [error, setError] = useState<string>()
  const [confirmed, setConfirmed] = useState<string>()
  const [rechecked, setRechecked] = useState<string>()
  const [reconciled, setReconciled] = useState<string>()
  const d = item.delivery
  if (!d) return <section role="status">Delivery metadata unavailable. Refresh before confirming.</section>
  const action = d.scopeBinding || d.work?.state === 'superseded' ? undefined : d.nextAction
  const key = `${d.id}:${d.revision}:${action?.id}`
  const available = item.actionMode === 'feature_delivery' && item.status === 'pending' && !item.invalidation
    && !d.scopeBinding && d.state === 'awaiting_decision' && action?.revision === d.revision && !!action.fingerprint && confirmed !== key
  const recordedAdvice = d.recommendation
  const recommendation = recordedAdvice && action && recordedAdvice.actionId === action.id && recordedAdvice.kind === action.kind && recordedAdvice.fingerprint === action.fingerprint && ['take', 'hold'].includes(recordedAdvice.disposition ?? '')
    ? recordedAdvice : undefined
  const endorsed = recommendation?.disposition === 'take'
  const pinnedRefs = [...new Map([...(d.bindings.refs ?? []), ...(d.preparedPublication?.refs ?? [])].map(ref => [JSON.stringify(ref), ref])).values()]
  const recovery = d.reconciliation
  const recoveryKey = `${d.id}:${d.revision}:${recovery?.id}:${recovery?.actionId}`
  const reconcileAvailable = !!onReconcile && item.actionMode === 'feature_delivery' && item.status === 'pending' && !item.invalidation && !d.scopeBinding && d.state === 'blocked' && !!recovery?.id && !!recovery.actionId && recovery.revision === d.revision && reconciled !== recoveryKey
  const reconcile = async () => {
    if (!reconcileAvailable || !recovery || acting.current) return
    acting.current = true; setBusy(true); setError(undefined)
    try { await onReconcile!({ revision: d.revision, actionId: recovery.actionId }); setReconciled(recoveryKey) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { acting.current = false; setBusy(false) }
  }
  const recheckAvailable = !recovery && !!onRecheck && d.state === 'blocked' && !d.scopeBinding && !action && item.status === 'pending' && !item.invalidation && !!d.preparation && d.blocker === d.preparation.message && rechecked !== key
  const recheck = async () => {
    if (!recheckAvailable || acting.current) return
    acting.current = true; setBusy(true); setError(undefined)
    try { await onRecheck!({ revision: d.revision }); setRechecked(key) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { acting.current = false; setBusy(false) }
  }
  const confirm = async () => {
    if (!available || !action || acting.current) return
    acting.current = true; setBusy(true); setError(undefined)
    try { await onConfirm({ revision: d.revision, actionId: action.id }); setConfirmed(key) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { acting.current = false; setBusy(false) }
  }
  return <section id={`delivery-${d.id}`} className="dt-delivery-card" aria-label={`Feature delivery: ${d.title}`} style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 18, color: '#e6edf3' }}>
    <small>Feature delivery · {d.work?.state === 'superseded' ? 'Superseded history' : `${d.stage.replaceAll('_', ' ')} · ${d.work?.state === 'owned' ? 'owned / in progress' : d.work?.state === 'awaiting_direction' ? 'ready for your next step' : d.state.replaceAll('_', ' ')}`}</small>
    <h3>{d.title}</h3>
    <p><strong>Owner: {d.work?.owner ?? d.owner}</strong></p>
    {d.work && <section aria-label="Current work ownership"><p role="status">{d.work.nextStep}</p>
      {d.work.progress && <><p><strong>Latest worker report:</strong> {d.work.progress.length > 480 ? `${d.work.progress.slice(0, 480)}…` : d.work.progress}</p>
        {d.work.progress.length > 480 && <details><summary>Full worker progress report</summary><p style={{ whiteSpace: 'pre-wrap' }}>{d.work.progress}</p></details>}</>}
      {d.work.supersededBy && <p>Superseded by <code>worker-{d.work.supersededBy}</code>. Original dropped-worker history and mandate are unchanged.</p>}
      {!!d.work.replaces?.length && <p>Active replacement for {d.work.replaces.map(id => `worker-${id}`).join(', ')}.</p>}
    </section>}
    {d.scopeBinding && d.work?.state === 'awaiting_direction' && <p role="status">Release handoff needs preparation: the artifact is ready for review, but its deployable source revision, target and acceptance checks are not bound. Preparing a reply does not merge or publish it.</p>}
    {d.blocker && !d.work && <p role="status">Blocked: {d.blocker}</p>}
    {recommendation ? <aside aria-label="Senior Developer recommendation"><strong>{endorsed ? `Senior Developer recommends: ${action!.label}` : 'Senior Developer recommends waiting'}</strong><p>{recommendation.rationale}</p><small>{recommendation.provider} · {recommendation.recordedAt}</small></aside>
      : d.recommendationError && d.work?.state !== 'superseded' ? <p role="status">Senior Developer advice unavailable: {d.recommendationError.message}. Advice failure does not veto an otherwise eligible action.</p> : action ? <p>No current Senior Developer recommendation recorded for this action.</p> : null}
    {action?.kind === 'publish' && <section aria-label="Publication effects"><p><strong>Before publishing:</strong> this confirms the pinned publication for {d.preparedPublication?.repository ?? d.bindings.repository}{d.preparedPublication ? ` PR #${d.preparedPublication.pr}` : ''} in {d.preparedPublication?.environment ?? d.bindings.environment ?? 'the configured environment'}. Inspect all pinned references below before confirming.</p>
      <p><strong>Components:</strong> {d.preparedPublication?.components?.length ? d.preparedPublication.components.join(', ') : 'Not recorded in this publication snapshot.'}</p>
      <p><strong>Effects:</strong> {d.preparedPublication?.effects?.length ? d.preparedPublication.effects.join('; ') : 'Not recorded; no component or restart effects are inferred.'}</p></section>}
    {d.acceptance ? <p role="status">Acceptance recorded by {d.acceptance.actor} at {d.acceptance.at}.</p>
      : <p>Not accepted. {d.work?.state === 'awaiting_direction' ? 'Choose a next step in the Senior Developer suggestions. Release confirmation follows preparation.' : action?.label ?? (d.state === 'running' ? 'Work is in progress.' : 'No confirmation currently offered.')}</p>}
    {available && (endorsed ? <Button variant="primary" disabled={busy} onClick={() => { void confirm() }}>{busy ? 'Confirming…' : `Confirm: ${action!.label}`}</Button>
      : <details><summary>Inspect eligible action / proceed without recommendation</summary><p>{recommendation?.disposition === 'hold' ? 'The Senior Developer recommends waiting. ' : 'No current endorsement is recorded. '}An explicit operator override can confirm only this server-eligible action; it grants no additional authority.</p><Button variant="outline" disabled={busy} onClick={() => { void confirm() }}>{busy ? 'Confirming…' : `Proceed without recommendation: ${action!.label}`}</Button></details>)}
    {reconcileAvailable && <div><p>Observe the existing handoff using its recorded identity. This does not approve or replay a mutation.</p><Button variant="outline" disabled={busy} onClick={() => { void reconcile() }}>{busy ? 'Requesting reconciliation…' : recovery!.label}</Button></div>}
    {reconciled === recoveryKey && <p role="status">Existing handoff reconciliation requested; no mutation replay. Await server evidence before treating it as complete.</p>}
    {recheckAvailable && <Button variant="outline" disabled={busy} onClick={() => { void recheck() }}>{busy ? 'Rechecking…' : 'Recheck publication configuration'}</Button>}
    {rechecked === key && <p role="status">Publication configuration rechecked. Awaiting the current server snapshot; no publication action was confirmed.</p>}
    {confirmed === key && <p role="status">Confirmation recorded. Awaiting the current server snapshot; no automatic retry.</p>}
    {error && <p role="alert">{error} Refresh to review the current delivery before trying again.</p>}
    <details aria-label="Pinned scope and publication references" style={{ marginTop: 16 }}><summary>Pinned scope and publication references</summary>
      {d.scopeBinding ? <p>Scope unbound: {d.scopeBinding.reason}. Source trigger: {d.scopeBinding.sourceTriggerId}. No pinned revision or action is authorized.</p> : <dl><dt>Source</dt><dd>{d.bindings.repository} #{d.bindings.sourceIssue}</dd><dt>Base</dt><dd><code>{d.bindings.baseSha}</code></dd><dt>Head</dt><dd><code>{d.bindings.headSha}</code></dd>
        {d.bindings.artifact && <><dt>Artifact</dt><dd>{d.bindings.artifact}</dd></>}{d.bindings.environment && <><dt>Environment</dt><dd>{d.bindings.environment}</dd></>}
        <dt>Delivery / revision</dt><dd>{d.id} / {d.revision}</dd>{action && <><dt>Action scope / evidence fingerprint</dt><dd><code>{action.fingerprint}</code></dd></>}</dl>}
      {!d.scopeBinding && d.preparedPublication && <dl><dt>Prepared publication</dt><dd>{d.preparedPublication.id}</dd><dt>Repository / PR</dt><dd>{d.preparedPublication.repository} #{d.preparedPublication.pr}</dd><dt>Pinned head</dt><dd><code>{d.preparedPublication.headSha}</code></dd><dt>Patch SHA-256</dt><dd><code>{d.preparedPublication.patchSha256}</code></dd><dt>Target environment</dt><dd>{d.preparedPublication.environment}</dd><dt>Prepared at</dt><dd>{d.preparedPublication.preparedAt}</dd></dl>}
      {d.preparedPublication?.scopeSha256 && <p>Publication scope SHA-256: <code>{d.preparedPublication.scopeSha256}</code></p>}
      {!d.scopeBinding && <ul aria-label="All pinned publication references">{pinnedRefs.map((ref, i) => <li key={`${ref.repository}:${ref.pr}:${i}`}>{ref.repository} PR #{ref.pr} · Head: <code>{ref.headSha}</code>{ref.baseSha && <> · Base: <code>{ref.baseSha}</code></>}{ref.diffSha256 && <> · Diff SHA-256: <code>{ref.diffSha256}</code></>}</li>)}</ul>}
      <p>Only this revision and its pinned evidence are authorized. Worker completion, merge and rollback do not establish feature acceptance.</p>
    </details>
    <details><summary>Acceptance requirements</summary><ul>{d.requirements.map(requirement => <li key={requirement}>{requirement}</li>)}</ul>{d.acceptance && <p>Accepted evidence: {d.acceptance.evidenceIds.join(', ')}</p>}</details>
    <details><summary>Recorded evidence ({d.evidence.length})</summary><ul>{d.evidence.map(e => <li key={e.id}>{e.kind}: {e.outcome} · {e.recordedAt} · {e.reference} · Scope: {e.bindings.repository} #{e.bindings.sourceIssue} / {e.bindings.headSha}{e.requirements?.length ? ` · Requirements: ${e.requirements.join(', ')}` : ''}</li>)}</ul></details>
    <details><summary>Delivery history and attempts ({d.audit.length})</summary><p>Review attempts: {d.attempts.review}/{d.attempts.maxReview} · Fix attempts: {d.attempts.fix}/{d.attempts.maxFix}</p><ol>{d.audit.map((entry, i) => <li key={i}>{entry.at} · {entry.event} · {entry.actor}</li>)}</ol></details>
  </section>
}
