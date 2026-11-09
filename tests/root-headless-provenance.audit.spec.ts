import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { FindingRuntime } from '../src/app/finding-runtime.ts'
import { Engine } from '../src/core/engine.ts'
import { key } from '../src/core/index.ts'
import { FindingError, isReservedActor } from '../src/app/finding.ts'
import { readFindingCoordinationInstruction } from '../src/app/finding-coordination.ts'
import { adviceContext } from '../src/app/advice-context.ts'

describe('root headless provenance and authority audit', () => {
  it('real delegated retry dispatch preserves coordinator identity and never becomes a fresh human approval', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'headless-provenance-'))
    const store = new Store(join(dir, 'db.sqlite'))
    const engine = new Engine({
      repo: store,
      policy: () => ({ version: 'p1', paused: false }),
      executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
      outbox: { send: vi.fn(), status: vi.fn(), withdraw: vi.fn() },
    } as any)
    store.saveSettings({ executor: { model: { provider: 'configured', model: 'executor' }, maxWorkers: 1 } })
    const runtime = new FindingRuntime({ store, engine, ctx: { get: vi.fn(), llm: {} } as any, commands: { gh: vi.fn() } as any, lifetime: new AbortController().signal })
    try {
      const f = runtime.store.observe({ dedupKey: 'delegated', title: 'Bounded repair', problem: 'Audit provenance', scope: 'Same approved repair only', owner: 'coordinator', kind: 'fix', requirements: ['Preserve exact identity'], repository: 'org/repo', occurrence: { id: 'one', reference: 'test', evidence: 'isolated' } })
      runtime.store.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' }, 'local-operator')
      await runtime.request()
      const running = runtime.store.get(f.id)!
      runtime.store.markReview(f.id, { reference: 'isolated-review', summary: 'Needs correction', recordedAt: new Date().toISOString(), state: 'blocked' })
      const blocked = runtime.store.get(f.id)!
      const reopened = runtime.review(f.id, { revision: blocked.revision, decision: 'retry_scope' }, 'codex-coordinator')
      runtime.store.confirm(f.id, { revision: reopened.revision, choiceId: 'fix_now' }, 'codex-coordinator', true)
      await runtime.request()
      const next = runtime.store.get(f.id)!
      const ticket = store.tickets.get(next.job!.ticketId!)!
      const trigger = store.triggers.get(key('finding-trigger', next.job!.id))!
      expect({
        confirmActor: next.confirmation?.actor,
        dispatchActor: next.audit.filter(x => x.event === 'dispatched').at(-1)?.actor,
        mandateActor: ticket.mandate.actor.id,
        triggerActor: trigger.actor.id,
        human: trigger.human,
      }).toEqual({
        confirmActor: 'codex-coordinator',
        dispatchActor: 'codex-coordinator',
        mandateActor: 'codex-coordinator',
        triggerActor: 'codex-coordinator',
        human: false,
      })
      expect(trigger.text).toContain('Delegated coordinator codex-coordinator continued bounded fix finding')
      expect(trigger.text).not.toContain('Local operator confirmed bounded fix finding')
      expect(ticket.mandate.basis.sender).toBe('codex-coordinator')
    } finally {
      await runtime.stop()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('native protected confirmation preserves real human behavior and local-operator provenance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-provenance-'))
    const store = new Store(join(dir, 'db.sqlite'))
    const engine = new Engine({
      repo: store,
      policy: () => ({ version: 'p1', paused: false }),
      executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
      outbox: { send: vi.fn(), status: vi.fn(), withdraw: vi.fn() },
    } as any)
    store.saveSettings({ executor: { model: { provider: 'configured', model: 'executor' }, maxWorkers: 1 } })
    const runtime = new FindingRuntime({ store, engine, ctx: { get: vi.fn(), llm: {} } as any, commands: { gh: vi.fn() } as any, lifetime: new AbortController().signal })
    try {
      const f = runtime.store.observe({ dedupKey: 'native', title: 'Native repair', problem: 'Human observation', scope: 'Direct repair only', owner: 'operator', kind: 'fix', requirements: ['Preserve human origin'], repository: 'org/repo', occurrence: { id: 'native-1', reference: 'test-native', evidence: 'direct' } })
      runtime.store.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' }, 'local-operator')
      await runtime.request()
      const running = runtime.store.get(f.id)!
      const ticket = store.tickets.get(running.job!.ticketId!)!
      const trigger = store.triggers.get(key('finding-trigger', running.job!.id))!
      expect({
        confirmActor: running.confirmation?.actor,
        dispatchActor: running.audit.filter(x => x.event === 'dispatched').at(-1)?.actor,
        mandateActor: ticket.mandate.actor.id,
        triggerActor: trigger.actor.id,
        human: trigger.human,
      }).toEqual({
        confirmActor: 'local-operator',
        dispatchActor: 'local-operator',
        mandateActor: 'local-operator',
        triggerActor: 'local-operator',
        human: true,
      })
      expect(trigger.text).toContain('Local operator confirmed bounded fix finding')
      expect(ticket.mandate.basis.sender).toBe('local-operator')
    } finally {
      await runtime.stop()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed for untrusted or reserved actor impersonation in headless coordination', () => {
    expect(isReservedActor('local-operator')).toBe(true)
    expect(isReservedActor('operator')).toBe(true)
    expect(isReservedActor('native')).toBe(true)
    expect(isReservedActor('local-admin')).toBe(true)
    expect(isReservedActor('native-runner')).toBe(true)
    expect(isReservedActor('codex-coordinator')).toBe(false)
    expect(isReservedActor('ci-coordinator')).toBe(false)

    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'reserved-actor-')))
    try {
      const id = 'a338ad44-893d-4ebf-b8ff-aa0c3067e384'
      const now = Date.now()
      const finding = {
        id,
        revision: 3,
        state: 'awaiting_decision',
        scope: 'Bounded repair',
        choices: [{ id: 'fix_now' }],
        audit: [
          { event: 'confirmed', actor: 'local-operator', detail: 'fix_now', at: new Date(now - 2000).toISOString() },
          { event: 'dispatched', actor: 'local-operator', detail: 'ticket/assign', at: new Date(now - 1800).toISOString() },
          { event: 'blocked', actor: 'finding-runtime', detail: 'Review needed', at: new Date(now - 1500).toISOString() },
        ],
        priorJobs: [{ id: `finding:${id}:r1` }],
      }

      for (const reserved of ['local-operator', 'operator', 'native', 'local-agent']) {
        const instruction = {
          version: 1,
          authority: 'explicit_operator_coordination',
          findingId: id,
          revision: 3,
          action: 'confirm',
          choiceId: 'fix_now',
          actorId: reserved,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 60000).toISOString(),
          source: { reference: 'test', reason: 'Impersonation must fail closed' },
        }
        const file = join(dir, `${reserved}.json`)
        writeFileSync(file, JSON.stringify(instruction), { mode: 0o600 })
        expect(() => readFindingCoordinationInstruction(file, finding as any, now)).toThrow(
          /Headless instruction cannot claim reserved local-operator or native actor origin/,
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('delegated retry respects question and reply semantics without corrupting provenance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'headless-replies-'))
    const store = new Store(join(dir, 'db.sqlite'))
    const engine = new Engine({
      repo: store,
      policy: () => ({ version: 'p1', paused: false }),
      executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
      outbox: { send: vi.fn(), status: vi.fn(), withdraw: vi.fn() },
    } as any)
    store.saveSettings({ executor: { model: { provider: 'configured', model: 'executor' }, maxWorkers: 1 } })
    const runtime = new FindingRuntime({ store, engine, ctx: { get: vi.fn(), llm: {} } as any, commands: { gh: vi.fn() } as any, lifetime: new AbortController().signal })
    try {
      const f = runtime.store.observe({ dedupKey: 'replies', title: 'Replies test', problem: 'Check replies', scope: 'Questions', owner: 'coordinator', kind: 'fix', requirements: ['Preserve semantics'], repository: 'org/repo', occurrence: { id: 'r1', reference: 'ref', evidence: 'ev' } })
      runtime.store.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' }, 'local-operator')
      await runtime.request()
      runtime.store.markReview(f.id, { reference: 'r1', summary: 'Blocked', recordedAt: new Date().toISOString(), state: 'blocked' })
      const blocked = runtime.store.get(f.id)!
      const reopened = runtime.review(f.id, { revision: blocked.revision, decision: 'retry_scope' }, 'codex-coordinator')
      runtime.store.confirm(f.id, { revision: reopened.revision, choiceId: 'fix_now' }, 'codex-coordinator', true)
      await runtime.request()

      const current = runtime.store.get(f.id)!
      const ticketId = current.job!.ticketId!

      // Worker asks a question via report
      engine.report(ticketId, { state: 'progress', summary: 'Need clarification', question: 'Confirm boundary?' })
      const ticketWithQuestion = store.tickets.get(ticketId)!
      expect(ticketWithQuestion.attention?.question).toBe('Confirm boundary?')

      // Operator/main session replies to attention question
      ticketWithQuestion.channels = [{ source: 'test', thread: 'channel-1', address: {} }]
      store.tickets.save(ticketWithQuestion)
      const reply = engine.reply({ purpose: 'attention', ticketId, question: 'Confirm boundary?', text: 'Boundary confirmed.' })
      expect(reply.status).toBe('pending')

      // Worker updates and finishes with ready report
      engine.report(ticketId, { state: 'ready', summary: 'Ready with verification' })
      const ticketAfterReady = store.tickets.get(ticketId)!
      expect(ticketAfterReady.attention).toBeUndefined()

      runtime.reconcile()
      const blockedAfterReport = runtime.store.get(f.id)!
      expect(blockedAfterReport.state).toBe('blocked')

      // Provenance remains intact
      expect(ticketAfterReady.mandate.actor.id).toBe('codex-coordinator')
      const trigger = store.triggers.get(key('finding-trigger', current.job!.id))!
      expect(trigger.actor.id).toBe('codex-coordinator')
      expect(trigger.human).toBe(false)
    } finally {
      await runtime.stop()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('current helper context derives bounded facts for delegated finding ticket without human counterfeiting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'headless-helper-'))
    const store = new Store(join(dir, 'db.sqlite'))
    const engine = new Engine({
      repo: store,
      policy: () => ({ version: 'p1', paused: false }),
      executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
      outbox: { send: vi.fn(), status: vi.fn(), withdraw: vi.fn() },
    } as any)
    store.saveSettings({ executor: { model: { provider: 'configured', model: 'executor' }, maxWorkers: 1 } })
    const runtime = new FindingRuntime({ store, engine, ctx: { get: vi.fn(), llm: {} } as any, commands: { gh: vi.fn() } as any, lifetime: new AbortController().signal })
    try {
      const f = runtime.store.observe({ dedupKey: 'helper', title: 'Helper context test', problem: 'Check helper context', scope: 'Helper test scope', owner: 'coordinator', kind: 'fix', requirements: ['Test helper context'], repository: 'org/repo', occurrence: { id: 'h1', reference: 'ref', evidence: 'ev' } })
      runtime.store.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' }, 'local-operator')
      await runtime.request()
      runtime.store.markReview(f.id, { reference: 'h1', summary: 'Blocked', recordedAt: new Date().toISOString(), state: 'blocked' })
      const blocked = runtime.store.get(f.id)!
      const reopened = runtime.review(f.id, { revision: blocked.revision, decision: 'retry_scope' }, 'codex-coordinator')
      runtime.store.confirm(f.id, { revision: reopened.revision, choiceId: 'fix_now' }, 'codex-coordinator', true)
      await runtime.request()

      const current = runtime.store.get(f.id)!
      const ticket = store.tickets.get(current.job!.ticketId!)!
      const context = adviceContext(ticket)

      expect(context).toContain('Helper test scope')
      expect(context).toContain('task')
      expect(context).not.toContain('RELEASE COMPLETE')
    } finally {
      await runtime.stop()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('idempotent redispatch preserves ticket and original triggers while rejecting altered scope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'headless-idempotent-'))
    const store = new Store(join(dir, 'db.sqlite'))
    const engine = new Engine({
      repo: store,
      policy: () => ({ version: 'p1', paused: false }),
      executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
      outbox: { send: vi.fn(), status: vi.fn(), withdraw: vi.fn() },
    } as any)
    store.saveSettings({ executor: { model: { provider: 'configured', model: 'executor' }, maxWorkers: 1 } })
    try {
      const assignment = {
        jobId: 'finding:test:r2',
        findingId: 'test-finding-id',
        title: 'Idempotency test',
        scope: 'Original scope',
        repository: 'org/repo',
        text: 'Delegated coordinator codex-coordinator continued bounded fix finding test-finding-id; job finding:test:r2.',
        actorId: 'codex-coordinator',
        human: false,
      }
      const ticket1 = engine.dispatchFinding(assignment)
      const ticket2 = engine.dispatchFinding(assignment)
      expect(ticket2.id).toBe(ticket1.id)

      expect(() => engine.dispatchFinding({ ...assignment, scope: 'Altered scope' })).toThrow(/Finding job scope mismatch/)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
