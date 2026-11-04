import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DecisionInbox, restartDecision, stageDecision, submitDecision } from '../src/app/decision-inbox.ts'
import { DecisionRestartRequest } from '../src/app/http.ts'

const databases: DatabaseSync[] = []
afterEach(() => { databases.splice(0).forEach(db => db.close()) })
const text = 'Test first'
function assistant(seq: number, turn: number, id: string, value: string): SessionEvent {
  return { type: 'assistant/message', seq, time: 100 + seq, data: { turn, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text: value }] }, stream: [] } } as unknown as SessionEvent
}
function end(seq: number, turn: number): SessionEvent { return { type: 'turn/end', seq, time: 100 + seq, data: { turn, reason: { kind: 'completed' } } } as unknown as SessionEvent }
function human(seq: number, rpcId: string, value = text): SessionEvent {
  return { type: 'user/message', seq, time: 100 + seq, data: { id: `native-${seq}`, role: 'user', source: { kind: 'user', rpcId }, content: [{ type: 'text', text: value }] } } as unknown as SessionEvent
}
function start(seq: number, turn: number): SessionEvent { return { type: 'turn/start', seq, time: 100 + seq, data: { turn } } as unknown as SessionEvent }
function initial(): SessionEvent[] { return [start(0, 1), assistant(1, 1, 'original-source', 'Which approach?\nA) Test first\nB) Review first'), end(2, 1)] }
function history(): SessionEvent[] { return [...initial(), human(3, 'original-send'), start(4, 2), assistant(5, 2, 'latest-source', 'The requested tests have finished successfully.'), end(6, 2)] }
function setup() {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const inbox = new DecisionInbox(db)
  inbox.capture('session', initial())
  const id = inbox.list()[0]!.id, attemptId = randomUUID()
  inbox.stage(id, { attemptId, choiceId: 'option-a', draftText: text })
  inbox.bindSubmission(id, { attemptId, submissionId: 'original-send' }, initial())
  inbox.capture('session', history())
  return { db, inbox, id, parent: inbox.get(id)! }
}
function context(events: SessionEvent[]) {
  const flush = vi.fn(async () => {})
  const open = vi.fn(async (id: string, mode: string) => {
    expect(id).toBe('session'); expect(mode).toBe('read')
    return { read: async (offset: number) => ({ events: offset ? [] : events }), [Symbol.asyncDispose]: async () => {} }
  })
  return { sessionPersistence: { flush, open } }
}

it('creates a separate pending child, preserving the parent SQLite bytes and omitting all copied proof', () => {
  const { db, inbox, id, parent } = setup()
  const before = db.prepare('SELECT value FROM decision_inbox WHERE id=?').get(id)!.value
  const child = inbox.startNewDecision(id, history())
  expect(child).toMatchObject({ status: 'pending', parentDecisionId: id, restartAfterSeq: 6, sessionId: 'session', sourceMessageId: 'original-source', sourceSeq: 1, sourceTurn: 1, choices: parent.choices, question: parent.question, context: parent.context, resolutionPolicy: 'on_send' })
  expect(child.id).not.toBe(id)
  expect(child.createdAt).toBeGreaterThan(parent.createdAt)
  for (const key of ['staging', 'submissionId', 'submittedMessageId', 'submittedSeq', 'resolvedChoice', 'resolvedAt', 'resolutionBasis', 'invalidation', 'draftResponse', 'ticketId']) expect(child).not.toHaveProperty(key)
  expect(db.prepare('SELECT value FROM decision_inbox WHERE id=?').get(id)!.value).toBe(before)
  expect(inbox.get(id)).toEqual(parent)
})

it('deduplicates retries, and a recreated inbox selects the newest child for the original source', () => {
  const { db, inbox, id } = setup()
  const child = inbox.startNewDecision(id, history())
  expect(inbox.startNewDecision(id, history())).toEqual(child)
  const reloaded = new DecisionInbox(db)
  expect(reloaded.startNewDecision(id, history())).toEqual(child)
  expect(reloaded.findSource({ sessionId: 'session', sourceMessageId: 'original-source', sourceTurn: 1 })).toEqual(child)
  expect(reloaded.list().filter(item => item.parentDecisionId === id)).toHaveLength(1)
  expect(reloaded.findSource({ sessionId: 'other-session', sourceMessageId: 'original-source' })).toBeUndefined()
})

