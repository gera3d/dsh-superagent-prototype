import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createDeliveryCapabilities, recommendDeliveryAction, type DeliveryCapabilityDependencies } from '../src/app/delivery-capabilities.ts'
import { DeliveryStore, type DeliveryBindings, type DeliveryLease } from '../src/app/feature-delivery.ts'
import { Store } from '../src/app/store.ts'
import { Engine } from '../src/core/engine.ts'
import type { EngineOptions } from '../src/core/part.ts'
import type { Ticket } from '../src/core/model.ts'
import { key } from '../src/core/ids.ts'
import { messageId } from '../src/app/delivery.ts'
import type { Commands } from '../src/infra/commands.ts'

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), NEW = 'c'.repeat(40)
const bindings: DeliveryBindings = { repository: 'org/repo', sourceIssue: 167, baseSha: BASE, headSha: HEAD, refs: [{ repository: 'org/repo', pr: 17, headSha: HEAD }], artifact: 'old-artifact' }
let directory: string, store: Store, deliveries: DeliveryStore
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'delivery-capabilities-')); store = new Store(join(directory, 'db.sqlite')); deliveries = new DeliveryStore(store.db) })
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(directory, { recursive: true, force: true }) })
function fixture(followFixHeads = true) {
  store.saveSettings({ executor: { model: { provider: 'configured', model: 'executor' } } })
  let verdict: unknown = { verdict: 'passed', findings: [], rationale: 'The bounded code satisfies the intake; this is not publication approval.' }
  let head = HEAD
  const events: unknown[] = []
  const resolve = vi.fn(async () => ({ provider: 'configured', model: 'executor' }))
  const stream = vi.fn(async function* (_request: unknown) { yield { type: 'text-delta', text: JSON.stringify(verdict) }; yield { type: 'finish', reason: { kind: 'stop' } } })
  const gh = vi.fn(async (args: string[]) => {
    expect(args[0]).toBe('api'); expect(args.slice(-2)).toEqual(['--method', 'GET'])
    if (args[1]!.endsWith('/files?per_page=100&page=1')) return [{ filename: 'src/code.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }]
    expect(args[1]).toBe('repos/org/repo/pulls/17')
    return { head: { sha: head }, base: { sha: BASE }, changed_files: 1 }
  })
  const commands = { gh, withSignal: vi.fn(function () { return commands }) } as unknown as Commands
  const ctx = { llm: { resolveCallConfig: resolve, stream }, agents: { get: vi.fn(() => ({ session: { snapshotEvents: () => events } })) }, get: vi.fn() } as unknown as Context
  const deliver = vi.fn()
  const engine = new Engine({ repo: store, executor: { deliver, start: vi.fn(), stop: vi.fn() }, now: () => '2026-11-06T00:00:01.000Z' } as unknown as EngineOptions)
  const note = vi.spyOn(engine, 'note')
  const deps: DeliveryCapabilityDependencies = { ctx, store, commands, engine, lifetime: new AbortController().signal }
  const caps = createDeliveryCapabilities(deps)
  let d = deliveries.create({ id: 'feature', title: 'Implement safely', owner: 'alice', authorities: ['alice'], bindings, requirements: ['Retain existing authorization fences'], workers: ['original'], followFixHeads })
  d = deliveries.recordImplementation(d.id, d.revision, { id: 'initial-report', kind: 'implementation', bindings, outcome: 'passed', recordedAt: '2026-11-06T00:00:00.000Z', reference: 'ticket/original/report/a1' })
  function lease() { const d = deliveries.get('feature')!; deliveries.confirm(d.id, { revision: d.revision, actionId: d.nextAction!.id }, 'alice'); return deliveries.claim('adapter')! }
  function worker(id = 'original') {
    const ticket: Ticket = { id, title: 'Original authorized implementation', decisionId: 'decision', mandate: { strength: 'explicit', policyVersion: 'p1', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: 'original implementation only' }, channels: [], assignments: [{ id: 'a1', state: 'running', createdAt: '2026-11-06T00:00:00.000Z', report: { state: 'ready', summary: 'Old ready', at: '2026-11-06T00:00:00.000Z' } }], inputs: [], undelivered: [], origin: { triggerId: 't1', triggerIds: ['t1'] }, createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z' }
    store.tickets.save(ticket); return ticket
  }
  const failReview = () => { verdict = { verdict: 'failed', findings: [{ repository: 'org/repo', pr: 17, headSha: HEAD, path: 'src/code.ts', line: 1, severity: 'high', message: 'Preserve authorization fence before mutation.' }], rationale: 'The changed code removes the fence.' } }
  async function fixLease(): Promise<DeliveryLease> { failReview(); const r = lease(); deliveries.complete(r, await caps.review!.execute(r)); return lease() }
  function consumeAndReady(at = '2026-11-06T00:00:03.000Z') {
    const t = store.tickets.get('original')!; const input = t.inputs.at(-1)!; t.undelivered = []
    events.push({ type: 'user/message', time: Date.parse('2026-11-06T00:00:02.000Z'), data: { id: messageId(key(input.id)), source: { kind: 'dsh-superagent' } } })
    t.assignments[0]!.report = { state: 'ready', summary: 'Corrected under original mandate', at }; store.tickets.save(t)
  }
  return { caps, deps, lease, worker, fixLease, consumeAndReady, note, deliver, events, stream, resolve, gh, setHead: (v: string) => { head = v }, setVerdict: (v: unknown) => { verdict = v } }
}

it('invokes the configured executor independently with no tools and persists exact review evidence, never publication approval', async () => {
  const h = fixture(); const l = h.lease(); const result = await h.caps.review!.execute(l)
  expect(result.outcome).toBe('passed'); expect(h.resolve).toHaveBeenCalledWith({ provider: 'configured', model: 'executor' }, expect.any(AbortSignal))
  expect(h.stream).toHaveBeenCalledWith(expect.objectContaining({ tools: [], system: expect.stringContaining('untrusted external data') }))
  expect(h.note).not.toHaveBeenCalled(); expect(h.caps.publish).toBeUndefined()
  const row = store.db.prepare('SELECT * FROM delivery_capability_review WHERE id=?').get(l.id)!
  const saved = JSON.parse(String(row.value)); expect(saved.provider).toBe('configured / executor'); expect(saved.lease.id).toBe(l.id); expect(saved.lease.action).toEqual(l.action); expect(saved.result.evidence[0].bindings).toEqual(bindings)
  deliveries.complete(l, result); const d = deliveries.get('feature')!; expect(d.stage).toBe('ready_to_publish'); expect(d.state).not.toBe('accepted'); expect(d.authorities).toEqual(['alice'])
})
it('gives independent review bounded token and time headroom while advice keeps its tighter budget', async () => {
  const h = fixture(); const timeout = vi.spyOn(AbortSignal, 'timeout')
  const review = h.lease(); deliveries.complete(review, await h.caps.review!.execute(review))
  expect(h.stream).toHaveBeenCalledWith(expect.objectContaining({ tools: [], maxTokens: 32_768 }))
  expect(timeout).toHaveBeenCalledWith(180_000)
  const d = deliveries.get('feature')!, action = d.nextAction!
  h.setVerdict({ disposition: 'hold', actionId: action.id, fingerprint: action.fingerprint, rationale: 'Hold until separately authorized deployment review completes.' })
  await recommendDeliveryAction(d, action, h.deps)
  expect(h.stream).toHaveBeenLastCalledWith(expect.objectContaining({ maxTokens: 8_192 }))
  expect(timeout).toHaveBeenCalledWith(60_000)
})
it('fails closed with privacy-safe incomplete, malformed and oversized review-response diagnostics', async () => {
  const h = fixture(), l = h.lease()
  h.stream.mockImplementationOnce(async function* () {
    yield { type: 'text-delta', text: '{"verdict":"passed","findings":[],"rationale":"partial' }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  })
  const incomplete = await h.caps.review!.execute(l)
  expect(incomplete.outcome).toBe('uncertain')
  expect(incomplete.blocker).toContain('review model response incomplete (finish reason: max-tokens)')
  expect(incomplete.blocker).toContain('no partial result accepted')
  h.stream.mockImplementationOnce(async function* () {
    yield { type: 'text-delta', text: '{"verdict":' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const malformed = await h.caps.review!.execute(l)
  expect(malformed.blocker).toContain('review model returned malformed JSON')
  h.stream.mockImplementationOnce(async function* () { yield { type: 'text-delta', text: 'x'.repeat(32_001) } })
  const oversized = await h.caps.review!.execute(l)
  expect(oversized.blocker).toContain('review model response exceeded 32000-character bound')
  expect(store.db.prepare('SELECT * FROM delivery_capability_review').all()).toHaveLength(0)
})
it('never accepts an oversized advice response', async () => {
  const h = fixture(); const review = h.lease(); deliveries.complete(review, await h.caps.review!.execute(review))
  const d = deliveries.get('feature')!, action = d.nextAction!
  h.stream.mockImplementationOnce(async function* () { yield { type: 'text-delta', text: 'x'.repeat(32_001) }; yield { type: 'finish', reason: { kind: 'stop' } } })
  await expect(recommendDeliveryAction(d, action, h.deps)).rejects.toThrow(/advice model response exceeded 32000-character bound/)
})
it('reconciles a persisted review without another model invocation and fences changed replay heads', async () => {
  const h = fixture(), l = h.lease(); const first = await h.caps.review!.execute(l)
  const restarted = createDeliveryCapabilities(h.deps)
  expect(await restarted.review!.reconcile!({ ...l, reconcile: true })).toEqual(first); expect(h.stream).toHaveBeenCalledTimes(1)
  h.setHead(NEW); expect((await restarted.review!.reconcile!(l)).blocker).toContain('Stale head fence')
})
it('rejects a cached verdict if its base or patches change even when the PR head is unchanged', async () => {
  const h = fixture(), l = h.lease(); expect((await h.caps.review!.execute(l)).outcome).toBe('passed')
  h.gh.mockResolvedValueOnce({ head: { sha: HEAD }, base: { sha: NEW }, changed_files: 1 })
  expect((await h.caps.review!.reconcile!(l)).blocker).toContain('Stale base fence')
  h.gh.mockResolvedValueOnce({ head: { sha: HEAD }, base: { sha: BASE }, changed_files: 1 }).mockResolvedValueOnce([{ filename: 'src/code.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+different' }])
  expect((await h.caps.review!.reconcile!(l)).blocker).toContain('Cached review diff or base changed'); expect(h.stream).toHaveBeenCalledTimes(1)
})
it('checks every pinned PR head again after model execution and never persists a stale review', async () => {
  const h = fixture(), l = h.lease()
  h.stream.mockImplementationOnce(async function* () { h.setHead(NEW); yield { type: 'text-delta', text: '{"verdict":"passed","findings":[],"rationale":"ok"}' }; yield { type: 'finish', reason: { kind: 'stop' } } })
  expect((await h.caps.review!.execute(l)).blocker).toContain('Stale head fence')
  expect(store.db.prepare('SELECT * FROM delivery_capability_review').all()).toHaveLength(0)
})
it('blocks missing LLM capability, model quota, GitHub permission, and incomplete diff explicitly', async () => {
  const h = fixture(), l = h.lease()
  const missing = createDeliveryCapabilities({ ...h.deps, ctx: {} as Context }); expect((await missing.review!.execute(l)).blocker).toContain('Missing capability: configured LLM')
  h.resolve.mockRejectedValueOnce(new Error('Quota exhausted; resets 12:00 UTC')); expect((await h.caps.review!.execute(l)).blocker).toContain('Quota exhausted; resets 12:00 UTC')
  h.gh.mockRejectedValueOnce(new Error('HTTP 403 permission denied')); expect((await h.caps.review!.execute(l)).blocker).toContain('HTTP 403')
  h.gh.mockResolvedValueOnce({ head: { sha: HEAD }, base: { sha: BASE }, changed_files: 101 }); expect((await h.caps.review!.execute(l)).blocker).toContain('oversized')
})
it('rejects model approval fields, malformed verdicts and findings outside the pinned diff', async () => {
  const h = fixture(), l = h.lease()
  h.setVerdict({ verdict: 'passed', findings: [], rationale: 'ok', approved: true }); expect((await h.caps.review!.execute(l)).outcome).toBe('uncertain')
  h.setVerdict({ verdict: 'failed', findings: [], rationale: 'ok' }); expect((await h.caps.review!.execute(l)).blocker).toContain('Contradictory')
  h.setVerdict({ verdict: 'failed', findings: [{ repository: 'org/repo', pr: 17, headSha: NEW, path: 'src/code.ts', line: 1, severity: 'high', message: 'wrong head' }], rationale: 'bad' }); expect((await h.caps.review!.execute(l)).blocker).toContain('not bound')
})
it('routes exact findings through real Engine.note transaction once across replay; old ready and inbox delivery are not correction completion', async () => {
  const h = fixture(); const original = h.worker(); const l = await h.fixLease()
  const observedAt = Date.now(); const pending = await h.caps.fix!.execute(l)
  expect(pending).toEqual({ outcome: 'pending', nextRetryAt: expect.any(Number) })
  expect(pending.nextRetryAt).toBeGreaterThanOrEqual(observedAt + 60_000)
  expect(pending.nextRetryAt).toBeLessThanOrEqual(Date.now() + 60_000)
  expect(h.note).toHaveBeenCalledTimes(1); expect(h.deliver).toHaveBeenCalledTimes(1)
  const t = store.tickets.get('original')!; expect(t.mandate).toEqual(original.mandate); expect(t.inputs.at(-1)).toMatchObject({ kind: 'note', text: expect.stringContaining(HEAD) }); expect(t.inputs.at(-1)).toMatchObject({ text: expect.stringContaining('sqlite:delivery_capability_review/') })
  t.undelivered = []; store.tickets.save(t)
  const restarted = createDeliveryCapabilities(h.deps)
  expect(await restarted.fix!.reconcile!(l)).toEqual({ outcome: 'pending', nextRetryAt: expect.any(Number) }); expect(h.note).toHaveBeenCalledTimes(1)
  h.consumeAndReady('2026-11-06T00:00:01.500Z'); expect(await restarted.fix!.reconcile!(l)).toEqual({ outcome: 'pending', nextRetryAt: expect.any(Number) })
  h.consumeAndReady(); const result = await restarted.fix!.reconcile!(l); expect(result.outcome).toBe('passed'); expect(result.evidence![0]!.reference).toContain('delivery_capability_fix/'); expect(h.note).toHaveBeenCalledTimes(1)
})
it('never dispatches a new correction note from reconciliation when no durable handoff exists', async () => {
  const h = fixture(); h.worker(); const l = await h.fixLease(); h.gh.mockClear()
  const result = await h.caps.fix!.reconcile!({ ...l, reconcile: true })
  expect(result.outcome).toBe('uncertain'); expect(result.blocker).toContain('read-only reconciliation cannot dispatch a new note')
  expect(h.note).not.toHaveBeenCalled(); expect(h.deliver).not.toHaveBeenCalled(); expect(h.gh).not.toHaveBeenCalled()
  expect(store.tickets.get('original')!.inputs).toEqual([])
  expect(store.db.prepare('SELECT * FROM delivery_capability_fix').all()).toEqual([])
  expect(await h.caps.fix!.execute(l)).toEqual({ outcome: 'pending', nextRetryAt: expect.any(Number) }); expect(h.note).toHaveBeenCalledTimes(1)
  const mismatched = { ...l, action: { ...l.action, fingerprint: 'different-scope' } }
  expect((await h.caps.fix!.reconcile!(mismatched)).blocker).toContain('idempotency scope mismatch'); expect(h.note).toHaveBeenCalledTimes(1)
})
it('rolls Engine.note back with its fix outbox record on transaction failure', async () => {
  const h = fixture(); h.worker(); const l = await h.fixLease()
  store.db.exec("CREATE TRIGGER reject_fix BEFORE INSERT ON delivery_capability_fix BEGIN SELECT RAISE(ABORT, 'outbox failure'); END")
  expect((await h.caps.fix!.execute(l)).blocker).toContain('outbox failure'); expect(store.tickets.get('original')!.inputs).toEqual([])
})
it('never reopens ended workers or broadcasts a correction to ambiguous active owners', async () => {
  const h = fixture(); const t = h.worker(); t.ended = { by: 'executor', outcome: 'completed', at: '2026-11-06T00:00:00.000Z' }; store.tickets.save(t); const l = await h.fixLease()
  expect((await h.caps.fix!.execute(l)).blocker).toContain('never reopened'); expect(h.note).not.toHaveBeenCalled()
  delete t.ended; store.tickets.save(t); h.worker('second'); const d = deliveries.get('feature')!; deliveries.compareAndSwap(d.id, d.revision, v => { v.workers.push('second') })
  expect((await h.caps.fix!.execute(l)).blocker).toContain('Ambiguous correction owner'); expect(h.note).not.toHaveBeenCalled()
})
it('rebinds changed correction heads only within recorded follow-fix scope, clearing old artifact', async () => {
  const h = fixture(); h.worker(); const l = await h.fixLease(); await h.caps.fix!.execute(l); h.consumeAndReady(); h.setHead(NEW)
  const result = await h.caps.fix!.reconcile!(l); expect(result.outcome).toBe('passed'); expect(result.updatedBindings).toMatchObject({ headSha: NEW, refs: [{ repository: 'org/repo', pr: 17, headSha: NEW }] }); expect(result.updatedBindings!.artifact).toBeUndefined()
  deliveries.complete(l, result); const d = deliveries.get('feature')!; expect(d.stage).toBe('review'); expect(d.bindings.headSha).toBe(NEW)
})
it('blocks changed fix heads without pre-recorded scope and never treats old binding evidence as corrected', async () => {
  const h = fixture(false); h.worker(); const l = await h.fixLease(); await h.caps.fix!.execute(l); h.consumeAndReady(); h.setHead(NEW)
  const result = await h.caps.fix!.reconcile!(l)
  expect(result.outcome).toBe('uncertain'); expect(result.blocker).toContain('followFixHeads'); expect(result.evidence).toBeUndefined(); expect(deliveries.get('feature')!.bindings.headSha).toBe(HEAD)
})
it('checks all secondary refs before and after review, rather than trusting only the primary head', async () => {
  const h = fixture(), l = h.lease(); l.bindings = { ...l.bindings, refs: [...l.bindings.refs!, { repository: 'other/repo', pr: 28, headSha: NEW, baseSha: BASE }] }
  let secondaryReads = 0
  h.gh.mockImplementation(async args => {
    if (args[1]!.includes('/files?')) return [{ filename: 'src/code.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }]
    const secondary = args[1]!.includes('other/repo')
    if (secondary) secondaryReads++
    return { head: { sha: secondary ? (secondaryReads > 1 ? HEAD : NEW) : HEAD }, base: { sha: BASE }, changed_files: 1 }
  })
  expect((await h.caps.review!.execute(l)).blocker).toContain('Stale head fence: other/repo#28'); expect(secondaryReads).toBe(2)
})
it('requires pinned secondary bases and rejects repository path traversal before issuing GitHub reads', async () => {
  const h = fixture(), l = h.lease(); l.bindings = { ...l.bindings, refs: [{ repository: 'org/..', pr: 17, headSha: HEAD }] }
  expect((await h.caps.review!.execute(l)).outcome).toBe('uncertain'); expect(h.gh).not.toHaveBeenCalled()
  l.bindings.refs = [{ repository: 'other/repo', pr: 17, headSha: HEAD }]
  h.gh.mockResolvedValueOnce({ head: { sha: HEAD }, base: { sha: BASE }, changed_files: 1 })
  expect((await h.caps.review!.execute(l)).blocker).toContain('Missing pinned base SHA')
})
it('serializes simultaneous fix deliveries to one real Engine.note and blocks unconfigured executor selection', async () => {
  const h = fixture(); h.worker(); const l = await h.fixLease()
  const results = await Promise.all([h.caps.fix!.execute(l), h.caps.fix!.execute(l)])
  expect(results).toEqual([{ outcome: 'pending', nextRetryAt: expect.any(Number) }, { outcome: 'pending', nextRetryAt: expect.any(Number) }]); expect(h.note).toHaveBeenCalledTimes(1)
  store.saveSettings({ executor: { model: null }, models: { hierarchy: [] } })
  const reviewLease = { ...l, id: 'missing-model', action: { ...l.action, kind: 'review' as const } }
  expect((await h.caps.review!.execute(reviewLease)).blocker).toContain('configured executor model')
})
it('blocks truncated and oversized patches rather than silently reviewing a subset', async () => {
  const h = fixture(), l = h.lease()
  h.gh.mockResolvedValueOnce({ head: { sha: HEAD }, base: { sha: BASE }, changed_files: 1 }).mockResolvedValueOnce([{ filename: 'src/code.ts', status: 'modified', additions: 2, deletions: 0, patch: '@@ -0 +1 @@\n+only-one' }])
  expect((await h.caps.review!.execute(l)).blocker).toContain('Truncated PR patch')
  h.gh.mockResolvedValueOnce({ head: { sha: HEAD }, base: { sha: BASE }, changed_files: 1 }).mockResolvedValueOnce([{ filename: 'src/code.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -0 +1 @@\n+' + 'x'.repeat(110_000) }])
  expect((await h.caps.review!.execute(l)).blocker).toContain('size limit'); expect(h.stream).not.toHaveBeenCalled()
})
it('generates actual bounded Senior Developer advice without adding model-selected actions or authority', async () => {
  const h = fixture(); const d = deliveries.get('feature')!; const action = d.nextAction!
  h.setVerdict({ disposition: 'take', actionId: action.id, fingerprint: action.fingerprint, rationale: 'Take independent review now; publication still needs separately configured fences.' })
  expect(await recommendDeliveryAction(d, action, h.deps)).toMatchObject({ disposition: 'take', actionId: action.id, kind: 'review', fingerprint: action.fingerprint, provider: 'configured / executor', rationale: expect.stringContaining('separately configured') })
  h.setVerdict({ rationale: 'Merge', action: 'publish' }); await expect(recommendDeliveryAction(d, action, h.deps)).rejects.toThrow()
})
it('preserves held-publication disposition and rejects model-selected action IDs or stale fingerprints', async () => {
  const h = fixture(); const review = h.lease(); deliveries.complete(review, await h.caps.review!.execute(review))
  const d = deliveries.get('feature')!, action = d.nextAction!
  expect(action.kind).toBe('publish')
  h.setVerdict({ disposition: 'hold', actionId: action.id, fingerprint: action.fingerprint, rationale: 'Hold publication: independent deployment approval is missing.' })
  const recommendation = await recommendDeliveryAction(d, action, h.deps)
  expect(recommendation).toMatchObject({ disposition: 'hold', actionId: action.id, kind: 'publish', fingerprint: action.fingerprint })
  expect(deliveries.get(d.id)!.nextAction).toEqual(action)
  h.setVerdict({ disposition: 'take', actionId: 'invented-merge-action', fingerprint: action.fingerprint, rationale: 'Merge instead.' })
  await expect(recommendDeliveryAction(d, action, h.deps)).rejects.toThrow()
  h.setVerdict({ disposition: 'take', actionId: action.id, fingerprint: 'stale-fingerprint', rationale: 'Publish stale scope.' })
  await expect(recommendDeliveryAction(d, action, h.deps)).rejects.toThrow()
  h.setVerdict({ actionId: action.id, fingerprint: action.fingerprint, rationale: 'No disposition supplied.' })
  await expect(recommendDeliveryAction(d, action, h.deps)).rejects.toThrow()
})

const batchFile = (filename: string, additions: number) => ({ filename, status: 'modified', additions, deletions: 0,
  patch: '@@ -0,0 +1 @@\n' + Array.from({ length: additions }, () => '+x').join('\n') })
const batchVerdict = (verdict: 'passed' | 'failed', rationale: string, findings: unknown[] = []) => ({ verdict, findings, rationale })
function multiRefFixture() {
  const h = fixture(); const l = h.lease()
  l.bindings = { ...l.bindings, refs: [{ repository: 'org/repo', pr: 17, headSha: HEAD, baseSha: BASE },
    { repository: 'other/repo', pr: 28, headSha: NEW, baseSha: BASE }] }
  h.gh.mockImplementation(async (args: string[]) => {
    expect(args[0]).toBe('api'); expect(args.slice(-2)).toEqual(['--method', 'GET'])
    if (args[1]!.endsWith('/files?per_page=100&page=1')) return [batchFile('src/code.ts', 20_000)]
    const secondary = args[1]!.includes('other/repo')
    return { head: { sha: secondary ? NEW : HEAD }, base: { sha: BASE }, changed_files: 1 }
  })
  const answers = (values: unknown[]) => h.stream.mockImplementation(async function* () {
    const value = values.shift()
    if (!value) throw new Error('Unexpected extra review batch')
    yield { type: 'text-delta', text: JSON.stringify(value) }; yield { type: 'finish', reason: { kind: 'stop' } }
  })
  return { ...h, lease: () => l, answers }
}

it('reviews each pinned PR as its own bounded batch when the combined source/artifact payload exceeds the aggregate cap', async () => {
  const h = multiRefFixture()
  h.answers([batchVerdict('passed', 'Artifact batch retains the fences.'),
    batchVerdict('passed', 'Source batch retains the fences and complete diff.')])
  const result = await h.caps.review!.execute(h.lease())
  expect(result.outcome).toBe('passed')
  // Two exact-content batches with the same filename are both reviewed; nothing is skipped by filename.
  expect(h.stream).toHaveBeenCalledTimes(2)
  const saved = JSON.parse(String(store.db.prepare('SELECT value FROM delivery_capability_review WHERE id=?').get(h.lease().id)!.value))
  expect(saved.batches).toHaveLength(2)
  expect(saved.batches.map((batch: { pr: number }) => batch.pr)).toEqual([17, 28])
  expect(saved.diffs.reduce((total: number, diff: unknown) => total + Buffer.byteLength(JSON.stringify(diff)), 0)).toBeGreaterThan(100_000)
  expect(saved.diffs.every((diff: unknown) => Buffer.byteLength(JSON.stringify(diff)) <= 100_000)).toBe(true)
  expect(result.evidence).toHaveLength(1)
})

it('aggregates a failed batch into one bounded final verdict only after every batch completed', async () => {
  const h = multiRefFixture()
  h.answers([batchVerdict('passed', 'Artifact batch is complete.'),
    batchVerdict('failed', 'Source batch changes behavior.', [{ repository: 'other/repo', pr: 28, headSha: NEW, path: 'src/code.ts', line: 1, severity: 'high', message: 'Restore the source fence.' }])])
  const result = await h.caps.review!.execute(h.lease())
  expect(result.outcome).toBe('failed')
  const saved = JSON.parse(String(store.db.prepare('SELECT value FROM delivery_capability_review WHERE id=?').get(h.lease().id)!.value))
  expect(saved.verdict).toMatchObject({ verdict: 'failed', findings: [{ repository: 'other/repo', pr: 28, headSha: NEW }] })
  expect(saved.batches.map((batch: { verdict: string }) => batch.verdict)).toEqual(['passed', 'failed'])
  expect(saved.verdict.rationale).toContain('Batch 2/2 other/repo#28')
})

it('never persists a partial aggregate when a later batch is unbound or incomplete', async () => {
  const h = multiRefFixture()
  h.answers([batchVerdict('passed', 'Artifact batch is complete.'),
    { verdict: 'passed', findings: [{ repository: 'other/repo', pr: 28, headSha: NEW, path: 'src/code.ts', line: 1, severity: 'low', message: 'x' }], rationale: 'Contradictory.' }])
  expect((await h.caps.review!.execute(h.lease())).blocker).toContain('Contradictory')
  expect(h.stream).toHaveBeenCalledTimes(2)
  expect(store.db.prepare('SELECT * FROM delivery_capability_review').all()).toHaveLength(0)
})

type ReviewFile = { filename: string; status: string; additions: number; deletions: number; patch: string }
const artifactPatch = (nested: string): ReviewFile => ({ filename: 'patches/JOB_COST_SUMMARY.patch', status: 'modified', additions: 3, deletions: 0,
  patch: '@@ -0,0 +1,3 @@\n+diff --git a/src/nested.ts b/src/nested.ts\n+' + nested + '\n+--- a/src/nested.ts' })
function targetedFixture(filesFor: (repository: string, pr: number) => ReviewFile[]) {
  const h = multiRefFixture()
  h.gh.mockImplementation(async (args: string[]) => {
    expect(args[0]).toBe('api'); expect(args.slice(-2)).toEqual(['--method', 'GET'])
    const files = /^repos\/(.+)\/pulls\/(\d+)\/files\?per_page=100&page=1$/.exec(args[1]!)
    if (files) return filesFor(files[1]!, Number(files[2]))
    const secondary = args[1]!.includes('other/repo')
    return { head: { sha: secondary ? NEW : HEAD }, base: { sha: BASE }, changed_files: 1 }
  })
  const requests: { system: string; messages: { content: { text: string }[] }[] }[] = []
  let answers: unknown[] = []
  h.stream.mockImplementation(async function* (request: unknown) {
    requests.push(request as typeof requests[number])
    const value = answers.shift()
    if (!value) throw new Error('Unexpected extra review batch')
    yield { type: 'text-delta', text: JSON.stringify(value) }; yield { type: 'finish', reason: { kind: 'stop' } }
  })
  return { ...h, requests, answer: (...values: unknown[]) => { answers = values } }
}

it('names one authoritative reviewTarget per call with exact outer paths and no competing global refs', async () => {
  const h = targetedFixture((_repository, pr) => pr === 17 ? [artifactPatch('nested source identity is data only')] : [batchFile('src/code.ts', 10)])
  h.answer(batchVerdict('passed', 'Artifact batch retains the fences.'), batchVerdict('passed', 'Source batch retains the fences.'))
  expect((await h.caps.review!.execute(h.lease())).outcome).toBe('passed')
  expect(h.requests).toHaveLength(2)
  const payloads = h.requests.map(request => JSON.parse(request.messages[0]!.content[0]!.text))
  expect(payloads[0].reviewTarget).toEqual({ repository: 'org/repo', pr: 17, headSha: HEAD, baseSha: BASE, allowedPaths: ['patches/JOB_COST_SUMMARY.patch'] })
  expect(payloads[1].reviewTarget).toEqual({ repository: 'other/repo', pr: 28, headSha: NEW, baseSha: BASE, allowedPaths: ['src/code.ts'] })
  for (const payload of payloads) {
    expect(Object.keys(payload).sort()).toEqual(['batch', 'requirements', 'reviewTarget'])
    expect(payload.bindings).toBeUndefined()
    expect(payload.reviewTarget.allowedPaths).toEqual(payload.batch.diff.files.map((file: { filename: string }) => file.filename))
  }
  const identitySets = payloads.map(payload => {
    const found: string[] = []
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>
        if (typeof object.repository === 'string' && typeof object.pr === 'number') found.push(`${object.repository}#${object.pr}`)
        Object.values(object).forEach(walk)
      }
    }
    walk(payload.reviewTarget); walk(payload.batch)
    return [...new Set(found)]
  })
  expect(identitySets).toEqual([['org/repo#17'], ['other/repo#28']])
  expect(h.requests[0]!.system).toContain('reviewTarget is the single authoritative identity')
  expect(h.requests[0]!.system).toContain('OUTER artifact filename')
  expect(h.requests[0]!.system).toContain('no path_note or any other additional key')
  expect(h.requests[0]!.system).toContain('exactly verdict, findings and rationale')
  expect(h.requests[0]!.system).toContain('concise')
})

it('reviews a file containing an embedded source patch as its outer artifact filename and rejects nested identities', async () => {
  const h = targetedFixture((_repository, pr) => pr === 17
    ? [artifactPatch('nested source diff for other/repo#28 ' + NEW + ' at src/nested.ts')]
    : [batchFile('src/code.ts', 10)])
  h.answer({ verdict: 'failed', findings: [{ repository: 'org/repo', pr: 17, headSha: HEAD, path: 'src/nested.ts', line: 2, severity: 'high', message: 'nested identity' }], rationale: 'Nested path used.' })
  expect((await h.caps.review!.execute(h.lease())).blocker).toContain('not bound to supplied diff')
  expect(store.db.prepare('SELECT * FROM delivery_capability_review').all()).toHaveLength(0)
  const first = JSON.parse(h.requests[0]!.messages[0]!.content[0]!.text)
  expect(first.reviewTarget).toMatchObject({ repository: 'org/repo', pr: 17, allowedPaths: ['patches/JOB_COST_SUMMARY.patch'] })
  expect(first.batch.diff.files[0]).toMatchObject({ filename: 'patches/JOB_COST_SUMMARY.patch', patch: expect.stringContaining('other/repo#28 ' + NEW) })
  h.answer({ verdict: 'failed', findings: [{ repository: 'org/repo', pr: 17, headSha: HEAD, path: 'patches/JOB_COST_SUMMARY.patch', line: 1, severity: 'high', message: 'Outer artifact patch retains a concrete defect.' }], rationale: 'Outer artifact path used.' },
    batchVerdict('passed', 'Source batch retains the fences.'))
  const outer = await h.caps.review!.execute(h.lease())
  expect(outer.outcome).toBe('failed')
  const saved = JSON.parse(String(store.db.prepare('SELECT value FROM delivery_capability_review WHERE id=?').get(h.lease().id)!.value))
  expect(saved.verdict).toMatchObject({ verdict: 'failed', findings: [{ repository: 'org/repo', pr: 17, path: 'patches/JOB_COST_SUMMARY.patch' }] })
})

it('rejects path_note and extra finding keys instead of legalizing or dropping them', async () => {
  const h = fixture(), l = h.lease()
  h.setVerdict({ verdict: 'passed', findings: [], rationale: 'ok', path_note: 'patches/JOB_COST_SUMMARY.patch' })
  expect((await h.caps.review!.execute(l)).outcome).toBe('uncertain')
  h.setVerdict({ verdict: 'failed', findings: [{ repository: 'org/repo', pr: 17, headSha: HEAD, path: 'src/code.ts', line: 1, severity: 'high', message: 'x', path_note: 'nested' }], rationale: 'bad' })
  expect((await h.caps.review!.execute(l)).outcome).toBe('uncertain')
  expect(store.db.prepare('SELECT * FROM delivery_capability_review').all()).toHaveLength(0)
})

it('drops only unknown null-valued review metadata and preserves every real finding exactly', async () => {
  const h = fixture(), l = h.lease()
  const findings = [
    { repository: 'org/repo', pr: 17, headSha: HEAD, path: 'src/code.ts', line: 5, severity: 'medium', message: 'In apply, a settlement with no sample returns before storing the replacement slot; later samples inflate attempts.', message_extra: null },
    { repository: 'org/repo', pr: 17, headSha: HEAD, path: 'src/code.ts', line: 9, severity: 'high', message: 'The `unattributed` flag is only ever set true and is never cleared after a same-step replacement.' },
  ]
  h.setVerdict({ verdict: 'failed', findings, rationale: 'Two concrete findings from the real preflight response.', path_note: null, message_extra: null })
  const result = await h.caps.review!.execute(l)
  expect(result.outcome).toBe('failed')
  const saved = JSON.parse(String(store.db.prepare('SELECT value FROM delivery_capability_review WHERE id=?').get(l.id)!.value))
  expect(saved.verdict.findings).toHaveLength(2)
  expect(saved.verdict.findings.map((finding: { line: number }) => finding.line)).toEqual([5, 9])
  expect(saved.verdict.findings.map((finding: { severity: string }) => finding.severity)).toEqual(['medium', 'high'])
  expect(saved.verdict.findings.map((finding: { message: string }) => finding.message)).toEqual(findings.map(finding => finding.message))
  expect(saved.verdict.findings.every((finding: Record<string, unknown>) => !('message_extra' in finding))).toBe(true)
  expect(saved.verdict).not.toHaveProperty('path_note'); expect(saved.verdict).not.toHaveProperty('message_extra')
})

it('accepts a passed review with null-only unknown root metadata without weakening strict schema', async () => {
  const h = fixture(), l = h.lease()
  h.setVerdict({ verdict: 'passed', findings: [], rationale: 'Complete batch satisfies intake.', extra: null })
  expect((await h.caps.review!.execute(l)).outcome).toBe('passed')
  const saved = JSON.parse(String(store.db.prepare('SELECT value FROM delivery_capability_review WHERE id=?').get(l.id)!.value))
  expect(saved.verdict).not.toHaveProperty('extra')
})

it('still rejects null core review keys instead of normalizing them', async () => {
  const h = fixture(), l = h.lease()
  h.setVerdict({ verdict: null, findings: [], rationale: 'bad', path_note: null })
  expect((await h.caps.review!.execute(l)).outcome).toBe('uncertain')
  h.setVerdict({ verdict: 'passed', findings: null, rationale: 'bad' })
  expect((await h.caps.review!.execute(l)).outcome).toBe('uncertain')
  h.setVerdict({ verdict: 'failed', findings: [{ repository: 'org/repo', pr: 17, headSha: HEAD, path: 'src/code.ts', line: 1, severity: null, message: 'x' }], rationale: 'bad' })
  expect((await h.caps.review!.execute(l)).outcome).toBe('uncertain')
  h.setVerdict({ verdict: 'failed', findings: [{ repository: 'org/repo', pr: 17, headSha: HEAD, path: 'src/code.ts', line: 1, severity: 'high', message: null }], rationale: 'bad' })
  expect((await h.caps.review!.execute(l)).outcome).toBe('uncertain')
  expect(store.db.prepare('SELECT * FROM delivery_capability_review').all()).toHaveLength(0)
})

it('keeps unknown non-null review metadata and objects present so strict schema still rejects them', async () => {
  const h = fixture(), l = h.lease()
  h.setVerdict({ verdict: 'passed', findings: [], rationale: 'ok', path_note: 'patches/JOB_COST_SUMMARY.patch' })
  expect((await h.caps.review!.execute(l)).outcome).toBe('uncertain')
  h.setVerdict({ verdict: 'passed', findings: [], rationale: 'ok', approved: true })
  expect((await h.caps.review!.execute(l)).outcome).toBe('uncertain')
  h.setVerdict({ verdict: 'passed', findings: [], rationale: 'ok', metadata: {} })
  expect((await h.caps.review!.execute(l)).outcome).toBe('uncertain')
  h.setVerdict({ verdict: 'failed', findings: [{ repository: 'org/repo', pr: 17, headSha: HEAD, path: 'src/code.ts', line: 1, severity: 'high', message: 'x', message_extra: 'not null' }], rationale: 'bad' })
  expect((await h.caps.review!.execute(l)).outcome).toBe('uncertain')
  expect(store.db.prepare('SELECT * FROM delivery_capability_review').all()).toHaveLength(0)
})

it('still rejects unbound finding identity and unknown paths even when unknown metadata is null', async () => {
  const h = fixture(), l = h.lease()
  h.setVerdict({ verdict: 'failed', findings: [{ repository: 'org/repo', pr: 17, headSha: NEW, path: 'src/code.ts', line: 1, severity: 'high', message: 'wrong head', message_extra: null }], rationale: 'bad' })
  expect((await h.caps.review!.execute(l)).blocker).toContain('not bound to supplied diff')
  h.setVerdict({ verdict: 'failed', findings: [{ repository: 'org/repo', pr: 17, headSha: HEAD, path: 'src/nested.ts', line: 1, severity: 'high', message: 'nested path', message_extra: null }], rationale: 'bad' })
  expect((await h.caps.review!.execute(l)).blocker).toContain('not bound to supplied diff')
  expect(store.db.prepare('SELECT * FROM delivery_capability_review').all()).toHaveLength(0)
})

it('never applies null-metadata canonicalization to advice responses', async () => {
  const h = fixture(); const d = deliveries.get('feature')!, action = d.nextAction!
  h.setVerdict({ disposition: 'take', actionId: action.id, fingerprint: action.fingerprint, rationale: 'Take the recorded next action.', path_note: null })
  await expect(recommendDeliveryAction(d, action, h.deps)).rejects.toThrow()
})

it('rejects a parsed root __proto__ object instead of inheriting injected verdict fields', async () => {
  const h = fixture(), l = h.lease()
  const raw = '{"__proto__":{"verdict":"passed","findings":[],"rationale":"injected prototype verdict"}}'
  h.stream.mockImplementationOnce(async function* () { yield { type: 'text-delta', text: raw }; yield { type: 'finish', reason: { kind: 'stop' } } })
  const blocked = await h.caps.review!.execute(l)
  expect(blocked.outcome).toBe('uncertain')
  expect(store.db.prepare('SELECT * FROM delivery_capability_review').all()).toHaveLength(0)
  expect(({} as Record<string, unknown>).verdict).toBeUndefined()
  expect(({} as Record<string, unknown>).findings).toBeUndefined()
  expect(({} as Record<string, unknown>).rationale).toBeUndefined()
  expect(Object.prototype).not.toHaveProperty('verdict')
  const withCore = '{"verdict":"passed","findings":[],"rationale":"own core","__proto__":{"verdict":"failed","findings":[],"rationale":"injected"}}'
  h.stream.mockImplementationOnce(async function* () { yield { type: 'text-delta', text: withCore }; yield { type: 'finish', reason: { kind: 'stop' } } })
  const rejected = await h.caps.review!.execute(l)
  expect(rejected.outcome).toBe('uncertain')
  expect(store.db.prepare('SELECT * FROM delivery_capability_review').all()).toHaveLength(0)
})

it('rejects a parsed finding __proto__ carrying identity fields instead of letting it pollute the finding', async () => {
  const h = fixture(), l = h.lease()
  const finding = '{"__proto__":{"repository":"org/repo","pr":17,"headSha":"' + HEAD + '","path":"src/code.ts","line":1,"severity":"high","message":"injected"},"message":"real message"}'
  const raw = '{"verdict":"failed","findings":[' + finding + '],"rationale":"adversarial finding metadata"}'
  h.stream.mockImplementationOnce(async function* () { yield { type: 'text-delta', text: raw }; yield { type: 'finish', reason: { kind: 'stop' } } })
  expect((await h.caps.review!.execute(l)).outcome).toBe('uncertain')
  expect(store.db.prepare('SELECT * FROM delivery_capability_review').all()).toHaveLength(0)
  expect(({} as Record<string, unknown>).repository).toBeUndefined()
  expect(({} as Record<string, unknown>).severity).toBeUndefined()
  expect(Object.prototype).not.toHaveProperty('repository')
})

it('gives advice bounded server-derived prepared-publication proof and separates source, artifact and target', async () => {
  const h = fixture(); const review = h.lease(); deliveries.complete(review, await h.caps.review!.execute(review))
  const prepared = { id: 'manifest', ticketId: 'original', decisionId: 'decision', repository: 'org/repo', pr: 17, headSha: HEAD,
    patchSha256: 'd'.repeat(64), environment: 'isolated-service@127.0.0.1:3082', preparedAt: '2026-11-06T00:00:02.000Z',
    scopeSha256: 'e'.repeat(64), components: ['dsh-superagent'], effects: ['Restart the exact existing service'],
    refs: [{ repository: 'org/repo', pr: 17, headSha: HEAD, baseSha: BASE }],
    proof: { observedAt: '2026-11-06T00:00:02.000Z', status: { checks: 'passed' as const, review: 'approved' as const }, verified: true,
      reviewer: 'Independent reviewer', reportSha256: 'f'.repeat(64), reviewExcerpt: 'Verified review excerpt for the exact pins.',
      checks: [{ name: 'pnpm test', completedAt: '2026-11-06T00:00:01.000Z', reportSha256: 'a'.repeat(64), excerpt: 'Full backend suite passed.' }],
      limitations: ['Native browser acceptance remains separate.'], counts: { checks: 1, limitations: 1 } } }
  const bound = deliveries.compareAndSwap('feature', deliveries.get('feature')!.revision, d => { d.preparedPublication = prepared })
  const action = bound.nextAction!
  let request: { messages: { content: { text: string }[] }[] } | undefined
  h.stream.mockImplementationOnce(async function* (value: unknown) {
    request = value as typeof request
    yield { type: 'text-delta', text: JSON.stringify({ disposition: 'take', actionId: action.id, fingerprint: action.fingerprint,
      rationale: 'Hand the exact prepared publication to the authorized publisher.' }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await recommendDeliveryAction(bound, action, h.deps)
  const payload = JSON.parse(request!.messages[0]!.content[0]!.text)
  expect(payload.preparedPublication).toMatchObject({ repository: 'org/repo', pr: 17, headSha: HEAD, environment: 'isolated-service@127.0.0.1:3082',
    proof: { verified: true, reviewer: 'Independent reviewer', reviewExcerpt: 'Verified review excerpt for the exact pins.',
      checks: [{ name: 'pnpm test', excerpt: 'Full backend suite passed.' }], limitations: ['Native browser acceptance remains separate.'] } })
  expect(payload.bindings.artifact).toBe('old-artifact')
  // The adviser receives the recorded owner and the next-stage owner instead of inferring either.
  expect(payload.owner).toBe('alice')
  expect(payload.stageOwner).toContain('authorized release operator through the protected publication gate')
  expect(payload.authorities).toEqual(['alice'])
  expect(payload.preparedPublication.totals).toEqual({ components: 1, effects: 1, refs: 1, checks: 1, limitations: 1 })
  expect(payload.proofState).toBe('verified-exact-pin-observation')
})

it('reports missing or unverified prepared proof as a hold-worthy unknown instead of assuming freshness', async () => {
  const h = fixture(); const review = h.lease(); deliveries.complete(review, await h.caps.review!.execute(review))
  const before = deliveries.get('feature')!
  const action = before.nextAction!
  const read = async (delivery: typeof before) => {
    let payload: { proofState: string } | undefined
    h.stream.mockImplementationOnce(async function* (request: unknown) {
      payload = JSON.parse((request as { messages: { content: { text: string }[] }[] }).messages[0]!.content[0]!.text)
      yield { type: 'text-delta', text: JSON.stringify({ disposition: 'hold', actionId: action.id, fingerprint: action.fingerprint,
        rationale: 'Verify the prepared publication before handing it off.' }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    await recommendDeliveryAction(delivery, action, h.deps)
    return payload!.proofState
  }
  expect(await read(before)).toBe('missing')
  const prepared = { id: 'manifest', ticketId: 'original', decisionId: 'decision', repository: 'org/repo', pr: 17, headSha: HEAD,
    patchSha256: 'd'.repeat(64), environment: 'isolated', preparedAt: '2026-11-06T00:00:02.000Z', refs: [{ repository: 'org/repo', pr: 17, headSha: HEAD }] }
  const withPrepared = deliveries.compareAndSwap(before.id, before.revision, d => { d.preparedPublication = prepared })
  expect(await read(withPrepared)).toBe('proof-not-recorded')
})
