import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { DeliveryStore } from '../src/app/feature-delivery.ts'
import { deliveryPublicationCapabilities } from '../src/app/delivery-publication.ts'
import { ticketDecisions } from '../src/app/decision-inbox.ts'
import { publicationConversation, type LifecyclePublication } from '../src/app/lifecycle-publication.ts'
import type { Ticket } from '../src/core/model.ts'

const handles: DatabaseSync[] = []
afterEach(() => handles.splice(0).forEach(db => db.close()))
function fixture() {
  const db = new DatabaseSync(':memory:'); handles.push(db)
  const store = new DeliveryStore(db)
  const at = '2026-11-06T10:00:00.000Z'
  const ticket: Ticket = { id: 'worker-one', title: 'Bound release', decisionId: 'original', mandate: {} as never,
    origin: { triggerId: 'source', triggerIds: ['source'] }, createdAt: at, updatedAt: at,
    channels: [], inputs: [], undelivered: [], follows: [{ thread: 'github:12', own: true }],
    assignments: [{ id: 'assignment', state: 'running', createdAt: at, idleAt: at, report: { state: 'ready', summary: 'Ready', at } }] }
  const item = ticketDecisions([ticket])[0]!
  const pins = { repository: 'org/repo', prNumber: 12, headSha: 'a'.repeat(40), patchSha256: 'd'.repeat(64) }
  const snapshot = { ...pins, id: 'manifest-id', ticketId: ticket.id, conversationId: publicationConversation(item), status: 'prepared' as const, createdAt: at, updatedAt: at, outcomes: [], audit: [], requests: {} }
  const enqueue = vi.fn(async () => ({ ...snapshot, status: 'published' as const }))
  const scope = { environment: 'isolated-test', refs: [{ repository: pins.repository, pr: 12, headSha: pins.headSha }], components: ['Example component'], effects: ['apply', 'build', 'restart', 'verify'], manifestSha256: 'e'.repeat(64) }
  const publication = { service: { snapshot: vi.fn(async () => snapshot) }, pinsFor: () => pins, scopeFor: () => scope, enqueue } as unknown as LifecyclePublication
  let d = store.create({ id: 'feature', title: 'Feature', owner: 'reviewer', workers: [ticket.id], requirements: ['native-click'], authorities: ['operator'],
    bindings: { repository: pins.repository, sourceIssue: 159, baseSha: 'b'.repeat(40), headSha: pins.headSha, environment: 'isolated-test', refs: [{ repository: pins.repository, pr: 12, headSha: pins.headSha }] } })
  d = store.compareAndSwap(d.id, d.revision, value => { value.stage = 'ready_to_publish'; value.preparedPublication = { id: snapshot.id, ticketId: ticket.id, decisionId: item.id, repository: pins.repository, pr: 12, headSha: pins.headSha, patchSha256: pins.patchSha256, environment: 'isolated-test', preparedAt: at, scopeSha256: scope.manifestSha256 } as never })
  return { store, ticket, publication, enqueue, d, scope }
}
it('passes actual durable confirm provenance through the existing protected publication route once', async () => {
  const { store, ticket, publication, enqueue, d } = fixture()
  const request = { revision: d.revision, actionId: d.nextAction!.id }
  store.confirm(d.id, request, { actor: 'operator', source: 'local_operator', reference: 'actual-http-confirmation', scope: d.nextAction!.fingerprint })
  const lease = store.claim('coordinator')!
  expect(lease.authorization).toMatchObject({ source: 'local_operator', reference: 'actual-http-confirmation' })
  await deliveryPublicationCapabilities(store, { get: () => ticket } as never, publication).publish!.execute(lease)
  expect(enqueue).toHaveBeenCalledTimes(1)
  expect(enqueue.mock.calls[0]).toMatchObject([{ requestId: lease.id, publicationId: 'manifest-id' }, { actorId: 'operator', kind: 'human_click', authorized: true }])
  expect(() => store.confirm(d.id, request, 'operator')).toThrow()
})
it('never upgrades a recorded intake authority string into a human publication click', async () => {
  const { store, ticket, publication, enqueue, d } = fixture()
  store.confirm(d.id, { revision: d.revision, actionId: d.nextAction!.id }, 'operator')
  const result = await deliveryPublicationCapabilities(store, { get: () => ticket } as never, publication).publish!.execute(store.claim('coordinator')!)
  expect(result.blocker).toContain('trusted local confirmation'); expect(enqueue).not.toHaveBeenCalled()
})
it('fails closed when the trusted scope does not cover every repository or the deployment target', async () => {
  const { store, ticket, publication, enqueue, d, scope } = fixture()
  scope.environment = 'different-target'
  store.confirm(d.id, { revision: d.revision, actionId: d.nextAction!.id }, { actor: 'operator', source: 'local_operator', reference: 'confirmation', scope: d.nextAction!.fingerprint })
  const result = await deliveryPublicationCapabilities(store, { get: () => ticket } as never, publication).publish!.execute(store.claim('coordinator')!)
  expect(result.outcome).toBe('failed'); expect(enqueue).not.toHaveBeenCalled()
})
it('does not widen a primary published snapshot to an uncovered secondary repository', async () => {
  const { store, ticket, publication, d } = fixture()
  const multi = store.compareAndSwap(d.id, d.revision, value => { value.bindings.refs!.push({ repository: 'org/plugin', pr: 8, headSha: 'f'.repeat(40) }) })
  store.confirm(multi.id, { revision: multi.revision, actionId: multi.nextAction!.id }, { actor: 'operator', source: 'local_operator', reference: 'confirmation', scope: multi.nextAction!.fingerprint })
  const lease = store.claim('coordinator')!
  vi.mocked(publication.service.snapshot).mockResolvedValue({ ...(await publication.service.snapshot(ticket.id))!, status: 'published' })
  const result = await deliveryPublicationCapabilities(store, { get: () => ticket } as never, publication).publish!.reconcile!(lease)
  expect(result.outcome).toBe('uncertain'); expect(result.evidence).toBeUndefined()
})
it('keeps rolled-back publication unresolved instead of accepting HTTP or restoration evidence', async () => {
  const { store, ticket, publication, d } = fixture()
  store.confirm(d.id, { revision: d.revision, actionId: d.nextAction!.id }, { actor: 'operator', source: 'local_operator', reference: 'confirmation', scope: d.nextAction!.fingerprint })
  const lease = store.claim('coordinator')!
  vi.mocked(publication.service.snapshot).mockResolvedValue({ ...(await publication.service.snapshot(ticket.id))!, status: 'rolled_back' })
  const result = await deliveryPublicationCapabilities(store, { get: () => ticket } as never, publication).publish!.reconcile!(lease)
  expect(result).toMatchObject({ outcome: 'failed', blocker: expect.stringContaining('acceptance remains unresolved'), evidence: [{ kind: 'rollback' }] })
  store.complete(lease, result)
  expect(store.get(d.id)?.state).toBe('blocked'); expect(store.get(d.id)?.acceptance).toBeUndefined()
})