it('ignores historical sends and completed turns both with an old cursor and on a full cold replay', () => {
  const { db, inbox, id } = setup()
  const child = inbox.startNewDecision(id, history())
  inbox.capture('session', history())
  expect(inbox.get(child.id)).toEqual(child)
  db.prepare('DELETE FROM decision_inbox_cursor WHERE session=?').run('session')
  inbox.capture('session', history())
  expect(inbox.get(child.id)).toEqual(child)
  const attemptId = randomUUID()
  inbox.stage(child.id, { attemptId, choiceId: 'option-a', draftText: text })
  expect(() => inbox.bindSubmission(child.id, { attemptId, submissionId: 'original-send' }, history())).toThrow('before the restart checkpoint')
  expect(inbox.bindSubmission(child.id, { attemptId, submissionId: 'new-send' }, history()).item.status).toBe('pending')
  expect(inbox.get(child.id)?.staging?.candidateSubmission).toBeUndefined()
  expect(inbox.get(child.id)?.resolvedChoice).toBeUndefined()
})

it('resolves a restarted choice only from a newly bound matching native submission', () => {
  const { inbox, id } = setup()
  const child = inbox.startNewDecision(id, history()), attemptId = randomUUID()
  inbox.stage(child.id, { attemptId, choiceId: 'option-a', draftText: text })
  expect(inbox.bindSubmission(child.id, { attemptId, submissionId: 'new-send' }, history()).item.status).toBe('pending')
  inbox.capture('session', [...history(), human(7, 'new-send')])
  expect(inbox.get(child.id)).toMatchObject({ status: 'resolved', parentDecisionId: id, restartAfterSeq: 6, resolvedChoice: 'option-a', resolutionBasis: 'submitted', submittedSeq: 7, submittedMessageId: 'native-7', submissionId: 'new-send' })
  expect(inbox.get(id)).toMatchObject({ status: 'resolved', submissionId: 'original-send', submittedSeq: 3 })
})

it('does not resolve an equal-text new event without the matching new binding', () => {
  const { inbox, id } = setup()
  const child = inbox.startNewDecision(id, history()), attemptId = randomUUID()
  inbox.stage(child.id, { attemptId, choiceId: 'option-a', draftText: text })
  inbox.bindSubmission(child.id, { attemptId, submissionId: 'different-send' }, history())
  inbox.capture('session', [...history(), human(7, 'new-send')])
  expect(inbox.get(child.id)).toMatchObject({ status: 'pending', staging: { candidateSubmission: { submissionId: 'new-send', seq: 7 } } })
  expect(inbox.get(child.id)?.resolvedChoice).toBeUndefined()
})

it.each([
  ['human message', human(7, 'unrelated', 'An unrelated question')],
  ['turn start', start(7, 3)],
  ['turn end', end(7, 3)],
])('invalidates a pending restart on a later %s', (_name, event) => {
  const { inbox, id } = setup(), child = inbox.startNewDecision(id, history())
  inbox.capture('session', [...history(), event])
  expect(inbox.get(child.id)).toMatchObject({ status: 'stale', invalidation: { sourceSeq: 7 } })
  expect(inbox.get(id)?.status).toBe('resolved')
  expect(inbox.startNewDecision(id, [...history(), event]).id).toBe(child.id)
  expect(inbox.startNewDecision(id, [...history(), event]).status).toBe('stale')
})

it('permits staging original alternatives after restart even when the current completed response differs', async () => {
  const { inbox, id } = setup(), child = inbox.startNewDecision(id, history())
  const ctx = context(history())
  const result = await stageDecision(ctx as any, inbox, child.id, { attemptId: randomUUID(), choiceId: 'option-a', draftText: text })
  expect(result).toMatchObject({ execution: 'not_executed', item: { status: 'pending', parentDecisionId: id, sourceMessageId: 'original-source', restartAfterSeq: 6 } })
  expect(ctx.sessionPersistence.flush).toHaveBeenCalledOnce()
})

it('refuses staging when session activity advanced beyond the server-owned restart checkpoint', async () => {
  const { inbox, id } = setup(), child = inbox.startNewDecision(id, history())
  const changed = [...history(), human(7, 'unrelated', 'Another task'), start(8, 3), assistant(9, 3, 'newest-source', 'Another task is completed.'), end(10, 3)]
  await expect(stageDecision(context(changed) as any, inbox, child.id, { attemptId: randomUUID(), choiceId: 'option-a', draftText: text })).rejects.toThrow('source changed')
  expect(inbox.get(child.id)?.staging).toBeUndefined()
})

