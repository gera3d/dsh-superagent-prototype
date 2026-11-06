import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deliveryFingerprint, sameDeliveryRefs, DeliveryConflict, DeliveryCoordinator, DeliveryStore, type Delivery, type DeliveryCreate, type DeliveryLease, type DeliveryActionKind, type DeliveryBindings, type DeliveryEvidence } from '../src/app/feature-delivery.ts'

let directory: string
let stores: DeliveryStore[]
const bindings: DeliveryBindings = { repository: 'org/repo', sourceIssue: 159, baseSha: 'base', headSha: 'head', artifact: 'sha256:artifact', environment: 'production' }
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'delivery-store-')); stores = [] })
afterEach(() => { for (const s of stores) s.close(); rmSync(directory, { recursive: true, force: true }) })
function open() { const s = new DeliveryStore(join(directory, 'delivery.sqlite')); stores.push(s); return s }
function create(s: DeliveryStore) { return s.create({ id: 'feature', title: 'Feature', owner: 'alice', authorities: ['alice'], bindings, requirements: ['behavior', 'live'], workers: ['ended-1', 'ended-2'] }) }
function evidence(kind: DeliveryEvidence['kind'], outcome: DeliveryEvidence['outcome'] = 'passed', requirements?: string[]): DeliveryEvidence {
  return { id: `${kind}-${outcome}`, kind, outcome, bindings, recordedAt: '2026-11-06T00:00:00Z', reference: `https://evidence.test/${kind}`, requirements }
}
function confirm(s: DeliveryStore, kind?: DeliveryActionKind) {
  const d = s.get('feature')!; expect(d.nextAction).toBeDefined()
  if (kind) expect(d.nextAction!.kind).toBe(kind)
  return s.confirm(d.id, { revision: d.revision, actionId: d.nextAction!.id }, 'alice')
}
function finish(s: DeliveryStore, kind: DeliveryActionKind, e: DeliveryEvidence, outcome: 'passed' | 'failed' = 'passed') {
  confirm(s, kind); const lease = s.claim('worker')!; return s.complete(lease, { outcome, evidence: [e] })
}
function verifying(s: DeliveryStore) {
  create(s); finish(s, 'implement', evidence('implementation')); finish(s, 'review', evidence('review')); return finish(s, 'publish', evidence('publication'))
}

it('tracks a new accepted ticket durably with honest unknown scope and no invented authority', () => {
  let s = open()
  const input = { ticketId: 'new-ticket', title: 'New job', owner: 'requester', repository: 'org/repo', triggerId: 'actual-trigger' }
  const d = s.trackUnbound(input)
  expect(d.id).toBe('auto-new-ticket')
  expect(d.bindings).toEqual({ repository: 'org/repo', sourceIssue: 0, baseSha: '', headSha: '', refs: [] })
  expect(d.scopeBinding!.sourceTriggerId).toBe('actual-trigger')
  expect(d.requirements).toEqual(['intake:acceptance-requirements-unconfirmed'])
  expect(d.authorities).toEqual([]); expect(d.delegatedActions).toEqual([]); expect(d.delegatedScope).toBeUndefined()
  expect(d.state).toBe('blocked'); expect(d.nextAction).toBeUndefined(); expect(s.claim('runner')).toBeUndefined()
  expect(s.trackUnbound(input)).toEqual(d)
  stores.pop()!.close(); s = open()
  expect(s.trackUnbound(input)).toEqual(d)
  const working = s.compareAndSwap(d.id, d.revision, value => { value.state = 'running' })
  expect(working.state).toBe('running'); expect(working.nextAction).toBeUndefined()
  const ready = s.compareAndSwap(d.id, working.revision, value => { value.state = 'blocked'; value.stage = 'review' })
  expect(ready.scopeBinding).toEqual(d.scopeBinding); expect(ready.nextAction).toBeUndefined()
})

it('unbound scope cannot become accepted or actionable even through fabricated completion evidence', () => {
  const s = open(); const d = s.trackUnbound({ ticketId: 'job', title: 'Unbound', owner: 'requester', repository: 'org/repo', triggerId: 'trigger' })
  const forged = s.compareAndSwap(d.id, d.revision, value => {
    value.evidence.push({ ...evidence('publication'), bindings: d.bindings }, { ...evidence('verification', 'passed', d.requirements), bindings: d.bindings })
    value.stage = 'verifying'; value.state = 'awaiting_decision'; delete value.blocker
  })
  expect(forged.nextAction).toBeUndefined()
  expect(() => s.confirm(d.id, { revision: forged.revision, actionId: 'forged-accept' }, 'requester')).toThrow('ineligible')
  expect(() => s.compareAndSwap(d.id, forged.revision, value => { value.state = 'accepted'; value.stage = 'accepted'; value.acceptance = { actor: 'requester', at: 'now', evidenceIds: value.evidence.map(e => e.id), fingerprint: deliveryFingerprint({ bindings: value.bindings, evidence: value.evidence, requirements: value.requirements }) } })).toThrow('Acceptance lacks')
  expect(() => s.compareAndSwap(d.id, forged.revision, value => { delete value.scopeBinding })).toThrow('Immutable intake')
  expect(() => s.recordImplementation(d.id, forged.revision, { ...evidence('implementation'), bindings: d.bindings })).toThrow('not eligible')
  expect(s.claim('runner')).toBeUndefined()
})

