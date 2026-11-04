import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DecisionInbox, draftFingerprint, submitDecision, stageDecision } from '../src/app/decision-inbox.ts'

const databases: DatabaseSync[] = [], directories: string[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true }) })
const text = 'Existing user draft\n\nTest first'
function source(): SessionEvent[] { return [
  { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
  { type: 'assistant/message', seq: 1, time: 101, data: { turn: 1, step: 1, message: { id: 'source-message', role: 'assistant', content: [{ type: 'text', text: 'Which approach?\nA) Test first\nB) Review first' }] }, stream: [] } },
  { type: 'turn/end', seq: 2, time: 102, data: { turn: 1, reason: { kind: 'completed' } } },
] as unknown as SessionEvent[] }
function human(rpcId: string | undefined, value = text, seq = 3, kind = 'user'): SessionEvent { return { type: 'user/message', seq, time: 1000 + seq, data: { id: `native-message-${seq}`, role: 'user', source: { kind, ...(rpcId ? { rpcId } : {}) }, content: [{ type: 'text', text: value }] } } as unknown as SessionEvent }
function end(seq = 4): SessionEvent { return { type: 'turn/end', seq, time: 1000 + seq, data: { turn: 2, reason: { kind: 'completed' } } } as unknown as SessionEvent }
function open(path = ':memory:') { const db = new DatabaseSync(path); databases.push(db); const inbox = new DecisionInbox(db); inbox.capture('session', source()); return { db, inbox, item: inbox.list()[0]!, attemptId: randomUUID() } }
function staged(path?: string) { const value = open(path); value.inbox.stage(value.item.id, { attemptId: value.attemptId, choiceId: 'option-a', draftText: text }); return value }
function bind(value: ReturnType<typeof staged>, submissionId = 'native-request-1', events: SessionEvent[] = source(), retryOf?: string) { return value.inbox.bindSubmission(value.item.id, { attemptId: value.attemptId, submissionId, ...(retryOf ? { retryOf } : {}) }, events) }

it('stages pending, fingerprints full serialized text without persisting user plaintext, and blocks legacy fake resolve', () => {
  const { inbox, item, attemptId, db } = open()
  const result = inbox.stage(item.id, { choiceId: 'option-a', attemptId, draftText: text })
  expect(result).toMatchObject({ execution: 'not_executed', item: { status: 'pending' }, staging: { attemptId, choiceId: 'option-a', draftFingerprint: draftFingerprint(text) } })
  expect(result.item.resolvedChoice).toBeUndefined()
  expect(db.prepare('SELECT value FROM decision_inbox').get()?.value).not.toContain('Existing user draft')
  expect(inbox.stage(item.id, { choiceId: 'option-a', attemptId, draftText: text })).toEqual(result)
  expect(() => inbox.resolve(item.id, 'option-a')).toThrow('Linked native submission required')
  expect(draftFingerprint(text)).not.toBe(draftFingerprint(text + ' '))
})
it('bind-before-event waits for an actual native admission and resolves only its exact requestId/fulltext', () => {
  const value = staged(); expect(bind(value).item.status).toBe('pending')
  expect(value.inbox.get(value.item.id)?.resolvedAt).toBeUndefined()
  value.inbox.capture('session', [...source(), human('native-request-1')])
  const resolved = value.inbox.get(value.item.id)!
  expect(resolved).toMatchObject({ status: 'resolved', resolvedChoice: 'option-a', resolutionBasis: 'submitted', submissionId: 'native-request-1', submittedMessageId: 'native-message-3', submittedSeq: 3, resolvedAt: 1003 })
  expect(resolved.draftResponse).toBeUndefined()
  expect(value.inbox.resolve(value.item.id, 'option-a').item).toEqual(resolved)
  expect(() => value.inbox.resolve(value.item.id, 'option-b')).toThrow('already resolved')
})
it('event-before-bind remains a pending candidate across turn/end, then confirms the explicit link idempotently', () => {
  const value = staged(), events = [...source(), human('native-request-1'), end()]
  value.inbox.capture('session', events)
  expect(value.inbox.get(value.item.id)).toMatchObject({ status: 'pending', staging: { candidateSubmission: { submissionId: 'native-request-1' } } })
  const first = bind(value, 'native-request-1', events)
  expect(first.item).toMatchObject({ status: 'resolved', resolutionBasis: 'submitted', submissionId: 'native-request-1' })
  expect(bind(value, 'native-request-1', events)).toEqual(first)
})
it('never resolves equal text with the wrong native requestId, even when a different binding exists', () => {
  const value = staged(); bind(value)
  value.inbox.capture('session', [...source(), human('different-native-request'), end()])
  expect(value.inbox.get(value.item.id)).toMatchObject({ status: 'pending', staging: { submissionId: 'native-request-1', candidateSubmission: { submissionId: 'different-native-request' } } })
  expect(value.inbox.get(value.item.id)?.resolvedChoice).toBeUndefined()
  expect(() => bind(value, 'different-native-request')).toThrow('retryOf')
})
it.each([
  ['same rpc with changed fulltext', () => human('native-request-1', text + ' edited')],
  ['same text without a native rpcId', () => human(undefined)],
])('rejects %s as proof and invalidates the pending source', (_label, event) => {
  const value = staged(); bind(value)
  value.inbox.capture('session', [...source(), event()])
  expect(value.inbox.get(value.item.id)).toMatchObject({ status: 'stale' })
  expect(value.inbox.get(value.item.id)?.resolvedChoice).toBeUndefined()
})
it('does not accept custom user-rpc sources or another session as native proof', () => {
  const value = staged(); bind(value)
  value.inbox.capture('other-session', [...source(), human('native-request-1')])
  value.inbox.capture('session', [...source(), human('native-request-1', text, 3, 'user-rpc')])
  expect(value.inbox.get(value.item.id)?.status).toBe('pending')
})
it('does not accept a wrong source history or choice and rejects conflicting active attempts/content', () => {
  const value = staged()
  expect(() => value.inbox.stage(value.item.id, { attemptId: randomUUID(), choiceId: 'option-b', draftText: text })).toThrow('conflicting')
  expect(() => value.inbox.stage(value.item.id, { attemptId: value.attemptId, choiceId: 'option-a', draftText: text + 'changed' })).toThrow('conflicting')
  expect(() => value.inbox.stage(value.item.id, { attemptId: value.attemptId, choiceId: 'missing', draftText: text })).toThrow('Unknown')
  expect(() => value.inbox.bindSubmission(value.item.id, { attemptId: value.attemptId, submissionId: 'native-request-1' }, [])).toThrow('source history')
  expect(() => value.inbox.bindSubmission(value.item.id, { attemptId: randomUUID(), submissionId: 'native-request-1' }, source())).toThrow('attempt')
})
it('unrelated human after an unbound candidate makes it stale and prevents late binding resurrection', () => {
  const value = staged(); const events = [...source(), human('native-request-1'), end(), human('unrelated', 'A different user request', 5)]
  value.inbox.capture('session', events)
  expect(value.inbox.get(value.item.id)?.status).toBe('stale')
  expect(() => bind(value, 'native-request-1', events)).toThrow('stale or closed')
})
it('pending obsolete decisions become stale, but confirmed resolution survives later obsolescence with a marker', () => {
  const pending = staged(); pending.inbox.capture('session', [...source(), end()])
  expect(pending.inbox.get(pending.item.id)?.status).toBe('stale')
  const value = staged(); bind(value)
  const admitted = [...source(), human('native-request-1')]; value.inbox.capture('session', admitted)
  const confirmed = value.inbox.get(value.item.id)!
  value.inbox.capture('session', [...admitted, human('later', 'Another request', 4)])
  expect(value.inbox.get(value.item.id)).toMatchObject({ status: 'resolved', resolvedChoice: confirmed.resolvedChoice, resolvedAt: confirmed.resolvedAt, submissionId: confirmed.submissionId, invalidation: { sourceSeq: 4 } })
})
it('discard removes only the matching staging linkage, never draftResponse or composer content', () => {
  const value = staged(); expect(() => value.inbox.discardStaging(value.item.id, randomUUID())).toThrow('attempt')
  const before = value.inbox.get(value.item.id)!
  const result = value.inbox.discardStaging(value.item.id, value.attemptId)
  expect(result.item).toEqual({ ...Object.fromEntries(Object.entries(before).filter(([key]) => key !== 'staging')), resolutionRevision: before.resolutionRevision! + 1 })
  expect(result.item.status).toBe('pending')
  expect(value.inbox.discardStaging(value.item.id, value.attemptId)).toEqual(result)
  value.inbox.capture('session', [...source(), human('native-request-1')])
  expect(value.inbox.get(value.item.id)?.status).toBe('stale')
})
it('supports explicit CAS native retries and confirms the actual old late acceptance without duplicate resolution', () => {
  const value = staged(); bind(value, 'first')
  expect(() => bind(value, 'second')).toThrow('retryOf')
  expect(bind(value, 'second', source(), 'first').staging).toMatchObject({ submissionId: 'second', submissionIds: ['first', 'second'] })
  expect(() => bind(value, 'third', source(), 'first')).toThrow('retryOf')
  value.inbox.capture('session', [...source(), human('first')])
  expect(value.inbox.get(value.item.id)).toMatchObject({ status: 'resolved', submissionId: 'first', resolvedChoice: 'option-a' })
  expect(bind(value, 'second').item.submissionId).toBe('first')
})
it('actual SQLite close/reopen recovers bound and unbound admission candidates without resurrecting choices', () => {
  for (const bound of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), 'decision-send-')); directories.push(dir); const path = join(dir, 'state.sqlite')
    const first = staged(path), events = [...source(), human('native-request-1'), end()]
    if (bound) bind(first)
    else first.inbox.capture('session', events)
    databases.pop()!.close()
    const reopened = open(path)
    reopened.inbox.capture('session', events)
    if (!bound) {
      expect(reopened.inbox.get(first.item.id)?.status).toBe('pending')
      reopened.inbox.bindSubmission(first.item.id, { attemptId: first.attemptId, submissionId: 'native-request-1' }, events)
    }
    const saved = reopened.inbox.get(first.item.id)!
    expect(saved).toMatchObject({ status: 'resolved', resolutionBasis: 'submitted', submissionId: 'native-request-1' })
    reopened.inbox.capture('session', events)
    expect(reopened.inbox.get(first.item.id)).toEqual(saved)
    expect(reopened.inbox.list().filter(item => item.sourceMessageId === 'source-message')).toHaveLength(1)
  }
})
it('two connections cannot overwrite an active staging attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-cas-')); directories.push(dir); const path = join(dir, 'state.sqlite')
  const one = open(path), two = open(path)
  const results = await Promise.allSettled([one, two].map(value => Promise.resolve().then(() => value.inbox.stage(value.item.id, { attemptId: value.attemptId, choiceId: 'option-a', draftText: text }))))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  expect(one.inbox.get(one.item.id)?.staging).toEqual(two.inbox.get(two.item.id)?.staging)
})
it('failed/no-event submissions remain pending and full durable pagination is used before binding', async () => {
  const value = staged(), offsets: number[] = []
  const ctx = { sessionPersistence: { flush: async () => {}, open: async (id: string, mode: string) => {
    expect(id).toBe('session'); expect(mode).toBe('read')
    return { read: async (offset: number) => { offsets.push(offset); return { events: offset ? [] : source() } }, [Symbol.asyncDispose]: async () => {} }
  } } }
  expect((await submitDecision(ctx as any, value.inbox, value.item.id, { attemptId: value.attemptId, submissionId: 'queued-only' })).item.status).toBe('pending')
  expect(offsets).toEqual([0, 3])
  expect(value.inbox.get(value.item.id)?.resolvedChoice).toBeUndefined()
})
it('keeps old stage-resolved history intact and never upgrades it into submitted proof', () => {
  const value = open(); const legacy = { ...value.item, id: 'legacy', sourceMessageId: 'legacy-source', status: 'resolved' as const, resolvedChoice: 'option-a', resolvedAt: 500, draftResponse: 'Historical draft' }
  value.inbox.put(legacy)
  expect(() => value.inbox.resolve('legacy', 'option-a')).toThrow('Linked native submission required')
  expect(value.inbox.get('legacy')).toEqual({ ...legacy, actionMode: 'stage_response' })
})
it('advisor publication preserves an identical staged choice set and rejects changed choices atomically', () => {
  const value = open()
  const input = { sessionId: 'session', sourceMessageId: 'source-message', sourceSeq: 1, sourceTurn: 1, key: '2', question: 'Which?', context: '', model: 'configured/model', createdAt: 102,
    options: [{ id: 'option-a', label: 'Test first', prompt: 'Run all tests.', why: 'Verify.', recommended: true }, { id: 'option-b', label: 'Review first', prompt: 'Review everything.', why: 'Inspect.', recommended: false }] }
  value.inbox.publishAdvisor(input)
  const staging = value.inbox.stage(value.item.id, { attemptId: value.attemptId, choiceId: 'option-a', draftText: 'Existing user draft\n\nRun all tests.' }).staging
  expect(value.inbox.publishAdvisor(input).staging).toEqual(staging)
  expect(() => value.inbox.publishAdvisor({ ...input, options: input.options.map(option => ({ ...option, prompt: option.prompt + ' Changed.' })) })).toThrow('while a draft is staged')
  expect(value.inbox.get(value.item.id)?.staging).toEqual(staging)
  const altered = value.inbox.get(value.item.id)!
  altered.choices[0]!.prompt = 'External corrupted choice'
  altered.resolutionRevision = altered.resolutionRevision! + 1
  value.db.prepare('UPDATE decision_inbox SET value=? WHERE id=?').run(JSON.stringify(altered), altered.id)
  expect(() => bind(value)).toThrow('invalidated')
  expect(value.inbox.get(value.item.id)?.status).toBe('stale')
})
it('an explicit retry whose native event arrives before its link remains pending until retryOf is bound', () => {
  const value = staged(); bind(value, 'failed-first')
  const events = [...source(), human('explicit-retry'), end()]
  value.inbox.capture('session', events)
  expect(value.inbox.get(value.item.id)?.status).toBe('pending')
  expect(bind(value, 'explicit-retry', events, 'failed-first').item).toMatchObject({ status: 'resolved', submissionId: 'explicit-retry' })
})
it('replays a lost first binding before linking an actually admitted explicit native retry', () => {
  const value = staged(), events = [...source(), human('second-native-id'), end()]
  value.inbox.capture('session', events)
  expect(bind(value, 'first-native-id', events).item.status).toBe('pending')
  expect(bind(value, 'second-native-id', events, 'first-native-id').item).toMatchObject({ status: 'resolved', submissionId: 'second-native-id' })
})
it('rejects a selected canonical prompt changed between the client read and stage', () => {
  const value = open(), changed = { ...value.item, choices: value.item.choices.map(choice => ({ ...choice, prompt: 'A new complete continuation.' })) }
  value.db.prepare('UPDATE decision_inbox SET value=? WHERE id=?').run(JSON.stringify(changed), changed.id)
  expect(() => value.inbox.stage(changed.id, { attemptId: value.attemptId, choiceId: 'option-a', draftText: text })).toThrow('prompt changed')
  expect(value.inbox.get(changed.id)?.staging).toBeUndefined()
})
it('guards staged rows against old same-DB UPSERT capture/resolve writers and reconciles even past old cursors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-legacy-writer-')); directories.push(dir); const path = join(dir, 'state.sqlite')
  const value = staged(path), old = new DatabaseSync(path); databases.push(old)
  const upsert = old.prepare('INSERT INTO decision_inbox(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
  const pending = value.inbox.get(value.item.id)!
  expect(pending.resolutionPolicy).toBe('on_send')
  old.exec('SAVEPOINT old_capture')
  expect(() => upsert.run(pending.id, JSON.stringify({ ...pending, status: 'stale', staleReason: 'Old human capture' }))).toThrow(/revision|proof-aware invalidation/)
  old.exec('ROLLBACK TO old_capture; RELEASE old_capture')
  expect(() => upsert.run(pending.id, JSON.stringify({ ...pending, status: 'resolved', resolvedChoice: 'option-a', resolvedAt: Date.now() }))).toThrow('proof required')
  const withoutPolicy = { ...pending, resolutionRevision: pending.resolutionRevision! + 1 }; delete withoutPolicy.resolutionPolicy
  expect(() => upsert.run(pending.id, JSON.stringify(withoutPolicy))).toThrow('policy cannot be removed')
  expect(value.inbox.get(pending.id)).toEqual(pending)
  const lostStaging = { ...pending }; delete lostStaging.staging
  expect(() => upsert.run(pending.id, JSON.stringify(lostStaging))).toThrow('revision')
  bind(value)
  expect(() => upsert.run(pending.id, JSON.stringify(pending))).toThrow('revision')
  expect(value.inbox.get(pending.id)?.staging?.submissionId).toBe('native-request-1')
  old.prepare('UPDATE decision_inbox_cursor SET seq=? WHERE session=?').run(999, 'session')
  value.inbox.capture('session', [...source(), human('native-request-1')])
  expect(value.inbox.get(pending.id)).toMatchObject({ status: 'resolved', resolutionBasis: 'submitted', submissionId: 'native-request-1' })
  value.inbox.capture('session', [...source(), human('native-request-1'), human('later', 'Unrelated request', 4)])
  const resolved = value.inbox.get(pending.id)!
  expect(resolved).toMatchObject({ status: 'resolved', resolvedChoice: 'option-a', invalidation: { sourceSeq: 4 } })
  expect(() => upsert.run(pending.id, JSON.stringify({ ...resolved, resolutionRevision: resolved.resolutionRevision! + 1, status: 'stale' }))).toThrow('history cannot be erased')
  expect(value.inbox.list()).toHaveLength(1)
})
it('persists native binding before a blocked history flush and does not lose accepted proof to a later human', async () => {
  const value = staged(); let release!: () => void
  const flush = new Promise<void>(resolve => { release = resolve })
  let events = source()
  const ctx = { sessionPersistence: { flush: () => flush, open: async () => ({ read: async (offset: number) => ({ events: offset ? [] : events }), [Symbol.asyncDispose]: async () => {} }) } }
  const pending = submitDecision(ctx as any, value.inbox, value.item.id, { attemptId: value.attemptId, submissionId: 'native-request-1' })
  expect(value.inbox.get(value.item.id)).toMatchObject({ status: 'pending', staging: { submissionId: 'native-request-1' } })
  events = [...source(), human('native-request-1'), human('later', 'Unrelated next request', 4)]
  value.inbox.capture('session', events)
  expect(value.inbox.get(value.item.id)).toMatchObject({ status: 'resolved', resolutionBasis: 'submitted', submissionId: 'native-request-1', invalidation: { sourceSeq: 4 } })
  release()
  expect((await pending).item).toEqual(value.inbox.get(value.item.id))
})
it('revalidates durable source history before staging when live capture has not yet seen a newer human', async () => {
  const value = open(); let release!: () => void
  const flush = new Promise<void>(resolve => { release = resolve })
  const events = [...source(), human('unrelated', 'A different request')]
  const ctx = { sessionPersistence: { flush: () => flush, open: async () => ({ read: async (offset: number) => ({ events: offset ? [] : events }), [Symbol.asyncDispose]: async () => {} }) } }
  const request = stageDecision(ctx as any, value.inbox, value.item.id, { attemptId: value.attemptId, choiceId: 'option-a', draftText: text })
  expect(value.inbox.get(value.item.id)?.staging).toBeUndefined()
  release()
  await expect(request).rejects.toThrow('stale or closed')
  expect(value.inbox.get(value.item.id)).toMatchObject({ status: 'stale' })
  expect(value.inbox.get(value.item.id)?.staging).toBeUndefined()
})
it('rejects an old source replaced by a newer completed assistant message in the same turn', async () => {
  const value = open()
  const events = [...source(), { type: 'assistant/message', seq: 3, time: 103, data: { turn: 1, message: { id: 'replacement-source', role: 'assistant', content: [{ type: 'text', text: 'Which newer option?' }] } } }, { type: 'turn/end', seq: 4, time: 104, data: { turn: 1, reason: { kind: 'completed' } } }] as unknown as SessionEvent[]
  const ctx = { sessionPersistence: { flush: async () => {}, open: async () => ({ read: async (offset: number) => ({ events: offset ? [] : events }), [Symbol.asyncDispose]: async () => {} }) } }
  await expect(stageDecision(ctx as any, value.inbox, value.item.id, { attemptId: value.attemptId, choiceId: 'option-a', draftText: text })).rejects.toThrow('current completed assistant response')
  expect(value.inbox.get(value.item.id)?.staging).toBeUndefined()
})
it('infers an omitted optional sourceTurn from the exact native source message', () => {
  const value = open(), item = { ...value.item }; delete item.sourceTurn
  value.db.prepare('UPDATE decision_inbox SET value=? WHERE id=?').run(JSON.stringify(item), item.id)
  value.inbox.stage(item.id, { attemptId: value.attemptId, choiceId: 'option-a', draftText: text })
  expect(bind(value).item.status).toBe('pending')
  value.inbox.capture('session', [...source(), human('native-request-1')])
  expect(value.inbox.get(item.id)?.status).toBe('resolved')
})
it('blocks legacy unproved resolution of every pending row, even before explicit native staging', () => {
  const value = open(), pending = value.inbox.get(value.item.id)!
  expect(pending.resolutionPolicy).toBeUndefined()
  expect(() => value.db.prepare('INSERT INTO decision_inbox(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(pending.id, JSON.stringify({ ...pending, status: 'resolved', resolvedChoice: 'option-a', resolvedAt: 500 }))).toThrow('Linked native submission proof required')
  expect(value.inbox.get(pending.id)).toEqual(pending)
})
