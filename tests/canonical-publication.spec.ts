import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DecisionInbox, captureAdvisorTask } from '../src/app/decision-inbox.ts'
import { CanonicalClaimSchema, CanonicalPublishSchema } from '../src/app/http.ts'

const databases: DatabaseSync[] = [], directories: string[] = []
afterEach(() => { databases.splice(0).forEach(db => db.close()); directories.splice(0).forEach(dir => rmSync(dir, { recursive: true })) })
const inbox = (path = ':memory:') => { const db = new DatabaseSync(path); databases.push(db); return new DecisionInbox(db) }
const source = { sessionId: 'chat', sourceMessageId: 'answer', sourceTurn: 1, sourceSeq: 2, draftRevision: 'sha256:revision-1' }
const events = [
  { type: 'user/message', seq: 0, time: 100, data: { id: 'human', source: { kind: 'user' }, content: [{ type: 'text', text: 'Explain why backups are useful before changing software.' }] } },
  { type: 'turn/start', seq: 1, time: 101, data: { turn: 1 } },
  { type: 'assistant/message', seq: 2, time: 102, data: { turn: 1, message: { id: 'answer', content: [{ type: 'text', text: 'Backups preserve earlier data and enable recovery when software changes go wrong.' }] } } },
  { type: 'turn/end', seq: 3, time: 103, data: { turn: 1, reason: { kind: 'completed' } } },
] as unknown as SessionEvent[]
const options = [
  { id: 'explain', label: 'Explain recovery limits', prompt: 'Explain exactly which recovery guarantees backups provide.', why: 'Clarify guarantees.', recommended: false },
  { id: 'verify', label: 'Verify recovery', prompt: 'Describe a safe restore verification procedure.', why: 'Verify real recoverability.', recommended: true },
]
function ready(queue: DecisionInbox) {
  const claim = queue.claimCanonical({ ...source, owner: 'tab-a' }, events)
  const write = { ...source, leaseToken: claim.leaseToken! }
  return { write, item: queue.publishCanonical({ ...write, options, model: 'helper' }, events).item }
}
const evaluation = { recommendedValue: 'explain', confidence: 0.7, rationale: 'Actual ranker result', distribution: [{ id: 'explain', probability: 0.7 }, { id: 'verify', probability: 0.3 }], provider: 'model', latencyMs: 20 }

