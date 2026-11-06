import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { FindingRuntime, recommendFindingAction } from '../src/app/finding-runtime.ts'
import { DeliveryStore } from '../src/app/feature-delivery.ts'
import { Engine } from '../src/core/engine.ts'
import type { EngineOptions } from '../src/core/part.ts'
import type { Commands } from '../src/infra/commands.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { DshExecutor, type ExecutorHost } from '../src/executor/dsh.ts'

const cleanup: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); for (const done of cleanup.splice(0).reverse()) done() })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'finding-runtime-'))
  const store = new Store(join(directory, 'db.sqlite'))
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  store.saveSettings({ executor: { model: { provider: 'configured', model: 'executor' } } })
  store.db.exec('CREATE TABLE test_native_launch (ticket TEXT PRIMARY KEY, assignment TEXT)')
  const start = vi.fn((ticket: { id: string }, assignment: { id: string }) => {
    store.db.prepare('INSERT INTO test_native_launch VALUES (?,?)').run(ticket.id, assignment.id)
  })
  const engine = new Engine({ repo: store, policy: () => ({ version: 'p1', paused: false }), executor: { start, deliver: vi.fn(), stop: vi.fn() } } as unknown as EngineOptions)
  const note = vi.spyOn(engine, 'note')
  const stream = vi.fn(async function* (request: { messages: { content: { text: string }[] }[] }) {
    const input = JSON.parse(request.messages[0]!.content[0]!.text)
    yield { type: 'text-delta', text: JSON.stringify({ findingId: input.id, revision: input.revision, choiceId: 'queue_next', rationale: 'Verify the bounded regression offline after current work.' }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const resolve = vi.fn(async () => ({ provider: 'configured', model: 'executor' }))
  const ctx = { llm: { resolveCallConfig: resolve, stream }, get: vi.fn() } as unknown as Context
  const commands = { gh: vi.fn() } as unknown as Commands
  const deps = { store, engine, ctx, commands, lifetime: new AbortController().signal }
  const runtime = new FindingRuntime(deps)
  cleanup.push(() => runtime.stop())
  const observe = (dedupKey: string, existingDeliveryId?: string) => runtime.store.observe({ dedupKey, title: dedupKey, problem: 'Observed regression', scope: 'Verify only the corrected regression offline', owner: 'team', kind: 'verification', requirements: ['Record actual offline evidence'], repository: 'org/repo', occurrence: { id: dedupKey, reference: 'issue/171', evidence: 'Observed failure' }, ...(existingDeliveryId ? { existingDeliveryId } : {}) })
  const confirm = (id: string, choiceId: 'fix_now' | 'queue_next' = 'queue_next') => runtime.store.confirm(id, { revision: runtime.store.get(id)!.revision, choiceId })
  return { deps, runtime, store, engine, start, note, resolve, stream, observe, confirm }
}
it('calls the real configured model with no tools and persists attributable advice', async () => {
  const h = fixture(), finding = h.observe('one')
  await h.runtime.request()
  expect(h.resolve).toHaveBeenCalledWith({ provider: 'configured', model: 'executor' }, expect.any(AbortSignal))
  expect(h.stream).toHaveBeenCalledWith(expect.objectContaining({ tools: [], system: expect.stringContaining('untrusted data') }))
  expect(h.runtime.store.get(finding.id)?.recommendation).toMatchObject({ choiceId: 'queue_next', provider: 'configured / executor', revision: finding.revision })
  expect(h.start).not.toHaveBeenCalled()
  expect(h.deps.commands.gh).not.toHaveBeenCalled()
})
it('records honest configured-model failure without fabricating provider advice or preventing confirmation', async () => {
  const h = fixture(), finding = h.observe('one')
  h.resolve.mockRejectedValue(new Error('Configured provider unavailable'))
  await h.runtime.request()
  expect(h.runtime.store.get(finding.id)?.recommendation).toBeUndefined()
  expect(h.runtime.store.get(finding.id)?.recommendationError).toContain('Configured provider unavailable')
  h.confirm(finding.id)
  await h.runtime.request()
  expect(h.runtime.store.get(finding.id)?.state).toBe('running')
  expect(h.start).toHaveBeenCalledTimes(1)
})
it('dispatches FIFO once across concurrent requests and restart; reports require review, never automatic resolution', async () => {
  const h = fixture(), first = h.observe('first'), second = h.observe('second')
  h.confirm(first.id, 'queue_next'); h.confirm(second.id, 'fix_now')
  await Promise.all([h.runtime.request(), h.runtime.request(), h.runtime.request()])
  expect(h.start).toHaveBeenCalledTimes(1)
  const dispatched = h.runtime.store.get(first.id)!
  expect(dispatched.state).toBe('running'); expect(h.runtime.store.get(second.id)?.state).toBe('queued')
  const restart = new FindingRuntime(h.deps)
  await restart.request()
  expect(h.start).toHaveBeenCalledTimes(1)
  const ticket = h.store.tickets.get(dispatched.job!.ticketId!)!
  h.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
  h.engine.report(ticket.id, { state: 'ready', summary: 'Offline evidence: regression test passes; independent review needed' })
  await restart.request()
  expect(restart.store.get(first.id)).toMatchObject({ state: 'blocked', reports: [{ reference: `ticket/${ticket.id}/report/${ticket.assignments[0]!.id}`, evidence: expect.stringContaining('Offline evidence'), nextDecision: expect.stringContaining('Review') }] })
  expect(restart.store.get(second.id)?.state).toBe('running')
  expect(h.start).toHaveBeenCalledTimes(2)
  expect(h.note).not.toHaveBeenCalled()
  expect(h.store.tickets.get(ticket.id)?.assignments).toHaveLength(1)
  restart.stop()
})
it('keeps a 16385-character actual native report linked and starts the next queued finding', async () => {
  const h = fixture(), first = h.observe('long-report'), second = h.observe('after-long-report')
  h.confirm(first.id); h.confirm(second.id)
  await h.runtime.request()
  const job = h.runtime.store.get(first.id)!.job!
  h.engine.assignmentStarted(job.ticketId!, job.assignmentId!)
  const summary = 'x'.repeat(16_385)
  h.engine.report(job.ticketId!, { state: 'ready', summary })
  await expect(h.runtime.request()).resolves.toBeUndefined()
  expect(h.runtime.store.get(first.id)?.state).toBe('blocked')
  expect(h.runtime.store.get(first.id)?.reports[0]).toMatchObject({ reference: `ticket/${job.ticketId}/report/${job.assignmentId}`,
    summaryTruncated: true, originalLength: 16_385, reportSummarySha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(h.store.tickets.get(job.ticketId!)?.assignments[0]?.report?.summary).toBe(summary)
  expect(h.runtime.store.get(second.id)?.state).toBe('running')
})
it('isolates malformed native report timestamps instead of aborting reconciliation or FIFO dispatch', async () => {
  const h = fixture(), first = h.observe('malformed-report'), second = h.observe('after-malformed-report')
  h.confirm(first.id); h.confirm(second.id)
  await h.runtime.request()
  const job = h.runtime.store.get(first.id)!.job!
  const ticket = h.store.tickets.get(job.ticketId!)!
  ticket.assignments[0]!.report = { state: 'ready', summary: 'Persisted malformed report', at: 'not-a-time' }
  h.store.tickets.save(ticket)
  await expect(h.runtime.request()).resolves.toBeUndefined()
  const blocked = h.runtime.store.get(first.id)!
  expect(blocked.state).toBe('blocked')
  expect(blocked.blocker).toContain('Finding report reconciliation failed')
  expect(blocked.blocker).toContain(`ticket/${job.ticketId}/report/${job.assignmentId}`)
  expect(h.runtime.store.get(second.id)?.state).toBe('running')
  expect(h.start).toHaveBeenCalledTimes(2)
})
it('atomically commits native ticket, executor effect, finding job, and existing delivery audit relation', async () => {
  const h = fixture(), deliveries = new DeliveryStore(h.store.db)
  deliveries.create({ id: 'existing', title: 'Existing aggregate', owner: 'original', workers: ['ended-original'], authorities: ['original-authority'], requirements: ['Original immutable requirements'], bindings: { repository: 'org/repo', sourceIssue: 171, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), refs: [] } })
  const before = deliveries.get('existing')!
  const finding = h.observe('verify', 'existing'); h.confirm(finding.id)
  const realMark = h.runtime.store.markDispatched.bind(h.runtime.store)
  vi.spyOn(h.runtime.store, 'markDispatched').mockImplementationOnce(() => { throw new Error('Injected atomic handoff failure') })
  await expect(h.runtime.request()).rejects.toThrow('Injected atomic handoff failure')
  expect(h.store.tickets.list()).toHaveLength(0)
  expect(h.store.db.prepare('SELECT * FROM test_native_launch').all()).toHaveLength(0)
  expect(h.runtime.store.get(finding.id)?.state).toBe('queued')
  expect(deliveries.get('existing')).toEqual(before)
  vi.mocked(h.runtime.store.markDispatched).mockImplementation(realMark)
  await h.runtime.request()
  const dispatched = h.runtime.store.get(finding.id)!
  expect(deliveries.list()).toHaveLength(1)
  const after = deliveries.get('existing')!
  expect(after.workers).toEqual(['ended-original'])
  const native = h.store.tickets.get(dispatched.job!.ticketId!)!
  expect(h.store.triggers.get(native.origin.triggerId)?.text).toContain('Original immutable requirements')
  expect(after.authorities).toEqual(before.authorities)
  expect(after.requirements).toEqual(before.requirements)
  expect(after.bindings).toEqual(before.bindings)
  expect(after.audit.at(-1)?.event).toContain(`finding-assignment:${finding.id}`)
  expect(h.store.db.prepare('SELECT * FROM test_native_launch').all()).toHaveLength(1)
})
it('links terminal delivery history without mutation or starving the next FIFO finding', async () => {
  const h = fixture(), deliveries = new DeliveryStore(h.store.db)
  const existing = deliveries.create({ id: 'terminal', title: 'Settled aggregate', owner: 'original', workers: ['ended-original'], authorities: ['original'], requirements: ['Original requirements'], bindings: { repository: 'org/repo', sourceIssue: 171, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), refs: [] } })
  deliveries.compareAndSwap(existing.id, existing.revision, d => { d.state = 'cancelled' })
  const before = deliveries.get(existing.id)!
  const first = h.observe('terminal-verification', existing.id), second = h.observe('later')
  h.confirm(first.id); h.confirm(second.id)
  await h.runtime.request()
  const linked = h.runtime.store.get(first.id)!
  expect(linked).toMatchObject({ state: 'running', existingDeliveryId: existing.id, job: { ticketId: expect.any(String) } })
  expect(deliveries.get(existing.id)).toEqual(before)
  const ticket = h.store.tickets.get(linked.job!.ticketId!)!
  h.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
  h.engine.report(ticket.id, { state: 'ready', summary: 'Verification evidence recorded, review required' })
  await h.runtime.request()
  expect(h.runtime.store.get(first.id)?.state).toBe('blocked')
  expect(h.runtime.store.get(second.id)?.state).toBe('running')
  expect(deliveries.get(existing.id)).toEqual(before)
})
it('persists one actual DshExecutor launch effect atomically and never runs live operations', async () => {
  const h = fixture(), board = new HealthBoard(), effects = new Effects(h.store, board)
  const executor = new DshExecutor({ store: h.store, effects, paused: () => false, machine: { stateDir: '/isolated-test-only' } } as unknown as ExecutorHost)
  cleanup.push(() => executor.dispose())
  const engine = new Engine({ repo: h.store, policy: () => ({ version: 'p1', paused: false }), executor,
    prepareTicket: (ticket: Parameters<DshExecutor['prepare']>[0], outcome: Parameters<DshExecutor['prepare']>[1]) => executor.prepare(ticket, outcome) } as unknown as EngineOptions)
  const runtime = new FindingRuntime({ ...h.deps, engine })
  const finding = h.observe('native-effect'); h.confirm(finding.id)
  vi.spyOn(runtime.store, 'markDispatched').mockImplementationOnce(() => { throw new Error('Rollback native effect') })
  await expect(runtime.request()).rejects.toThrow('Rollback native effect')
  expect(h.store.db.prepare("SELECT * FROM effect WHERE kind='launch'").all()).toHaveLength(0)
  expect(h.store.tickets.list()).toHaveLength(0)
  vi.mocked(runtime.store.markDispatched).mockRestore()
  await runtime.request(); await runtime.request()
  const job = runtime.store.get(finding.id)!.job!
  const row = h.store.db.prepare("SELECT * FROM effect WHERE kind='launch'").all()
  expect(row).toHaveLength(1)
  expect(JSON.parse(String(row[0]!.value))).toEqual({ ticketId: job.ticketId, assignmentId: job.assignmentId })
  expect(h.store.tickets.get(job.ticketId!)?.execution?.assignment).toContain('No publication, merge, deployment')
  await runtime.stop()
})
it('retires blocked native work and holds fresh recovery dispatch until its actual background stop completes', async () => {
  const h = fixture(), board = new HealthBoard(), effects = new Effects(h.store, board)
  let session = '', jobStatus = 'running'
  let collect!: () => void
  const collected = new Promise<void>(resolve => { collect = resolve })
  const agent = { status: 'running', cancel: vi.fn(() => { agent.status = 'idle' }), whenIdle: async () => {} }
  const historicalChild = { status: 'idle' }
  const jobs = { list: (caller: string) => caller === session ? [{ id: 'background', owner: session, status: jobStatus }] : [],
    wait: vi.fn(async () => { await collected; return { status: jobStatus } }), kill: vi.fn(() => { jobStatus = 'stopping' }) }
  const subagents = { listChildren: vi.fn(async (parent: string) => parent === session ? [{ id: 'historical-idle-child' }] : []),
    drainChildren: vi.fn(async () => {}), waitForChildren: vi.fn(async () => false) }
  const ctx = { agents: { get: (id: string) => id === session ? agent : id === 'historical-idle-child' ? historicalChild : undefined },
    get: (service: string) => service === 'jobs' ? jobs : service === 'subagents' ? subagents : undefined } as unknown as Context
  const executor = new DshExecutor({ store: h.store, context: ctx, effects, paused: () => false, health: board.claim('worker'),
    machine: { stateDir: '/isolated-test-only' }, lifetime: h.deps.lifetime } as unknown as ExecutorHost)
  cleanup.push(() => executor.dispose())
  const engine = new Engine({ repo: h.store, policy: () => ({ version: 'p1', paused: false }), executor } as unknown as EngineOptions)
  const runtime = new FindingRuntime({ ...h.deps, engine, isQuiescent: ticket => executor.quiescent(ticket) })
  const finding = h.observe('busy-recovery'); h.confirm(finding.id)
  await runtime.request()
  const original = runtime.store.get(finding.id)!.job!
  session = `worker-${original.ticketId}`
  engine.assignmentStarted(original.ticketId!, original.assignmentId!)
  engine.report(original.ticketId!, { state: 'blocked', summary: 'Cannot proceed; review and fresh bounded authority needed' })
  expect(h.store.tickets.get(original.ticketId!)?.assignments[0]?.state).toBe('ended')
  expect(agent.cancel).toHaveBeenCalled()
  expect(jobs.kill).toHaveBeenCalled()
  await runtime.request()
  const blocked = runtime.store.get(finding.id)!
  runtime.store.review(finding.id, { revision: blocked.revision, decision: 'retry_scope' })
  runtime.store.confirm(finding.id, { revision: runtime.store.get(finding.id)!.revision, choiceId: 'fix_now' })
  await runtime.request()
  expect(runtime.store.get(finding.id)?.state).toBe('queued')
  expect(h.store.tickets.list()).toHaveLength(1)
  expect(await executor.quiescent(h.store.tickets.get(original.ticketId!)!)).toBe(false)
  jobStatus = 'completed'; collect()
  // stopBackground drains children after job collection; wait through its asynchronous stop chain.
  await vi.waitFor(async () => { expect(await executor.quiescent(h.store.tickets.get(original.ticketId!)!)).toBe(true) })
  await runtime.request()
  const recovered = runtime.store.get(finding.id)!
  expect(recovered.state).toBe('running')
  expect(recovered.job!.ticketId).not.toBe(original.ticketId)
  expect(h.store.tickets.list()).toHaveLength(2)
  expect(h.store.db.prepare("SELECT * FROM effect WHERE kind='launch'").all()).toHaveLength(2)
  expect(h.store.tickets.get(original.ticketId!)?.assignments[0]?.report?.state).toBe('blocked')
  await runtime.stop()
})
it('awaits cancellation on stop without persisting late model advice', async () => {
  const h = fixture(), finding = h.observe('cancel-advice')
  let entered!: () => void; let finish!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const release = new Promise<void>(resolve => { finish = resolve })
  h.stream.mockImplementationOnce(async function* () { entered(); await release; yield { type: 'finish', reason: { kind: 'stop' } } })
  const pass = h.runtime.request()
  await started
  await h.runtime.stop()
  await pass
  expect(h.runtime.store.get(finding.id)?.recommendation).toBeUndefined()
  expect(h.runtime.store.get(finding.id)?.recommendationError).toBeUndefined()
  finish()
})
it('rejects intake and dispatch for a different configured repository', async () => {
  const h = fixture(), runtime = new FindingRuntime({ ...h.deps, repository: () => 'other/repo' })
  const finding = h.observe('wrong-repository')
  expect(() => runtime.observe({ ...finding, occurrence: finding.occurrences[0]! } as never)).toThrow('configured deployment repository')
  h.confirm(finding.id); await runtime.request()
  expect(runtime.store.get(finding.id)).toMatchObject({ state: 'blocked', blocker: expect.stringContaining('configured deployment repository') })
  expect(h.start).not.toHaveBeenCalled()
  await runtime.stop()
})
it('rejects model advice for another finding rather than accepting substituted scope', async () => {
  const h = fixture(), finding = h.observe('one')
  h.stream.mockImplementationOnce(async function* () {
    yield { type: 'text-delta', text: JSON.stringify({ findingId: 'other', revision: 1, choiceId: 'fix_now', rationale: 'Wrong scope' }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await expect(recommendFindingAction(finding, h.deps)).rejects.toThrow()
  expect(h.start).not.toHaveBeenCalled()
})