it('binds unknown scope only through exact explicit local operator intake and preserves worker provenance', () => {
  const s = open(); const original = { ticketId: 'new-job', title: 'Unbound', owner: 'requester', repository: 'org/repo', triggerId: 'trigger' }
  const d = s.trackUnbound(original)
  const working = s.compareAndSwap(d.id, d.revision, value => { value.state = 'running' })
  const input: DeliveryCreate = { id: d.id, title: 'Explicit feature scope', owner: 'alice', bindings, requirements: ['behavior', 'live'], authorities: ['alice'], workers: ['other-original-worker'], delegatedActions: ['review', 'fix'], maxReview: 2 }
  const proof = { actor: 'alice', source: 'local_operator' as const, reference: 'trusted-request:scope-bind', scope: deliveryFingerprint(input) }
  expect(() => s.bindScope(d.id, working.revision, input, { ...proof, scope: 'wrong' })).toThrow('exact reviewed')
  expect(() => s.bindScope(d.id, working.revision, input, { ...proof, source: 'github' })).toThrow('local operator')
  const bound = s.bindScope(d.id, working.revision, input, proof)
  expect(bound.scopeBinding).toBeUndefined(); expect(bound.blocker).toBeUndefined(); expect(bound.state).toBe('awaiting_decision')
  expect(bound.bindings).toEqual(bindings); expect(bound.requirements).toEqual(['behavior', 'live']); expect(bound.authorities).toEqual(['alice'])
  expect(bound.workers).toEqual(['new-job', 'other-original-worker']); expect(bound.audit[0]).toEqual(d.audit[0])
  expect(bound.audit.at(-1)!.event).toContain('scope-bound:local_operator:trusted-request:scope-bind')
  expect(bound.attempts.maxReview).toBe(2); expect(bound.nextAction!.kind).toBe('implement')
  expect(s.trackUnbound(original)).toEqual(bound)
  expect(() => s.bindScope(d.id, bound.revision, input, proof)).toThrow('already bound')
  const reviewed = s.recordImplementation(d.id, bound.revision, evidence('implementation'))
  expect(reviewed.stage).toBe('review'); expect(reviewed.acceptance).toBeUndefined()
})

it('never upgrades unknown scope through normal creation, guessed requirements, or a different source issue', () => {
  const s = open(); const d = s.trackUnbound({ ticketId: 'job', title: 'Unbound', owner: 'requester', repository: 'org/repo', sourceIssue: 159, triggerId: 'trigger' })
  expect(() => s.compareAndSwap(d.id, d.revision, value => { value.bindings.headSha = 'guessed-head' })).toThrow('Immutable')
  const input: DeliveryCreate = { id: d.id, title: 'Bound', owner: 'alice', bindings: { ...bindings, sourceIssue: 160 }, requirements: ['behavior'], authorities: ['alice'] }
  expect(() => s.bindScope(d.id, d.revision, input, { actor: 'alice', source: 'local_operator', reference: 'request', scope: deliveryFingerprint(input) })).toThrow('differs from original')
  expect(() => s.create({ ...input, id: 'invented', requirements: ['intake:acceptance-requirements-unconfirmed'] })).toThrow('Invalid delivery intake')
  expect(() => s.create({ ...input, id: 'invented', scopeBinding: d.scopeBinding, bindings: { ...d.bindings }, requirements: d.requirements })).toThrow('Invalid unbound')
  expect(s.list()).toHaveLength(1)
})

it('persists intake, confirms once only, restarts and delivers transactional handoff', () => {
  let s = open(); const initial = create(s)
  expect(create(s)).toEqual(initial)
  const request = { revision: initial.revision, actionId: initial.nextAction!.id }
  expect(() => s.confirm('feature', request, 'mallory')).toThrow('Authority')
  s.confirm('feature', request, 'alice')
  expect(() => s.confirm('feature', request, 'alice')).toThrow(DeliveryConflict)
  stores.pop()!.close(); s = open()
  expect(s.get('feature')!.state).toBe('running')
  const lease = s.claim('worker')!
  expect(lease.reconcile).toBe(false)
  s.complete(lease, { outcome: 'passed', evidence: [evidence('implementation')] })
  expect(s.claim('worker')).toBeUndefined()
  expect(s.get('feature')!.nextAction!.kind).toBe('review')
})

it('shares runtime SQLite transactions without closing the borrowed connection', () => {
  const owner = open(); const borrowed = new DeliveryStore(owner.db)
  owner.db.exec('BEGIN')
  create(borrowed); confirm(borrowed)
  owner.db.exec('ROLLBACK')
  expect(owner.get('feature')).toBeUndefined(); expect(owner.claim('runner')).toBeUndefined()
  borrowed.close()
  expect(owner.db.prepare('SELECT 1 AS n').get()!.n).toBe(1)
})

it('CAS rejects two competing revisions and rolls back callback failures and outbox writes', () => {
  const a = open(); const b = open(); const d = create(a)
  a.compareAndSwap(d.id, d.revision, value => { value.title = 'winner' })
  expect(() => b.compareAndSwap(d.id, d.revision, value => { value.title = 'loser' })).toThrow('Stale')
  const current = a.get(d.id)!
  expect(() => a.compareAndSwap(d.id, current.revision, value => { value.title = 'rolled back'; throw new Error('abort') })).toThrow('abort')
  expect(a.get(d.id)!.title).toBe('winner')
  a.db.exec(`CREATE TRIGGER fail_delivery_update BEFORE UPDATE ON feature_delivery BEGIN SELECT RAISE(ABORT, 'injected rollback'); END`)
  expect(() => confirm(a)).toThrow('injected rollback')
  expect(a.claim('worker')).toBeUndefined()
  expect(a.get(d.id)!.revision).toBe(current.revision)
})

