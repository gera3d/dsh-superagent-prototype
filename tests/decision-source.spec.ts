import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { DecisionInbox } from '../src/app/decision-inbox.ts'
import type { PendingDecisionItem } from '../src/core/decision.ts'

it('enriches the captured decision instead of creating a competing recommendation', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const inbox = new DecisionInbox(db)
    const item: PendingDecisionItem = { id: 'captured', sessionId: 'session', sourceMessageId: 'message',
      ticketTitle: 'Single source test', trigger: 'Explicit alternatives', status: 'pending', urgency: 'low', createdAt: 1,
      context: 'Which choice?', question: 'Which choice?', choices: [{ id: 'a', label: 'Review first' }, { id: 'b', label: 'Skip review' }],
      recommendation: { recommendedValue: '', confidence: 0, rationale: 'Not evaluated', distribution: [], provider: 'Not evaluated', latencyMs: 0 } }
    inbox.put(item)
    const evaluated: PendingDecisionItem = { ...item, id: 'inline-session-message', recommendation: {
      recommendedValue: 'a', confidence: .8, rationale: 'Review first.', distribution: [{ id: 'a', probability: .8 }, { id: 'b', probability: .2 }], provider: 'configured-model', latencyMs: 100 } }
    expect(inbox.put(evaluated)).toMatchObject({ id: 'captured', recommendation: { recommendedValue: 'a' } })
    expect(inbox.list()).toHaveLength(1)
    expect(() => inbox.resolve('captured', 'a')).toThrow('Linked native submission required')
    inbox.stale('session', 'Source superseded')
    expect(inbox.put({ ...evaluated, recommendation: { ...evaluated.recommendation, recommendedValue: 'b' } }).status).toBe('stale')
    expect(inbox.get('captured')?.recommendation.recommendedValue).toBe('a')
    expect(inbox.list()).toHaveLength(1)
  } finally { db.close() }
})
