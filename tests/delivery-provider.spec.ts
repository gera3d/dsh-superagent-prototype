import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { apply } from '../src/app/decision-inbox-provider.ts'
import { DecisionInbox } from '../src/app/decision-inbox.ts'
import { FeatureDeliveryRuntime, projectDeliveries } from '../src/app/delivery-runtime.ts'
import { Store } from '../src/app/store.ts'
import type { AdvisorDecision } from '../src/core/decision.ts'
import type { Ticket } from '../src/core/model.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const at = '2026-11-06T14:00:00.000Z'
const originalWorker = '3b4864f597572937fdf1c6b7c019c1d6'
const source = { sessionId: `worker-${originalWorker}`, sourceMessageId: '44576320-fcb9-4a04-b709-e46f5148c6ea', sourceTurn: 3, sourceSeq: 2988 }
function advice(overrides: Partial<AdvisorDecision> = {}): AdvisorDecision {
  return { ...source, key: 'source-empty-160', createdAt: 1793955953843, question: 'Choose the next step for this thread', context: '',
    title: 'Original #160 generated advice', model: 'recorded-advisor', options: [
      { id: 'verify-final-heads', label: 'Verify final PR gates', prompt: 'Inspect existing backend PR #25 and plugin PR #6.', why: 'Inspect the exact existing heads', recommended: true },
      { id: 'audit-evidence', label: 'Audit publication evidence', prompt: 'Audit existing publication evidence.', why: 'Read recorded evidence', recommended: false },
    ], ...overrides }
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'delivery-provider-'))
  const database = join(directory, 'orchestrator.sqlite')
  const store = new Store(database)
  const runtime = new FeatureDeliveryRuntime(store)
  const inbox = new DecisionInbox(store.db)
  const registrations = new Map<string, any>()
  const services = new Map<string, any>()
  let dispose: (() => Promise<void>) | undefined
  const ctx = {
    on: () => () => {}, logger: { error: () => {}, warn: () => {} },
    effect: (effect: () => any) => { dispose = effect() },
    provide: (name: string, service: any) => { services.set(name, service); return () => { services.delete(name) } },
    sessionPersistence: { flush: async () => {}, list: async () => [], open: async () => ({ read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }) },
    webServer: { host: '127.0.0.1', port: 3082, register: (route: any) => { registrations.set(route.path, route.handler); return () => { registrations.delete(route.path) } } },
  }
  const load = () => apply(ctx as any, { database })
  const reload = async () => { await dispose?.(); dispose = undefined; load(); await services.get('decisionInbox').ready }
  const call = async (method: string, path: string, body?: unknown) => {
    const url = `/orchestrator/api/decisions/${path}`
    const handler = registrations.get(url)
    if (!handler) return { status: 404, body: { error: 'No registered route' } }
    let status = 0, text = ''
    await handler({ method, url, headers: { host: '127.0.0.1:3082', origin: 'http://127.0.0.1:3082', 'x-orchestrator-request': '1' },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } },
    { writeHead: (code: number) => { status = code }, end: (value: string) => { text = value } })
    return { status, body: JSON.parse(text) }
  }
  const worker = (id = originalWorker) => {
    const ticket: Ticket = { id, title: `Ended implementation ${id}`, decisionId: 'source-160', mandate: {} as never,
      origin: { triggerId: 'source-160', triggerIds: ['source-160'] }, createdAt: at, updatedAt: at,
      channels: [], inputs: [], undelivered: [], follows: [{ thread: 'github:25', own: true, closed: { at, outcome: 'merged' } }],
      ended: { at, by: 'pull' as never, outcome: 'merged' },
      assignments: [{ id: `assignment-${id}`, state: 'running', createdAt: at, idleAt: at, report: { state: 'ready', summary: 'Recorded implementation ready', at } }] }
    store.tickets.save(ticket)
    return ticket
  }
  const delivery = (workers = [originalWorker]) => {
    const initial = runtime.store.create({ id: 'source-160', title: 'Durable source #160 delivery', owner: 'integration-owner', workers,
      authorities: ['local-operator'], requirements: ['native-evidence'], bindings: { repository: 'org/backend', sourceIssue: 160,
        headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), environment: 'sandbox', refs: [{ repository: 'org/backend', pr: 25, headSha: 'a'.repeat(40) }, { repository: 'org/plugins', pr: 6, headSha: 'c'.repeat(40) }] } })
    return runtime.store.compareAndSwap(initial.id, initial.revision, value => {
      value.stage = 'verifying'; value.state = 'blocked'; value.blocker = 'Native acceptance evidence pending'
      value.evidence.push({ id: 'merged-heads-160', kind: 'review', bindings: value.bindings, recordedAt: at,
        reference: 'Recorded merged backend PR #25 and plugin PR #6', outcome: 'passed' })
    })
  }
  cleanup.push(async () => { await dispose?.(); await runtime.stop(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { store, runtime, inbox, services, load, reload, call, worker, delivery }
}

it('independently loaded provider preserves ended-worker aggregate identity/revision in actual GET and provided service across reload', async () => {
  const f = fixture()
  f.worker(); f.worker('second-ended-worker')
  const delivery = f.delivery([originalWorker, 'second-ended-worker'])
  f.load()
  await f.services.get('decisionInbox').ready
  const expected = f.runtime.project(f.inbox.list()).find(item => item.delivery?.id === delivery.id)!
  expect(expected).toEqual(projectDeliveries(f.runtime.store, f.inbox.list()).find(item => item.id === expected.id))
  const first = await f.call('GET', 'inbox')
  expect(first.status).toBe(200)
  expect(first.body.items.find((item: any) => item.id === expected.id)).toEqual(expected)
  expect(f.services.get('decisionInbox').get(expected.id)).toEqual(expected)
  expect(f.services.get('decisionInbox').list().find((item: any) => item.id === expected.id)).toEqual(expected)
  f.inbox.syncTickets([], f.store.tickets.list())
  expect(f.runtime.store.get(delivery.id)).toEqual(delivery)
  await f.reload()
  const reopened = await f.call('GET', 'inbox')
  expect(reopened.body.items.find((item: any) => item.id === expected.id)).toEqual(expected)
  expect(f.runtime.store.get(delivery.id)?.revision).toBe(delivery.revision)
})

it('retires original #160 source-empty advice durably before GET, prevents helper revival, and rejects the actual stage route', async () => {
  const f = fixture()
  f.worker()
  const generated = f.inbox.publishAdvisor(advice())
  f.delivery()
  f.load()
  const service = f.services.get('decisionInbox')
  await service.ready
  // No GET has run: helper lookup must persist currency, not merely decorate a projection.
  expect(service.findSource(source)).toMatchObject({ id: generated.id, status: 'stale' })
  expect(f.inbox.get(generated.id)).toMatchObject({ status: 'stale', invalidation: { reason: expect.stringContaining('superseded') } })
  expect(service.publishAdvisor(advice())).toMatchObject({ id: generated.id, status: 'stale' })
  expect(service.ensureAdvisor(advice())).toMatchObject({ id: generated.id, status: 'stale' })
  const stage = await f.call('POST', `${generated.id}/stage`, { choiceId: 'verify-final-heads', attemptId: randomUUID(), draftText: advice().options[0]!.prompt })
  expect(stage).toMatchObject({ status: 409, body: { error: expect.stringMatching(/stale|closed/i) } })
  await f.reload()
  expect(f.inbox.get(generated.id)?.status).toBe('stale')
  expect(f.services.get('decisionInbox').findSource(source)?.status).toBe('stale')
})

it('provider retires late helper-created source-empty advice but preserves real questions and pending staged native submissions', async () => {
  const f = fixture()
  f.worker()
  const question = f.inbox.publishAdvisor(advice({ sourceMessageId: 'real-question', sourceTurn: 4, question: 'Which intake evidence is still missing?', context: 'Which intake evidence is still missing?' }))
  const staged = f.inbox.publishAdvisor(advice({ sourceMessageId: 'pending-native-submission', sourceTurn: 5 }))
  const attemptId = randomUUID()
  f.inbox.stage(staged.id, { choiceId: 'verify-final-heads', attemptId, draftText: advice().options[0]!.prompt })
  f.inbox.linkSubmission(staged.id, { attemptId, submissionId: 'native-request-still-pending' })
  const beforeStaged = f.inbox.get(staged.id)
  const beforeQuestion = f.inbox.get(question.id)
  f.delivery()
  f.load()
  const service = f.services.get('decisionInbox')
  await service.ready
  const late = service.ensureAdvisor(advice({ sourceMessageId: 'late-empty-advice', sourceTurn: 6 }))
  expect(late.status).toBe('stale')
  expect(f.inbox.get(late.id)?.status).toBe('stale')
  const latePublished = service.publishAdvisor(advice({ sourceMessageId: 'late-published-advice', sourceTurn: 7 }))
  expect(latePublished.status).toBe('stale')
  expect(f.inbox.get(latePublished.id)?.status).toBe('stale')
  await f.call('GET', 'inbox')
  expect(service.findSource({ sessionId: source.sessionId, sourceMessageId: 'real-question' })).toEqual(beforeQuestion)
  expect(f.inbox.get(question.id)).toEqual(beforeQuestion)
  expect(f.inbox.get(staged.id)).toEqual(beforeStaged)
  expect(service.get(staged.id)).toEqual(beforeStaged)
  await f.reload()
  expect(f.services.get('decisionInbox').get(staged.id)).toEqual(beforeStaged)
  expect(f.inbox.get(question.id)).toEqual(beforeQuestion)
})