it('arbitrates actual simultaneous worker-process aggregate revisions once only', async () => {
  const s = open(); const d = create(s)
  const code = `const {parentPort,workerData}=require('node:worker_threads'); (async()=>{ const {DeliveryStore}=await import(workerData.module); const s=new DeliveryStore(workerData.path); parentPort.postMessage('ready'); parentPort.once('message',()=>{try{ const result=s.compareAndSwap('feature',workerData.revision,d=>{d.title=workerData.title}); parentPort.postMessage({ok:true,revision:result.revision}) }catch(e){parentPort.postMessage({ok:false,error:String(e)})}finally{s.close()}}) })().catch(e=>{throw e})`
  const workers = ['one', 'two'].map(title => new Worker(code, { eval: true, execArgv: ['--experimental-transform-types'], workerData: { module: new URL('../src/app/feature-delivery.ts', import.meta.url).href, path: join(directory, 'delivery.sqlite'), title, revision: d.revision } }))
  try {
    await Promise.all(workers.map(w => new Promise<void>((resolve, reject) => { w.once('message', () => resolve()); w.once('error', reject) })))
    const results = workers.map(w => new Promise<{ ok: boolean }>((resolve, reject) => { w.once('message', resolve); w.once('error', reject) }))
    workers.forEach(w => w.postMessage('go'))
    const outcomes = await Promise.all(results)
    expect(outcomes.filter(r => r.ok)).toHaveLength(1)
    expect(s.get('feature')!.revision).toBe(2)
  } finally { await Promise.all(workers.map(w => w.terminate())) }
})

it('binds actions to exact evidence/scope and freezes recorded authority and requirements', () => {
  const s = open(); const d = create(s)
  s.compareAndSwap(d.id, d.revision, value => { value.bindings.headSha = 'new-head' })
  expect(() => s.confirm(d.id, { revision: d.revision, actionId: d.nextAction!.id }, 'alice')).toThrow(DeliveryConflict)
  const current = s.get(d.id)!
  expect(current.nextAction!.fingerprint).not.toBe(d.nextAction!.fingerprint)
  expect(() => s.compareAndSwap(d.id, current.revision, value => { value.authorities.push('mallory') })).toThrow('Immutable')
  expect(() => s.compareAndSwap(d.id, current.revision, value => { value.requirements = [] })).toThrow('Immutable')
})

it('fences expired and concurrent leases; restart mutation reconciles instead of replaying', async () => {
  let s = open(); create(s); confirm(s)
  const first = s.claim('one', 100, 50)!
  expect(s.claim('two', 120)).toBeUndefined()
  const second = s.claim('two', 151, 50)!
  expect(second.reconcile).toBe(true)
  expect(() => s.complete(first, { outcome: 'passed' }, 152)).toThrow('fenced')
  expect(() => s.complete(second, { outcome: 'passed' }, 202)).toThrow('expired')
  stores.pop()!.close(); s = open()
  const execute = vi.fn(); const reconcile = vi.fn(async () => ({ outcome: 'passed' as const, evidence: [evidence('implementation')] }))
  await new DeliveryCoordinator(s, { implement: { execute, reconcile } }).runOnce('restart')
  expect(execute).not.toHaveBeenCalled(); expect(reconcile).toHaveBeenCalledOnce()
  expect(s.get('feature')!.stage).toBe('review')
})

it('blocks missing independent capabilities and uncertain mutation until reconciled', async () => {
  const s = open(); create(s); finish(s, 'implement', evidence('implementation')); confirm(s, 'review')
  await new DeliveryCoordinator(s, {}).runOnce('runner')
  expect(s.get('feature')!.blocker).toContain('Missing capability: review')
  expect(s.eligibleActions('feature')).toEqual([])
  expect(await new DeliveryCoordinator(s, {}).runOnce('runner')).toBe(false)
  const blocked = s.get('feature')!
  s.resume(blocked.id, blocked.revision, 'alice')
  const execute = vi.fn(async () => ({ outcome: 'passed' as const, evidence: [evidence('review')] }))
  const reconcile = vi.fn(async () => ({ outcome: 'passed' as const, evidence: [evidence('review')] }))
  await new DeliveryCoordinator(s, { review: { execute, reconcile } }).runOnce('runner')
  expect(execute).not.toHaveBeenCalled(); expect(reconcile).toHaveBeenCalledOnce()
  expect(s.get('feature')!.nextAction!.kind).toBe('publish')
})

