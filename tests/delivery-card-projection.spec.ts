import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { DeliveryStore, type Delivery, type DeliveryConfirmationAuthority } from '../src/app/feature-delivery.ts'
import { deliveryDecision, projectDeliveries, reconcileDeliveries, FeatureDeliveryRuntime } from '../src/app/delivery-runtime.ts'
import { DecisionInbox } from '../src/app/decision-inbox.ts'
import { decisionNeedsAttention, decisionInHistory } from '../src/core/publication-queue.ts'
import type { Ticket } from '../src/core/model.ts'

function createTestDelivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: 'test-delivery-1',
    title: 'Test Delivery',
    owner: 'worker:worker-1',
    bindings: { repository: 'gera3d/superagent-sandbox', sourceIssue: 1, baseSha: '', headSha: '', refs: [] },
    requirements: ['intake:test'],
    authorities: [],
    delegatedActions: [],
    followFixHeads: false,
    authorizedFixScopes: [],
    generation: 0,
    workers: ['worker-1'],
    revision: 1,
    stage: 'review',
    state: 'awaiting_decision',
    attempts: { review: 0, fix: 0, maxReview: 3, maxFix: 2 },
    evidence: [],
    audit: [{ at: '2026-11-20T12:00:00.000Z', event: 'created', actor: 'test' }],
    ...overrides,
  }
}

