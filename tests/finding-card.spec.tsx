// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { PendingDecisionItem } from '../src/core/decision.ts'
import type { Finding } from '../src/app/finding.ts'
import { FindingCard, FindingEvidenceRejection, confirmFinding, recordFindingEvidence, revisitFinding } from '../src/client/finding-card.tsx'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let cleanup = () => {}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function record(): PendingDecisionItem {
  const finding: Finding = { id: 'finding-171', dedupKey: 'scope', title: 'Verify History', problem: 'Missing verification context', scope: 'Only History visibility', owner: 'Senior Developer', kind: 'verification', repository: 'example/repo', requirements: ['Retain attribution'], occurrences: [{ id: 'o', reference: 'History', evidence: 'Missing context', at: 'now' }], existingDeliveryId: 'delivery-159', revision: 3, state: 'awaiting_decision', choices: [{ id: 'fix_now', kind: 'fix_now', label: 'Run verification' }, { id: 'queue_next', kind: 'queue_next', label: 'Queue next' }, { id: 'defer', kind: 'defer', label: 'Defer' }], recommendation: { choiceId: 'queue_next', rationale: 'Preserve current work ordering', provider: 'Configured model', recordedAt: 'now', revision: 3 }, reports: [], audit: [], createdAt: 'now', updatedAt: 'now' }
  return { id: finding.id, finding, actionMode: 'finding_triage', ticketTitle: finding.title, trigger: finding.problem, status: 'pending', urgency: 'medium', createdAt: 1, context: finding.scope, question: finding.title, choices: [], recommendation: { recommendedValue: '', confidence: 0, distribution: [], rationale: '', provider: '', latencyMs: 0 } }
}
async function mount(item = record(), onConfirm = vi.fn(async (_request: unknown) => ({})), onRevisit = vi.fn(async (_request: unknown) => ({})), onRecordEvidence?: (request: unknown) => Promise<unknown>) {
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node)
  cleanup = () => { act(() => root.unmount()); node.remove() }
  const render = async () => { await act(async () => { root.render(<FindingCard item={item} onConfirm={onConfirm} onRevisit={onRevisit} onRecordEvidence={onRecordEvidence} />) }) }
  await render()
  const click = async (label: string) => { await act(async () => { [...node.querySelectorAll('button')].find(b => b.textContent === label)!.click() }) }
  return { node, onConfirm, onRevisit, onRecordEvidence, render, click, item }
}
async function type(node: HTMLElement, label: string, value: string) {
  const field = node.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!
  await act(async () => { setter.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function check(node: HTMLElement, label: string) {
  await act(async () => { (node.querySelector(`[aria-label="${label}"]`) as HTMLInputElement).click() })
}
function blocked(): PendingDecisionItem {
  const item = record(); item.finding!.state = 'blocked'; item.finding!.job = { id: 'job-171', ticketId: 'ticket-171', assignmentId: 'assignment-171' }
  item.finding!.reports = [{ reference: 'native-report:171', evidence: 'Bounded report', nextDecision: 'Review the linked evidence', at: 'now', jobId: 'job-171', state: 'ready' }]
  return item
}
async function fillOperatorEvidence(node: HTMLElement) {
  await type(node, 'Durable evidence reference', 'ci:run:42')
  await type(node, 'Verification results and limits', '65 tests passed locally; installed native UI was not exercised')
  await type(node, 'Next decision', 'Explicitly review this recorded evidence')
}
it('renders real recorded advice, bounded scope, linked delivery and FIFO semantics', async () => {
  const view = await mount()
  for (const text of ['Senior Developer recommends: Queue next', 'Preserve current work ordering', 'Only History visibility', 'FIFO', 'configured worker capacity']) expect(view.node.textContent).toContain(text)
  expect(view.node.querySelector('a')?.getAttribute('href')).toBe('#delivery-delivery-159')
  expect([...view.node.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Run verification', 'Queue next', 'Defer'])
})
it('keeps the normal face compact with real advice, status and typed actions before closed disclosures', async () => {
  const view = await mount()
  const visibleText = [...view.node.querySelectorAll('h3, p, strong, button, summary')].filter(element => !element.closest('details') || element.tagName === 'SUMMARY').map(element => element.textContent).join(' ')
  for (const text of ['Verify History', 'Missing verification context', 'Senior Developer recommends: Queue next', 'Preserve current work ordering', 'awaiting decision', 'Owner: Senior Developer']) expect(visibleText).toContain(text)
  for (const text of ['Only History visibility', 'Retain attribution', 'Repository:', 'FIFO', 'revision 3', 'Configured model']) expect(visibleText).not.toContain(text)
  expect([...view.node.querySelectorAll('details')].every(details => !details.open)).toBe(true)
  expect(view.node.querySelector('.dt-btn-primary')?.textContent).toBe('Queue next')
  const actions = view.node.querySelector('[aria-label="Confirm finding triage"]')!
  const scope = [...view.node.querySelectorAll('details')].find(details => details.querySelector('summary')?.textContent === 'Bounded scope, requirements & action effects')!
  expect(actions.compareDocumentPosition(scope) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  for (const text of ['Only History visibility', 'Retain attribution', 'FIFO', 'Defer records a revisitable decision', 'no pinned implementation revision']) expect(scope.textContent).toContain(text)
})
it.each(['Run verification', 'Queue next', 'Defer'])('confirms %s with exact choice and current revision, then prevents replay', async label => {
  const view = await mount(); await view.click(label)
  expect(view.onConfirm).toHaveBeenCalledExactlyOnceWith({ revision: 3, choiceId: { 'Run verification': 'fix_now', 'Queue next': 'queue_next', Defer: 'defer' }[label] })
  expect(view.node.querySelectorAll('button')).toHaveLength(0)
  expect(view.node.textContent).toContain('Awaiting the authoritative finding snapshot')
  view.item.finding!.revision = 4; view.item.finding!.recommendation = undefined; await view.render()
  expect(view.node.querySelectorAll('button')).toHaveLength(3)
})
it('does not present stale advice as current and exposes model failure honestly', async () => {
  const item = record(); item.finding!.recommendation!.revision = 2; item.finding!.recommendationError = 'Model unavailable'
  const view = await mount(item)
  expect(view.node.textContent).not.toContain('Senior Developer recommends:')
  expect(view.node.textContent).toContain('Senior Developer advice unavailable: Model unavailable')
})
it('discloses truncated excerpts with original length, digest and full native report reference', async () => {
  const item = record(); item.finding!.reports = [{ reference: 'native-report:171', evidence: 'Bounded excerpt…', nextDecision: 'Inspect complete report', at: 'now', summaryTruncated: true, originalLength: 20000, reportSummarySha256: 'full-report-digest' }]
  const view = await mount(item)
  for (const text of ['Truncated excerpt, not the full report', '20000', 'full-report-digest', 'Full native report reference: native-report:171']) expect(view.node.textContent).toContain(text)
})
it('does not erase prior dispatch history when deferred after review', async () => {
  const item = record(); item.finding!.state = 'deferred'; item.finding!.job = { id: 'existing-job' }
  const view = await mount(item)
  expect(view.node.textContent).toContain('No new work will be dispatched while deferred')
  expect(view.node.textContent).toContain('existing-job')
  expect(view.node.textContent).not.toContain('No job dispatched')
})
it('preserves durable defer and revisits only the current revision without dispatch', async () => {
  const item = record(); item.finding!.state = 'deferred'; item.status = 'resolved'
  const view = await mount(item); expect(view.node.textContent).toContain('Durably deferred, not resolved')
  await view.click('Revisit finding')
  expect(view.onRevisit).toHaveBeenCalledExactlyOnceWith({ revision: 3 }); expect(view.onConfirm).not.toHaveBeenCalled()
})
it.each(['queued', 'running', 'resolved'] as const)('does not offer triage for %s and retains job attribution', async state => {
  const item = record(); item.finding!.state = state; item.finding!.job = { id: 'job-171', ticketId: 'ticket-171', assignmentId: 'assignment-171' }
  const view = await mount(item)
  expect(view.node.querySelector('[aria-label="Confirm finding triage"]')).toBeNull()
  expect([...view.node.querySelectorAll('button')].map(button => button.textContent)).not.toContain('Fix now')
  expect(view.node.textContent).toContain('job-171'); expect(view.node.textContent).toContain('assignment-171')
})
it('does not offer old success evidence after a later failure from the same job', async () => {
  const item = record(); item.finding!.state = 'blocked'; item.finding!.job = { id: 'job-171' }
  item.finding!.reports = [{ reference: 'old-pass', evidence: 'passed', nextDecision: 'review', at: '1', jobId: 'job-171', state: 'ready' }, { reference: 'new-fail', evidence: 'failed', nextDecision: 'retry', at: '2', jobId: 'job-171', state: 'failed' }]
  const view = await mount(item)
  expect(view.node.querySelector('select')).toBeNull()
  expect(view.node.textContent).toContain('Reopen bounded triage')
})
it('shows no-repair-needed resolution without claiming a fix or delivery acceptance', async () => {
  const item = record(); item.finding!.state = 'resolved'; item.finding!.resolution = { outcome: 'no_repair_needed', evidenceReference: 'visual-correction', requirements: ['Retain attribution'], at: 'now', actor: 'local-operator', jobId: 'job-171' }
  const view = await mount(item)
  expect(view.node.textContent).toContain('No repair needed')
  expect(view.node.textContent).toContain('not acceptance of the linked delivery')
  expect(view.node.querySelectorAll('button')).toHaveLength(0)
})
it('requires explicit recorded evidence and requirement review before accepting a blocked finding', async () => {
  const item = record(); item.finding!.state = 'blocked'; item.finding!.job = { id: 'job-171' }; item.finding!.reports = [{ reference: 'report-1', evidence: 'Tests pass for bounded scope', nextDecision: 'Review evidence', at: 'now', jobId: 'job-171', state: 'ready' }]
  const fetch = vi.fn(async () => Response.json({})); vi.stubGlobal('fetch', fetch)
  const view = await mount(item)
  const accept = [...view.node.querySelectorAll('button')].find(b => b.textContent === 'Accept reviewed finding evidence')!
  expect(accept.disabled).toBe(true)
  const requirements = view.node.querySelector('[aria-label="Finding review requirements"]')!
  expect(requirements.textContent).toContain('Retain attribution')
  expect(requirements.closest('details')).toBeNull()
  const review = view.node.querySelector('[aria-label="Review finding evidence"]')!
  expect(review.closest('details')).toBeNull()
  expect(review.textContent).toContain('Tests pass for bounded scope')
  expect(review.textContent).toContain('I reviewed the selected evidence against every bounded requirement')
  const select = view.node.querySelector('select')!
  await act(async () => { select.value = 'report-1'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(accept.disabled).toBe(true)
  await act(async () => { (view.node.querySelector('[aria-label="Requirements acknowledgment"]') as HTMLInputElement).click() })
  await view.click('Accept reviewed finding evidence')
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/orchestrator/api/findings/finding-171/review', expect.objectContaining({ body: JSON.stringify({ revision: 3, decision: 'accept_evidence', evidenceReference: 'report-1', requirements: ['Retain attribution'], outcome: 'verified' }) }))
  expect(view.onConfirm).not.toHaveBeenCalled()
})
it.each([['Reopen bounded triage', 'retry_scope'], ['Defer review', 'defer']])('sends only a scoped review for %s without staging', async (label, decision) => {
  const item = record(); item.finding!.state = 'blocked'
  const fetch = vi.fn(async () => Response.json({})); vi.stubGlobal('fetch', fetch)
  const view = await mount(item); await view.click(label)
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/orchestrator/api/findings/finding-171/review', expect.objectContaining({ body: JSON.stringify({ revision: 3, decision }) }))
  expect(view.onConfirm).not.toHaveBeenCalled()
})
it('shows confirmation conflict without automatic replay', async () => {
  const onConfirm = vi.fn(async () => { throw new Error('409 stale revision') })
  const view = await mount(record(), onConfirm); await view.click('Run verification')
  expect(view.node.querySelector('[role=alert]')?.textContent).toContain('409 stale revision')
  expect(onConfirm).toHaveBeenCalledTimes(1)
})
it('POSTs typed revision and choice only, never a chat prompt or caller authority', async () => {
  const fetch = vi.fn(async () => Response.json({})); vi.stubGlobal('fetch', fetch)
  await confirmFinding('finding/a', { revision: 3, choiceId: 'queue_next' })
  expect(fetch).toHaveBeenCalledWith('/orchestrator/api/findings/finding%2Fa/confirm', expect.objectContaining({ method: 'POST', body: JSON.stringify({ revision: 3, choiceId: 'queue_next' }) }))
  await revisitFinding('finding/a', { revision: 4 })
  expect(fetch).toHaveBeenLastCalledWith('/orchestrator/api/findings/finding%2Fa/revisit', expect.objectContaining({ method: 'POST', body: JSON.stringify({ revision: 4 }) }))
})
it('offers operator evidence only for the same dispatched running or blocked finding', async () => {
  const running = record(); running.finding!.state = 'running'; running.finding!.job = { id: 'job-171', ticketId: 'ticket-171' }
  const active = await mount(running)
  expect(active.node.querySelector('[aria-label="Record operator evidence"]')).not.toBeNull()
  const undispatched = record(); undispatched.finding!.state = 'blocked'
  const blockedWithoutJob = await mount(undispatched)
  expect(blockedWithoutJob.node.querySelector('[aria-label="Record operator evidence"]')).toBeNull()
  const resolved = record(); resolved.finding!.state = 'resolved'; resolved.finding!.job = { id: 'job-171', ticketId: 'ticket-171' }
  const settled = await mount(resolved)
  expect(settled.node.querySelector('[aria-label="Record operator evidence"]')).toBeNull()
})
it('records nothing before an explicit click and posts only the exact finding revision payload', async () => {
  const fetch = vi.fn(async () => Response.json({})); vi.stubGlobal('fetch', fetch)
  const view = await mount(blocked())
  expect(fetch).not.toHaveBeenCalled()
  expect(view.node.textContent).toContain('Observation only')
  expect(view.node.textContent).toContain('does not accept this finding or the linked delivery')
  await fillOperatorEvidence(view.node)
  await check(view.node, 'Verified operator attestation')
  expect(fetch).not.toHaveBeenCalled()
  await view.click('Record operator evidence')
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/orchestrator/api/findings/finding-171/evidence', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ revision: 3, reference: 'ci:run:42', evidence: '65 tests passed locally; installed native UI was not exercised', nextDecision: 'Explicitly review this recorded evidence', verified: true }),
  }))
  expect(view.onConfirm).not.toHaveBeenCalled()
  expect(view.node.textContent).toContain('Evidence recorded for revision 3: ci:run:42')
  expect(view.node.textContent).toContain('did not accept the finding or delivery')
})
it('preserves the operator evidence draft and never auto-replays after a stale-revision rejection', async () => {
  const fetch = vi.fn(async () => Response.json({ error: 'Evidence requires the current dispatched finding revision' }, { status: 409 }))
  vi.stubGlobal('fetch', fetch)
  const item = blocked()
  const view = await mount(item)
  await fillOperatorEvidence(view.node)
  await view.click('Record operator evidence')
  expect(fetch).toHaveBeenCalledTimes(1)
  const alerts = [...view.node.querySelectorAll('[role=alert]')].map(element => element.textContent).join(' ')
  expect(alerts).toContain('Evidence requires the current dispatched finding revision')
  expect(alerts).toContain('409')
  expect(alerts).toContain('no automatic replay')
  expect((view.node.querySelector('[aria-label="Durable evidence reference"]') as HTMLInputElement).value).toBe('ci:run:42')
  expect((view.node.querySelector('[aria-label="Next decision"]') as HTMLTextAreaElement).value).toBe('Explicitly review this recorded evidence')
  expect([...view.node.querySelectorAll('button')].find(button => button.textContent === 'Record operator evidence')!.disabled).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(1)
  item.finding!.revision = 4
  await view.render()
  expect((view.node.querySelector('[aria-label="Durable evidence reference"]') as HTMLInputElement).value).toBe('ci:run:42')
  expect([...view.node.querySelectorAll('button')].find(button => button.textContent === 'Record operator evidence')!.disabled).toBe(false)
})
it('keeps observed operator evidence selected-only and requires explicit verification before acceptance', async () => {
  const unverified = blocked()
  unverified.finding!.reports = [{ reference: 'operator-observation', evidence: 'Visible History is populated', nextDecision: 'Review no-repair-needed verification', at: 'now', jobId: 'job-171', state: 'evidence' }]
  const view = await mount(unverified)
  expect(view.node.querySelector('select')).toBeNull()
  const verified = blocked()
  verified.finding!.reports = [{ reference: 'operator-verified', evidence: '65 tests pass at this revision', nextDecision: 'Accept recorded evidence', at: 'now', jobId: 'job-171', state: 'verified' }]
  const fetch = vi.fn(async () => Response.json({})); vi.stubGlobal('fetch', fetch)
  const accepted = await mount(verified)
  const accept = [...accepted.node.querySelectorAll('button')].find(button => button.textContent === 'Accept reviewed finding evidence')!
  expect(accept.disabled).toBe(true)
  const select = accepted.node.querySelector('[aria-label="Evidence to accept"]') as HTMLSelectElement
  expect([...select.options].map(option => option.value)).toContain('operator-verified')
  await act(async () => { select.value = 'operator-verified'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await check(accepted.node, 'Requirements acknowledgment')
  await accepted.click('Accept reviewed finding evidence')
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/orchestrator/api/findings/finding-171/review', expect.objectContaining({
    body: JSON.stringify({ revision: 3, decision: 'accept_evidence', evidenceReference: 'operator-verified', requirements: ['Retain attribution'], outcome: 'verified' }),
  }))
  expect(accepted.onConfirm).not.toHaveBeenCalled()
})
it('POSTs operator evidence to the protected endpoint without any injected authority field', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({})); vi.stubGlobal('fetch', fetch)
  await recordFindingEvidence('finding/a', { revision: 5, reference: 'file:report.md', evidence: 'Inspected the native report', nextDecision: 'Review evidence', verified: false })
  expect(fetch).toHaveBeenCalledWith('/orchestrator/api/findings/finding%2Fa/evidence', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ revision: 5, reference: 'file:report.md', evidence: 'Inspected the native report', nextDecision: 'Review evidence', verified: false }),
  }))
  expect((fetch.mock.calls[0]![1] as RequestInit).headers).toEqual({ 'content-type': 'application/json', 'x-orchestrator-request': '1' })
})
it('surfaces the server rejection status as a typed evidence error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Explicit local operator evidence recording required' }, { status: 403 })))
  await expect(recordFindingEvidence('finding-171', { revision: 3, reference: 'r', evidence: 'e', nextDecision: 'n', verified: false })).rejects.toThrow(FindingEvidenceRejection)
  await expect(recordFindingEvidence('finding-171', { revision: 3, reference: 'r', evidence: 'e', nextDecision: 'n', verified: false })).rejects.toMatchObject({ status: 403 })
})