it('does not replay adapter exceptions and requires reconciliation', async () => {
  const s = open(); create(s); confirm(s)
  const execute = vi.fn(async () => { throw new Error('remote connection lost after mutation') })
  const coordinator = new DeliveryCoordinator(s, { implement: { execute } })
  await coordinator.runOnce('runner'); expect(await coordinator.runOnce('runner')).toBe(false)
  expect(execute).toHaveBeenCalledOnce()
  let blocked = s.get('feature')!
  expect(blocked.state).toBe('blocked')
  s.resume(blocked.id, blocked.revision, 'alice')
  await coordinator.runOnce('runner')
  expect(execute).toHaveBeenCalledOnce()
  blocked = s.get('feature')!
  expect(blocked.blocker).toContain('Missing reconciliation')
  s.resume(blocked.id, blocked.revision, 'alice')
  const reconcile = vi.fn(async () => ({ outcome: 'passed' as const, evidence: [evidence('implementation')] }))
  await new DeliveryCoordinator(s, { implement: { execute, reconcile } }).runOnce('runner')
  expect(reconcile).toHaveBeenCalledOnce(); expect(s.get('feature')!.stage).toBe('review')
})

it('enforces finite independent review and fix retry budgets', () => {
  const s = open(); s.create({ id: 'feature', title: 'Feature', owner: 'alice', authorities: ['alice'], bindings, requirements: ['behavior'], maxReview: 2, maxFix: 1 })
  finish(s, 'implement', evidence('implementation'))
  finish(s, 'review', evidence('review', 'failed'), 'failed')
  expect(s.get('feature')!.nextAction!.kind).toBe('fix')
  finish(s, 'fix', { ...evidence('implementation'), id: 'fixed-implementation' })
  finish(s, 'review', { ...evidence('review', 'failed'), id: 'second-review' }, 'failed')
  expect(s.get('feature')!.state).toBe('blocked')
  expect(s.get('feature')!.blocker).toContain('budget exhausted')
  expect(s.get('feature')!.evidence.filter(e => e.kind === 'review' && e.outcome === 'failed')).toHaveLength(2)
  expect(s.get('feature')!.generation).toBe(1)
  expect(s.eligibleActions('feature')).toEqual([])
})

it('never accepts merged workers, reports, publication, or unresolved intake alone', () => {
  const s = open(); const d = verifying(s)
  expect(d.workers).toEqual(['ended-1', 'ended-2'])
  expect(d.acceptance).toBeUndefined(); expect(d.nextAction!.kind).toBe('verify')
  const result = finish(s, 'verify', evidence('verification', 'passed', ['behavior']))
  expect(result.state).toBe('blocked'); expect(result.acceptance).toBeUndefined()
  expect(() => s.compareAndSwap(result.id, result.revision, value => { value.state = 'accepted'; value.stage = 'accepted' })).toThrow('Acceptance lacks')
})

it('accepts only explicitly satisfied exact-bound evidence and makes acceptance terminal', () => {
  const s = open(); verifying(s)
  const result = finish(s, 'verify', evidence('verification', 'passed', ['behavior', 'live']))
  expect(result.nextAction!.kind).toBe('accept')
  const accepted = confirm(s, 'accept')
  expect(accepted.state).toBe('accepted'); expect(accepted.acceptance!.evidenceIds).toContain('verification-passed')
  expect(s.eligibleActions('feature')).toEqual([])
  expect(() => s.compareAndSwap(accepted.id, accepted.revision, value => { value.title = 'changed' })).toThrow('Settled')
})

it('rollback or uncertain evidence prevents acceptance even after a successful verification', () => {
  for (const kind of ['rollback', 'uncertain'] as const) {
    const s = new DeliveryStore(':memory:'); stores.push(s); verifying(s)
    const d = s.get('feature')!
    s.compareAndSwap(d.id, d.revision, value => { value.evidence.push(kind === 'rollback' ? evidence('rollback') : evidence('publication', 'uncertain')) })
    const result = finish(s, 'verify', evidence('verification', 'passed', ['behavior', 'live']))
    expect(result.state).toBe('blocked'); expect(result.nextAction).toBeUndefined(); expect(result.acceptance).toBeUndefined()
  }
})

it('resolves rollback only through explicitly bound recorded reconciliation while retaining history', () => {
  const s = open(); verifying(s)
  const d = s.get('feature')!
  s.compareAndSwap(d.id, d.revision, value => { value.evidence.push(evidence('rollback')) })
  confirm(s, 'verify'); const lease = s.claim('verifier')!
  const result = s.complete(lease, { outcome: 'passed', evidence: [
    { ...evidence('publication'), id: 'reconciled-publication', supersedes: ['rollback-passed'] },
    evidence('verification', 'passed', ['behavior', 'live']),
  ] })
  expect(result.evidence.some(e => e.kind === 'rollback')).toBe(true)
  expect(result.nextAction!.kind).toBe('accept')
  expect(confirm(s, 'accept').state).toBe('accepted')
})

it('rejects mismatched and reused evidence and preserves lease after rollback', () => {
  const s = open(); create(s); confirm(s); const lease = s.claim('runner')!
  expect(() => s.complete(lease, { outcome: 'passed', evidence: [{ ...evidence('implementation'), bindings: { ...bindings, headSha: 'wrong' } }] })).toThrow('binding mismatch')
  expect(s.get('feature')!.state).toBe('running')
  s.complete(lease, { outcome: 'passed', evidence: [evidence('implementation')] })
  confirm(s); const review = s.claim('runner')!
  expect(() => s.complete(review, { outcome: 'passed', evidence: [{ ...evidence('review'), id: 'implementation-passed' }] })).toThrow('Evidence ID reused')
})

