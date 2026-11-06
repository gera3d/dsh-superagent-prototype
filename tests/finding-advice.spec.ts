import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { FindingStore } from '../src/app/finding.ts'
import { DeliveryStore } from '../src/app/feature-delivery.ts'
import { DecisionInbox } from '../src/app/decision-inbox.ts'
import { reconcileInboxCurrency } from '../src/app/delivery-runtime.ts'

it('persists finding-owned generic advice retirement before source lookup/staging, preserving real questions and staged submissions', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const findings = new FindingStore(db), deliveries = new DeliveryStore(db), inbox = new DecisionInbox(db)
    let f = findings.observe({ dedupKey: 'verification', title: 'Verify observation', problem: 'Unconfirmed report', scope: 'Verify only', owner: 'team', kind: 'verification', requirements: ['Record observed evidence'], repository: 'org/repo', occurrence: { id: 'observed', reference: 'issue/171', evidence: 'Needs verification' } })
    findings.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' })
    f = findings.markDispatched(f.id, 'new-ticket', 'new-assignment')
    const options = [{ id: 'verify', label: 'Verify', prompt: 'Verify', why: 'Verify', recommended: true }, { id: 'inspect', label: 'Inspect', prompt: 'Inspect', why: 'Inspect', recommended: false }]
    let turn = 0
    const advice = (sourceMessageId: string, sessionId: string, context = '') => inbox.publishAdvisor({ sessionId, sourceMessageId,
      sourceTurn: ++turn, sourceSeq: turn, key: sourceMessageId, createdAt: Date.now(), question: context || 'Choose the next step for this thread', context, title: 'Advice', model: 'configured-advisor', options })
    const generated = advice('blank-final', 'worker-new-ticket')
    const bare = advice('bare-ticket', 'new-ticket')
    const question = advice('real-question', 'worker-new-ticket', 'Which requirement should I verify?')
    const staged = advice('staged', 'worker-new-ticket')
    inbox.stage(staged.id, { choiceId: 'verify', attemptId: '123e4567-e89b-42d3-a456-426614174000', draftText: 'Verify' })
    const unrelated = advice('other-worker', 'worker-unrelated')
    reconcileInboxCurrency(inbox, deliveries, undefined, findings)
    for (const item of [generated, bare]) {
      expect(inbox.get(item.id)).toMatchObject({ status: 'stale', staleReason: expect.stringContaining(f.id) })
      expect(inbox.findSource({ sessionId: item.sessionId!, sourceMessageId: item.sourceMessageId })?.status).toBe('stale')
      expect(() => inbox.stage(item.id, { choiceId: 'verify', attemptId: '123e4567-e89b-42d3-a456-426614174001', draftText: 'Verify' })).toThrow('stale')
    }
    expect(inbox.get(question.id)?.status).toBe('pending')
    expect(inbox.get(staged.id)?.staging?.attemptId).toBe('123e4567-e89b-42d3-a456-426614174000')
    expect(inbox.get(unrelated.id)?.status).toBe('pending')
    const freshConnection = new DecisionInbox(db)
    expect(freshConnection.get(generated.id)?.status).toBe('stale')
  } finally { db.close() }
})
