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
it('HTTP verification cannot fulfill required native-click evidence', async () => {
  const { store, ticket, publication, d } = fixture()
  // 1. Operator confirms publish
  store.confirm(d.id, { revision: d.revision, actionId: d.nextAction!.id }, { actor: 'operator', source: 'local_operator', reference: 'confirmation', scope: d.nextAction!.fingerprint })
  const publishLease = store.claim('coordinator')!
  const snapshot = (await publication.service.snapshot(ticket.id))!
  const publishedSnapshot = {
    ...snapshot,
    status: 'published' as const,
    requests: { [publishLease.id]: { action: 'publish' as const, actorId: 'operator' } },
    outcomes: [
      { stage: 'apply' as const, operationId: 'op-apply', status: 'succeeded' as const, startedAt: snapshot.updatedAt, finishedAt: snapshot.updatedAt },
      { stage: 'build' as const, operationId: 'op-build', status: 'succeeded' as const, startedAt: snapshot.updatedAt, finishedAt: snapshot.updatedAt },
      { stage: 'restart' as const, operationId: 'op-restart', status: 'succeeded' as const, startedAt: snapshot.updatedAt, finishedAt: snapshot.updatedAt },
      { stage: 'verify' as const, operationId: 'op-verify', status: 'succeeded' as const, startedAt: snapshot.updatedAt, finishedAt: snapshot.updatedAt, detail: 'http 200 ok' },
    ],
  }
  vi.mocked(publication.service.snapshot).mockResolvedValue(publishedSnapshot)

  const capabilities = deliveryPublicationCapabilities(store, { get: () => ticket } as never, publication)
  const publishResult = await capabilities.publish!.reconcile!(publishLease)
  expect(publishResult.outcome).toBe('passed')
  expect(publishResult.evidence).toHaveLength(1)
  expect(publishResult.evidence![0]!.kind).toBe('publication')

  // Completing publish transitions delivery to stage 'verifying', next action 'verify'
  const afterPublish = store.complete(publishLease, publishResult)
  expect(afterPublish.stage).toBe('verifying')
  expect(afterPublish.nextAction?.kind).toBe('verify')

  // 2. Execute verify action under routine qualification
  store.confirm(afterPublish.id, { revision: afterPublish.revision, actionId: afterPublish.nextAction!.id }, { actor: 'operator', source: 'local_operator', reference: 'verify-ref', scope: afterPublish.nextAction!.fingerprint })
  const verifyLease = store.claim('coordinator')!
  const verifyResult = await capabilities.verify!.execute(verifyLease)
  expect(verifyResult.evidence?.some(e => e.kind === 'verification' && e.outcome === 'passed' && e.requirements?.includes('native-click'))).not.toBe(true)
})