it('durably polls asynchronous handoffs only when due and never replays external mutation', async () => {
  vi.useFakeTimers()
  try {
    let s = open(); create(s); confirm(s)
    const execute = vi.fn(async () => ({ outcome: 'pending' as const, nextRetryAt: Date.now() + 5_000 }))
    const reconcile = vi.fn(async () => ({ outcome: 'passed' as const, evidence: [evidence('implementation')] }))
    await new DeliveryCoordinator(s, { implement: { execute, reconcile } }).runOnce('runner')
    expect(s.get('feature')!.state).toBe('running'); expect(s.claim('other')).toBeUndefined()
    stores.pop()!.close(); s = open()
    const coordinator = new DeliveryCoordinator(s, { implement: { execute, reconcile } })
    expect(await coordinator.runOnce('restart')).toBe(false)
    await vi.advanceTimersByTimeAsync(5_000)
    await coordinator.runOnce('restart')
    expect(execute).toHaveBeenCalledOnce(); expect(reconcile).toHaveBeenCalledOnce()
    expect(s.get('feature')!.stage).toBe('review')
  } finally { vi.useRealTimers() }
})

it('bounds external pending reconciliation attempts and then parks an explicit blocker', () => {
  const s = open(); create(s); confirm(s)
  let now = Date.now()
  for (let i = 0; i < 21; i++) {
    const lease = s.claim('runner', now, 30_000)!
    expect(lease.reconcile).toBe(i > 0)
    s.complete(lease, { outcome: 'pending', nextRetryAt: now + 1_000 }, now)
    expect(s.claim('runner', now)).toBeUndefined()
    now += 1_000
  }
  expect(s.get('feature')!.blocker).toContain('reconciliation budget exhausted')
  expect(s.claim('runner', now + 1_000_000)).toBeUndefined()
})

it('recovers eventual remote completion after exhausting polling using only the original reconciliation key', async () => {
  vi.useFakeTimers()
  try {
    let s = open(); create(s); confirm(s)
    let completed = false
    const execute = vi.fn(async () => ({ outcome: 'pending' as const, nextRetryAt: Date.now() + 1_000 }))
    const reconcile = vi.fn(async (_lease: DeliveryLease) => completed ? { outcome: 'passed' as const, evidence: [evidence('implementation')] } : { outcome: 'pending' as const, nextRetryAt: Date.now() + 1_000 })
    let coordinator = new DeliveryCoordinator(s, { implement: { execute, reconcile } })
    await coordinator.runOnce('initial')
    for (let i = 0; i < 20; i++) { await vi.advanceTimersByTimeAsync(1_000); await coordinator.runOnce('poller') }
    expect(execute).toHaveBeenCalledOnce(); expect(reconcile).toHaveBeenCalledTimes(20)
    const blocked = s.get('feature')!
    expect(blocked.blocker).toContain('budget exhausted'); expect(blocked.reconciliation).toBeDefined()
    const recovery = blocked.reconciliation!
    const original = String(s.db.prepare('SELECT value FROM feature_delivery_outbox WHERE id=?').get(recovery.id)!.value)
    expect(JSON.parse(String(s.db.prepare('SELECT value FROM feature_delivery WHERE id=?').get(blocked.id)!.value)).reconciliation).toBeUndefined()
    const beforeReads = s.db.prepare('SELECT total_changes() AS n').get()!.n
    expect(s.list()[0]!.reconciliation).toEqual(recovery); expect(s.get(blocked.id)!.reconciliation).toEqual(recovery)
    expect(s.db.prepare('SELECT total_changes() AS n').get()!.n).toBe(beforeReads)
    stores.pop()!.close(); s = open(); coordinator = new DeliveryCoordinator(s, { implement: { execute, reconcile } })
    expect(s.get(blocked.id)!.reconciliation).toEqual(recovery)
    const proof = { actor: 'alice', source: 'local_operator' as const, reference: 'trusted-request:reconcile', scope: recovery.actionId }
    expect(() => s.resume(blocked.id, blocked.revision, { ...proof, scope: 'stale-scope' }, recovery.actionId)).toThrow('recovery scope')
    expect(() => s.resume(blocked.id, blocked.revision, proof, 'wrong-action')).toThrow('current exact')
    const resumed = s.resume(blocked.id, blocked.revision, proof, recovery.actionId)
    expect(resumed.reconciliation).toBeUndefined(); expect(resumed.state).toBe('running')
    expect(resumed.audit.at(-1)).toMatchObject({ event: 'resume-reconciliation', actor: 'alice', actionId: recovery.id, authorization: proof })
    expect(String(s.db.prepare('SELECT value FROM feature_delivery_outbox WHERE id=?').get(recovery.id)!.value)).toBe(original)
    expect(() => s.resume(blocked.id, blocked.revision, proof, recovery.actionId)).toThrow('current exact')
    expect(() => s.resume(blocked.id, resumed.revision, proof, recovery.actionId)).toThrow('current exact')
    completed = true
    await coordinator.runOnce('recovery')
    expect(execute).toHaveBeenCalledOnce(); expect(reconcile).toHaveBeenCalledTimes(21)
    expect(reconcile.mock.calls.at(-1)![0]).toMatchObject({ id: recovery.id, reconcile: true, authorization: JSON.parse(original).authorization })
    expect(s.get(blocked.id)!.stage).toBe('review'); expect(s.get(blocked.id)!.reconciliation).toBeUndefined()
  } finally { vi.useRealTimers() }
})

