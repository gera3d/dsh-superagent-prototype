import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { FeatureDeliveryRuntime, deliveryDecision, reconcileInboxCurrency } from '../src/app/delivery-runtime.ts'
import { DecisionInbox, ticketDecisions } from '../src/app/decision-inbox.ts'
import { publicationConversation, type LifecyclePublication } from '../src/app/lifecycle-publication.ts'
import type { Ticket } from '../src/core/model.ts'

const cleanup: (() => void)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const done of cleanup.splice(0).reverse()) done() })
const at = '2026-11-06T10:00:00.000Z'
function fixture(capabilities: ConstructorParameters<typeof FeatureDeliveryRuntime>[1] = {}, options: ConstructorParameters<typeof FeatureDeliveryRuntime>[2] = {}) {
  const path = mkdtempSync(join(tmpdir(), 'delivery-runtime-'))
  const store = new Store(join(path, 'test.sqlite')); cleanup.push(() => { store.close(); rmSync(path, { recursive: true, force: true }) })
  const runtime = new FeatureDeliveryRuntime(store, capabilities, options)
  const worker = (id: string, ended = true) => {
    const ticket: Ticket = { id, title: id, decisionId: 'source-decision', mandate: {} as never, origin: { triggerId: 'source', triggerIds: ['source'] }, createdAt: at, updatedAt: at,
      channels: [], inputs: [], undelivered: [], follows: [{ thread: 'github:12', own: true, ...(ended ? { closed: { at, outcome: 'merged' as const } } : {}) }],
      ...(ended ? { ended: { at, by: 'pull' as never, outcome: 'merged' as const } } : {}),
      assignments: [{ id: 'a', state: 'running', createdAt: at, idleAt: at, report: { state: 'ready', summary: 'Actual recorded ready report', at } }] }
    store.tickets.save(ticket); return ticket
  }
  const intake = (id: string, workers: string[], delegatedActions: ('review' | 'fix')[] = []) => runtime.store.create({ id, title: id, owner: 'integration-owner', workers, delegatedActions,
    authorities: ['operator'], requirements: ['native-click'], bindings: { repository: 'org/repo', sourceIssue: 159, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), environment: 'isolated',
      refs: [{ repository: 'org/repo', pr: 12, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }] } })
  return { store, runtime, worker, intake }
}
it('keeps two ended and merged jobs visible through actual durable handoffs and the canonical inbox projection', async () => {
  const { runtime, worker, intake } = fixture()
  const one = worker('one'), two = worker('two')
  intake('feature-one', [one.id], ['review']); intake('feature-two', [two.id], ['review'])
  await runtime.request()
  const items = runtime.project([])
  expect(items).toHaveLength(2)
  for (const item of items) {
    expect(item).toMatchObject({ status: 'pending', actionMode: 'feature_delivery', delivery: { stage: 'review', state: 'blocked', blocker: 'Missing capability: review' } })
    expect(item.delivery?.acceptance).toBeUndefined()
    expect(deliveryDecision(runtime.store.get(item.delivery!.id)!)).toEqual(item)
  }
  await runtime.stop()
})
it('leaves explicitly cancelled unbound history terminal while later deliveries continue', async () => {
  const { runtime, worker, intake } = fixture()
  const stopped = worker('cancelled')
  const tracked = runtime.store.trackUnbound({ ticketId: stopped.id, title: stopped.title, owner: 'source-owner', repository: 'org/repo', triggerId: 'source' })
  runtime.store.compareAndSwap(tracked.id, tracked.revision, d => { d.state = 'cancelled' })
  intake('later', [worker('later').id], ['review'])
  await runtime.request()
  expect(runtime.store.get(tracked.id)?.state).toBe('cancelled')
  expect(runtime.store.get('later')?.stage).toBe('review')
  await runtime.stop()
})
it('does not give an unavailable recommendation model authority to veto an otherwise eligible action', async () => {
  const recommend = vi.fn(async () => { throw new Error('Configured advice model unavailable') })
  const { runtime, worker, intake } = fixture({}, { recommend })
  intake('feature', [worker('one').id])
  await runtime.request(); await runtime.request()
  const delivery = runtime.store.get('feature')!
  expect(delivery.state).toBe('awaiting_decision'); expect(delivery.nextAction?.kind).toBe('review')
  expect(delivery.recommendationError?.message).toContain('unavailable'); expect(delivery.blocker).toBeUndefined()
  expect(recommend).toHaveBeenCalledTimes(1)
  await runtime.stop()
})
it('recovers preparation when the same-bound trusted manifest becomes available without database edits or new intake', async () => {
  let available = false
  const publication = { pinsFor: () => available ? { repository: 'org/repo', prNumber: 12, headSha: 'a'.repeat(40), patchSha256: 'd'.repeat(64) } : undefined,
    scopeFor: () => ({ environment: 'isolated', refs: [{ repository: 'org/repo', pr: 12, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }], components: ['Example'], effects: ['Rebuild example'], manifestSha256: 'e'.repeat(64) }),
    service: { prepare: vi.fn(async (input: object) => ({ ...input, id: 'manifest', status: 'prepared', createdAt: at, updatedAt: at, outcomes: [], audit: [], requests: {} })) } } as unknown as LifecyclePublication
  const { runtime, worker, intake } = fixture({}, { publication })
  const initial = intake('feature', [worker('one', false).id])
  runtime.store.compareAndSwap(initial.id, initial.revision, d => { d.stage = 'ready_to_publish' })
  await runtime.request()
  expect(runtime.store.get('feature')?.state).toBe('blocked')
  available = true
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 6000)
  await runtime.request()
  expect(runtime.store.get('feature')).toMatchObject({ state: 'awaiting_decision', preparedPublication: { id: 'manifest', environment: 'isolated', scopeSha256: 'e'.repeat(64) }, nextAction: { kind: 'publish' } })
  expect(publication.service.prepare).toHaveBeenCalledTimes(1)
  await runtime.stop()
})
it('aborts a pending actual coordinator lease on stop and parks uncertainty without duplicate effects', async () => {
  let signal: AbortSignal | undefined
  let started!: () => void
  const begun = new Promise<void>(resolve => { started = resolve })
  const execute = vi.fn(async (lease: { signal?: AbortSignal }) => { signal = lease.signal; started(); return new Promise<never>(() => {}) })
  const { runtime, worker, intake } = fixture({ review: { execute } })
  intake('feature', [worker('one').id], ['review'])
  const request = runtime.request(); await begun
  await runtime.stop(); await request
  expect(signal?.aborted).toBe(true); expect(execute).toHaveBeenCalledTimes(1)
  expect(runtime.store.get('feature')).toMatchObject({ state: 'blocked', blocker: expect.stringContaining('reconciliation required') })
  expect(await runtime.coordinator.runOnce('after-stop')).toBe(false)
})
it('persists evidence-linked source-empty generated advice retirement without retiring real questions', async () => {
  const { store, runtime, worker, intake } = fixture()
  const ticket = worker('original-160')
  let d = intake('feature', [ticket.id])
  d = runtime.store.compareAndSwap(d.id, d.revision, value => { value.stage = 'verifying'; value.state = 'blocked'; value.blocker = 'Native acceptance pending'; value.evidence.push({ id: 'actual-merge', kind: 'review', bindings: value.bindings, recordedAt: at, reference: 'https://github.com/org/repo/pull/12', outcome: 'passed' }) })
  const inbox = new DecisionInbox(store.db)
  const generated = inbox.publishAdvisor({ sessionId: `worker-${ticket.id}`, sourceMessageId: 'blank-final', sourceTurn: 1, sourceSeq: 117, key: 'source-empty', createdAt: Date.parse(at) - 1000,
    question: 'Choose the next step for this thread', context: '', title: 'Generated advice', model: 'actual-advisor', options: [{ id: 'checks', label: 'Read every PR check', prompt: 'Read every PR check', why: 'Verify', recommended: true }, { id: 'audit', label: 'Audit handoff', prompt: 'Audit handoff', why: 'Audit', recommended: false }] })
  const question = inbox.publishAdvisor({ sessionId: `worker-${ticket.id}`, sourceMessageId: 'real-question', sourceTurn: 2, sourceSeq: 119, key: 'real-question', createdAt: Date.parse(at) - 500,
    question: 'Which acceptance requirement is missing?', context: 'Which acceptance requirement is missing?', title: 'Real question', model: 'actual-advisor', options: [{ id: 'explain', label: 'Explain', prompt: 'Explain', why: 'Explain', recommended: true }, { id: 'inspect', label: 'Inspect', prompt: 'Inspect', why: 'Inspect', recommended: false }] })
  reconcileInboxCurrency(inbox, runtime.store)
  expect(inbox.get(generated.id)?.status).toBe('stale')
  expect(inbox.findSource({ sessionId: generated.sessionId!, sourceMessageId: 'blank-final' })?.status).toBe('stale')
  expect(() => inbox.stage(generated.id, { choiceId: 'checks', attemptId: 'attempt', draftText: 'Read every PR check' })).toThrow('stale')
  expect(inbox.get(question.id)?.status).toBe('pending')
  expect(runtime.project(inbox.list()).find(item => item.id === generated.id)?.status).toBe('stale')
  await runtime.stop()
})
