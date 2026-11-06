// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LifecycleCard } from '../src/client/lifecycle-card.tsx'
import type { PendingDecisionItem } from '../src/core/decision.ts'
import type { PublicationSnapshot } from '../src/app/publication.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const item: PendingDecisionItem = { id: 'life-demo', ticketId: 't1', ticketTitle: 'Public example', trigger: 'Ready', status: 'pending', urgency: 'low', createdAt: 1,
  question: 'Ready', context: 'Ready for review', actionMode: 'ticket_lifecycle', lifecycle: { kind: 'done', assignmentId: 'a1', prNumber: 150, docsOnly: false },
  choices: [{ id: 'try_it', label: 'Try it' }, { id: 'changes_needed', label: 'Changes needed' }],
  recommendation: { recommendedValue: '', confidence: 0, rationale: '', distribution: [], provider: '', latencyMs: 0 } }
const publication: PublicationSnapshot = {
  id: 'manifest-1', ticketId: 't1', conversationId: 'conversation-1', repository: 'example/project', prNumber: 150,
  headSha: 'a'.repeat(40), patchSha256: 'b'.repeat(64), status: 'prepared', createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z',
  evidence: { repository: 'example/project', prNumber: 150, headSha: 'a'.repeat(40), patchSha256: 'b'.repeat(64), observedAt: '2026-11-06T00:00:00Z', checks: 'passed', review: 'approved', mergeable: true, state: 'open' },
  outcomes: [], audit: [], requests: {},
}
function publishedItem(snapshot = publication, actions = ['prepare_publication', 'publish']): PendingDecisionItem {
  return { ...item, lifecycle: { ...item.lifecycle!, publication: snapshot }, choices: actions.map(id => ({ id, label: id })) }
}
let root: ReturnType<typeof createRoot> | undefined
const container = document.createElement('div')
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label)
  expect(found, `button ${label}`).toBeDefined()
  return found!
}
afterEach(() => { act(() => root?.unmount()); root = undefined; container.replaceChildren() })
async function render(props: Partial<Parameters<typeof LifecycleCard>[0]> = {}) {
  root = createRoot(container)
  const onAction = vi.fn().mockResolvedValue({ execution: 'not_executed', ticketId: 't1', message: 'No action executed.', url: 'https://github.com/example/project/pull/150/files' })
  const onTicket = vi.fn()
  await act(async () => { root!.render(<LifecycleCard item={item} onAction={onAction} onTicket={onTicket} {...props} />) })
  return { onAction, onTicket }
}
it('does not assume publication readiness without server evidence or expose model/advisor controls', async () => {
  const { onAction } = await render()
  expect(container.textContent).toContain('Publication evidence unavailable')
  expect(container.textContent).not.toContain('Done · ready for review')
  expect(container.textContent).not.toContain('Get recommendation')
  expect(container.textContent).not.toContain('Not scored')
  expect(button('Approve + publish').disabled).toBe(true)
  expect(button('Rollback').disabled).toBe(true)
  expect(onAction).not.toHaveBeenCalled()
})
it('uses an explicit action and renders a safe human review link without executing chat', async () => {
  const { onAction, onTicket } = await render()
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Try it')!.click() })
  expect(onAction).toHaveBeenCalledWith('try_it')
  expect(onTicket).not.toHaveBeenCalled()
  expect(container.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
  expect(container.querySelector('[role="status"]')?.textContent).toContain('No action executed')
})
it('opens feedback in the ticket only after server validation and surfaces stale conflicts', async () => {
  const onTicket = vi.fn(), onAction = vi.fn().mockRejectedValueOnce(new Error('Ticket state changed')).mockResolvedValue({ execution: 'not_executed', ticketId: 't1', message: 'No message sent.' })
  await render({ onTicket, onAction })
  const changes = [...container.querySelectorAll('button')].find(button => button.textContent === 'Changes needed')!
  await act(async () => { changes.click() })
  expect(onTicket).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Ticket state changed')
  await act(async () => { changes.click() })
  expect(onTicket).toHaveBeenCalledOnce()
})
it('renders exact pinned evidence without inventing phase success or readiness', async () => {
  await render({ item: publishedItem(publication, ['prepare_publication']) })
  expect(container.textContent).toContain('example/project #150')
  expect(container.textContent).toContain(publication.headSha)
  expect(container.textContent).toContain(publication.patchSha256)
  expect(container.textContent).toContain('Checks: passed')
  expect(container.textContent).toContain('No publication phases executed')
  expect(button('Approve + publish').disabled).toBe(true)
  expect(button('Rollback').disabled).toBe(true)
})
it('inspects a manifest then uses returned server choices and binds explicit approval to that manifest', async () => {
  const onAction = vi.fn().mockResolvedValueOnce({ execution: 'not_executed', ticketId: 't1', message: 'Manifest reviewed.', publication,
    choices: [{ id: 'prepare_publication', label: 'Inspect' }, { id: 'publish', label: 'Publish' }] })
    .mockResolvedValueOnce({ execution: 'published', ticketId: 't1', message: 'Published.', publication: { ...publication, status: 'published' }, choices: [{ id: 'prepare_publication', label: 'Inspect' }] })
  await render({ item: { ...item, choices: [{ id: 'prepare_publication', label: 'Inspect' }] }, onAction })
  expect(onAction).not.toHaveBeenCalled()
  await act(async () => { button('Inspect publication').click() })
  expect(onAction).toHaveBeenNthCalledWith(1, 'prepare_publication')
  expect(button('Approve + publish').disabled).toBe(false)
  expect(container.textContent).toContain(publication.patchSha256)
  await act(async () => { button('Approve + publish').click() })
  expect(onAction).toHaveBeenNthCalledWith(2, 'publish', { publicationId: publication.id, requestId: expect.any(String) })
  expect(onAction.mock.calls[1]![1].requestId).toMatch(/^[\da-f-]{36}$/i)
  expect(button('Approve + publish').disabled).toBe(true)
})
it('does not infer controls from a returned manifest lacking server-projected choices', async () => {
  const onAction = vi.fn().mockResolvedValue({ execution: 'not_executed', ticketId: 't1', message: 'Reviewed.', publication })
  await render({ item: publishedItem(), onAction })
  await act(async () => { button('Inspect publication').click() })
  expect(button('Approve + publish').disabled).toBe(true)
  expect(button('Rollback').disabled).toBe(true)
})
it('shows server blocked reasons and actual phase failures while allowing only projected rollback', async () => {
  const failed: PublicationSnapshot = { ...publication, status: 'blocked', audit: [{ at: publication.updatedAt, event: 'gates_blocked', detail: 'Repository/PR/head/patch changed' }],
    outcomes: [{ stage: 'apply', operationId: 'apply-1', status: 'succeeded', startedAt: publication.createdAt, finishedAt: publication.updatedAt, detail: 'Applied pinned patch' },
      { stage: 'build', operationId: 'build-1', status: 'failed', startedAt: publication.createdAt, finishedAt: publication.updatedAt, detail: 'Compiler rejected patch' }] }
  const onAction = vi.fn().mockResolvedValue({ execution: 'rolled_back', ticketId: 't1', message: 'Rollback completed.', publication: { ...failed, status: 'rolled_back' }, choices: [] })
  await render({ item: publishedItem(failed, ['prepare_publication', 'rollback']), onAction })
  expect(container.textContent).toContain('Publication blocked: Repository/PR/head/patch changed')
  expect(container.textContent).toContain('apply: succeeded')
  expect(container.textContent).toContain('build: failed')
  expect(container.textContent).toContain('Compiler rejected patch')
  expect(container.textContent).not.toContain('verify: succeeded')
  expect(button('Approve + publish').disabled).toBe(true)
  expect(button('Rollback').disabled).toBe(false)
  await act(async () => { button('Rollback').click() })
  expect(onAction).toHaveBeenCalledWith('rollback', { publicationId: publication.id, requestId: expect.any(String) })
  expect(button('Rollback').disabled).toBe(true)
})
it('prevents duplicate synchronous approvals while the server is processing', async () => {
  let finish!: (result: unknown) => void
  const onAction = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await render({ item: publishedItem(), onAction })
  await act(async () => { button('Approve + publish').click(); button('Approve + publish').click() })
  expect(onAction).toHaveBeenCalledOnce()
  expect(button('Rollback').disabled).toBe(true)
  await act(async () => { finish({ execution: 'not_executed', ticketId: 't1', message: 'No action.' }) })
})
it('does not approve invalidated or stale cards even when actions were previously offered', async () => {
  const onAction = vi.fn()
  await render({ item: { ...publishedItem(), invalidation: { at: 1, reason: 'New head received' } }, onAction })
  expect(container.textContent).toContain('New head received')
  expect(button('Approve + publish').disabled).toBe(true)
  expect(button('Inspect publication').disabled).toBe(true)
  await act(async () => { button('Approve + publish').click() })
  expect(onAction).not.toHaveBeenCalled()
})
it('does not describe publication as published without a successful verification outcome', async () => {
  await render({ item: publishedItem({ ...publication, status: 'published' }, ['prepare_publication']) })
  expect(container.textContent).toContain('publication verification unconfirmed')
  expect(container.textContent).not.toContain('publication published')
})
it('replaces local result evidence when refreshed server props change the manifest', async () => {
  const onAction = vi.fn().mockResolvedValue({ execution: 'not_executed', ticketId: 't1', message: 'Reviewed.', publication, choices: [{ id: 'publish', label: 'Publish' }] })
  await render({ item: publishedItem(), onAction })
  await act(async () => { button('Inspect publication').click() })
  expect(button('Approve + publish').disabled).toBe(false)
  const newer = { ...publication, id: 'manifest-2', headSha: 'c'.repeat(40), status: 'blocked' as const }
  await act(async () => { root!.render(<LifecycleCard item={publishedItem(newer, ['prepare_publication'])} onAction={onAction} onTicket={() => {}} />) })
  expect(container.textContent).toContain(newer.headSha)
  expect(container.textContent).not.toContain('manifest-1')
  expect(button('Approve + publish').disabled).toBe(true)
})
it('uses the newest publication timestamp across click results and polling props', async () => {
  const clicked = { ...publication, updatedAt: '2026-11-06T00:00:01Z' }
  const onAction = vi.fn().mockResolvedValue({ execution: 'publication', ticketId: 't1', message: 'Manifest reviewed.', publication: clicked,
    choices: [{ id: 'publish', label: 'Publish' }] })
  await render({ item: publishedItem(), onAction })
  await act(async () => { button('Inspect publication').click() })
  // An older poll must not revoke the newer reviewed result or replace its controls.
  await act(async () => { root!.render(<LifecycleCard item={publishedItem(publication, ['prepare_publication'])} onAction={onAction} onTicket={() => {}} />) })
  expect(button('Approve + publish').disabled).toBe(false)
  const running: PublicationSnapshot = { ...clicked, updatedAt: '2026-11-06T00:00:02Z', outcomes: [{ stage: 'build', operationId: 'build-1', status: 'running', startedAt: clicked.updatedAt }] }
  await act(async () => { root!.render(<LifecycleCard item={publishedItem(running, ['prepare_publication', 'rollback'])} onAction={onAction} onTicket={() => {}} />) })
  expect(container.textContent).toContain('build: running')
  expect(button('Approve + publish').disabled).toBe(true)
  expect(button('Rollback').disabled).toBe(false)
})
it('renders local Senior Developer evidence fingerprints, check reports, and limitations without inventing results', async () => {
  const local: PublicationSnapshot = { ...publication, evidence: { ...publication.evidence!, local: {
    reviewer: 'Senior Developer', reportSha256: 'd'.repeat(64), checks: [{ name: 'Targeted lifecycle tests', reportSha256: 'e'.repeat(64), completedAt: '2026-11-06T00:00:00Z' }],
    limitations: ['Browser verification was not performed', 'External deployment target is not covered'],
  } } }
  await render({ item: publishedItem(local, ['prepare_publication']) })
  const evidence = container.querySelector('[aria-label="Local exact-head review"]')!
  expect(evidence.textContent).toContain('Reviewer: Senior Developer · Verdict: approved')
  expect(evidence.textContent).toContain('d'.repeat(64))
  expect(evidence.textContent).toContain('e'.repeat(64))
  expect(evidence.textContent).toContain('Targeted lifecycle tests')
  expect(evidence.textContent).toContain('Completed: 2026-11-06T00:00:00Z')
  expect(evidence.textContent).toContain('Browser verification was not performed')
  expect(evidence.textContent).toContain('External deployment target is not covered')
  expect(evidence.querySelector('details')).toBeNull()
  expect(evidence.querySelector('pre')).toBeNull()
  expect(button('Approve + publish').disabled).toBe(true)
})
it('renders server review and check excerpts as collapsed escaped text without interpreting markup', async () => {
  const reviewExcerpt = 'Senior Developer: approved\n<script>window.injected = true</script>\nReviewed <exact-head> & patch.'
  const outputExcerpt = '24 tests passed\n<img src=x onerror="alert(1)">\n$ pnpm test'
  const local: PublicationSnapshot = { ...publication, evidence: { ...publication.evidence!, local: {
    reviewer: 'Senior Developer', reportSha256: 'd'.repeat(64), reviewExcerpt,
    checks: [{ name: 'Lifecycle tests', reportSha256: 'e'.repeat(64), completedAt: publication.updatedAt, outputExcerpt },
      { name: 'Typecheck without excerpt', reportSha256: 'f'.repeat(64), completedAt: publication.updatedAt }], limitations: [],
  } } }
  await render({ item: publishedItem(local) })
  const review = container.querySelector<HTMLDetailsElement>('details[aria-label="Review evidence"]')!
  const check = container.querySelector<HTMLDetailsElement>('details[aria-label="Check output: Lifecycle tests"]')!
  expect(review.querySelector('summary')?.textContent).toBe('Review evidence')
  expect(check.querySelector('summary')?.textContent).toBe('Check output: Lifecycle tests')
  expect(review.open).toBe(false)
  expect(check.open).toBe(false)
  expect(review.querySelector('pre')?.textContent).toBe(reviewExcerpt)
  expect(check.querySelector('pre')?.textContent).toBe(outputExcerpt)
  expect(review.querySelector('pre')?.style.whiteSpace).toBe('pre-wrap')
  expect(check.querySelector('pre')?.style.whiteSpace).toBe('pre-wrap')
  expect(container.querySelectorAll('details')).toHaveLength(2)
  expect(container.querySelector('script, img, exact-head')).toBeNull()
  expect(container.querySelector('details[aria-label="Check output: Typecheck without excerpt"]')).toBeNull()
})
it('does not fabricate local reviewer evidence when the server did not provide it', async () => {
  await render({ item: publishedItem() })
  expect(container.querySelector('[aria-label="Local exact-head review"]')).toBeNull()
  expect(container.textContent).not.toContain('Senior Developer')
})
it.each(['stale', 'resolved'] as const)('allows only explicitly offered rollback on a %s recovery card', async status => {
  const recoverable: PublicationSnapshot = { ...publication, status: 'failed', outcomes: [{ stage: 'apply', operationId: 'apply-1', status: 'failed', startedAt: publication.createdAt, detail: 'Apply failed' }] }
  const original = publishedItem(recoverable, ['prepare_publication', 'publish', 'rollback', 'changes_needed', 'try_it'])
  const recovery: PendingDecisionItem = { ...original, status, invalidation: { at: 2, reason: 'Original PR merged' }, lifecycle: { ...original.lifecycle!, recovery: true } }
  const onAction = vi.fn().mockResolvedValue({ execution: 'publication', ticketId: 't1', message: 'Rolled back.', publication: { ...recoverable, status: 'rolled_back' }, choices: [] })
  const onTicket = vi.fn()
  await render({ item: recovery, onAction, onTicket })
  expect(container.textContent).toContain('Recovery only')
  expect(container.textContent).toContain('apply: failed')
  expect(button('Approve + publish').disabled).toBe(true)
  expect(button('Inspect publication').disabled).toBe(true)
  expect(button('Rollback').disabled).toBe(false)
  expect([...container.querySelectorAll('button')].map(control => control.textContent)).toEqual(['View ticket', 'Inspect publication', 'Approve + publish', 'Rollback'])
  expect(onAction).not.toHaveBeenCalled()
  await act(async () => { button('Approve + publish').click(); button('Inspect publication').click(); button('Rollback').click() })
  expect(onAction).toHaveBeenCalledExactlyOnceWith('rollback', { publicationId: publication.id, requestId: expect.any(String) })
  expect(onTicket).not.toHaveBeenCalled()
  expect(button('Rollback').disabled).toBe(true)
})
it('does not grant rollback from the recovery marker without a server-projected rollback choice', async () => {
  const original = publishedItem(publication, ['publish'])
  const recovery: PendingDecisionItem = { ...original, status: 'stale', lifecycle: { ...original.lifecycle!, recovery: true } }
  const { onAction } = await render({ item: recovery })
  expect(button('Approve + publish').disabled).toBe(true)
  expect(button('Rollback').disabled).toBe(true)
  await act(async () => { button('Rollback').click() })
  expect(onAction).not.toHaveBeenCalled()
})
it.each(['stale', 'resolved'] as const)('permits only server publication actions for a %s own-merge continuation', async status => {
  const blocked: PublicationSnapshot = { ...publication, status: 'blocked', audit: [{ at: publication.updatedAt, event: 'gates_blocked', detail: 'Transient post-merge checks pending' }],
    outcomes: [{ stage: 'merge', operationId: 'merge-1', status: 'succeeded', startedAt: publication.createdAt, finishedAt: publication.updatedAt }] }
  const original = publishedItem(blocked, ['prepare_publication', 'changes_needed', 'try_it', 'merge'])
  const continuation: PendingDecisionItem = { ...original, status, invalidation: { at: 2, reason: 'Own PR merged' }, lifecycle: { ...original.lifecycle!, recovery: true, continuation: true } }
  const refreshed: PublicationSnapshot = { ...blocked, status: 'merged', updatedAt: '2026-11-06T00:00:01Z' }
  const onAction = vi.fn().mockResolvedValueOnce({ execution: 'publication', ticketId: 't1', message: 'Evidence refreshed.', publication: refreshed,
    choices: [{ id: 'prepare_publication', label: 'Inspect' }, { id: 'publish', label: 'Publish' }] })
    .mockResolvedValueOnce({ execution: 'publication', ticketId: 't1', message: 'Queued.', publication: { ...refreshed, updatedAt: '2026-11-06T00:00:02Z', coordination: {
      grantId: 'grant-1', status: 'queued', createdAt: refreshed.updatedAt, updatedAt: '2026-11-06T00:00:02Z' } }, choices: [] })
  const onTicket = vi.fn()
  await render({ item: continuation, onAction, onTicket })
  expect(container.textContent).toContain('Server-authorized continuation')
  expect(container.textContent).toContain('Transient post-merge checks pending')
  expect(button('Inspect publication').disabled).toBe(false)
  expect(button('Approve + publish').disabled).toBe(true)
  expect(button('Rollback').disabled).toBe(true)
  expect([...container.querySelectorAll('button')].map(control => control.textContent)).toEqual(['View ticket', 'Inspect publication', 'Approve + publish', 'Rollback'])
  expect(onAction).not.toHaveBeenCalled()
  await act(async () => { button('Inspect publication').click() })
  expect(onAction).toHaveBeenNthCalledWith(1, 'prepare_publication')
  expect(button('Approve + publish').disabled).toBe(false)
  await act(async () => { button('Approve + publish').click() })
  expect(onAction).toHaveBeenNthCalledWith(2, 'publish', { publicationId: publication.id, requestId: expect.any(String) })
  expect(onTicket).not.toHaveBeenCalled()
  expect(button('Approve + publish').disabled).toBe(true)
  expect(container.textContent).toContain('Publication worker: queued')
})
it('does not grant stale publication access from a continuation flag without server recovery authority', async () => {
  const original = publishedItem()
  const invalid: PendingDecisionItem = { ...original, status: 'stale', lifecycle: { ...original.lifecycle!, continuation: true } }
  const { onAction } = await render({ item: invalid })
  expect(button('Inspect publication').disabled).toBe(true)
  expect(button('Approve + publish').disabled).toBe(true)
  await act(async () => { button('Inspect publication').click(); button('Approve + publish').click() })
  expect(onAction).not.toHaveBeenCalled()
})
it.each(['queued', 'running'] as const)('shows actual %s worker coordination without permitting duplicate actions', async status => {
  const coordinated: PublicationSnapshot = { ...publication, coordination: { grantId: 'grant-1', status, createdAt: publication.createdAt, updatedAt: publication.updatedAt, detail: 'Detached worker owns the exact pinned manifest' } }
  const { onAction } = await render({ item: publishedItem(coordinated, ['prepare_publication', 'publish', 'rollback']) })
  const progress = container.querySelector('[aria-label="Publication coordination"]')!
  expect(progress.textContent).toContain(`Publication worker: ${status}`)
  expect(progress.textContent).toContain('Detached worker owns the exact pinned manifest')
  expect(progress.textContent).toContain('Queued: 2026-11-06T00:00:00Z')
  expect(container.textContent).toContain('No publication phases executed')
  expect(button('Approve + publish').disabled).toBe(true)
  expect(button('Inspect publication').disabled).toBe(true)
  expect(button('Rollback').disabled).toBe(true)
  await act(async () => { button('Approve + publish').click(); button('Rollback').click() })
  expect(onAction).not.toHaveBeenCalled()
})
it('shows expired coordination and never translates completed coordination into publication success', async () => {
  const expired: PublicationSnapshot = { ...publication, coordination: { grantId: 'grant-1', status: 'expired', createdAt: publication.createdAt, updatedAt: publication.updatedAt, detail: 'Worker authorization expired before claim' } }
  const { onAction } = await render({ item: publishedItem(expired, ['prepare_publication']) })
  expect(container.textContent).toContain('Worker authorization expired before claim')
  expect(container.textContent).toContain('Worker expired. Review the recorded outcomes; no automatic replay.')
  expect(button('Approve + publish').disabled).toBe(true)
  const completed: PublicationSnapshot = { ...expired, updatedAt: '2026-11-06T00:00:01Z', coordination: { ...expired.coordination!, status: 'completed' } }
  await act(async () => { root!.render(<LifecycleCard item={publishedItem(completed, ['prepare_publication'])} onAction={onAction} onTicket={() => {}} />) })
  expect(container.textContent).toContain('Publication worker: completed')
  expect(container.textContent).not.toContain('publication published')
  expect(container.textContent).not.toContain('verify: succeeded')
})
it('shows only Retry and Open issue for stuck cards and disables successful retries', async () => {
  const stuck = { ...item, lifecycle: { kind: 'stuck' as const, assignmentId: 'a1', issueUrl: 'https://github.com/example/project/issues/143' }, choices: [{ id: 'retry', label: 'Retry' }, { id: 'open_issue', label: 'Open issue' }] }
  const onAction = vi.fn().mockResolvedValue({ execution: 'retried', ticketId: 't1', message: 'Fresh assignment requested.' })
  await render({ item: stuck, onAction })
  expect(container.querySelector('a')?.getAttribute('href')).toBe(stuck.lifecycle.issueUrl)
  expect(container.querySelector('a')?.textContent).toContain('Open issue')
  const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry')!
  await act(async () => { retry.click() })
  expect(retry.disabled).toBe(true)
  await act(async () => { retry.click() })
  expect(onAction).toHaveBeenCalledOnce()
})
