import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { Engine } from '../src/core/engine.ts'
import { DshExecutor } from '../src/executor/dsh.ts'

/**
 * Regression for the real antigravity failure: a worker turn ended with an availability error, the fallback route was being
 * selected, and the worker's idle finalized the missing report as blocked before the fallback turn could start.
 */
describe('availability fallback versus missing-report finalization', () => {
  let dir: string, store: Store, engine: Engine, executor: DshExecutor, ticketId: string
  let release: () => void, selected: Promise<void>, prompts: string[]
  const agent = { id: 'worker', status: 'idle', whenIdle: async () => {},
    session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn: 1 } }], requestHeader: () => ({ config: { provider: 'antigravity', model: 'gemini-3.8-flash' } }) } }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fallback-idle-')); const work = join(dir, 'work'); mkdirSync(work)
    store = new Store(join(dir, 'state.sqlite'))
    store.saveSettings({ executor: { model: { provider: 'antigravity', model: 'gemini-3.8-flash' }, maxWorkers: 1 } } as never)
    engine = new Engine({ repo: store, policy: () => ({ version: 'p1', paused: false }), executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() } } as never)
    let ticket = engine.dispatchFinding({ jobId: 'finding:order:r1', findingId: 'order', title: 'Ordering', scope: 'Fallback ordering', repository: 'org/repo', text: 'Isolated test' })
    if (!ticket.execution?.directory) { ticket = { ...ticket, execution: { name: 'order', directory: work, text: 'Test' } } as never; store.tickets.save(ticket) }
    if (ticket.assignments.at(-1)?.state !== 'running') engine.assignmentStarted(ticket.id, ticket.assignments.at(-1)!.id)
    ticketId = ticket.id
    prompts = []
    selected = new Promise<void>(resolve => { release = resolve })
    executor = new DshExecutor({ store: { tickets: store.tickets, triggers: store.triggers, settings: () => store.settings(), set: store.set.bind(store),
      afterCommit: store.afterCommit.bind(store), atomic: store.atomic.bind(store) }, engine, context: { get: () => undefined, agents: new Map() },
    effects: { handle: () => {}, enqueue: () => {} },
    sessions: { relay: () => {}, selectModel: async () => { await selected }, prompt: async (_id: string, _req: string, text: string) => { prompts.push(text) } },
    health: { get: () => undefined, set: () => {} }, machine: { stateDir: dir }, lifetime: new AbortController().signal, closing: () => false,
    paused: () => false, environment: () => [] } as never)
  })
  afterEach(() => { delete (agent as any).inbox; executor.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }) })

  const idle = () => { const t = store.tickets.get(ticketId)!; return (executor as never as { workerIdle(t: unknown, a: unknown, g: unknown): Promise<void> }).workerIdle(t, t.assignments.at(-1), agent) }
  const fallBack = () => { const t = store.tickets.get(ticketId)!; return (executor as never as { handleUnavailableModel(t: unknown, a: unknown, g: unknown, e: unknown): Promise<void> })
    .handleUnavailableModel(t, t.assignments.at(-1), agent, new Error('All Antigravity accounts are unavailable (1 in cooldown)')) }

  it('does not finalize a missing report as blocked while the fallback route is being selected, then resumes the worker', async () => {
    const falling = fallBack()
    await idle()
    expect(store.tickets.get(ticketId)!.ended).toBeUndefined()
    expect(store.tickets.get(ticketId)!.assignments.at(-1)?.report).toBeUndefined()
    release(); await falling
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Continue the assignment where it stopped')
    // Once the fallback is settled, a genuine turn end without a report still surfaces evidence instead of idling.
    await idle()
    expect(store.tickets.get(ticketId)!.assignments.at(-1)?.report?.state).toBe('blocked')
  })

  it('still records a failed report and clears the pending mark when the fallback route cannot be selected', async () => {
    const t = store.tickets.get(ticketId)!
    ;(executor as never as { host: { sessions: { selectModel(): Promise<void> } } }).host.sessions.selectModel = async () => { throw new Error('selection exploded') }
    await fallBack()
    expect(store.tickets.get(t.id)!.assignments.at(-1)?.report?.state).toBe('failed')
    expect((executor as never as { fallingBack: Set<string> }).fallingBack.size).toBe(0)
  })
  it('keeps the mandate open after fallback prompt queues but before its next turn starts', async () => {
    const inbox = { nextTurn: [] as unknown[], nextStep: [] as unknown[] }
    Object.assign(agent, { inbox })
    const host = (executor as any).host
    host.sessions.prompt = async () => { inbox.nextTurn.push({ id: 'real-fallback-message', source: { kind: 'dsh-superagent' } }) }
    const falling = fallBack()
    release(); await falling
    await idle()
    expect(store.tickets.get(ticketId)!.ended).toBeUndefined()
    expect(store.tickets.get(ticketId)!.assignments.at(-1)?.report).toBeUndefined()
    inbox.nextTurn.length = 0
    await idle()
    expect(store.tickets.get(ticketId)!.assignments.at(-1)?.report?.state).toBe('blocked')
  })

  it('handles error -> idle -> queued fallback -> running -> terminal idle through installed event listeners', async () => {
    const handlers = new Map<string, (...args: any[]) => any>()
    const host = (executor as any).host
    host.context.on = (name: string, callback: (...args: any[]) => any) => { handlers.set(name, callback); return () => handlers.delete(name) }
    const eventAgent = { ...agent, id: `worker-${ticketId}`, inbox: { nextTurn: [] as unknown[], nextStep: [] as unknown[] } }
    host.sessions.prompt = async () => { eventAgent.inbox.nextTurn.push({ id: 'fallback-next-turn' }) }
    executor.install()
    const falling = handlers.get('agent/error')!({ agent: eventAgent, error: new Error('All Antigravity accounts are unavailable (1 in cooldown)') })
    handlers.get('agent/status')!({ agent: eventAgent, status: 'idle' })
    await Promise.resolve(); await Promise.resolve()
    expect(store.tickets.get(ticketId)!.ended).toBeUndefined()
    release(); await falling
    handlers.get('agent/status')!({ agent: eventAgent, status: 'idle' })
    await Promise.resolve(); await Promise.resolve()
    expect(store.tickets.get(ticketId)!.ended).toBeUndefined()
    eventAgent.inbox.nextTurn.length = 0
    eventAgent.status = 'running'
    handlers.get('agent/status')!({ agent: eventAgent, status: 'running' })
    eventAgent.status = 'idle'
    handlers.get('agent/status')!({ agent: eventAgent, status: 'idle' })
    await vi.waitFor(() => expect(store.tickets.get(ticketId)!.assignments.at(-1)?.report?.state).toBe('blocked'))
  })

})