it('rejects stale recovery revisions, changed bindings and corrupted original authorization', () => {
  const s = open(); create(s); confirm(s); const lease = s.claim('runner')!
  const blocked = s.complete(lease, { outcome: 'uncertain' })
  const originalRecovery = blocked.reconciliation!
  expect(originalRecovery).toBeDefined()
  const revised = s.compareAndSwap(blocked.id, blocked.revision, value => { value.title = 'Revised context' })
  expect(revised.reconciliation!.actionId).not.toBe(originalRecovery.actionId)
  expect(() => s.resume(blocked.id, blocked.revision, 'alice', originalRecovery.actionId)).toThrow('current exact')
  expect(() => s.resume(blocked.id, revised.revision, 'alice', originalRecovery.actionId)).toThrow('current exact')
  const changed = s.compareAndSwap(blocked.id, revised.revision, value => { value.bindings.headSha = 'another-head' })
  expect(changed.reconciliation).toBeUndefined()
  expect(() => s.resume(changed.id, changed.revision, 'alice')).toThrow('current exact')
  const restored = s.compareAndSwap(changed.id, changed.revision, value => { value.bindings = structuredClone(bindings) })
  const row = s.db.prepare('SELECT value FROM feature_delivery_outbox WHERE id=?').get(originalRecovery.id)!
  const payload = JSON.parse(String(row.value)); payload.authorization.scope = 'corrupt-original-scope'
  s.db.prepare('UPDATE feature_delivery_outbox SET value=? WHERE id=?').run(JSON.stringify(payload), originalRecovery.id)
  expect(s.get(restored.id)!.reconciliation).toBeUndefined()
  expect(() => s.resume(restored.id, restored.revision, 'alice')).toThrow('current exact')
  expect(s.claim('runner')).toBeUndefined()
})

it('does not recover a parked publication handoff against substituted prepared target metadata', () => {
  const s = open(); const d = create(s)
  const prepared = s.compareAndSwap(d.id, d.revision, value => { value.preparedPublication = { id: 'original-publication', ticketId: 'ticket', decisionId: 'decision', repository: bindings.repository, pr: 1, headSha: bindings.headSha, patchSha256: 'patch', environment: 'production', preparedAt: 'now' } })
  s.confirm(prepared.id, { revision: prepared.revision, actionId: prepared.nextAction!.id }, 'alice')
  const lease = s.claim('runner')!; const blocked = s.complete(lease, { outcome: 'uncertain' })
  expect(blocked.reconciliation).toBeDefined()
  const changed = s.compareAndSwap(blocked.id, blocked.revision, value => { value.preparedPublication!.id = 'substituted-publication' })
  expect(changed.reconciliation).toBeUndefined()
  expect(() => s.resume(changed.id, changed.revision, 'alice')).toThrow('current exact')
})

it('heartbeats long-running real asynchronous adapters so another coordinator cannot overlap', async () => {
  vi.useFakeTimers()
  try {
    const s = open(); const competing = open(); create(s); confirm(s)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const execute = vi.fn(async () => { await gate; return { outcome: 'passed' as const, evidence: [evidence('implementation')] } })
    const pending = new DeliveryCoordinator(s, { implement: { execute } }, { leaseMs: 90 }).runOnce('long-review')
    await vi.advanceTimersByTimeAsync(900)
    expect(competing.claim('other')).toBeUndefined()
    release(); await pending
    expect(execute).toHaveBeenCalledOnce(); expect(s.get('feature')!.stage).toBe('review')
  } finally { vi.useRealTimers() }
})

it('aborts the adapter and refuses completion when process ownership is lost', async () => {
  vi.useFakeTimers()
  try {
    const s = open(); create(s); confirm(s)
    let release!: () => void; let signal: AbortSignal | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const pending = new DeliveryCoordinator(s, { implement: { execute: async lease => { signal = lease.signal; await gate; return { outcome: 'passed', evidence: [evidence('implementation')] } } } }, { leaseMs: 90 }).runOnce('one')
    // A replacement token models a process fence after external ownership recovery.
    s.db.prepare("UPDATE feature_delivery_outbox SET token='replacement'").run()
    const check = expect(pending).rejects.toThrow('ownership lost')
    await vi.advanceTimersByTimeAsync(31)
    expect(signal!.aborted).toBe(true)
    release(); await check
    expect(s.get('feature')!.state).toBe('running')
  } finally { vi.useRealTimers() }
})

it('aborts a hung capability promptly, parks uncertainty, and never blocks runtime stop', async () => {
  const s = open(); create(s); confirm(s)
  const controller = new AbortController(); let adapterSignal: AbortSignal | undefined
  const execute = vi.fn((lease: DeliveryLease) => { adapterSignal = lease.signal; return new Promise<never>(() => {}) })
  const coordinator = new DeliveryCoordinator(s, { implement: { execute } })
  const pending = coordinator.runOnce('runner', controller.signal)
  controller.abort('runtime stopping')
  expect(await pending).toBe(true)
  expect(adapterSignal!.aborted).toBe(true)
  expect(s.get('feature')!.blocker).toContain('stopped during capability')
  expect(s.claim('restart')).toBeUndefined()
  expect(await coordinator.runOnce('restart', controller.signal)).toBe(false)
  expect(execute).toHaveBeenCalledOnce()
})

