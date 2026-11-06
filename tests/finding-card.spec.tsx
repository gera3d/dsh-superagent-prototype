// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { PendingDecisionItem } from '../src/core/decision.ts'
import type { Finding } from '../src/app/finding.ts'
import { FindingCard, confirmFinding, revisitFinding } from '../src/client/finding-card.tsx'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let cleanup = () => {}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function record(): PendingDecisionItem {
  const finding: Finding = { id: 'finding-171', dedupKey: 'scope', title: 'Verify History', problem: 'Missing verification context', scope: 'Only History visibility', owner: 'Senior Developer', kind: 'verification', repository: 'example/repo', requirements: ['Retain attribution'], occurrences: [{ id: 'o', reference: 'History', evidence: 'Missing context', at: 'now' }], existingDeliveryId: 'delivery-159', revision: 3, state: 'awaiting_decision', choices: [{ id: 'fix_now', kind: 'fix_now', label: 'Run verification' }, { id: 'queue_next', kind: 'queue_next', label: 'Queue next' }, { id: 'defer', kind: 'defer', label: 'Defer' }], recommendation: { choiceId: 'queue_next', rationale: 'Preserve current work ordering', provider: 'Configured model', recordedAt: 'now', revision: 3 }, reports: [], audit: [], createdAt: 'now', updatedAt: 'now' }
  return { id: finding.id, finding, actionMode: 'finding_triage', ticketTitle: finding.title, trigger: finding.problem, status: 'pending', urgency: 'medium', createdAt: 1, context: finding.scope, question: finding.title, choices: [], recommendation: { recommendedValue: '', confidence: 0, distribution: [], rationale: '', provider: '', latencyMs: 0 } }
}
async function mount(item = record(), onConfirm = vi.fn(async (_request: unknown) => ({})), onRevisit = vi.fn(async (_request: unknown) => ({}))) {
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node)
  cleanup = () => { act(() => root.unmount()); node.remove() }
  const render = async () => { await act(async () => { root.render(<FindingCard item={item} onConfirm={onConfirm} onRevisit={onRevisit} />) }) }
  await render()
  const click = async (label: string) => { await act(async () => { [...node.querySelectorAll('button')].find(b => b.textContent === label)!.click() }) }
  return { node, onConfirm, onRevisit, render, click, item }
}
it('renders real recorded advice, bounded scope, linked delivery and FIFO semantics', async () => {
  const view = await mount()
  for (const text of ['Senior Developer recommends: Queue next', 'Preserve current work ordering', 'Only History visibility', 'FIFO', 'next scheduler pass']) expect(view.node.textContent).toContain(text)
  expect(view.node.querySelector('a')?.getAttribute('href')).toBe('#delivery-delivery-159')
  expect([...view.node.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Run verification', 'Queue next', 'Defer'])
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
  expect(view.node.querySelectorAll('button')).toHaveLength(0)
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
  const select = view.node.querySelector('select')!
  await act(async () => { select.value = 'report-1'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(accept.disabled).toBe(true)
  await act(async () => { (view.node.querySelector('input[type=checkbox]') as HTMLInputElement).click() })
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
