import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adviceContext } from '../src/app/advice-context.ts'
import { DeliveryStore, deliveryFingerprint } from '../src/app/feature-delivery.ts'
import { Store } from '../src/app/store.ts'
import { FeatureDeliveryRuntime, reconcileDeliveryAdvice, reconcileInboxCurrency } from '../src/app/delivery-runtime.ts'
import { DecisionInbox } from '../src/app/decision-inbox.ts'
import type { PendingDecisionItem } from '../src/core/decision.ts'
import type { Ticket } from '../src/core/model.ts'

const id = 'auto-1aa9568a8df574db0cef146a58004c4b'
const worker = '1aa9568a8df574db0cef146a58004c4b'
const record = { deliveryId: id, revision: 3, sourceIssue: 184, originalWorkerId: worker, releasePr: 33, releaseMergedSha: 'fb591843c3f9ff19965a49e45a4157ed195fc890', evidenceReference: 'https://github.com/gera3d/dsh-superagent-prototype/pull/33', attestation: 'Operator independently checked source issue closure, later release and current live feature evidence.' }
function fixture(repository = 'gera3d/superagent-sandbox') {
  const store = new DeliveryStore(':memory:')
  const d = store.trackUnbound({ ticketId: worker, title: 'Legacy delivery', owner: `worker:${worker}`, repository, sourceIssue: 184, triggerId: '94e8322655e0271463212f4999519ab9' })
  store.compareAndSwap(d.id, 1, v => { v.stage = 'review'; v.state = 'blocked' })
  store.compareAndSwap(d.id, 2, () => {})
  store.db.exec('CREATE TABLE ticket(id TEXT PRIMARY KEY, value TEXT NOT NULL)')
  store.db.prepare('INSERT INTO ticket VALUES (?, ?)').run(worker, JSON.stringify({ id: worker, ended: { by: 'executor', outcome: 'merged', at: '2026-11-07T02:25:52Z' }, assignments: [{ state: 'done' }] }))
  return store
}
const reconcile = (store: DeliveryStore) => {
  const hash = deliveryFingerprint([record])
  return store.reconcileLegacyHistoricalCompletion([record], hash, { source: 'local_operator', actor: 'codex-coordinator', scope: hash, reference: 'user-approved-legacy-reconciliation' })
}
describe('independent exact legacy identity and missing-worker fences', () => {
  it('does not hide a same-ID issue from another source repository', () => {
    const s = fixture('other/repository')
    try { expect(() => reconcile(s)).toThrow(); expect(s.get(id)?.historicalCompletion).toBeUndefined() } finally { s.close() }
  })
  it('requires the actual original ended worker, not absence of a ticket row', () => {
    const s = fixture(); s.db.prepare('DELETE FROM ticket WHERE id=?').run(worker)
    try { expect(() => reconcile(s)).toThrow(); expect(s.get(id)?.historicalCompletion).toBeUndefined() } finally { s.close() }
  })
  it('fails closed on malformed worker data rather than swallowing it', () => {
    const s = fixture(); s.db.prepare('UPDATE ticket SET value=? WHERE id=?').run('{invalid', worker)
    try { expect(() => reconcile(s)).toThrow(); expect(s.get(id)?.historicalCompletion).toBeUndefined() } finally { s.close() }
  })
  it('cannot hide an additional active linked worker', () => {
    const s = fixture(); const extra='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    s.compareAndSwap(id, 3, d => { d.workers.push(extra) })
    // Preserve the original expected revision to isolate identity fencing, in this disposable fixture only.
    const row = s.db.prepare('SELECT value FROM feature_delivery WHERE id=?').get(id)!
    const value = JSON.parse(String(row.value)); value.revision=3
    s.db.prepare('UPDATE feature_delivery SET revision=3,value=? WHERE id=?').run(JSON.stringify(value), id)
    s.db.prepare('INSERT INTO ticket VALUES (?,?)').run(extra, JSON.stringify({ id: extra, assignments: [{ state: 'running' }] }))
    try { expect(() => reconcile(s)).toThrow(); expect(s.get(id)?.historicalCompletion).toBeUndefined() } finally { s.close() }
  })
  it('preserves original missing bindings and history for a genuine ended legacy record', () => {
    const s = fixture(); const before = s.get(id)!
    try {
      const after = reconcile(s)[0]!
      expect(after.bindings).toEqual(before.bindings)
      expect(after.scopeBinding).toEqual(before.scopeBinding)
      expect(after.requirements).toEqual(before.requirements)
      expect(after.authorities).toEqual(before.authorities)
      expect(after.acceptance).toBeUndefined()
      expect(after.evidence).toEqual(before.evidence)
      expect(after.audit.slice(0,before.audit.length)).toEqual(before.audit)
      expect(after.historicalCompletion).toBeDefined()
      expect(after.nextAction).toBeUndefined()
    } finally { s.close() }
  })
  it('fresh advisor context recognizes historical delivery without reopening an unbound release gate', () => {
    const s = fixture()
    try {
      const d = reconcile(s)[0]!
      const context = adviceContext(undefined, d)
      expect(context).toMatch(/historical|delivered by later release/i)
      expect(context).not.toContain('UNBOUND DELIVERY GATE:')
      expect(context).not.toContain('this delivery is already verified and accepted')
    } finally { s.close() }
  })

  it('repeated runtime wake skips historical rows during worker sync and does not block processing', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'legacy-wake-test-'))
    const store = new Store(join(tempDir, 'test.sqlite'))
    const runtime = new FeatureDeliveryRuntime(store)

    try {
      // Seed legacy ended worker ticket
      const ticket: Ticket = {
        id: worker,
        title: 'Legacy worker ticket',
        decisionId: 'decision-1',
        mandate: { strength: 'explicit' } as never,
        origin: { triggerId: 'trigger-1aa', triggerIds: ['trigger-1aa'] },
        createdAt: '2026-11-06T10:00:00.000Z',
        updatedAt: '2026-11-06T10:00:00.000Z',
        channels: [],
        inputs: [],
        undelivered: [],
        ended: { at: '2026-11-07T02:25:52Z', by: 'executor' as never, outcome: 'merged' },
        assignments: [{ id: 'a1', state: 'ended', createdAt: '2026-11-06T10:00:00.000Z' }],
      }
      store.tickets.save(ticket)

      // Create unbound delivery in store
      const d = runtime.store.trackUnbound({
        ticketId: worker,
        title: 'Add temporary subscription conservation and restore-priority settings',
        owner: `worker:${worker}`,
        repository: 'gera3d/superagent-sandbox',
        sourceIssue: 184,
        triggerId: '94e8322655e0271463212f4999519ab9',
      })
      runtime.store.compareAndSwap(d.id, 1, v => { v.stage = 'review'; v.state = 'blocked' })
      runtime.store.compareAndSwap(d.id, 2, () => {})

      // Reconcile it
      const [reconciled] = reconcile(runtime.store)
      expect(reconciled!.revision).toBe(4)
      expect(reconciled!.historicalCompletion).toBeDefined()

      // Repeated runtime wake cycles
      await runtime.request()
      await runtime.request()

      // Later old-worker notification: worker ticket updated
      ticket.attention = { id: 'att-1', question: 'Old worker attention message' }
      store.tickets.save(ticket)

      // Wake runtime again
      await runtime.request()

      // Delivery record remains completely unchanged
      const current = runtime.store.get(id)!
      expect(current.revision).toBe(4)
      expect(current.stage).toBe('review')
      expect(current.state).toBe('blocked')
      expect(current.historicalCompletion).toBeDefined()
      expect(current.historicalCompletion!.fingerprint).toBe(reconciled!.historicalCompletion!.fingerprint)
      expect(current.nextAction).toBeUndefined()
    } finally {
      await runtime.stop()
      store.close()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('preserves later genuine human requests and unrelated decisions across reconciliation', () => {
    const s = fixture()
    const tempDir = mkdtempSync(join(tmpdir(), 'legacy-inbox-test-'))
    const inboxDb = new Store(join(tempDir, 'inbox.sqlite'))
    const inbox = new DecisionInbox(inboxDb.db)

    try {
      const [reconciled] = reconcile(s)
      const reconciledAt = Date.parse(reconciled!.historicalCompletion!.reconciledAt)

      const canonicalMeta = {
        draftRevision: '1',
        phase: 'ready' as const,
        owner: 'operator',
        leaseToken: 'token',
        leaseExpiresAt: Date.now() + 60_000,
      }

      // 1. Older generic generated advice for this worker
      const olderAdvice: PendingDecisionItem = {
        id: 'chat-advice-old',
        sessionId: `worker-${worker}`,
        ticketId: worker,
        ticketTitle: 'Old thread',
        trigger: 'conversation',
        status: 'pending',
        urgency: 'low',
        question: 'Choose the next step for this thread',
        context: '',
        createdAt: reconciledAt - 10_000,
        canonical: canonicalMeta,
        advisor: { key: 'senior' } as never,
        choices: [],
        recommendation: { recommendedValue: '', confidence: 0, rationale: '', distribution: [], provider: '', latencyMs: 0 },
      }

      // 2. Later genuine human request on this thread
      const laterHumanRequest: PendingDecisionItem = {
        id: 'chat-human-question',
        sessionId: `worker-${worker}`,
        ticketId: worker,
        ticketTitle: 'Follow-up question',
        trigger: 'conversation',
        status: 'pending',
        urgency: 'medium',
        question: 'Should we add further configuration options?',
        context: 'User requested next steps regarding conservation settings.',
        createdAt: reconciledAt + 10_000,
        canonical: canonicalMeta,
        choices: [{ id: 'yes', label: 'Yes' }],
        recommendation: { recommendedValue: '', confidence: 0, rationale: '', distribution: [], provider: '', latencyMs: 0 },
      }

      // 3. Unrelated decision item on different thread
      const unrelatedItem: PendingDecisionItem = {
        id: 'chat-unrelated',
        sessionId: 'worker-other',
        ticketId: 'other',
        ticketTitle: 'Unrelated work',
        trigger: 'conversation',
        status: 'pending',
        urgency: 'high',
        question: 'Deploy new service?',
        context: '',
        createdAt: reconciledAt + 5_000,
        canonical: canonicalMeta,
        choices: [{ id: 'deploy', label: 'Deploy' }],
        recommendation: { recommendedValue: '', confidence: 0, rationale: '', distribution: [], provider: '', latencyMs: 0 },
      }

      inbox.put(olderAdvice)
      inbox.put(laterHumanRequest)
      inbox.put(unrelatedItem)

      // Reconcile advice
      const adviceProjected = reconcileDeliveryAdvice([olderAdvice, laterHumanRequest, unrelatedItem], [reconciled!])
      expect(adviceProjected.find(i => i.id === 'chat-advice-old')!.status).toBe('stale')
      expect(adviceProjected.find(i => i.id === 'chat-human-question')!.status).toBe('pending')
      expect(adviceProjected.find(i => i.id === 'chat-unrelated')!.status).toBe('pending')

      // Reconcile inbox currency
      reconcileInboxCurrency(inbox, s)
      expect(inbox.get('chat-advice-old')!.status).toBe('stale')
      expect(inbox.get('chat-human-question')!.status).toBe('pending')
      expect(inbox.get('chat-unrelated')!.status).toBe('pending')
    } finally {
      s.close()
      inboxDb.close()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

})