it.each(['capture-first', 'helper-first'])('publishes pending → ready → scored once (%s), exact IDs/order/prompts without padding', order => {
  const queue = inbox()
  if (order === 'capture-first') captureAdvisorTask(queue, source.sessionId, events)
  const pending = queue.claimCanonical({ ...source, owner: 'tab-a' }, events)
  expect(pending.item.choices).toEqual([])
  expect(pending.item.canonical?.phase).toBe('pending')
  const { write, item } = ready(queue)
  expect(item.choices).toEqual(options.map(option => ({ id: option.id, label: option.label, prompt: option.prompt, description: option.why })))
  expect(item.recommendation).toMatchObject({ recommendedValue: 'verify', distribution: [], confidence: 0 })
  captureAdvisorTask(queue, source.sessionId, events)
  queue.capture(source.sessionId, events)
  expect(queue.list()).toHaveLength(1)
  expect(queue.get(item.id)?.choices).toEqual(item.choices)
  const scored = queue.scoreCanonical({ ...write, evaluation }, events).item
  expect(scored.canonical?.phase).toBe('scored')
  expect(scored.choices).toEqual(item.choices)
  expect(scored.recommendation).toEqual(evaluation)
  expect(queue.scoreCanonical({ ...write, evaluation }, events).item).toEqual(scored)
  expect(queue.publishCanonical({ ...write, options, model: 'helper' }, events).item).toEqual(scored)
})
it('deduplicates tabs and reloads with durable lease CAS, permits expired scoring takeover', () => {
  const directory = mkdtempSync(join(tmpdir(), 'canonical-')); directories.push(directory)
  const path = join(directory, 'inbox.sqlite'), first = inbox(path), second = inbox(path)
  const now = Date.now()
  const claimed = first.claimCanonical({ ...source, owner: 'a' }, events, now)
  expect(second.claimCanonical({ ...source, owner: 'b' }, events, now).claimed).toBe(false)
  expect(second.claimCanonical({ ...source, owner: 'a' }, events, now).leaseToken).toBe(claimed.leaseToken)
  const takeover = second.claimCanonical({ ...source, owner: 'b' }, events, now + 120001)
  expect(takeover.leaseToken).not.toBe(claimed.leaseToken)
  expect(() => first.publishCanonical({ ...source, leaseToken: claimed.leaseToken!, options, model: 'helper' }, events)).toThrow('lease changed')
  const ready = second.publishCanonical({ ...source, leaseToken: takeover.leaseToken!, options, model: 'helper' }, events).item
  expect(first.get(ready.id)).toEqual(ready)
  expect(first.claimCanonical({ ...source, owner: 'c' }, events, now + 240002).claimed).toBe(false)
  const scoring = first.claimCanonical({ ...source, owner: 'c', purpose: 'score' }, events, now + 240002)
  expect(scoring.claimed).toBe(true)
  expect(scoring.item.canonical?.phase).toBe('ready')
  expect(second.scoreCanonical({ ...source, leaseToken: scoring.leaseToken!, evaluation }, events).item.canonical?.phase).toBe('scored')
})
it('keeps ready choices visible on scoring failure and permits a scoring retry', () => {
  const queue = inbox(), { write, item } = ready(queue)
  const failed = queue.failCanonical({ ...write, error: 'Scorer unavailable' }, events).item
  expect(failed.choices).toEqual(item.choices)
  expect(failed.canonical).toMatchObject({ phase: 'ready', error: 'Scorer unavailable' })
  expect(failed.recommendation.distribution).toEqual([])
  expect(queue.scoreCanonical({ ...write, evaluation }, events).item.recommendation).toEqual(evaluation)
})
it('rejects wrong identity/revision, cancelled/interrupted and continued sources', () => {
  const queue = inbox(), { write } = ready(queue)
  for (const patch of [{ sourceMessageId: 'wrong' }, { sourceSeq: 0 }, { sourceTurn: 2 }, { draftRevision: 'older' }]) {
    expect(() => queue.scoreCanonical({ ...write, ...patch, evaluation }, events)).toThrow()
  }
  const cancelled = structuredClone(events) as any[]; cancelled[3].data.reason.kind = 'cancelled'
  expect(() => queue.scoreCanonical({ ...write, evaluation }, cancelled)).toThrow('completed turn')
  const interrupted = structuredClone(events) as any[]; interrupted[2].data.interrupted = true
  expect(() => queue.scoreCanonical({ ...write, evaluation }, interrupted)).toThrow('completed turn')
  const continued = [...events, { type: 'turn/start', seq: 4, time: 104, data: { turn: 2 } }] as SessionEvent[]
  expect(() => queue.scoreCanonical({ ...write, evaluation }, continued)).toThrow('completed turn')
})
it('locks staged drafts, keeps them readable, and only resolves with matching native submission proof', () => {
  const queue = inbox(), { write, item } = ready(queue), attemptId = randomUUID()
  const draftText = item.choices[0]!.prompt!
  queue.stage(item.id, { attemptId, choiceId: 'explain', draftText })
  expect(queue.claimCanonical({ ...source, owner: 'tab-b' }, events)).toMatchObject({ claimed: false, item: { staging: { attemptId } } })
  expect(() => queue.scoreCanonical({ ...write, evaluation }, events)).toThrow('staged')
  expect(() => queue.publishCanonical({ ...write, options, model: 'helper' }, events)).toThrow('staged')
  expect(() => queue.resolve(item.id, 'explain')).toThrow('native submission')
  queue.bindSubmission(item.id, { attemptId, submissionId: 'native-send' }, events)
  queue.capture(source.sessionId, [...events, { type: 'user/message', seq: 4, time: 104, data: { id: 'sent', source: { kind: 'user', rpcId: 'native-send' }, content: [{ type: 'text', text: draftText }] } }] as unknown as SessionEvent[])
  expect(queue.resolve(item.id, 'explain').item).toMatchObject({ status: 'resolved', submittedMessageId: 'sent', submittedSeq: 4 })
  expect(() => queue.publishCanonical({ ...write, options, model: 'helper' }, events)).toThrow('closed')
})
it('rejects padded/pruned/duplicate choices and scoring ID/order changes; preserves legacy history', () => {
  const queue = inbox()
  queue.capture(source.sessionId, events.map(event => event.type === 'assistant/message' ? { ...event, data: { ...event.data, message: { ...event.data.message, content: [{ type: 'text' as const, text: 'Should I verify backups?' }] } } } : event))
  const prior = queue.list()[0]!.choices
  const claim = queue.claimCanonical({ ...source, owner: 'tab-a' }, events), write = { ...source, leaseToken: claim.leaseToken! }
  expect(() => queue.publishCanonical({ ...write, options: [...options, ...options, options[0]!], model: 'helper' }, events)).toThrow('2–4')
  const item = queue.publishCanonical({ ...write, options, model: 'helper' }, events).item
  expect(item.optionSets?.[0]?.choices).toEqual(prior)
  expect(item.optionSets?.at(-1)?.choices).toEqual(item.choices)
  expect(() => queue.scoreCanonical({ ...write, evaluation: { ...evaluation, distribution: [...evaluation.distribution].reverse() } }, events)).toThrow('IDs/order')
  expect(() => queue.publishCanonical({ ...write, options: [...options].reverse(), model: 'helper' }, events)).toThrow('already published')
})
it('rejects legacy database writers removing identity or overwriting published options', () => {
  const queue = inbox(), { item } = ready(queue), db = databases.at(-1)!
  expect(() => db.prepare('UPDATE decision_inbox SET value=? WHERE id=?').run(JSON.stringify({ ...item, canonical: undefined }), item.id)).toThrow('immutable')
  expect(() => db.prepare('UPDATE decision_inbox SET value=? WHERE id=?').run(JSON.stringify({ ...item, choices: [...item.choices].reverse() }), item.id)).toThrow('immutable')
  expect(() => queue.restoreOptionSet(item.id, 1)).toThrow('immutable')
  expect(queue.get(item.id)).toEqual(item)
})
it('strict HTTP schemas require full source identity and bounded exact helper choices', () => {
  expect(CanonicalClaimSchema.safeParse({ ...source, owner: 'tab-a' }).success).toBe(true)
  expect(CanonicalClaimSchema.safeParse({ ...source, sourceSeq: undefined, owner: 'tab-a' }).success).toBe(false)
  expect(CanonicalPublishSchema.safeParse({ ...source, leaseToken: randomUUID(), model: 'helper', options }).success).toBe(true)
  expect(CanonicalPublishSchema.safeParse({ ...source, leaseToken: randomUUID(), model: 'helper', options: [...options, ...options, options[0]] }).success).toBe(false)
})
