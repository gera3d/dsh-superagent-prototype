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
export interface FindingEvidenceRecord { reference: string; evidence: string; nextDecision: string; verified: boolean }
/** Explicit local operator observation; recording it never accepts the finding or its delivery. */
export class FindingEvidenceRejection extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'FindingEvidenceRejection' }
}
export async function recordFindingEvidence(id: string, request: FindingEvidenceRecord & { revision: number }) {
  const response = await fetch(`/orchestrator/api/findings/${encodeURIComponent(id)}/evidence`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' }, body: JSON.stringify(request),
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined) as { error?: unknown } | undefined
    const reason = typeof detail?.error === 'string' && detail.error.trim() ? detail.error : 'Operator evidence was rejected'
    throw new FindingEvidenceRejection(response.status, `${reason} (${response.status}). Refresh the finding before trying again; the draft is preserved and no automatic replay occurs.`)
  }
  return response.json()
}
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
export function FindingCard({ item, onConfirm = request => confirmFinding(item.finding!.id, request), onRevisit = request => revisitFinding(item.finding!.id, request), onReview = request => reviewFinding(item.finding!.id, request), onRecordEvidence = request => recordFindingEvidence(item.finding!.id, request) }: {
  item: PendingDecisionItem; onConfirm?: (request: FindingConfirmation) => Promise<unknown>; onRevisit?: (request: { revision: number }) => Promise<unknown>; onReview?: (request: FindingReview) => Promise<unknown>; onRecordEvidence?: (request: FindingEvidenceRecord & { revision: number }) => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const acting = useRef(false)
  const [error, setError] = useState<string>()
  const [confirmed, setConfirmed] = useState<string>()
  const [reviewedKey, setReviewedKey] = useState<string>()
  const [reviewOutcome, setReviewOutcome] = useState<{ key: string; value: 'verified' | 'no_repair_needed' }>()
  const [selectedEvidence, setSelectedEvidence] = useState<{ key: string; reference: string }>()
  const [evidenceDraft, setEvidenceDraft] = useState<FindingEvidenceRecord>({ reference: '', evidence: '', nextDecision: '', verified: false })
  const [evidenceError, setEvidenceError] = useState<string>()
  const [staleEvidenceKey, setStaleEvidenceKey] = useState<string>()
  const [recordedEvidence, setRecordedEvidence] = useState<{ key: string; reference: string }>()
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
  const recordEvidenceAvailable = item.actionMode === 'finding_triage' && !item.invalidation && !!f.job?.ticketId && ['running', 'blocked'].includes(f.state)
  const evidenceIncomplete = !evidenceDraft.reference.trim() || !evidenceDraft.evidence.trim() || !evidenceDraft.nextDecision.trim()
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
  const recordEvidence = async () => {
    if (!recordEvidenceAvailable || acting.current || evidenceIncomplete || staleEvidenceKey === key || recordedEvidence?.key === key) return
    acting.current = true; setBusy(true); setEvidenceError(undefined)
    try {
      await onRecordEvidence({ revision: f.revision, reference: evidenceDraft.reference.trim(), evidence: evidenceDraft.evidence.trim(), nextDecision: evidenceDraft.nextDecision.trim(), verified: evidenceDraft.verified })
      setRecordedEvidence({ key, reference: evidenceDraft.reference.trim() })
      setEvidenceDraft({ reference: '', evidence: '', nextDecision: '', verified: false })
    }
    catch (reason) {
      setEvidenceError(reason instanceof Error ? reason.message : String(reason))
      if (reason instanceof FindingEvidenceRejection && reason.status === 409) setStaleEvidenceKey(key)
    }
    finally { acting.current = false; setBusy(false) }
  }
  return <section id={`finding-${f.id}`} className="dt-finding-card" aria-label={`Finding: ${f.title}`} style={{ background: 'var(--dsw-alias-background-l1, #161b22)', border: '1px solid var(--dsw-alias-border-l2, #30363d)', borderRadius: 8, padding: 18, color: 'var(--dsw-alias-label-primary, #e6edf3)' }}>
    <h3 style={{ margin: '0 0 8px' }}>{f.title}</h3><p>{f.problem}</p>
    <p role="status"><strong>{f.state.replaceAll('_', ' ')}</strong> · Owner: {f.owner}</p>
    {advice ? <aside aria-label="Senior Developer recommendation"><strong>Senior Developer recommends: {choices.find(choice => choice.id === advice.choiceId)?.label}</strong><p>{advice.rationale}</p></aside>
      : <p role="status">{f.recommendationError ? `Senior Developer advice unavailable: ${f.recommendationError}` : 'No current Senior Developer recommendation recorded.'} Explicit operator choice is required; no recommendation or execution is inferred.</p>}
    {f.state === 'queued' && <p role="status">Durably queued. Waiting for available configured worker capacity; not proof that work started.</p>}
    {f.state === 'deferred' && <div><p role="status">Durably deferred, not resolved. No new work will be dispatched while deferred. Revisit opens a new decision revision; it does not execute work.</p>{confirmed !== key && item.actionMode === 'finding_triage' && !item.invalidation && <Button variant="outline" disabled={busy} onClick={() => { void revisit() }}>{busy ? 'Revisiting…' : 'Revisit finding'}</Button>}</div>}
    {f.resolution && <p role="status">Finding review: {f.resolution.outcome === 'no_repair_needed' ? 'No repair needed' : 'Verified'} · {f.resolution.evidenceReference} · {f.resolution.actor} · {f.resolution.at}. This is not acceptance of the linked delivery.</p>}
    {f.state === 'running' && <p role="status">Work dispatched. Await linked execution evidence; idle, merge and worker completion do not resolve this finding.</p>}
    {f.blocker && <p role="status">Blocked: {f.blocker}</p>}
    {reviewAvailable && <section aria-label="Finding review requirements"><h4>Bounded requirements to review</h4><p>{f.scope}</p><ul>{f.requirements.map(requirement => <li key={requirement}>{requirement}</li>)}</ul></section>}
    {recordEvidenceAvailable && <section aria-label="Record operator evidence"><h4>Record operator-reviewed evidence</h4>
      <p role="note">Observation only: recording evidence does not accept this finding or the linked delivery, queue work, merge, deploy, change scope or grant authority. Record only results you personally verified.</p>
      <p><label>Durable evidence reference <input aria-label="Durable evidence reference" value={evidenceDraft.reference} maxLength={16384} disabled={busy} onChange={event => { setEvidenceDraft({ ...evidenceDraft, reference: event.target.value }); setEvidenceError(undefined) }} /></label></p>
      <p><label>Verification results and limits <textarea aria-label="Verification results and limits" value={evidenceDraft.evidence} maxLength={16384} rows={3} disabled={busy} onChange={event => { setEvidenceDraft({ ...evidenceDraft, evidence: event.target.value }); setEvidenceError(undefined) }} /></label></p>
      <p><label>Next decision <textarea aria-label="Next decision" value={evidenceDraft.nextDecision} maxLength={16384} rows={2} disabled={busy} onChange={event => { setEvidenceDraft({ ...evidenceDraft, nextDecision: event.target.value }); setEvidenceError(undefined) }} /></label></p>
      <p><label><input aria-label="Verified operator attestation" type="checkbox" checked={evidenceDraft.verified} disabled={busy} onChange={event => setEvidenceDraft({ ...evidenceDraft, verified: event.target.checked })} /> I personally ran or inspected these results and record this as explicitly verified evidence.</label></p>
      <p role="note">The recorded evidence becomes the latest current-job report. Only explicitly verified evidence can be selected in the separate finding review; unverified evidence is still the latest report and can block accepting an earlier ready report until newer evidence arrives.</p>
      {recordedEvidence?.key === key && <p role="status">Evidence recorded for revision {f.revision}: {recordedEvidence.reference}. Awaiting the authoritative finding snapshot; this did not accept the finding or delivery.</p>}
      {staleEvidenceKey === key && <p role="alert">Stale finding revision. Refresh before recording again; the draft is preserved and nothing was retried.</p>}
      {evidenceError && <p role="alert">{evidenceError}</p>}
      <Button variant="outline" disabled={busy || evidenceIncomplete || staleEvidenceKey === key || recordedEvidence?.key === key} onClick={() => { void recordEvidence() }}>{busy ? 'Recording…' : 'Record operator evidence'}</Button>
    </section>}
    {reviewAvailable && <section aria-label="Review finding evidence"><h4>Explicit finding review</h4><p>Retry reopens only this bounded scope for a new triage choice; it does not start work. Defer keeps the finding revisitable. Accepting reviewed evidence resolves only this finding, never the linked delivery.</p>
      {eligibleReports.length > 0 && <div><h4>Current-job ready or verified evidence</h4><ul>{eligibleReports.map((report, i) => <li key={i}><ReportEvidence report={report} /></li>)}</ul><label>Evidence to accept <select aria-label="Evidence to accept" value={evidenceReference} disabled={busy} onChange={event => { setSelectedEvidence({ key, reference: event.target.value }); setReviewedKey(undefined) }}><option value="">Choose recorded evidence</option>{eligibleReports.map((report, i) => <option key={i} value={report.reference}>{report.reference}</option>)}</select></label><p><label>Finding review outcome <select aria-label="Finding review outcome" value={reviewOutcome?.key === key ? reviewOutcome.value : 'verified'} disabled={busy} onChange={event => { setReviewOutcome({ key, value: event.target.value as 'verified' | 'no_repair_needed' }); setReviewedKey(undefined) }}><option value="verified">Verified</option><option value="no_repair_needed">No repair needed</option></select></label></p><p><label><input aria-label="Requirements acknowledgment" type="checkbox" checked={reviewedKey === key} disabled={busy || !evidenceReference} onChange={event => setReviewedKey(event.target.checked ? key : undefined)} /> I reviewed the selected evidence against every bounded requirement listed above.</label></p><Button variant="primary" disabled={busy || reviewedKey !== key || !evidenceReference} onClick={() => { void review('accept_evidence') }}>Accept reviewed finding evidence</Button></div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}><Button variant="outline" disabled={busy} onClick={() => { void review('retry_scope') }}>Reopen bounded triage</Button><Button variant="outline" disabled={busy} onClick={() => { void review('defer') }}>Defer review</Button></div>
    </section>}
    {available && <div role="group" aria-label="Confirm finding triage" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{choices.map(choice => <Button key={choice.id} variant={advice?.choiceId === choice.id ? 'primary' : 'outline'} disabled={busy} onClick={() => { void confirm(choice.id) }}>{busy ? 'Confirming…' : choice.label}</Button>)}</div>}
    {confirmed === key && <p role="status">Choice recorded. Awaiting the authoritative finding snapshot; no automatic retry.</p>}
    {error && <p role="alert">{error}</p>}
    <details><summary>Bounded scope, requirements &amp; action effects</summary><section aria-label="Finding scope"><p>{f.scope}</p><ul>{f.requirements.map(requirement => <li key={requirement}>{requirement}</li>)}</ul><p>Queue next is admitted FIFO when configured worker capacity is available. {f.kind === 'verification' ? 'Run verification' : 'Fix now'} also uses the durable FIFO queue and the configured capacity limit.</p><p>Defer records a revisitable decision without dispatching new work.</p><p>Pre-work finding: no pinned implementation revision, merge, deployment or acceptance is authorized by triage.</p></section></details>
    <details><summary>Source, recommendation &amp; job details</summary><p>Finding triage · {f.kind} · revision {f.revision}</p><p>Repository: {f.repository}{f.sourceIssue ? ` · Issue #${f.sourceIssue}` : ''}</p>{advice && <p>Recommendation source: {advice.provider} · {advice.recordedAt}</p>}{f.existingDeliveryId && <p>Linked existing delivery: <a style={{ color: 'var(--dsw-alias-link-primary, #79b8ff)' }} href={`#delivery-${encodeURIComponent(f.existingDeliveryId)}`}>{f.existingDeliveryId}</a>. Triage preserves this link; it does not create acceptance evidence.</p>}{f.job && <p aria-label="Finding job attribution">Job: <code>{f.job.id}</code>{f.job.ticketId && <> · Ticket: {f.job.ticketId}</>}{f.job.assignmentId && <> · Assignment: {f.job.assignmentId}</>}</p>}</details>
    {!!f.priorJobs?.length && <details><summary>Prior job attribution ({f.priorJobs.length})</summary><ul>{f.priorJobs.map(job => <li key={job.id}>{job.id} · Ticket: {job.ticketId ?? 'not recorded'} · Assignment: {job.assignmentId ?? 'not recorded'}</li>)}</ul></details>}
    {!!f.reports?.length && <details><summary>Linked execution evidence ({f.reports.length})</summary><ul>{f.reports.map((report, i) => <li key={i}><ReportEvidence report={report} /></li>)}</ul></details>}
    <details><summary>Finding history ({f.audit.length})</summary><ol>{f.audit.map((entry, i) => <li key={i}>{entry.at} · {entry.event} · {entry.actor}</li>)}</ol></details>
    <details><summary>Recorded occurrences ({f.occurrences.length})</summary><ul>{f.occurrences.map(occurrence => <li key={occurrence.id}>{occurrence.reference} · {occurrence.evidence} · {occurrence.at}</li>)}</ul></details>
  </section>
}
