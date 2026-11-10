import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { Engine } from '../src/core/engine.ts'
import { DshExecutor } from '../src/executor/dsh.ts'
import { DeliveryConflict, DeliveryStore, type Delivery, type DeliveryEvidence } from '../src/app/feature-delivery.ts'
import { deliveryPublicationCapabilities } from '../src/app/delivery-publication.ts'
import { FeatureDeliveryRuntime, projectDeliveries } from '../src/app/delivery-runtime.ts'
import { publicationConversation, type LifecyclePublication } from '../src/app/lifecycle-publication.ts'
import { activeDeliveryForSession, deliveryMatchesSession } from '../src/client/finding-association.ts'
import { recordOperatorEvidence } from '../src/app/delivery-evidence.ts'
import type { Ticket } from '../src/core/model.ts'

describe('Thread-native review, test, and release handoff lifecycle', () => {
  let dir: string, work: string, store: Store, engine: Engine, executor: DshExecutor
  let deliveryStore: DeliveryStore, ticketId: string, coordinatorTriggerId: string

  const agent = {
    id: 'worker',
    status: 'idle',
    whenIdle: async () => {},
    session: {
      snapshotEvents: () => [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'turn/end', data: { turn: 1 } },
      ],
      requestHeader: () => ({ config: { provider: 'antigravity', model: 'gemini-3.8-flash' } }),
    },
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'handoff-lifecycle-'))
    work = join(dir, 'work')
    mkdirSync(work)
    store = new Store(join(dir, 'state.sqlite'))
    store.saveSettings({ executor: { model: { provider: 'antigravity', model: 'gemini-3.8-flash' }, maxWorkers: 1 } } as never)
    engine = new Engine({
      repo: store,
      policy: () => ({ version: 'p1', paused: false }),
      executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    } as never)

    deliveryStore = new DeliveryStore(store.db)

    let ticket = engine.dispatchFinding({
      jobId: 'finding:lifecycle-test:r1',
      findingId: 'lifecycle-finding',
      title: 'Lifecycle feature handoff',
      scope: 'Bounded lifecycle repair',
      repository: 'org/repo',
      actorId: 'codex-coordinator',
      actorSource: 'coordinator',
      human: false,
      text: 'Lifecycle finding dispatch',
    })
    coordinatorTriggerId = ticket.origin.triggerId

    if (!ticket.execution?.directory) {
      ticket = { ...ticket, execution: { name: 'lifecycle-work', directory: work, text: 'Test' }, follows: [{ thread: 'github:42', own: true }] } as never
      store.tickets.save(ticket)
    }
    if (ticket.assignments.at(-1)?.state !== 'running') {
      engine.assignmentStarted(ticket.id, ticket.assignments.at(-1)!.id)
    }
    ticketId = ticket.id

    executor = new DshExecutor({
      store: {
        tickets: store.tickets,
        triggers: store.triggers,
        settings: () => store.settings(),
        set: store.set.bind(store),
        afterCommit: store.afterCommit.bind(store),
        atomic: store.atomic.bind(store),
      },
      engine,
      context: { get: () => undefined, agents: new Map() },
      effects: { handle: () => {}, enqueue: () => {} },
      sessions: { relay: () => {}, selectModel: async () => {}, prompt: async () => {} },
      health: { get: () => undefined, set: () => {} },
      machine: { stateDir: dir },
      lifetime: new AbortController().signal,
      closing: () => false,
      paused: () => false,
      environment: () => [],
    } as never)
  })

  afterEach(() => {
    executor.dispose()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs the full lifecycle from ready report to independent review, tests, publish, live acceptance, and history retirement', async () => {
    const at = '2026-11-09T17:00:00.000Z'
    const t = store.tickets.get(ticketId)!
    const assignment = t.assignments.at(-1)!

    // 1. Ready report stage: worker reports ready in workspace file
    const reportPath = join(work, '.dsh-report.json')
    writeFileSync(reportPath, JSON.stringify({
      state: 'ready',
      summary: 'Repaired and qualified offline',
      pr_number: 42,
      ticket_id: t.id,
      assignment_id: assignment.id,
      turn_id: 1,
      reply_to_trigger_id: coordinatorTriggerId,
      at: new Date().toISOString(),
    }))

    // Ingest report via executor.workerIdle
    await (executor as any).workerIdle(t, assignment, agent)

    store.atomic(() => {
      const curr = store.tickets.get(ticketId)!
      curr.assignments.at(-1)!.idleAt = new Date().toISOString()
      store.tickets.save(curr)
    })

    // Verify ready report committed and claim consumed
    const updatedTicket = store.tickets.get(ticketId)!
    expect(updatedTicket.assignments.at(-1)!.report?.state).toBe('ready')
    expect(readdirSync(work).filter(f => f.startsWith('.dsh-report.consumed.'))).toHaveLength(1)

    // 2. Feature delivery intake
    const pins = { repository: 'org/repo', prNumber: 42, headSha: 'a'.repeat(40), patchSha256: 'd'.repeat(64) }
    const bindings = {
      repository: pins.repository,
      sourceIssue: 101,
      baseSha: 'b'.repeat(40),
      headSha: pins.headSha,
      environment: 'isolated-target',
      refs: [{ repository: pins.repository, pr: 42, headSha: pins.headSha, baseSha: 'b'.repeat(40) }],
    }

    let delivery = deliveryStore.create({
      id: 'lifecycle-delivery',
      title: 'Lifecycle delivery',
      owner: 'reviewer',
      workers: [ticketId],
      requirements: ['automated-health', 'native-click'],
      authorities: ['operator'],
      bindings,
    })

    expect(delivery.stage).toBe('implementation')
    expect(deliveryMatchesSession({ delivery, sessionId: `worker-${ticketId}` } as any, `worker-${ticketId}`)).toBe(true)

    // Transition implementation -> review using the committed ready report
    const implementationEvidence: DeliveryEvidence = {
      id: `implementation:${pins.headSha}`,
      kind: 'implementation',
      bindings,
      recordedAt: at,
      reference: `ticket/${ticketId}/report/${assignment.id}`,
      outcome: 'passed',
    }
    delivery = deliveryStore.recordImplementation(delivery.id, delivery.revision, implementationEvidence)
    expect(delivery.stage).toBe('review')
    expect(delivery.state).toBe('awaiting_decision')
    expect(delivery.nextAction?.kind).toBe('review')

    // Negative case: stale revision rejection on review confirmation
    expect(() => deliveryStore.confirm(delivery.id, { revision: 999, actionId: delivery.nextAction!.id }, {
      actor: 'operator', source: 'local_operator', reference: 'ref', scope: delivery.nextAction!.fingerprint,
    })).toThrow(DeliveryConflict)

    // Confirm review
    delivery = deliveryStore.confirm(delivery.id, { revision: delivery.revision, actionId: delivery.nextAction!.id }, {
      actor: 'operator', source: 'local_operator', reference: 'confirm-review', scope: delivery.nextAction!.fingerprint,
    })
    expect(delivery.state).toBe('running')

    // Simulate review coordinator lease execution
    const reviewLease = deliveryStore.claim('coordinator')!
    expect(reviewLease.action.kind).toBe('review')

    const reviewResult = {
      outcome: 'passed' as const,
      evidence: [{
        id: `review:${pins.headSha}`,
        kind: 'review' as const,
        bindings,
        recordedAt: at,
        reference: 'review:passed',
        outcome: 'passed' as const,
      }],
    }
    delivery = deliveryStore.complete(reviewLease, reviewResult)
    expect(delivery.stage).toBe('ready_to_publish')
    expect(delivery.state).toBe('awaiting_decision')

    // 3. Exact release preparation
    const snapshot = {
      ...pins,
      id: 'manifest-lifecycle',
      ticketId,
      conversationId: `worker-${ticketId}:decision:d1`,
      status: 'prepared' as const,
      createdAt: at,
      updatedAt: at,
      outcomes: [],
      audit: [],
      requests: {},
    }
    const scope = {
      environment: 'isolated-target',
      refs: bindings.refs,
      components: ['Harness UI'],
      effects: ['apply', 'build', 'restart', 'verify'],
      manifestSha256: 'e'.repeat(64),
    }

    // Negative case: preparation fails if environment mismatch
    const badPublication = {
      pinsFor: () => pins,
      scopeFor: () => ({ ...scope, environment: 'mismatched-target' }),
      service: { prepare: vi.fn() },
    } as unknown as LifecyclePublication

    const runtime = new FeatureDeliveryRuntime(store, {}, { publication: badPublication })
    await expect((runtime as any).prepareQualified(delivery)).rejects.toThrow('does not prove the deployment target')

    // Successful preparation
    const goodPublication = {
      pinsFor: () => pins,
      scopeFor: () => scope,
      service: {
        prepare: vi.fn(async () => snapshot),
        snapshot: vi.fn(async () => snapshot),
      },
      enqueue: vi.fn(async () => ({ ...snapshot, status: 'published' as const })),
    } as unknown as LifecyclePublication

    const goodRuntime = new FeatureDeliveryRuntime(store, {}, { publication: goodPublication })
    await (goodRuntime as any).prepareQualified(delivery)

    delivery = deliveryStore.get(delivery.id)!
    expect(delivery.preparedPublication).toBeDefined()
    expect(delivery.nextAction?.kind).toBe('publish')

    // 4. Native publish confirmation
    // Negative case: unauthorized confirmation rejected
    expect(() => deliveryStore.confirm(delivery.id, { revision: delivery.revision, actionId: delivery.nextAction!.id }, {
      actor: 'unauthorized-user', source: 'local_operator', reference: 'ref', scope: delivery.nextAction!.fingerprint,
    })).toThrow(DeliveryConflict)

    // Operator confirms publish
    delivery = deliveryStore.confirm(delivery.id, { revision: delivery.revision, actionId: delivery.nextAction!.id }, {
      actor: 'operator', source: 'local_operator', reference: 'confirm-publish', scope: delivery.nextAction!.fingerprint,
    })
    expect(delivery.stage).toBe('publishing')
    expect(delivery.state).toBe('running')

    // Publication execution
    const publishLease = deliveryStore.claim('coordinator')!
    const capabilities = deliveryPublicationCapabilities(deliveryStore, store.tickets, goodPublication)

    const publishedSnapshot = {
      ...snapshot,
      status: 'published' as const,
      requests: { [publishLease.id]: { action: 'publish' as const, actorId: 'operator' } },
      outcomes: [
        { stage: 'apply' as const, operationId: 'op-apply', status: 'succeeded' as const, startedAt: at, finishedAt: at },
        { stage: 'build' as const, operationId: 'op-build', status: 'succeeded' as const, startedAt: at, finishedAt: at },
        { stage: 'restart' as const, operationId: 'op-restart', status: 'succeeded' as const, startedAt: at, finishedAt: at },
        { stage: 'verify' as const, operationId: 'op-verify', status: 'succeeded' as const, startedAt: at, finishedAt: at, detail: 'http 200 ok' },
      ],
    }
    vi.mocked(goodPublication.service.snapshot).mockResolvedValue(publishedSnapshot)

    const publishResult = await capabilities.publish!.reconcile!(publishLease)
    expect(publishResult.outcome).toBe('passed')
    delivery = deliveryStore.complete(publishLease, publishResult)
    expect(delivery.stage).toBe('verifying')
    expect(delivery.nextAction?.kind).toBe('verify')

    // 5. Automated verification vs Native operator attestation
    delivery = deliveryStore.confirm(delivery.id, { revision: delivery.revision, actionId: delivery.nextAction!.id }, {
      actor: 'operator', source: 'local_operator', reference: 'confirm-verify', scope: delivery.nextAction!.fingerprint,
    })
    const verifyLease = deliveryStore.claim('coordinator')!
    const verifyResult = await capabilities.verify!.execute(verifyLease)
    expect(verifyResult.outcome).toBe('passed')

    // Runner verification is its own automated fact: it asserts NO intake requirement, however the ID is worded.
    expect(verifyResult.evidence![0]!.requirements ?? []).toEqual([])

    delivery = deliveryStore.complete(verifyLease, verifyResult)
    // Every requirement still needs explicit operator evidence
    expect(delivery.stage).toBe('verifying')
    expect(delivery.state).toBe('blocked')
    expect(delivery.blocker).toContain('explicit operator live evidence')
    expect(delivery.awaitingOperatorEvidence).toEqual(['automated-health', 'native-click'])

    // 6. Explicit native operator evidence attestation through thread UI
    const nativeEvidence: DeliveryEvidence = {
      id: `native:click:${pins.headSha}`,
      kind: 'verification',
      bindings,
      recordedAt: at,
      reference: 'https://github.com/org/repo/pull/42#native-attestation',
      outcome: 'passed',
      requirements: ['automated-health', 'native-click'],
    }
    const evidenceRequest = {
      deliveryId: delivery.id,
      revision: delivery.revision,
      evidence: [nativeEvidence],
    }
    const { deliveryFingerprint } = await import('../src/app/feature-delivery.ts')
    const hash = deliveryFingerprint(evidenceRequest)

    delivery = recordOperatorEvidence(deliveryStore, evidenceRequest, hash, {
      source: 'local_operator', actor: 'operator', reference: 'thread-click-check', scope: hash,
    })
    // Now all requirements are satisfied! Acceptance becomes ready
    expect(delivery.state).toBe('awaiting_decision')
    expect(delivery.nextAction?.kind).toBe('accept')

    // 7. Explicit operator acceptance confirmation
    delivery = deliveryStore.confirm(delivery.id, { revision: delivery.revision, actionId: delivery.nextAction!.id }, {
      actor: 'operator', source: 'local_operator', reference: 'final-operator-accept', scope: delivery.nextAction!.fingerprint,
    })
    expect(delivery.stage).toBe('accepted')
    expect(delivery.state).toBe('accepted')
    expect(delivery.acceptance?.actor).toBe('operator')
    expect(delivery.nextAction).toBeUndefined()

    // 8. History & retirement of obsolete next steps
    const decisionItem = { id: `delivery-${delivery.id}`, delivery, status: 'resolved' as const }
    expect(activeDeliveryForSession(decisionItem as any, `worker-${ticketId}`)).toBe(false)
  })
})
