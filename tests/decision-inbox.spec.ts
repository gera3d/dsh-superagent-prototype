import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DecisionInbox, decisionQuestion, registerDecisionCapture } from '../src/app/decision-inbox.ts'

const dbs: DatabaseSync[] = []
const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }) })
function inbox(path = ':memory:') { const db = new DatabaseSync(path); dbs.push(db); return new DecisionInbox(db) }
function history(text: string, reason = 'completed'): SessionEvent[] {
  return [{ type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
    { type: 'assistant/message', seq: 1, time: 101, data: { turn: 1, step: 1, message: { id: 'message-1', role: 'assistant', content: [{ type: 'text', text }] }, stream: [] } },
    { type: 'turn/end', seq: 2, time: 102, data: { turn: 1, reason: { kind: reason } } }] as unknown as SessionEvent[]
}
function user(seq: number): SessionEvent { return { type: 'user/message', seq, time: 103, data: { id: 'human', role: 'user', source: { kind: 'user' }, content: [] } } as unknown as SessionEvent }

it('captures questions and offers without inventing recommendation or execution', () => {
  const queue = inbox()
  queue.capture('one', history('Would you like me to deploy this?'))
  queue.capture('two', history('If you want, I can add regression tests next.'))
  expect(queue.list()).toHaveLength(2)
  const question = queue.list().find(item => item.sessionId === 'one')!
  expect(question).toMatchObject({ sessionId: 'one', sourceMessageId: 'message-1', sourceTurn: 1, sourceSeq: 1,
    status: 'pending', actionMode: 'stage_response', createdAt: 102, recommendation: { confidence: 0, recommendedValue: '' } })
  const attemptId = randomUUID(), draftText = `Regarding your question:\n${question.question}\n\nMy response: review first.`
  expect(queue.stage(question.id, { attemptId, choiceId: 'respond', draftText }).item.status).toBe('pending')
  queue.bindSubmission(question.id, { attemptId, submissionId: 'native' }, history('Would you like me to deploy this?'))
  queue.capture('one', [...history('Would you like me to deploy this?'), { type: 'user/message', seq: 3, time: 104, data: { id: 'sent', source: { kind: 'user', rpcId: 'native' }, content: [{ type: 'text', text: draftText }] } }] as unknown as SessionEvent[])
  const resolution = queue.resolve(question.id, 'respond')
  expect(resolution).toMatchObject({ execution: 'not_executed', item: { status: 'resolved', resolutionBasis: 'submitted' } })
  expect(queue.resolve(resolution.item.id, 'respond')).toEqual(resolution)
  expect(() => queue.resolve(resolution.item.id, 'discuss')).toThrow('already resolved')
})
it('retains real explicit alternatives instead of generic choices', () => {
  const queue = inbox()
  queue.capture('one', history('Which approach do you prefer?\nA) Add tests first\nB) Refactor first'))
  expect(queue.list()[0]?.choices).toEqual([{ id: 'option-a', label: 'Add tests first' }, { id: 'option-b', label: 'Refactor first' }])
})
it('ignores code, quotes, ordinary task lists, commentary and interrupted turns', () => {
  expect(decisionQuestion('All tests passed.\n- Add tests\n- Deploy later')).toBeUndefined()
  expect(decisionQuestion('```ts\nWhich option?\n```\n> Would you like to deploy?')).toBeUndefined()
  expect(decisionQuestion('The user asked: should I deploy?')).toBeUndefined()
  expect(decisionQuestion('`Would you like to deploy?`\nhttps://example.com/Which?')).toBeUndefined()
  expect(decisionQuestion('~~~\nWould you like to deploy?\n~~~\n“Would you like to deploy?”')).toBeUndefined()
  expect(decisionQuestion('What changed?\nAll tests now pass. I can confirm the fix is complete.')).toBeUndefined()
  expect(decisionQuestion("I could not run the tests. I can't access that file.")).toBeUndefined()
  expect(decisionQuestion('Should I deploy `prod`?')).toBe('Should I deploy `prod`?')
  expect(decisionQuestion('Can you review https://example.com/target?')).toBe('Can you review https://example.com/target?')
  const queue = inbox()
  queue.capture('aborted', history('Would you like to deploy?', 'aborted'))
  const events = history('Would you like to deploy?')
  events.splice(2, 0, { ...events[1], seq: 2, data: { ...(events[1] as any).data, message: { ...(events[1] as any).data.message, id: 'final', content: [{ type: 'text', text: 'Done. No action needed.' }] } } } as SessionEvent)
  events[3] = { ...events[3], seq: 3 } as SessionEvent
  queue.capture('commentary', events)
  expect(queue.list()).toEqual([])
})
it('deduplicates replay and source ids across reloads, and refuses stale resolution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-inbox-')); dirs.push(dir)
  const path = join(dir, 'state.sqlite')
  const first = inbox(path)
  const events = history('If you want, I can add tests.')
  first.capture('session', events)
  const item = first.list()[0]!
  first.put({ ...item, id: 'legacy-client-id' })
  expect(first.list()).toHaveLength(1)
  const second = inbox(path)
  second.capture('session', events)
  expect(second.list()).toHaveLength(1)
  second.capture('session', [...events, user(3)])
  expect(second.get(item.id)).toMatchObject({ status: 'stale', staleReason: expect.stringContaining('human') })
  expect(() => second.resolve(item.id, 'continue')).toThrow('stale')
  // An older cold snapshot and a late client POST cannot resurrect it.
  second.capture('session', events)
  second.put({ ...item, id: 'late-client-id' })
  expect(second.list()).toHaveLength(1)
  expect(second.list()[0]?.status).toBe('stale')
})
it('persists a resolved draft and idempotent selection after closing and reopening SQLite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-resolved-')); dirs.push(dir)
  const path = join(dir, 'state.sqlite')
  const first = inbox(path)
  const events = history('If you want, I can add tests.')
  first.capture('one', events)
  const id = first.list()[0]!.id, attemptId = randomUUID()
  const draftText = `Please continue with the next step you offered:\n${first.get(id)!.question}`
  first.stage(id, { attemptId, choiceId: 'continue', draftText })
  first.bindSubmission(id, { attemptId, submissionId: 'native' }, events)
  first.capture('one', [...events, { type: 'user/message', seq: 3, time: 104, data: { id: 'sent', source: { kind: 'user', rpcId: 'native' }, content: [{ type: 'text', text: draftText }] } }] as unknown as SessionEvent[])
  const original = first.resolve(id, 'continue')
  dbs.pop()!.close()
  const reopened = inbox(path)
  reopened.capture('one', events)
  expect(reopened.list()).toEqual([original.item])
  expect(reopened.resolve(original.item.id, 'continue')).toEqual(original)
})
it('supersedes pending questions when a later turn completes with no ask', () => {
  const queue = inbox(); const events = history('Should I deploy?')
  queue.capture('one', events)
  const next = history('Done.').map(event => ({ ...event, seq: event.seq + 3, data: { ...event.data, turn: 2 } })) as SessionEvent[]
  queue.capture('one', [...events, ...next])
  expect(queue.list()[0]?.status).toBe('stale')
})
it('does not dedupe unrelated ticket decisions without source message ids', () => {
  const queue = inbox(); queue.capture('one', history('Should I deploy?'))
  const base = queue.list()[0]!
  queue.put({ ...base, id: 'ticket-1', ticketId: 'one', sourceMessageId: undefined })
  queue.put({ ...base, id: 'ticket-2', ticketId: 'two', sourceMessageId: undefined })
  expect(queue.list()).toHaveLength(3)
})
it('recovers cold sessions and captures live unmounted sessions at turn end', async () => {
  const queue = inbox(); let listener: any
  const events = history('If you want, I can add tests.')
  const ctx = { on: vi.fn((_name, fn) => { listener = fn; return vi.fn() }), logger: { error: vi.fn(), warn: vi.fn() }, sessionPersistence: {
    flush: vi.fn(async () => {}), list: async () => [{ header: { id: 'cold' } }], open: async () => ({
      read: async (offset: number) => ({ events: offset ? [] : events }), [Symbol.asyncDispose]: async () => {} }) } }
  const capture = registerDecisionCapture(ctx as any, () => queue)
  await capture.ready
  await listener({ id: 'unmounted', snapshotEvents: () => events }, events[2])
  expect(queue.list().map(item => item.sessionId).sort()).toEqual(['cold', 'unmounted'])
  expect(ctx.logger.error).not.toHaveBeenCalled()
  capture.dispose()
})