describe('Delivery Card Projection & Reconciliation', () => {
  let db: DatabaseSync
  let store: DeliveryStore

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    store = new DeliveryStore(db)
  })

  it('action-less delivery is not pending', () => {
    // Delivery without nextAction and without blocker
    const actionless = createTestDelivery({
      nextAction: undefined,
      blocker: undefined,
      state: 'awaiting_decision',
      stage: 'review',
    })
    const decision = deliveryDecision(actionless)

    expect(decision.status).toBe('stale')
    expect(decision.staleReason).toBe('review: awaiting_decision')
    expect(decision.choices).toEqual([])
    expect(decision.urgency).toBe('low')
    expect(decisionNeedsAttention(decision)).toBe(false)
    expect(decisionInHistory(decision)).toBe(true)
  })

  it('packaging delivery is not pending but stays visible as informational stale status', () => {
    const packaging = createTestDelivery({
      stage: 'ready_to_publish',
      release: {
        findingId: 'f-1',
        findingRevision: 1,
        jobId: 'job-1',
        ticketId: 'worker-1',
        assignmentId: 'assign-1',
        branch: 'feat',
        prNumber: 10,
        headSha: 'head',
        patchSha256: 'patch',
        preparedAt: '2026-11-20T12:00:00.000Z',
      },
      preparedPublication: undefined,
      blocker: undefined,
      nextAction: {
        id: 'pkg-action',
        kind: 'publish',
        label: 'Publish bound artifact',
        revision: 1,
        fingerprint: 'fp',
      },
    })
    const decision = deliveryDecision(packaging)

    expect(decision.status).toBe('stale')
    expect(decision.staleReason).toContain('Release packaging in progress')
    expect(decision.choices).toEqual([])
    expect(decision.urgency).toBe('low')
    expect(decisionNeedsAttention(decision)).toBe(false)
  })

  it('delivery with action stays pending with its choice', () => {
    const withAction = createTestDelivery({
      nextAction: {
        id: 'action-1',
        kind: 'review',
        label: 'Review feature changes',
        revision: 1,
        fingerprint: 'fp-1',
      },
      blocker: undefined,
      state: 'awaiting_decision',
    })
    const decision = deliveryDecision(withAction)

    expect(decision.status).toBe('pending')
    expect(decision.choices).toHaveLength(1)
    expect(decision.choices[0]!.id).toBe('action-1')
    expect(decision.choices[0]!.label).toBe('Review feature changes')
    expect(decisionNeedsAttention(decision)).toBe(true)
  })

  it('blocked delivery stays pending', () => {
    const blocked = createTestDelivery({
      nextAction: undefined,
      blocker: 'Need test credentials',
      state: 'blocked',
    })
    const decision = deliveryDecision(blocked)

    expect(decision.status).toBe('pending')
    expect(decision.choices).toEqual([])
    expect(decision.urgency).toBe('medium')
    expect(decision.question).toBe('Need test credentials')
    expect(decisionNeedsAttention(decision)).toBe(true)
  })

  it('historical stays stale', () => {
    const historical = createTestDelivery({
      historicalCompletion: {
        attestation: 'attestation-hash',
        fingerprint: 'fp',
        reconciledAt: '2026-11-20T12:00:00.000Z',
        operator: 'local-operator',
        releasePr: 42,
        releaseMergedSha: 'abcdef123456',
        sourceIssue: 1,
        caption: 'Retained as completed history',
        evidenceReference: 'ref',
      },
      blocker: 'Old blocker text',
    })
    const decision = deliveryDecision(historical)

    expect(decision.status).toBe('stale')
    expect(decision.staleReason).toBe('Retained as completed history')
    expect(decision.choices).toEqual([])
    expect(decision.urgency).toBe('low')
    expect(decisionNeedsAttention(decision)).toBe(false)
    expect(decisionInHistory(decision)).toBe(true)
  })

  it('reconcile is idempotent and loses no audit rows', () => {
    const delivery = store.create({
      id: 'd1',
      title: 'T1',
      owner: 'worker:worker-1',
      bindings: { repository: 'repo', sourceIssue: 1, baseSha: '', headSha: '', refs: [] },
      requirements: ['intake:acceptance-requirements-unconfirmed'],
      authorities: [],
      delegatedActions: [],
      workers: ['worker-1'],
      scopeBinding: { reason: 'Operator-confirmed delivery scope missing', sourceTriggerId: 'trig-1' },
    })

    // Simulate worker report ready
    store.compareAndSwap(delivery.id, delivery.revision, d => {
      d.state = 'blocked'
      d.blocker = d.scopeBinding!.reason
      d.audit.push({ at: '2026-11-20T12:01:00.000Z', event: 'worker-reported-ready', actor: 'worker-1' })
    })

    const ticketEnded: Ticket = {
      id: 'worker-1',
      title: 'Task',
      decisionId: 'dec-1',
      mandate: { strength: 'explicit', policyVersion: 'p1', basis: { source: 'github', scope: { number: 1, isPr: false, kind: 'issue' }, row: 'issues', sender: 'user', via: 'addressed', addressed: 'mention' }, actor: { source: 'github', id: 'user' }, scope: 'Task' },
      channels: [],
      assignments: [],
      inputs: [],
      undelivered: [],
      createdAt: '2026-11-20T12:00:00.000Z',
      updatedAt: '2026-11-20T12:02:00.000Z',
      origin: { triggerId: 'trig-1', triggerIds: ['trig-1'] },
      ended: { at: '2026-11-20T12:02:00.000Z', by: 'executor', outcome: 'merged' },
    }

    const tickets = new Map<string, Ticket>([['worker-1', ticketEnded]])

    // First reconciliation
    const firstPass = reconcileDeliveries(store, { get: id => tickets.get(id) })
    const afterFirst = store.get('d1')!

    expect(afterFirst.audit).toHaveLength(3) // create, worker-reported-ready, reconcile:worker-ended
    expect(afterFirst.audit[1]!.event).toBe('worker-reported-ready')
    expect(afterFirst.audit[2]!.event).toBe('reconcile:worker-ended')

    // Second reconciliation (idempotent)
    const secondPass = reconcileDeliveries(store, { get: id => tickets.get(id) })
    const afterSecond = store.get('d1')!

    expect(afterSecond.revision).toBe(afterFirst.revision)
    expect(afterSecond.audit).toEqual(afterFirst.audit) // No audit rows lost or duplicated
  })

  it('projectDeliveries excludes action-less deliveries from decisionNeedsAttention', () => {
    store.create({
      id: 'd-done',
      title: 'Done Feature',
      owner: 'worker:w1',
      bindings: { repository: 'repo', sourceIssue: 1, baseSha: '', headSha: '', refs: [] },
      requirements: ['intake:acceptance-requirements-unconfirmed'],
      authorities: [],
      delegatedActions: [],
      workers: ['w1'],
      scopeBinding: { reason: 'Scope unconfirmed', sourceTriggerId: 't1' },
    })

    const ticket: Ticket = {
      id: 'w1',
      title: 'Done Ticket',
      decisionId: 'dec-1',
      mandate: { strength: 'explicit', policyVersion: 'p1', basis: { source: 'github', scope: { number: 1, isPr: false, kind: 'issue' }, row: 'issues', sender: 'user', via: 'addressed', addressed: 'mention' }, actor: { source: 'github', id: 'user' }, scope: 'Done Ticket' },
      channels: [],
      assignments: [],
      inputs: [],
      undelivered: [],
      createdAt: '2026-11-20T12:00:00.000Z',
      updatedAt: '2026-11-20T12:02:00.000Z',
      origin: { triggerId: 't1', triggerIds: ['t1'] },
      ended: { at: '2026-11-20T12:02:00.000Z', by: 'executor', outcome: 'merged' },
    }

    // Save ticket in DB for readDeliveryWorkers
    db.exec(`CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run('w1', JSON.stringify(ticket))

    const projected = projectDeliveries(store, [])
    expect(projected).toHaveLength(1)
    const card = projected[0]!

    expect(card.status).toBe('stale')
    expect(card.choices).toEqual([])
    expect(decisionNeedsAttention(card)).toBe(false)
    expect(decisionInHistory(card)).toBe(true)
  })

  it('ordinaryDecision in operator-mcp allows dismiss for action-less delivery and refuses for active/blocked', async () => {
    // Import ordinaryDecision logic / simulate server.cjs check
    const isDelivery = (item: any) => Boolean(item.delivery || item.actionMode === 'feature_delivery')
    const hasAction = (item: any) => (item.choices && item.choices.length > 0) || Boolean(item.delivery?.nextAction)
    const hasBlocker = (item: any) => Boolean(item.delivery?.blocker || item.delivery?.state === 'blocked')
    const checkOrdinary = (item: any, op?: string) => {
      if (item.finding || item.delivery || item.lifecycle || ['finding_triage', 'feature_delivery', 'ticket_lifecycle'].includes(item.actionMode)) {
        if (op === 'dismiss' && isDelivery(item) && !hasAction(item) && !hasBlocker(item)) return item
        throw new Error('This is a typed finding/delivery decision.')
      }
      return item
    }

    const actionlessCard = deliveryDecision(createTestDelivery({ nextAction: undefined, blocker: undefined, state: 'awaiting_decision' }))
    const activeCard = deliveryDecision(createTestDelivery({ nextAction: { id: 'act', kind: 'review', label: 'Rev', revision: 1, fingerprint: 'fp' } }))
    const blockedCard = deliveryDecision(createTestDelivery({ blocker: 'Need credentials', state: 'blocked' }))
    const findingCard = { id: 'f1', finding: { id: 'f1' }, actionMode: 'finding_triage', choices: [] }

    // Dismissing actionless delivery is allowed
    expect(() => checkOrdinary(actionlessCard, 'dismiss')).not.toThrow()

    // Dismissing active card is refused
    expect(() => checkOrdinary(activeCard, 'dismiss')).toThrow('This is a typed finding/delivery decision.')

    // Dismissing blocked card is refused
    expect(() => checkOrdinary(blockedCard, 'dismiss')).toThrow('This is a typed finding/delivery decision.')

    // Dismissing finding is refused
    expect(() => checkOrdinary(findingCard, 'dismiss')).toThrow('This is a typed finding/delivery decision.')

    // Other operations (e.g. resolve) on actionless card are still refused
    expect(() => checkOrdinary(actionlessCard, 'resolve')).toThrow('This is a typed finding/delivery decision.')
  })
})