it('dispatches only recorded delegation and never extends the grant to changed repository heads', () => {
  const s = open()
  const d = s.create({ id: 'feature', title: 'Feature', owner: 'alice', bindings: { ...bindings, refs: [{ repository: 'org/plugin', pr: 9, headSha: 'plugin-head' }] }, requirements: ['behavior'], authorities: ['alice'], delegatedActions: ['implement', 'review'] })
  s.compareAndSwap(d.id, d.revision, value => { value.bindings.refs![0]!.headSha = 'changed-plugin-head' })
  expect(s.dispatchAuthorized(d.id)).toBeUndefined()
  expect(s.claim('runner')).toBeUndefined()
  const current = s.get(d.id)!
  s.compareAndSwap(current.id, current.revision, value => { value.bindings.refs![0]!.headSha = 'plugin-head' })
  expect(s.dispatchAuthorized(d.id)!.state).toBe('running')
  const lease = s.claim('runner')!
  expect(lease.authorization.source).toBe('delegation')
  expect(lease.authorization.scope).toBe(lease.action.fingerprint)
})

it('preserves failed history across corrected heads and follows only explicitly delegated review/fix scopes', () => {
  const s = open()
  s.create({ id: 'feature', title: 'Feature', owner: 'alice', bindings, requirements: ['behavior'], authorities: ['alice'], delegatedActions: ['review', 'fix', 'publish'], followFixHeads: true })
  finish(s, 'implement', evidence('implementation'))
  finish(s, 'review', evidence('review', 'failed'), 'failed')
  const failed = s.get('feature')!
  s.compareAndSwap(failed.id, failed.revision, d => { d.preparedPublication = { id: 'old', ticketId: 'ticket', decisionId: 'decision', repository: bindings.repository, pr: 1, headSha: bindings.headSha, patchSha256: 'patch', environment: 'production', preparedAt: 'now' } })
  confirm(s, 'fix'); const lease = s.claim('fixer')!
  const corrected = { ...bindings, headSha: 'corrected', artifact: undefined }
  const ready = s.complete(lease, { outcome: 'passed', updatedBindings: corrected, evidence: [{ ...evidence('implementation'), id: 'corrected-implementation', bindings: corrected }] })
  expect(ready.preparedPublication).toBeUndefined()
  expect(ready.bindings.headSha).toBe('corrected'); expect(ready.generation).toBe(1)
  expect(ready.evidence.some(e => e.kind === 'review' && e.outcome === 'failed')).toBe(true)
  expect(s.dispatchAuthorized('feature')!.state).toBe('running')
  const review = s.claim('reviewer')!
  s.complete(review, { outcome: 'passed', evidence: [{ ...evidence('review'), id: 'corrected-review', bindings: corrected }] })
  expect(s.get('feature')!.nextAction!.kind).toBe('publish')
  expect(s.dispatchAuthorized('feature')).toBeUndefined()
})

it('rejects fix results that change repository identities or retain a stale artifact', () => {
  const s = open(); create(s); finish(s, 'implement', evidence('implementation')); finish(s, 'review', evidence('review', 'failed'), 'failed'); confirm(s, 'fix')
  const lease = s.claim('fixer')!
  const invalid = { ...bindings, headSha: 'corrected' }
  expect(() => s.complete(lease, { outcome: 'passed', updatedBindings: invalid, evidence: [{ ...evidence('implementation'), id: 'new', bindings: invalid }] })).toThrow('cleared artifact')
  const elsewhere = { ...bindings, repository: 'other/repo', headSha: 'corrected', artifact: undefined }
  expect(() => s.complete(lease, { outcome: 'passed', updatedBindings: elsewhere, evidence: [{ ...evidence('implementation'), id: 'new', bindings: elsewhere }] })).toThrow('identical scope identities')
})

it('compares exact unique multi-repository ref sets without subset or duplicate matches', () => {
  const a = { repository: 'org/backend', pr: 1, headSha: 'backend-head', baseSha: 'backend-base' }
  const b = { repository: 'org/plugin', pr: 2, headSha: 'plugin-head', baseSha: 'plugin-base' }
  expect(sameDeliveryRefs([a, b], [b, a])).toBe(true)
  expect(sameDeliveryRefs([a, a], [a, b])).toBe(false)
  expect(sameDeliveryRefs([a], [a, b])).toBe(false)
  expect(sameDeliveryRefs([], [])).toBe(false)
  expect(sameDeliveryRefs(undefined, undefined)).toBe(false)
  expect(sameDeliveryRefs([a], [{ ...a, baseSha: undefined }])).toBe(false)
  expect(sameDeliveryRefs([{ ...a, diffSha256: 'recorded-review-diff' }], [a])).toBe(true)
  const s = open()
  expect(() => s.create({ id: 'duplicate', title: 'Duplicate', owner: 'alice', authorities: ['alice'], requirements: ['behavior'], bindings: { ...bindings, refs: [a, a] } })).toThrow('Invalid delivery intake')
  const d = create(s)
  expect(() => s.compareAndSwap(d.id, d.revision, value => { value.bindings.refs = [a, a] })).toThrow('Duplicate delivery reference')
})