it('rejects wrong-session restart requests before opening durable history and validates the strict request schema', async () => {
  const { inbox, id } = setup(), ctx = context(history())
  await expect(restartDecision(ctx as any, inbox, id, { sessionId: 'wrong-session' })).rejects.toMatchObject({ status: 409 })
  expect(ctx.sessionPersistence.open).not.toHaveBeenCalled()
  for (const request of [{}, { sessionId: '' }, { sessionId: 'session', restartAfterSeq: 999 }, { sessionId: 'session', parentDecisionId: id }]) expect(DecisionRestartRequest.safeParse(request).success).toBe(false)
  const result = await restartDecision(ctx as any, inbox, id, DecisionRestartRequest.parse({ sessionId: 'session' }))
  expect(result).toMatchObject({ execution: 'not_executed', item: { status: 'pending', parentDecisionId: id, restartAfterSeq: 6 } })
})

it('rejects missing, non-recorded, unavailable-source and still-running restart parents', () => {
  const { inbox, id } = setup()
  expect(() => inbox.startNewDecision('missing', history())).toThrow('not found')
  expect(() => inbox.startNewDecision(id, history().filter(event => event.seq !== 1))).toThrow('source history')
  expect(() => inbox.startNewDecision(id, [...history(), start(7, 3)])).toThrow('Wait for the conversation')
  const child = inbox.startNewDecision(id, history())
  expect(() => inbox.startNewDecision(child.id, history())).toThrow('Only a recorded decision')
})

it('supports another restart generation after a new completed assistant response without erasing either recorded ancestor', async () => {
  const { db, inbox, id } = setup(), first = inbox.startNewDecision(id, history()), attemptId = randomUUID()
  await stageDecision(context(history()) as any, inbox, first.id, { attemptId, choiceId: 'option-a', draftText: text })
  inbox.bindSubmission(first.id, { attemptId, submissionId: 'child-send' }, history())
  const later = [...history(), human(7, 'child-send'), start(8, 3), assistant(9, 3, 'third-source', 'The repeated tests completed successfully.'), end(10, 3)]
  inbox.capture('session', later)
  const firstBefore = inbox.get(first.id)!, originalBefore = inbox.get(id)!
  expect(firstBefore).toMatchObject({ status: 'resolved', parentDecisionId: id, submittedSeq: 7 })
  const second = inbox.startNewDecision(first.id, later)
  expect(second).toMatchObject({ status: 'pending', parentDecisionId: first.id, restartAfterSeq: 10, sourceMessageId: 'original-source', choices: first.choices })
  expect(second.createdAt).toBeGreaterThan(firstBefore.createdAt)
  expect(inbox.get(id)).toEqual(originalBefore)
  expect(inbox.get(first.id)).toEqual(firstBefore)
  expect(new DecisionInbox(db).findSource({ sessionId: 'session', sourceMessageId: 'original-source' })?.id).toBe(second.id)
  const nextAttempt = randomUUID()
  await stageDecision(context(later) as any, inbox, second.id, { attemptId: nextAttempt, choiceId: 'option-a', draftText: text })
  expect(() => inbox.bindSubmission(second.id, { attemptId: nextAttempt, submissionId: 'child-send' }, later)).toThrow('before the restart checkpoint')
  expect(inbox.bindSubmission(second.id, { attemptId: nextAttempt, submissionId: 'grandchild-send' }, later).item.status).toBe('pending')
  inbox.capture('session', [...later, human(11, 'grandchild-send')])
  expect(inbox.get(second.id)).toMatchObject({ status: 'resolved', submissionId: 'grandchild-send', submittedSeq: 11 })
  expect(inbox.get(first.id)).toMatchObject({ status: 'resolved', submissionId: 'child-send', submittedSeq: 7 })
  expect(inbox.get(id)).toMatchObject({ status: 'resolved', submissionId: 'original-send', submittedSeq: 3 })
})

it('rejects truncated durable history that omits the restart checkpoint before staging or binding', async () => {
  const { inbox, id } = setup(), child = inbox.startNewDecision(id, history()), attemptId = randomUUID()
  const truncated = history().filter(event => event.seq !== child.restartAfterSeq)
  await expect(stageDecision(context(truncated) as any, inbox, child.id, { attemptId, choiceId: 'option-a', draftText: text })).rejects.toThrow('checkpoint history is unavailable')
  expect(inbox.get(child.id)?.staging).toBeUndefined()
  inbox.stage(child.id, { attemptId, choiceId: 'option-a', draftText: text })
  expect(() => inbox.bindSubmission(child.id, { attemptId, submissionId: 'new-send' }, truncated)).toThrow('checkpoint history is unavailable')
  expect(inbox.get(child.id)?.staging?.submissionId).toBeUndefined()
  expect(inbox.get(child.id)?.status).toBe('pending')
})

