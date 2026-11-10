/** Canonical delivery presentation on every surface. Confirmation is typed, never chat. */
import { useRef, useState } from 'react'
import type { PendingDecisionItem } from '../core/decision.ts'
import { Button, Icon } from './controls.tsx'
import STYLES from './delivery-card.css?raw'

export interface DeliveryConfirmation { revision: number; actionId: string }
export interface DeliveryPrepare { revision: number; requirements: string[] }
export interface DeliveryLiveEvidence { revision: number; requirements: string[]; reference: string; outcome: 'passed' | 'failed' }
async function postDelivery(id: string, route: 'prepare' | 'evidence', body: unknown) {
  const response = await fetch(`/orchestrator/api/deliveries/${encodeURIComponent(id)}/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' }, body: JSON.stringify(body),
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined) as { error?: unknown } | undefined
    throw new Error(`${typeof detail?.error === 'string' && detail.error.trim() ? detail.error : 'Request was rejected'} (${response.status}).`)
  }
  return response.json()
}
const prepareDelivery = (id: string, request: DeliveryPrepare) => postDelivery(id, 'prepare', request)
const recordDeliveryEvidence = (id: string, request: DeliveryLiveEvidence) => postDelivery(id, 'evidence', request)
type Delivery = NonNullable<PendingDecisionItem['delivery']>

/** In-thread release handoff for an unbound delivery: shows derived facts, owner and exact missing inputs; one click starts the routine steps. */
function HandoffPanel({ d, onPrepare }: { d: Delivery; onPrepare: (request: DeliveryPrepare) => Promise<unknown> }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [started, setStarted] = useState(false)
  const [error, setError] = useState<string>()
  const acting = useRef(false)
  const handoff = d.handoff
  const requirements = text.split('\n').map(line => line.trim()).filter(Boolean)
  const ready = handoff?.status === 'ready'
  const start = async () => {
    if (acting.current) return
    if (!requirements.length) { setError('Enter at least one acceptance requirement (one per line) that you will verify live.'); return }
    acting.current = true; setBusy(true); setError(undefined)
    try { await onPrepare({ revision: d.revision, requirements }); setStarted(true) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { acting.current = false; setBusy(false) }
  }
  return <section aria-label="Release handoff" style={{ margin: '12px 0' }}>
    <p role="status"><strong>Release handoff: {ready ? 'ready to start' : 'needs inputs'}.</strong> Next owner: {handoff?.owner ?? d.owner}.</p>
    {handoff?.preview && <dl>
      <dt>Repository / PR</dt><dd>{handoff.preview.repository} #{handoff.preview.pr}</dd>
      <dt>Head / base</dt><dd><code>{handoff.preview.headSha.slice(0, 12)}</code> / <code>{handoff.preview.baseSha.slice(0, 12)}</code></dd>
      <dt>Target</dt><dd>{handoff.preview.environment}</dd>
    </dl>}
    {!!handoff?.missing.length && <><p>Missing, with the owner who supplies it:</p><ul>{handoff.missing.map(m => <li key={m.field}><strong>{m.field}</strong> · {m.owner}: {m.detail}</li>)}</ul></>}
    <p>Starting runs these through the existing delivery coordinator; it does not merge, publish or accept:</p>
    <ul>{(handoff?.starts ?? []).map(step => <li key={step}>{step}</li>)}</ul>
    <label>Acceptance requirements you will verify live (one per line)
      <textarea aria-label="Acceptance requirements" rows={3} value={text} onChange={event => setText(event.target.value)} style={{ display: 'block', width: '100%' }} /></label>
    {!started && <Button variant="primary" disabled={busy} onClick={() => { void start() }}>{busy ? 'Starting…' : ready ? 'Start review, tests and release preparation' : 'Re-check release inputs and start when complete'}</Button>}
    {started && <p role="status">Release handoff started. Review, checks and preparation now run in this thread; publication and acceptance still need your explicit confirmation.</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}
/** Operator live attestation. Names the intake requirements actually checked; recording it never accepts the delivery. */
function EvidencePanel({ d, onEvidence }: { d: Delivery; onEvidence: (request: DeliveryLiveEvidence) => Promise<unknown> }) {
  const open = d.awaitingOperatorEvidence ?? []
  const [picked, setPicked] = useState<string[]>([])
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string>()
  const [error, setError] = useState<string>()
  const acting = useRef(false)
  const send = async (outcome: 'passed' | 'failed') => {
    if (acting.current) return
    if (!picked.length || !reference.trim()) { setError('Select the requirements you checked and give an HTTPS evidence link.'); return }
    acting.current = true; setBusy(true); setError(undefined)
    try { await onEvidence({ revision: d.revision, requirements: picked, reference: reference.trim(), outcome }); setDone(outcome) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { acting.current = false; setBusy(false) }
  }
  return <section aria-label="Operator live evidence" style={{ margin: '12px 0' }}>
    <p role="status"><strong>Automated release verification passed, but it proves none of your requirements.</strong> Owner: you. Record what you checked live:</p>
    {open.map(requirement => <label key={requirement} style={{ display: 'block' }}><input type="checkbox" checked={picked.includes(requirement)} onChange={event => setPicked(event.target.checked ? [...picked, requirement] : picked.filter(r => r !== requirement))} /> {requirement}</label>)}
    <label>HTTPS link to your evidence <input aria-label="Evidence link" value={reference} onChange={event => setReference(event.target.value)} style={{ display: 'block', width: '100%' }} /></label>
    <Button variant="primary" disabled={busy || done !== undefined} onClick={() => { void send('passed') }}>Record live evidence: passed</Button>
    <Button variant="outline" disabled={busy || done !== undefined} onClick={() => { void send('failed') }}>Record live evidence: failed</Button>
    {done && <p role="status">Operator evidence recorded ({done}). Acceptance is a separate explicit confirmation.</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}
export function DeliveryCard({ item, onConfirm, onRecheck, onReconcile, onPrepare = request => prepareDelivery(item.delivery!.id, request), onEvidence = request => recordDeliveryEvidence(item.delivery!.id, request) }: { item: PendingDecisionItem; onConfirm: (request: DeliveryConfirmation) => Promise<unknown>; onRecheck?: (request: { revision: number }) => Promise<unknown>; onReconcile?: (request: DeliveryConfirmation) => Promise<unknown>; onPrepare?: (request: DeliveryPrepare) => Promise<unknown>; onEvidence?: (request: DeliveryLiveEvidence) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  const acting = useRef(false)
  const [error, setError] = useState<string>()
  const [confirmed, setConfirmed] = useState<string>()
  const [rechecked, setRechecked] = useState<string>()
  const [reconciled, setReconciled] = useState<string>()
  const d = item.delivery
  if (!d) return <section role="status">Delivery metadata unavailable. Refresh before confirming.</section>
  const isHistorical = !!d.historicalCompletion || d.work?.state === 'superseded'
  const packaging = !!d.release && d.stage === 'ready_to_publish' && !d.preparedPublication && !d.blocker
  const action = d.scopeBinding || isHistorical || packaging ? undefined : d.nextAction
  const key = `${d.id}:${d.revision}:${action?.id}`
  const available = !isHistorical && item.actionMode === 'feature_delivery' && item.status === 'pending' && !item.invalidation
    && !d.scopeBinding && d.state === 'awaiting_decision' && action?.revision === d.revision && !!action.fingerprint && confirmed !== key
  const recordedAdvice = d.recommendation
  const recommendation = recordedAdvice && action && recordedAdvice.actionId === action.id && recordedAdvice.kind === action.kind && recordedAdvice.fingerprint === action.fingerprint && ['take', 'hold'].includes(recordedAdvice.disposition ?? '')
    ? recordedAdvice : undefined
  const endorsed = recommendation?.disposition === 'take'
  const pinnedRefs = [...new Map([...(d.bindings.refs ?? []), ...(d.preparedPublication?.refs ?? [])].map(ref => [JSON.stringify(ref), ref])).values()]
  const recovery = isHistorical ? undefined : d.reconciliation
  const recoveryKey = `${d.id}:${d.revision}:${recovery?.id}:${recovery?.actionId}`
  const reconcileAvailable = !isHistorical && !!onReconcile && item.actionMode === 'feature_delivery' && item.status === 'pending' && !item.invalidation && !d.scopeBinding && d.state === 'blocked' && !!recovery?.id && !!recovery.actionId && recovery.revision === d.revision && reconciled !== recoveryKey
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
  const status = d.historicalCompletion ? 'Delivered by later release'
    : d.work?.state === 'superseded' ? 'Superseded history' : d.acceptance ? 'Accepted'
    : d.work?.state === 'awaiting_direction' ? 'Ready for your next step'
    : d.work?.state === 'owned' || d.state === 'running' ? 'In progress'
    : d.state === 'awaiting_decision' ? `${d.stage.replaceAll('_', ' ')} ready`
    : d.state.replaceAll('_', ' ')
  const hint = d.historicalCompletion ? 'Completed history'
    : d.work?.state === 'awaiting_direction' ? 'Your next step below'
    : available ? 'Review action' : reconcileAvailable ? 'Handoff needs attention' : recheckAvailable ? 'Configuration needs attention' : 'View details'
  return <section id={`delivery-${d.id}`} className="dt-delivery-card" aria-label={`Feature delivery: ${d.title}`}>
    <style>{STYLES}</style>
    <details className="dt-delivery-disclosure">
      <summary className="dt-delivery-summary">
        <Icon name="review" size={14} />
        <span className="dt-delivery-label">Delivery</span>
        <span className="dt-delivery-state" role="status">{status}</span>
        <span className="dt-delivery-hint">{hint}</span>
        <span className="dt-delivery-chevron"><Icon name="chevron-down" size={14} /></span>
      </summary>
      <div className="dt-delivery-body">
    <h3>{d.title}</h3>
    {d.historicalCompletion && <p className="dt-delivery-caption">{d.historicalCompletion.caption}</p>}
    <p className="dt-delivery-owner">Owner: {d.work?.owner === 'user' ? 'You' : d.work?.owner ?? d.owner}</p>
    {d.historicalCompletion && <section aria-label="Historical completion reconciliation" style={{ margin: '12px 0', padding: '10px 12px', background: 'rgba(56, 139, 253, 0.1)', border: '1px solid rgba(56, 139, 253, 0.3)', borderRadius: '6px' }}>
      <p style={{ fontWeight: 600, color: 'var(--dsw-alias-label-primary, #e6edf3)', margin: '0 0 6px' }}>Historical completion reconciliation</p>
      <p style={{ margin: '0 0 6px' }}>{d.historicalCompletion.caption}</p>
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px' }}>
        <dt>Source issue</dt><dd>#{d.historicalCompletion.sourceIssue} (closed completed)</dd>
        <dt>Later release PR</dt><dd><a href={`https://github.com/gera3d/dsh-superagent-prototype/pull/${d.historicalCompletion.releasePr}`} target="_blank" rel="noreferrer">PR #{d.historicalCompletion.releasePr}</a></dd>
        <dt>Merged SHA</dt><dd><code>{d.historicalCompletion.releaseMergedSha}</code></dd>
        <dt>Evidence ref</dt><dd>{d.historicalCompletion.evidenceReference}</dd>
        <dt>Reconciled at</dt><dd>{d.historicalCompletion.reconciledAt}</dd>
        <dt>Operator</dt><dd>{d.historicalCompletion.operator}</dd>
      </dl>
      <p style={{ margin: '6px 0 0', fontSize: '11px', color: 'var(--dsw-alias-label-muted, #8b949e)' }}>Original unbound pins and history preserved. Not typed delivery acceptance, new implementation or publication grant.</p>
    </section>}
    {d.work && <section aria-label="Current work ownership"><p role="status">{d.work.nextStep}</p>
      {d.work.progress && <><p><strong>Latest worker report:</strong> {d.work.progress.length > 480 ? `${d.work.progress.slice(0, 480)}…` : d.work.progress}</p>
        {d.work.progress.length > 480 && <details><summary>Full worker progress report</summary><p style={{ whiteSpace: 'pre-wrap' }}>{d.work.progress}</p></details>}</>}
      {d.work.supersededBy && <p>Superseded by <code>worker-{d.work.supersededBy}</code>. Original dropped-worker history and mandate are unchanged.</p>}
      {!!d.work.replaces?.length && <p>Active replacement for {d.work.replaces.map(id => `worker-${id}`).join(', ')}.</p>}
    </section>}
    {d.scopeBinding && !!d.handoff && d.work?.state !== 'owned' && d.work?.state !== 'superseded' && !d.historicalCompletion && item.status === 'pending' && !item.invalidation && <HandoffPanel d={d} onPrepare={onPrepare} />}
    {!!d.awaitingOperatorEvidence?.length && item.status === 'pending' && !item.invalidation && <EvidencePanel d={d} onEvidence={onEvidence} />}
    {d.blocker && !d.work && !d.historicalCompletion && <p role="status">Blocked: {d.blocker}</p>}
    {recommendation ? <aside aria-label="Senior Developer recommendation"><strong>{endorsed ? `Senior Developer recommends: ${action!.label}` : 'Senior Developer recommends waiting'}</strong><p>{recommendation.rationale}</p><small>{recommendation.provider} · {recommendation.recordedAt}</small></aside>
      : d.recommendationError && d.work?.state !== 'superseded' ? <p role="status">Senior Developer advice unavailable: {d.recommendationError.message}. Advice failure does not veto an otherwise eligible action.</p> : action ? <p>No current Senior Developer recommendation recorded for this action.</p> : null}
    {action?.kind === 'publish' && <section aria-label="Publication effects"><p><strong>Before publishing:</strong> this confirms the pinned publication for {d.preparedPublication?.repository ?? d.bindings.repository}{d.preparedPublication ? ` PR #${d.preparedPublication.pr}` : ''} in {d.preparedPublication?.environment ?? d.bindings.environment ?? 'the configured environment'}. Inspect all pinned references below before confirming.</p>
      <p><strong>Components:</strong> {d.preparedPublication?.components?.length ? d.preparedPublication.components.join(', ') : 'Not recorded in this publication snapshot.'}</p>
      <p><strong>Effects:</strong> {d.preparedPublication?.effects?.length ? d.preparedPublication.effects.join('; ') : 'Not recorded; no component or restart effects are inferred.'}</p></section>}
    {d.acceptance ? <p role="status">Acceptance recorded by {d.acceptance.actor} at {d.acceptance.at}.</p>
      : d.historicalCompletion ? <p role="status">Retired to completed history via later release. Not typed delivery acceptance.</p>
      : <p>Not accepted. {d.work?.state === 'awaiting_direction' ? 'Use the release handoff above. Release confirmation follows preparation.' : action?.label ?? (d.state === 'running' ? 'Work is in progress.' : 'No confirmation currently offered.')}</p>}
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
      </div>
    </details>
  </section>
}