it('stores hold/take advice for the exact current action without changing revision or granting authority', () => {
  const s = open(); const d = create(s)
  const rec = { kind: d.nextAction!.kind, actionId: d.nextAction!.id, fingerprint: d.nextAction!.fingerprint, disposition: 'hold' as const, rationale: 'Hold pending operator assessment', provider: 'independent-reviewer', recordedAt: '2026-11-06T00:00:00Z' }
  const advised = s.setRecommendation(d.id, d.revision, rec)
  expect(advised.revision).toBe(d.revision); expect(advised.nextAction).toEqual(d.nextAction)
  expect(advised.recommendation).toEqual(rec); expect(s.eligibleActions(d.id)).toEqual([d.nextAction])
  expect(s.claim('runner')).toBeUndefined()
  expect(() => s.setRecommendation(d.id, d.revision, { ...rec, actionId: 'different-action' })).toThrow('current exact action')
  const revised = s.compareAndSwap(d.id, d.revision, value => { value.title = 'Same evidence, new aggregate revision' })
  expect(revised.nextAction!.fingerprint).toBe(d.nextAction!.fingerprint)
  expect(revised.recommendation).toBeUndefined()
  expect(() => s.setRecommendation(d.id, d.revision, rec)).toThrow('current exact action')
})

it('prepared publication metadata invalidates previous action and recommendation without rewriting review evidence', () => {
  const s = open(); create(s); finish(s, 'implement', evidence('implementation')); const d = finish(s, 'review', evidence('review'))
  const recommended = s.setRecommendation(d.id, d.revision, { kind: 'publish', actionId: d.nextAction!.id, disposition: 'take', fingerprint: d.nextAction!.fingerprint, rationale: 'recorded review passed', provider: 'test', recordedAt: '2026-11-06T00:00:00Z' })
  expect(recommended.recommendation).toBeDefined()
  const prepared = s.compareAndSwap(d.id, recommended.revision, value => { value.preparedPublication = { id: 'prepared', ticketId: 'ticket', decisionId: 'decision', repository: bindings.repository, pr: 1, headSha: bindings.headSha, patchSha256: 'patch', environment: 'production', preparedAt: 'now' } })
  expect(prepared.nextAction!.fingerprint).not.toBe(recommended.nextAction!.fingerprint)
  expect(prepared.recommendation).toBeUndefined()
  expect(prepared.evidence).toEqual(recommended.evidence)
  expect(() => s.confirm(d.id, { revision: recommended.revision, actionId: recommended.nextAction!.id }, 'alice')).toThrow('Stale')
})

it('persists exact trusted confirmation provenance and rejects altered lease authority', () => {
  const s = open(); const d = create(s)
  const authority = { actor: 'alice', source: 'local_operator' as const, reference: 'request:trusted-123', scope: d.nextAction!.fingerprint }
  s.confirm(d.id, { revision: d.revision, actionId: d.nextAction!.id }, authority)
  const lease = s.claim('runner')!
  expect(lease.authorization).toEqual(authority)
  expect(() => s.complete({ ...lease, authorization: { ...authority, reference: 'forged' } }, { outcome: 'passed', evidence: [evidence('implementation')] })).toThrow('payload changed')
})

it('ingests actual implementation evidence without automatically reviewing or accepting workers', () => {
  const s = open(); const d = create(s)
  const ready = s.recordImplementation(d.id, d.revision, evidence('implementation'), ['ended-1', 'ended-2'])
  expect(ready.stage).toBe('review'); expect(ready.nextAction!.kind).toBe('review')
  expect(ready.acceptance).toBeUndefined(); expect(s.claim('runner')).toBeUndefined()
})

it('strict #159/#160 preview is read-only and preserves two ended merged workers', () => {
  const s = open()
  const record = { sourceIssue: 159, id: 'legacy', title: 'Legacy', owner: 'alice', bindings, requirements: ['behavior'], workers: [{ id: 'ended-1', ended: true, merged: true }, { id: 'ended-2', ended: true, merged: true }], evidence: [evidence('publication')] }
  const before = s.db.prepare('SELECT total_changes() AS n').get()!.n
  const preview = s.previewBackfill([record, { ...record, id: 'legacy-160', sourceIssue: 160, bindings: { ...bindings, sourceIssue: 160 }, evidence: [{ ...evidence('publication'), bindings: { ...bindings, sourceIssue: 160 } }] }])
  expect(preview[0]!.workers).toEqual(['ended-1', 'ended-2'])
  expect(preview.every(p => p.state === 'blocked')).toBe(true)
  expect(s.list()).toEqual([]); expect(s.claim('runner')).toBeUndefined()
  expect(s.db.prepare('SELECT total_changes() AS n').get()!.n).toBe(before)
  expect(() => s.previewBackfill([{ ...record, sourceIssue: 161 }])).toThrow('restricted')
  expect(() => s.previewBackfill([{ ...record, evidence: [] }])).toThrow('recorded')
  expect(() => s.previewBackfill([{ ...record, workers: [{ id: 'running', ended: false, merged: true }] }])).toThrow('ended merged')
  const fp = deliveryFingerprint([record])
  const authority = { actor: 'operator', source: 'local_operator' as const, reference: 'review:159', scope: fp }
  expect(() => s.applyBackfill([record], 'wrong-preview', authority)).toThrow('exact reviewed')
  const applied = s.applyBackfill([record], fp, authority)
  expect(applied[0]!.state).toBe('blocked'); expect(applied[0]!.stage).toBe('verifying')
  expect(applied[0]!.workers).toEqual(['ended-1', 'ended-2'])
  expect(s.applyBackfill([record], fp, authority)).toEqual(applied)
  expect(s.claim('runner')).toBeUndefined()
})
