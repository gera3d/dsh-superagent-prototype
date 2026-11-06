/** Canonical pre-work triage. Typed confirmation only; never stages or sends chat. */
import { useRef, useState } from 'react'
import type { PendingDecisionItem } from '../core/decision.ts'
import { Button } from './controls.tsx'
import type { FindingEvidence } from '../app/finding.ts'

function ReportEvidence({ report }: { report: FindingEvidence }) {
  return <>{report.reference} · {report.evidence} · Next decision: {report.nextDecision} · {report.at}
    {report.summaryTruncated && <p role="note"><strong>Truncated excerpt, not the full report.</strong> Original length: {report.originalLength ?? 'not recorded'} characters · Full summary SHA-256: <code>{report.reportSummarySha256 ?? 'not recorded'}</code> · Full native report reference: <code>{report.reference}</code>. Inspect the complete native report before accepting evidence.</p>}
  </>
}

export interface FindingConfirmation { revision: number; choiceId: string }
export interface FindingReview { revision: number; decision: 'accept_evidence' | 'retry_scope' | 'defer'; evidenceReference?: string; requirements?: string[]; outcome?: 'verified' | 'no_repair_needed' }
export async function reviewFinding(id: string, request: FindingReview) {
  const response = await fetch(`/orchestrator/api/findings/${encodeURIComponent(id)}/review`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' }, body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(`Finding review rejected (${response.status}). Refresh before trying again; no automatic replay.`)
  return response.json()
}
export async function confirmFinding(id: string, request: FindingConfirmation) {
  const response = await fetch(`/orchestrator/api/findings/${encodeURIComponent(id)}/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' }, body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(`Finding confirmation rejected (${response.status}). Refresh before trying again; no automatic replay.`)
  return response.json()
}
export async function revisitFinding(id: string, request: { revision: number }) {
  const response = await fetch(`/orchestrator/api/findings/${encodeURIComponent(id)}/revisit`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' }, body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(`Finding revisit rejected (${response.status}). Refresh before trying again; no automatic replay.`)
  return response.json()
}
export function FindingCard({ item, onConfirm = request => confirmFinding(item.finding!.id, request), onRevisit = request => revisitFinding(item.finding!.id, request), onReview = request => reviewFinding(item.finding!.id, request) }: {
  item: PendingDecisionItem; onConfirm?: (request: FindingConfirmation) => Promise<unknown>; onRevisit?: (request: { revision: number }) => Promise<unknown>; onReview?: (request: FindingReview) => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const acting = useRef(false)
  const [error, setError] = useState<string>()
  const [confirmed, setConfirmed] = useState<string>()
  const [reviewedKey, setReviewedKey] = useState<string>()
  const [reviewOutcome, setReviewOutcome] = useState<{ key: string; value: 'verified' | 'no_repair_needed' }>()
  const [selectedEvidence, setSelectedEvidence] = useState<{ key: string; reference: string }>()
  const f = item.finding
  if (!f) return <section role="status">Finding metadata unavailable. Refresh before confirming; chat Send cannot triage findings.</section>
  const key = `${f.id}:${f.revision}`
  const available = item.actionMode === 'finding_triage' && item.status === 'pending' && !item.invalidation && f.state === 'awaiting_decision' && confirmed !== key
  const choices = f.choices.filter(choice => ['fix_now', 'queue_next', 'defer'].includes(choice.kind))
  const advice = f.recommendation?.revision === f.revision && choices.some(choice => choice.id === f.recommendation?.choiceId) ? f.recommendation : undefined
  const latestReport = f.job ? f.reports.filter(report => report.jobId === f.job!.id).at(-1) : undefined
  const eligibleReports = latestReport && ['ready', 'verified'].includes(latestReport.state ?? '') ? [latestReport] : []
  const evidenceReference = selectedEvidence?.key === key ? selectedEvidence.reference : ''
  const reviewAvailable = item.actionMode === 'finding_triage' && !item.invalidation && f.state === 'blocked' && confirmed !== key
  const review = async (decision: FindingReview['decision']) => {
    if (!reviewAvailable || acting.current || decision === 'accept_evidence' && (reviewedKey !== key || !eligibleReports.some(report => report.reference === evidenceReference))) return
    acting.current = true; setBusy(true); setError(undefined)
    try { await onReview({ revision: f.revision, decision, ...(decision === 'accept_evidence' ? { evidenceReference, requirements: f.requirements, outcome: reviewOutcome?.key === key ? reviewOutcome.value : 'verified' } : {}) }); setConfirmed(key) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { acting.current = false; setBusy(false) }
  }
  const revisit = async () => {
    if (f.state !== 'deferred' || acting.current || confirmed === key || item.invalidation || item.actionMode !== 'finding_triage') return
    acting.current = true; setBusy(true); setError(undefined)
    try { await onRevisit({ revision: f.revision }); setConfirmed(key) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { acting.current = false; setBusy(false) }
  }
  const confirm = async (choiceId: string) => {
    if (!available || acting.current || !choices.some(choice => choice.id === choiceId)) return
    acting.current = true; setBusy(true); setError(undefined)
    try { await onConfirm({ revision: f.revision, choiceId }); setConfirmed(key) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { acting.current = false; setBusy(false) }
  }
  return <section id={`finding-${f.id}`} className="dt-finding-card" aria-label={`Finding: ${f.title}`} style={{ background: 'var(--dsw-alias-background-l1, #161b22)', border: '1px solid var(--dsw-alias-border-l2, #30363d)', borderRadius: 8, padding: 18, color: 'var(--dsw-alias-label-primary, #e6edf3)' }}>
    <h3 style={{ margin: '0 0 8px' }}>{f.title}</h3><p>{f.problem}</p>
    <p role="status"><strong>{f.state.replaceAll('_', ' ')}</strong> · Owner: {f.owner}</p>
    {advice ? <aside aria-label="Senior Developer recommendation"><strong>Senior Developer recommends: {choices.find(choice => choice.id === advice.choiceId)?.label}</strong><p>{advice.rationale}</p></aside>
      : <p role="status">{f.recommendationError ? `Senior Developer advice unavailable: ${f.recommendationError}` : 'No current Senior Developer recommendation recorded.'} Explicit operator choice is required; no recommendation or execution is inferred.</p>}
    {f.state === 'queued' && <p role="status">Durably queued. Waiting for serialized dispatch; not proof that work started.</p>}
    {f.state === 'deferred' && <div><p role="status">Durably deferred, not resolved. No new work will be dispatched while deferred. Revisit opens a new decision revision; it does not execute work.</p>{confirmed !== key && item.actionMode === 'finding_triage' && !item.invalidation && <Button variant="outline" disabled={busy} onClick={() => { void revisit() }}>{busy ? 'Revisiting…' : 'Revisit finding'}</Button>}</div>}
    {f.resolution && <p role="status">Finding review: {f.resolution.outcome === 'no_repair_needed' ? 'No repair needed' : 'Verified'} · {f.resolution.evidenceReference} · {f.resolution.actor} · {f.resolution.at}. This is not acceptance of the linked delivery.</p>}
    {f.state === 'running' && <p role="status">Work dispatched. Await linked execution evidence; idle, merge and worker completion do not resolve this finding.</p>}
    {f.blocker && <p role="status">Blocked: {f.blocker}</p>}
    {reviewAvailable && <section aria-label="Finding review requirements"><h4>Bounded requirements to review</h4><p>{f.scope}</p><ul>{f.requirements.map(requirement => <li key={requirement}>{requirement}</li>)}</ul></section>}
    {reviewAvailable && <section aria-label="Review finding evidence"><h4>Explicit finding review</h4><p>Retry reopens only this bounded scope for a new triage choice; it does not start work. Defer keeps the finding revisitable. Accepting reviewed evidence resolves only this finding, never the linked delivery.</p>
      {eligibleReports.length > 0 && <div><h4>Current-job ready or verified evidence</h4><ul>{eligibleReports.map((report, i) => <li key={i}><ReportEvidence report={report} /></li>)}</ul><label>Evidence to accept <select aria-label="Evidence to accept" value={evidenceReference} disabled={busy} onChange={event => { setSelectedEvidence({ key, reference: event.target.value }); setReviewedKey(undefined) }}><option value="">Choose recorded evidence</option>{eligibleReports.map((report, i) => <option key={i} value={report.reference}>{report.reference}</option>)}</select></label><p><label>Finding review outcome <select aria-label="Finding review outcome" value={reviewOutcome?.key === key ? reviewOutcome.value : 'verified'} disabled={busy} onChange={event => { setReviewOutcome({ key, value: event.target.value as 'verified' | 'no_repair_needed' }); setReviewedKey(undefined) }}><option value="verified">Verified</option><option value="no_repair_needed">No repair needed</option></select></label></p><p><label><input type="checkbox" checked={reviewedKey === key} disabled={busy || !evidenceReference} onChange={event => setReviewedKey(event.target.checked ? key : undefined)} /> I reviewed the selected evidence against every bounded requirement listed above.</label></p><Button variant="primary" disabled={busy || reviewedKey !== key || !evidenceReference} onClick={() => { void review('accept_evidence') }}>Accept reviewed finding evidence</Button></div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}><Button variant="outline" disabled={busy} onClick={() => { void review('retry_scope') }}>Reopen bounded triage</Button><Button variant="outline" disabled={busy} onClick={() => { void review('defer') }}>Defer review</Button></div>
    </section>}
    {available && <div role="group" aria-label="Confirm finding triage" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{choices.map(choice => <Button key={choice.id} variant={advice?.choiceId === choice.id ? 'primary' : 'outline'} disabled={busy} onClick={() => { void confirm(choice.id) }}>{busy ? 'Confirming…' : choice.label}</Button>)}</div>}
    {confirmed === key && <p role="status">Choice recorded. Awaiting the authoritative finding snapshot; no automatic retry.</p>}
    {error && <p role="alert">{error}</p>}
    <details><summary>Bounded scope, requirements &amp; action effects</summary><section aria-label="Finding scope"><p>{f.scope}</p><ul>{f.requirements.map(requirement => <li key={requirement}>{requirement}</li>)}</ul><p>Queue next waits FIFO behind queued or running findings. If nothing is running, dispatch can start on the next scheduler pass. {f.kind === 'verification' ? 'Run verification' : 'Fix now'} also uses the durable serialized queue; it never bypasses active work.</p><p>Defer records a revisitable decision without dispatching new work.</p><p>Pre-work finding: no pinned implementation revision, merge, deployment or acceptance is authorized by triage.</p></section></details>
    <details><summary>Source, recommendation &amp; job details</summary><p>Finding triage · {f.kind} · revision {f.revision}</p><p>Repository: {f.repository}{f.sourceIssue ? ` · Issue #${f.sourceIssue}` : ''}</p>{advice && <p>Recommendation source: {advice.provider} · {advice.recordedAt}</p>}{f.existingDeliveryId && <p>Linked existing delivery: <a style={{ color: 'var(--dsw-alias-link-primary, #79b8ff)' }} href={`#delivery-${encodeURIComponent(f.existingDeliveryId)}`}>{f.existingDeliveryId}</a>. Triage preserves this link; it does not create acceptance evidence.</p>}{f.job && <p aria-label="Finding job attribution">Job: <code>{f.job.id}</code>{f.job.ticketId && <> · Ticket: {f.job.ticketId}</>}{f.job.assignmentId && <> · Assignment: {f.job.assignmentId}</>}</p>}</details>
    {!!f.priorJobs?.length && <details><summary>Prior job attribution ({f.priorJobs.length})</summary><ul>{f.priorJobs.map(job => <li key={job.id}>{job.id} · Ticket: {job.ticketId ?? 'not recorded'} · Assignment: {job.assignmentId ?? 'not recorded'}</li>)}</ul></details>}
    {!!f.reports?.length && <details><summary>Linked execution evidence ({f.reports.length})</summary><ul>{f.reports.map((report, i) => <li key={i}><ReportEvidence report={report} /></li>)}</ul></details>}
    <details><summary>Finding history ({f.audit.length})</summary><ol>{f.audit.map((entry, i) => <li key={i}>{entry.at} · {entry.event} · {entry.actor}</li>)}</ol></details>
    <details><summary>Recorded occurrences ({f.occurrences.length})</summary><ul>{f.occurrences.map(occurrence => <li key={occurrence.id}>{occurrence.reference} · {occurrence.evidence} · {occurrence.at}</li>)}</ul></details>
  </section>
}
