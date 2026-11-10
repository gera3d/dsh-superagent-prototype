import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { Engine } from '../src/core/engine.ts'
import { DshExecutor } from '../src/executor/dsh.ts'

describe('R3 reproduction: worker report with coordinator non-human trigger does not stick', () => {
  let dir: string, work: string, store: Store, engine: Engine, executor: DshExecutor, ticketId: string, coordinatorTriggerId: string
  const agent = {
    id: 'worker',
    status: 'idle',
    whenIdle: async () => {},
    session: {
      snapshotEvents: () => [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'turn/end', data: { turn: 1 } },
      ],
      requestHeader: () => ({ config: { provider: 'antigravity', model: 'gemini-3.8-flash' } }),
    },
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'r3-coord-'))
    work = join(dir, 'work')
    mkdirSync(work)
    store = new Store(join(dir, 'state.sqlite'))
    store.saveSettings({ executor: { model: { provider: 'antigravity', model: 'gemini-3.8-flash' }, maxWorkers: 1 } } as never)
    engine = new Engine({
      repo: store,
      policy: () => ({ version: 'p1', paused: false }),
      executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    } as never)

    // Dispatch finding with non-human coordinator trigger
    let ticket = engine.dispatchFinding({
      jobId: 'finding:r3-test:r1',
      findingId: 'r3-finding',
      title: 'Fix issue',
      scope: 'Bounded test',
      repository: 'org/repo',
      actorId: 'codex-coordinator',
      actorSource: 'coordinator',
      human: false,
      text: 'Test finding dispatch',
    })
    coordinatorTriggerId = ticket.origin.triggerId
    expect(store.triggers.get(coordinatorTriggerId)?.human).toBe(false)

    if (!ticket.execution?.directory) {
      ticket = { ...ticket, execution: { name: 'r3-work', directory: work, text: 'Test' } } as never
      store.tickets.save(ticket)
    }
    if (ticket.assignments.at(-1)?.state !== 'running') {
      engine.assignmentStarted(ticket.id, ticket.assignments.at(-1)!.id)
    }
    ticketId = ticket.id

    executor = new DshExecutor({
      store: {
        tickets: store.tickets,
        triggers: store.triggers,
        settings: () => store.settings(),
        set: store.set.bind(store),
        afterCommit: store.afterCommit.bind(store),
        atomic: store.atomic.bind(store),
      },
      engine,
      context: { get: () => undefined, agents: new Map() },
      effects: { handle: () => {}, enqueue: () => {} },
      sessions: { relay: () => {}, selectModel: async () => {}, prompt: async () => {} },
      health: { get: () => undefined, set: () => {} },
      machine: { stateDir: dir },
      lifetime: new AbortController().signal,
      closing: () => false,
      paused: () => false,
      environment: () => [],
    } as never)
  })

  afterEach(() => {
    executor.dispose()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  for (const kind of ['unknown', 'foreign-human']) it(`rejects ${kind} report correlation without consuming ready`, async () => {
    const t = store.tickets.get(ticketId)!, assignment = t.assignments.at(-1)!
    let reply = 'missing-trigger'
    if (kind === 'foreign-human') {
      const foreign = engine.dispatchFinding({ jobId: 'foreign-job', findingId: 'foreign-finding', title: 'Other scope', scope: 'Other bounded scope', repository: 'org/other', actorId: 'operator', actorSource: 'local', human: true, text: 'Other scope' })
      reply = foreign.origin.triggerId
    }
    writeFileSync(join(work, '.dsh-report.json'), JSON.stringify({ state: 'ready', summary: 'Unrelated report correlation', ticket_id: t.id, assignment_id: assignment.id, turn_id: 1, reply_to_trigger_id: reply, at: new Date().toISOString() }))
    await (executor as any).workerIdle(t, assignment, agent).catch(() => {})
    expect(store.tickets.get(ticketId)!.assignments.at(-1)!.report?.state).not.toBe('ready')
    expect(readdirSync(work).filter(f => f.startsWith('.dsh-report.consumed.'))).toHaveLength(0)
  })
})
