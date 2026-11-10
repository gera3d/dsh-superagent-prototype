import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { DeliveryStore, deliveryFingerprint } from '../src/app/feature-delivery.ts'
import { recordOperatorEvidence } from '../src/app/delivery-evidence.ts'
import { deliveryPublicationCapabilities } from '../src/app/delivery-publication.ts'
import { ticketDecisions } from '../src/app/decision-inbox.ts'
import { publicationConversation, type LifecyclePublication } from '../src/app/lifecycle-publication.ts'
import type { Ticket } from '../src/core/model.ts'

const handles: DatabaseSync[] = []
afterEach(() => handles.splice(0).forEach(db => db.close()))
function fixture(requirements = ['native-click']) {
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
  let d = store.create({ id: 'feature', title: 'Feature', owner: 'reviewer', workers: [ticket.id], requirements, authorities: ['operator'],
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
it('observes healthy publication at sixty-second intervals instead of exhausting the finite budget in two minutes', async () => {
  const { store, ticket, publication, d } = fixture()
  store.confirm(d.id, { revision: d.revision, actionId: d.nextAction!.id }, { actor: 'operator', source: 'local_operator', reference: 'confirmation', scope: d.nextAction!.fingerprint })
  const lease = store.claim('coordinator')!
  const snapshot = (await publication.service.snapshot(ticket.id))!
  vi.mocked(publication.service.snapshot).mockResolvedValue({ ...snapshot, coordination: { grantId: 'existing-grant', status: 'running', createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt } })
  const started = Date.now()
  const result = await deliveryPublicationCapabilities(store, { get: () => ticket } as never, publication).publish!.reconcile!(lease)
  expect(result).toMatchObject({ outcome: 'pending' })
  expect(result.nextRetryAt).toBeGreaterThanOrEqual(started + 60_000)
  expect(result.nextRetryAt).toBeLessThanOrEqual(Date.now() + 60_000)
  store.complete(lease, result)
  expect(store.get(d.id)?.state).toBe('running')
  expect(store.claim('too-early', started + 59_000)).toBeUndefined()
  expect(store.claim('bounded-observer', started + 61_000)).toMatchObject({ id: lease.id, reconcile: true })
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
it('records verification evidence from published verify outcome and advances to operator acceptance', async () => {
  const { store, ticket, publication, d } = fixture(['service-health'])
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
  expect(verifyResult.outcome).toBe('passed')
  expect(verifyResult.evidence).toHaveLength(1)
  expect(verifyResult.evidence![0]!).toMatchObject({
    kind: 'verification',
    outcome: 'passed',
    reference: `publication:${publishedSnapshot.id}#verify:http 200 ok`,
  })
  expect(verifyResult.evidence![0]!.requirements ?? []).toEqual([])

  // Idempotent reconcile returns identical verification evidence
  const verifyReconciled = await capabilities.verify!.reconcile!(verifyLease)
  expect(verifyReconciled).toEqual(verifyResult)

  // Completing verify with passed verification evidence makes acceptance ready
  const afterVerify0 = store.complete(verifyLease, verifyResult)
  expect(afterVerify0.nextAction).toBeUndefined()
  expect(afterVerify0.awaitingOperatorEvidence).toEqual(['service-health'])
  const operatorRequest = { deliveryId: afterVerify0.id, revision: afterVerify0.revision, evidence: [{ id: 'operator:service-health', kind: 'verification' as const, bindings: afterVerify0.bindings, recordedAt: new Date().toISOString(), reference: 'https://example.test/live-check', outcome: 'passed' as const, requirements: ['service-health'] }] }
  const hash = deliveryFingerprint(operatorRequest)
  const afterVerify = recordOperatorEvidence(store, operatorRequest, hash, { source: 'local_operator', actor: 'operator', reference: 'live-check', scope: hash })
  expect(afterVerify.stage).toBe('verifying')
  expect(afterVerify.nextAction?.kind).toBe('accept')

  // 3. Genuine exact operator confirmation accepts delivery
  const accepted = store.confirm(afterVerify.id, { revision: afterVerify.revision, actionId: afterVerify.nextAction!.id }, { actor: 'operator', source: 'local_operator', reference: 'final-acceptance', scope: afterVerify.nextAction!.fingerprint })
  expect(accepted.state).toBe('accepted')
  expect(accepted.stage).toBe('accepted')
  expect(accepted.acceptance).toBeDefined()
  expect(accepted.acceptance?.actor).toBe('operator')
  expect(accepted.acceptance?.evidenceIds).toContain(verifyResult.evidence![0]!.id)
})
it('fails verify closed when publication verification failed in runner', async () => {
  const { store, ticket, publication, d } = fixture()
  store.confirm(d.id, { revision: d.revision, actionId: d.nextAction!.id }, { actor: 'operator', source: 'local_operator', reference: 'confirmation', scope: d.nextAction!.fingerprint })
  const publishLease = store.claim('coordinator')!
  const snapshot = (await publication.service.snapshot(ticket.id))!
  vi.mocked(publication.service.snapshot).mockResolvedValue({
    ...snapshot,
    status: 'published' as const,
    requests: { [publishLease.id]: { action: 'publish' as const, actorId: 'operator' } },
  })
  const capabilities = deliveryPublicationCapabilities(store, { get: () => ticket } as never, publication)
  const publishResult = await capabilities.publish!.reconcile!(publishLease)
  const afterPublish = store.complete(publishLease, publishResult)

  store.confirm(afterPublish.id, { revision: afterPublish.revision, actionId: afterPublish.nextAction!.id }, { actor: 'operator', source: 'local_operator', reference: 'verify-ref', scope: afterPublish.nextAction!.fingerprint })
  const verifyLease = store.claim('coordinator')!
  const failedResult = await capabilities.verify!.execute(verifyLease)
  expect(failedResult).toMatchObject({ outcome: 'failed', blocker: expect.stringContaining('verification') })
})
