import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { DeliveryStore, deliveryFingerprint, type DeliveryCreate } from '../src/app/feature-delivery.ts'
import { capturePhaseFence, deliveryPhaseItem, phaseConversation, phaseCurrent } from '../src/app/delivery-phase.ts'
import type { PublicationSnapshot } from '../src/app/publication.ts'

const H = 'a'.repeat(40), B = 'b'.repeat(40), P = 'c'.repeat(64)
function setup() {
  const db = new DatabaseSync(':memory:')
  const store = new DeliveryStore(db)
  db.exec('CREATE TABLE ticket(id TEXT PRIMARY KEY, value TEXT); CREATE TABLE finding(id TEXT PRIMARY KEY, dedup_key TEXT, value TEXT)')
  const ticket = { id: 't1', assignments: [{ id: 'a1', state: 'ended', report: { state: 'ready', summary: 'Committed bounded patch', at: '2026-11-10T00:00:00Z' } }], ended: { by: 'executor', outcome: 'done', at: 'x' } }
  const finding = { id: 'f1', revision: 1, state: 'blocked', reports: [{jobId:'j1',state:'ready',reference:'ticket/t1/report/a1',evidence:'Committed bounded patch',at:'2026-11-10T00:00:00Z'}], job: { id: 'j1', ticketId: 'worker-t1', assignmentId: 'a1' } }
  const put = (t: string, v: { id: string; [k: string]: unknown }) => db.prepare(`INSERT OR REPLACE INTO ${t}(id,value) VALUES(?,?)`).run(v.id, JSON.stringify(v))
  put('ticket', ticket); put('finding', finding)
  const t = store.trackUnbound({ ticketId: 't1', title: 'T', owner: 'o', repository: 'org/p', sourceIssue: 0, triggerId: 'tr' })
  const input: DeliveryCreate = { id: 'auto-t1', title: 'T', owner: 'o', bindings: { repository: 'org/p', sourceIssue: 7, baseSha: B, headSha: H, environment: 'env', refs: [{ repository: 'org/p', pr: 7, headSha: H, baseSha: B }] },
    requirements: ['r'], authorities: ['local-operator'], workers: ['t1'], delegatedActions: ['review', 'fix', 'verify'] }
  const d = store.bindScope('auto-t1', t.revision, input, { actor: 'local-operator', source: 'local_operator', reference: 'r', scope: deliveryFingerprint(input) },
    x => { x.release = { findingId: 'f1', findingRevision: 1, jobId: 'j1', ticketId: 't1', assignmentId: 'a1', branch: 'agent/x', prNumber: 7, headSha: H, patchSha256: P, preparedAt: '' } })
  const pub = { id: 'pub1', ticketId: 't1', conversationId: phaseConversation('auto-t1'), repository: 'org/p', prNumber: 7, headSha: H, patchSha256: P } as unknown as PublicationSnapshot
  store.compareAndSwap('auto-t1', d.revision, x => { x.preparedPublication = { id: 'pub1', ticketId: 't1', decisionId: deliveryPhaseItem(x)!.id, repository: 'org/p', pr: 7, headSha: H, patchSha256: P, environment: 'env', preparedAt: '' } })
  return { db, store, pub, put, ticket, finding }
}

it('ended implementation worker still yields a current typed phase fence', () => {
  const s = setup(); const fence = capturePhaseFence(s.db, s.pub)
  expect(fence).toMatchObject({ kind: 'delivery-phase', deliveryId: 'auto-t1', jobId: 'j1', headSha: H })
  expect(phaseCurrent(s.db, fence, s.pub)).toBe(true)
})
it('fails closed on resolved/superseded finding, new assignment, human end, foreign head or conversation', () => {
  const s = setup(); const fence = capturePhaseFence(s.db, s.pub)
  s.put('finding', { ...s.finding, state: 'resolved' }); expect(phaseCurrent(s.db, fence, s.pub)).toBe(false)
  s.put('finding', { ...s.finding, job: { ...s.finding.job, id: 'j2' } }); expect(phaseCurrent(s.db, fence, s.pub)).toBe(false)
  s.put('finding', s.finding); expect(phaseCurrent(s.db, fence, s.pub)).toBe(true)
  s.put('ticket', { ...s.ticket, assignments: [{ id: 'a1' }, { id: 'a2' }] }); expect(phaseCurrent(s.db, fence, s.pub)).toBe(false)
  s.put('ticket', { ...s.ticket, ended: { by: 'human' } }); expect(phaseCurrent(s.db, fence, s.pub)).toBe(false)
  s.put('ticket', s.ticket)
  expect(phaseCurrent(s.db, fence, { ...s.pub, headSha: 'd'.repeat(40) })).toBe(false)
  expect(phaseCurrent(s.db, fence, { ...s.pub, conversationId: 'delivery:x:decision:delivery-phase:x' })).toBe(false)
  expect(() => capturePhaseFence(s.db, { ...s.pub, id: 'other' })).toThrow()
})

it('root phase: changing target invalidates a captured publication fence',()=>{
 const s=setup(),f=capturePhaseFence(s.db,s.pub),d=s.store.get('auto-t1')!
 s.store.compareAndSwap(d.id,d.revision,x=>{x.bindings.environment='different-target'})
 expect(phaseCurrent(s.db,f,s.pub)).toBe(false)
})
it('root phase: a new blocked report in the same assignment invalidates publication',()=>{
 const s=setup(),f=capturePhaseFence(s.db,s.pub)
 s.put('ticket',{...s.ticket,assignments:[{id:'a1',state:'ended',report:{state:'blocked',summary:'Tests failed',at:'2026-11-10T00:00:00Z'}}]})
 expect(phaseCurrent(s.db,f,s.pub)).toBe(false)
})
it('root phase: a changed source revision invalidates captured confirmation',()=>{
 const s=setup(),f=capturePhaseFence(s.db,s.pub)
 s.put('finding',{...s.finding,revision:2})
 expect(phaseCurrent(s.db,f,s.pub)).toBe(false)
})
it('root phase: removing or replacing the prepared publication invalidates the worker',()=>{
 const s=setup(),f=capturePhaseFence(s.db,s.pub),d=s.store.get('auto-t1')!
 s.store.compareAndSwap(d.id,d.revision,x=>{delete x.preparedPublication})
 expect(phaseCurrent(s.db,f,s.pub)).toBe(false)
})