it('preserves restarted original alternatives when an older in-flight advisor result finally publishes', () => {
  const { inbox, id } = setup(), child = inbox.startNewDecision(id, history())
  const returned = inbox.publishAdvisor({ sessionId: 'session', sourceMessageId: 'original-source', sourceTurn: 1, sourceSeq: 1,
    key: 'old-advisor-request', question: 'Changed question?', context: 'Late model response', createdAt: 10, model: 'late/model',
    options: [{ id: 'late-a', label: 'Changed A', prompt: 'Run a different action.', why: 'Late advice', recommended: true },
      { id: 'late-b', label: 'Changed B', prompt: 'Ignore the original alternatives.', why: 'Late advice', recommended: false }] })
  expect(returned).toEqual(child)
  expect(inbox.get(child.id)).toEqual(child)
  expect(inbox.list().filter(item => item.parentDecisionId === id)).toHaveLength(1)
})

it('rejects forged resolution using parent submission proof even through a direct SQLite writer', () => {
  const { db, inbox, id, parent } = setup(), child = inbox.startNewDecision(id, history()), attemptId = randomUUID()
  inbox.stage(child.id, { attemptId, choiceId: 'option-a', draftText: text })
  const pending = inbox.linkSubmission(child.id, { attemptId, submissionId: 'new-send' }).item
  const forged = { ...pending, status: 'resolved', resolvedChoice: 'option-a', resolutionBasis: 'submitted', resolvedAt: parent.resolvedAt,
    submissionId: 'new-send', submittedMessageId: parent.submittedMessageId, submittedSeq: parent.submittedSeq, resolutionRevision: pending.resolutionRevision! + 1 }
  expect(() => db.prepare('UPDATE decision_inbox SET value=? WHERE id=?').run(JSON.stringify(forged), child.id)).toThrow('submission after its history checkpoint')
  expect(inbox.get(child.id)?.status).toBe('pending')
})

it('rejects excluded historical submit requests without mutating child bytes, then accepts a fresh first binding', async () => {
  const { db, inbox, id } = setup(), child = inbox.startNewDecision(id, history()), attemptId = randomUUID()
  expect(child.restartExcludedSubmissionIds).toContain('original-send')
  inbox.stage(child.id, { attemptId, choiceId: 'option-a', draftText: text })
  const before = db.prepare('SELECT value FROM decision_inbox WHERE id=?').get(child.id)!.value
  const rejectedContext = context(history())
  await expect(submitDecision(rejectedContext as any, inbox, child.id, { attemptId, submissionId: 'original-send' })).rejects.toThrow('before the restart checkpoint')
  expect(db.prepare('SELECT value FROM decision_inbox WHERE id=?').get(child.id)!.value).toBe(before)
  expect(rejectedContext.sessionPersistence.flush).not.toHaveBeenCalled()
  const result = await submitDecision(context(history()) as any, inbox, child.id, { attemptId, submissionId: 'fresh-first-send' })
  expect(result).toMatchObject({ item: { status: 'pending' }, staging: { submissionId: 'fresh-first-send', submissionIds: ['fresh-first-send'] } })
})

it('does not resolve a staged child if a new turn begins before its matching linked native message', () => {
  const { inbox, id } = setup(), child = inbox.startNewDecision(id, history()), attemptId = randomUUID()
  inbox.stage(child.id, { attemptId, choiceId: 'option-a', draftText: text })
  inbox.bindSubmission(child.id, { attemptId, submissionId: 'new-send' }, history())
  inbox.capture('session', [...history(), start(7, 3), human(8, 'new-send')])
  expect(inbox.get(child.id)).toMatchObject({ status: 'stale', invalidation: { sourceSeq: 7 } })
  expect(inbox.get(child.id)?.resolvedChoice).toBeUndefined()
  expect(inbox.get(id)?.status).toBe('resolved')
})

it('enforces immutable restart ancestry and checkpoint at the SQLite boundary', () => {
  const { db, inbox, id } = setup(), child = inbox.startNewDecision(id, history())
  const update = db.prepare('UPDATE decision_inbox SET value=? WHERE id=?')
  for (const change of [{ restartAfterSeq: 0 }, { parentDecisionId: 'another-parent' }, { restartExcludedSubmissionIds: [] }]) {
    expect(() => update.run(JSON.stringify({ ...child, ...change, resolutionRevision: child.resolutionRevision! + 1 }), child.id)).toThrow('lineage and checkpoint are immutable')
  }
  expect(inbox.get(child.id)).toEqual(child)
})
