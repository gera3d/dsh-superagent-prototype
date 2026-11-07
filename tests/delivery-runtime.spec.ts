import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { FeatureDeliveryRuntime, deliveryDecision, reconcileInboxCurrency } from '../src/app/delivery-runtime.ts'
import { DecisionInbox, ticketDecisions } from '../src/app/decision-inbox.ts'
import { publicationConversation, type LifecyclePublication } from '../src/app/lifecycle-publication.ts'
import type { Ticket } from '../src/core/model.ts'
import type { Delivery, DeliveryAction } from '../src/app/feature-delivery.ts'

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
it('renders a truthful readable blocker and durable card identity when an unbound implementation run reports blocked', async () => {
  const { runtime, store, worker } = fixture()
  const ticket = worker('blocked-worker', false)
  ticket.assignments[0]!.report = { state: 'blocked', summary: 'Required dependency unavailable; restore the configured service.', at }
  store.tickets.save(ticket)
  runtime.store.trackUnbound({ ticketId: ticket.id, title: ticket.title, owner: 'source-owner', repository: 'org/repo', triggerId: 'source' })
  await runtime.request()
  const item = runtime.project([])[0]!
  expect(item).toMatchObject({ context: ticket.assignments[0]!.report.summary, delivery: { state: 'blocked', stage: 'implementation', blocker: ticket.assignments[0]!.report.summary } })
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { DeliveryCard } = await import('../src/client/delivery-card.tsx')
  const rendered = renderToStaticMarkup(createElement(DeliveryCard, { item, onConfirm: async () => {} }))
  expect(rendered).toContain('Required dependency unavailable; restore the configured service.')
  expect(rendered).toContain(`id="delivery-${item.delivery!.id}"`)
  expect(item.choices).toEqual([])
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

function provenPublication(headSha: string) {
  const evidence = { repository: 'org/repo', prNumber: 12, headSha, patchSha256: 'd'.repeat(64), observedAt: at, checks: 'passed' as const,
    review: 'approved' as const, mergeable: true, state: 'open' as const,
    local: { reviewer: 'Codex', reportSha256: '1'.repeat(64), reviewExcerpt: 'r'.repeat(2000),
      checks: [{ name: 'pnpm test', reportSha256: '2'.repeat(64), completedAt: at, outputExcerpt: 'c'.repeat(1000) }],
      limitations: ['Native acceptance remains separate.'] } }
  return { pinsFor: () => ({ repository: 'org/repo', prNumber: 12, headSha: 'a'.repeat(40), patchSha256: 'd'.repeat(64) }),
    scopeFor: () => ({ environment: 'isolated', refs: [{ repository: 'org/repo', pr: 12, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }],
      components: ['Example'], effects: ['Rebuild example'], manifestSha256: 'e'.repeat(64) }),
    service: { prepare: vi.fn(async (input: object) => ({ ...input, id: 'manifest', status: 'prepared' as const, createdAt: at, updatedAt: at,
      outcomes: [], audit: [], requests: {}, evidence })) } } as unknown as LifecyclePublication
}

it('records bounded server-derived review/check proof when the prepared publication has exact verified evidence', async () => {
  const { runtime, worker, intake } = fixture({}, { publication: provenPublication('a'.repeat(40)) })
  const initial = intake('feature', [worker('one', false).id])
  runtime.store.compareAndSwap(initial.id, initial.revision, d => { d.stage = 'ready_to_publish' })
  await runtime.request()
  const prepared = runtime.store.get('feature')!.preparedPublication!
  expect(prepared.proof).toMatchObject({ verified: true, reviewer: 'Codex', status: { checks: 'passed', review: 'approved' },
    limitations: ['Native acceptance remains separate.'], counts: { checks: 1, limitations: 1 } })
  expect(prepared.proof!.reviewExcerpt).toHaveLength(600)
  expect(prepared.proof!.checks).toEqual([{ name: 'pnpm test', completedAt: at, reportSha256: '2'.repeat(64), excerpt: 'c'.repeat(200) }])
  await runtime.stop()
})

it('never records publication proof when the adapter evidence does not match the prepared pins', async () => {
  const { runtime, worker, intake } = fixture({}, { publication: provenPublication('3'.repeat(40)) })
  const initial = intake('feature', [worker('one', false).id])
  runtime.store.compareAndSwap(initial.id, initial.revision, d => { d.stage = 'ready_to_publish' })
  await runtime.request()
  const prepared = runtime.store.get('feature')!.preparedPublication!
  expect(prepared.headSha).toBe('a'.repeat(40))
  expect(prepared).not.toHaveProperty('proof')
  await runtime.stop()
})


it('derives exact-pin proof from the live snapshot for a pre-upgrade prepared card without persisting or repairing it', async () => {
  const evidence = { repository: 'org/repo', prNumber: 12, headSha: 'a'.repeat(40), patchSha256: 'd'.repeat(64), observedAt: at, checks: 'passed' as const,
    review: 'approved' as const, mergeable: true, state: 'open' as const,
    local: { reviewer: 'Codex', reportSha256: '1'.repeat(64), reviewExcerpt: 'Recorded review.',
      checks: [{ name: 'pnpm test', reportSha256: '2'.repeat(64), completedAt: at, outputExcerpt: 'Suite passed.' }],
      limitations: ['Native acceptance remains separate.'] } }
  // Pre-upgrade prepare recorded no evidence, so the durable card has no proof descriptor.
  const prepare = vi.fn(async (input: object) => ({ ...input, id: 'manifest', status: 'prepared' as const, createdAt: at, updatedAt: at,
    outcomes: [], audit: [], requests: {} }))
  const peek = vi.fn(() => ({ id: 'manifest', ticketId: 'one', conversationId: 'c', repository: 'org/repo', prNumber: 12,
    headSha: 'a'.repeat(40), patchSha256: 'd'.repeat(64), status: 'prepared' as const, createdAt: at, updatedAt: at, outcomes: [], audit: [],
    requests: {}, evidence }))
  const publication = { pinsFor: () => ({ repository: 'org/repo', prNumber: 12, headSha: 'a'.repeat(40), patchSha256: 'd'.repeat(64) }),
    scopeFor: () => ({ environment: 'isolated', refs: [{ repository: 'org/repo', pr: 12, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }],
      components: ['Example'], effects: ['Rebuild example'], manifestSha256: 'e'.repeat(64) }),
    service: { prepare, peek } } as unknown as LifecyclePublication
  const seen: { delivery: Delivery; action: DeliveryAction }[] = []
  const recommend = vi.fn(async (delivery: Delivery, action: DeliveryAction) => {
    seen.push({ delivery, action })
    return { disposition: 'take' as const, actionId: action.id, kind: action.kind, fingerprint: action.fingerprint,
      rationale: 'Hand the recorded publication to the release operator.', provider: 'test', recordedAt: at }
  })
  const { runtime, worker, intake } = fixture({}, { publication, recommend })
  const initial = intake('feature', [worker('one', false).id])
  runtime.store.compareAndSwap(initial.id, initial.revision, d => { d.stage = 'ready_to_publish' })
  await runtime.request()
  const stored = runtime.store.get('feature')!
  expect(stored.preparedPublication).toBeDefined()
  expect(stored.preparedPublication).not.toHaveProperty('proof')
  expect(peek).toHaveBeenCalledWith('one')
  expect(seen[0]!.delivery.preparedPublication?.proof).toMatchObject({ verified: true, reviewer: 'Codex', counts: { checks: 1, limitations: 1 } })
  expect(seen[0]!.delivery.preparedPublication!.id).toBe(stored.preparedPublication!.id)
  // The advice copy keeps the recorded action scope; no descriptor or history is written back.
  expect(seen[0]!.action.fingerprint).toBe(stored.nextAction!.fingerprint)
  expect(stored.recommendation).toMatchObject({ disposition: 'take', actionId: stored.nextAction!.id })
  await runtime.stop()
})
