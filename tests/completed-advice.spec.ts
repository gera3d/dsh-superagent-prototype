import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DecisionInbox } from '../src/app/decision-inbox.ts'
import { DeliveryStore } from '../src/app/feature-delivery.ts'
import { reconcileInboxCurrency } from '../src/app/delivery-runtime.ts'
import { adviceContext } from '../src/app/advice-context.ts'

const dbs: DatabaseSync[] = []
afterEach(() => dbs.splice(0).forEach(db => db.close()))
const options = [{ id: 'accept', label: 'Hand off for acceptance', prompt: 'Hand off to the release operator for native acceptance.', why: 'Finish release', recommended: true }, { id: 'check', label: 'Check deployed source', prompt: 'Check deployed source pins.', why: 'Check release', recommended: false }]
function fixture() {
  const db = new DatabaseSync(':memory:'); dbs.push(db)
  const inbox = new DecisionInbox(db), deliveries = new DeliveryStore(db)
  const create = (id = 'feature', worker = 'ticket') => deliveries.create({ id, title: id, owner: 'release operator', authorities: ['local-operator'], workers: [worker], requirements: ['native UI'], bindings: { repository: 'org/repo', sourceIssue: 1, baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), environment: 'test' } })
  create()
  const accept = () => {
    let d = deliveries.get('feature')!
    d = deliveries.compareAndSwap(d.id, d.revision, value => { value.state = 'awaiting_decision'; value.stage = 'verifying'; value.evidence = [
      { id: 'published', kind: 'publication', bindings: value.bindings, recordedAt: new Date().toISOString(), reference: 'test:published', outcome: 'passed' },
      { id: 'native', kind: 'verification', bindings: value.bindings, recordedAt: new Date().toISOString(), reference: 'test:native', outcome: 'passed', requirements: value.requirements },
    ] })
    expect(d.nextAction!.kind).toBe('accept')
    return deliveries.confirm(d.id, { revision: d.revision, actionId: d.nextAction!.id }, { actor: 'local-operator', source: 'local_operator', reference: 'test:actual-acceptance', scope: d.nextAction!.fingerprint })
  }
  const advice = (time = Date.now() - 10000, sessionId = 'worker-ticket', message = 'finished') => {
    const source = { sessionId, sourceMessageId: message, sourceTurn: 1, sourceSeq: 2, draftRevision: `rev-${message}` }
    const events = [
      { type: 'user/message', seq: 0, time: time - 2, data: { id: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Finish this release.' }] } },
      { type: 'turn/start', seq: 1, time: time - 1, data: { turn: 1 } },
      { type: 'assistant/message', seq: 2, time, data: { turn: 1, message: { id: message, content: [{ type: 'text', text: 'Ready for review; hand off for acceptance.' }] } } },
      { type: 'turn/end', seq: 3, time: time + 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]
    const claim = inbox.claimCanonical({ ...source, owner: 'helper' }, events)
    const write = { ...source, leaseToken: claim.leaseToken! }
    const item = inbox.publishCanonical({ ...write, model: 'actual-helper', options }, events).item
    return { source, events, write, item }
  }
  return { db, inbox, deliveries, create, accept, advice }
}
it('retires tailored pre-acceptance recommendations and prevents claim, refresh, publication, scoring and staging replay', () => {
  const f = fixture(), a = f.advice()
  const accepted = f.accept(), before = JSON.stringify(accepted)
  reconcileInboxCurrency(f.inbox, f.deliveries)
  const retired = f.inbox.get(a.item.id)!
  expect(retired.status).toBe('stale'); expect(retired.invalidation?.reason).toContain('No further release action')
  expect(retired.choices).toEqual(a.item.choices); expect(retired.recommendation).toEqual(a.item.recommendation)
  expect(() => f.inbox.claimCanonical({ ...a.source, owner: 'refresh' }, a.events)).toThrow('stale')
  expect(() => f.inbox.publishCanonical({ ...a.write, model: 'helper', options }, a.events)).toThrow('stale')
  expect(() => f.inbox.scoreCanonical({ ...a.write, evaluation: a.item.recommendation }, a.events)).toThrow('stale')
  expect(() => f.inbox.stage(a.item.id, { choiceId: 'accept', attemptId: 'attempt', draftText: options[0]!.prompt })).toThrow('stale')
  const once = JSON.stringify(retired); reconcileInboxCurrency(f.inbox, f.deliveries)
  expect(JSON.stringify(f.inbox.get(a.item.id))).toBe(once)
  expect(JSON.stringify(f.deliveries.get(accepted.id))).toBe(before)
})
it('preserves a staged draft and its source/proof while retiring its now-obsolete recommendation', () => {
  const f = fixture(), a = f.advice()
  const staged = f.inbox.stage(a.item.id, { choiceId: 'accept', attemptId: '123e4567-e89b-42d3-a456-426614174001', draftText: options[0]!.prompt }).item
  f.accept(); reconcileInboxCurrency(f.inbox, f.deliveries)
  expect(f.inbox.get(a.item.id)).toMatchObject({ status: 'stale', staging: staged.staging, sourceMessageId: a.source.sourceMessageId, choices: a.item.choices })
  expect(f.inbox.get(a.item.id)?.resolutionBasis).toBeUndefined()
})
it('retires an old source first claimed after acceptance, without needing a new worker conversation turn', () => {
  const f = fixture(); f.accept(); const a = f.advice()
  reconcileInboxCurrency(f.inbox, f.deliveries)
  expect(f.inbox.get(a.item.id)?.status).toBe('stale')
})
it('preserves genuinely later conversations and unrelated sessions', () => {
  const f = fixture(), accepted = f.accept()
  const later = f.advice(Date.parse(accepted.acceptance!.at) + 1000, 'worker-ticket', 'later-user-question')
  const unrelated = f.advice(Date.now() - 10000, 'worker-someone-else', 'unrelated')
  reconcileInboxCurrency(f.inbox, f.deliveries)
  expect(f.inbox.get(later.item.id)?.status).toBe('pending')
  expect(f.inbox.get(unrelated.item.id)?.status).toBe('pending')
})
it('does not confuse worker completion, review, publication or pending acceptance with accepted work', () => {
  const f = fixture(), a = f.advice()
  f.deliveries.compareAndSwap('feature', 1, d => { d.stage = 'verifying'; d.state = 'awaiting_decision' })
  reconcileInboxCurrency(f.inbox, f.deliveries)
  expect(f.inbox.get(a.item.id)?.status).toBe('pending')
})
it('does not let an older accepted scope suppress a newly active delivery in the same worker conversation', () => {
  const f = fixture(), a = f.advice(); f.accept(); f.create('new-feature')
  reconcileInboxCurrency(f.inbox, f.deliveries)
  expect(f.inbox.get(a.item.id)?.status).toBe('pending')
})
it('gives drafting and ranking explicit authoritative completion instead of another release handoff', () => {
  const f = fixture(), d = f.accept(), context = adviceContext(undefined, d)
  expect(context).toContain('RELEASE COMPLETE:')
  expect(context).toContain('"noFurtherReleaseAction":true')
  expect(context).toContain(d.acceptance!.at)
  expect(context).not.toContain('RELEASE OBJECTIVE:')
  expect(context).not.toContain('recommend handing the prepared publication')
  expect(context).toContain('"offeredAction":null')
  expect(adviceContext(undefined, { ...d, acceptance: undefined })).not.toContain('RELEASE COMPLETE:')
})
