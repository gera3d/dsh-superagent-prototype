import { expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { Ticket } from '../src/core/index.ts'
import { DecisionInbox, ticketDecisions } from '../src/app/decision-inbox.ts'
import { documentationPath, enrichLifecycle, lifecycleAction, verifiedDocsOnly, type LifecycleCommands } from '../src/app/lifecycle-decisions.ts'

const at = '2026-11-05T10:00:00.000Z'
function ticket(): Ticket {
  return { id: 't1', title: 'Public example task', assignments: [{ id: 'a1', state: 'running', createdAt: at, idleAt: at,
    report: { state: 'ready', summary: 'Ready for review.', at } }], inputs: [], undelivered: [], channels: [{ source: 'github', thread: 'github:143', address: { number: '143' } }],
    follows: [{ thread: 'github:150', own: true }], createdAt: at, updatedAt: at,
    origin: { triggerId: 'origin', triggerIds: ['origin'] }, decisionId: 'd1', mandate: {} as Ticket['mandate'] }
}
function commands(files: unknown[] = [{ filename: 'docs/guide.md' }], overrides = {}) {
  const pull = { state: 'open', draft: false, head: { sha: 'abc' }, changed_files: files.length, ...overrides }
  const api = vi.fn(async (schema, path) => schema.parse(path.includes('/files?') ? [files] : pull))
  return { api } as unknown as LifecycleCommands & { api: ReturnType<typeof vi.fn> }
}
function host(current = ticket(), cli: LifecycleCommands | undefined = commands()) {
  return { getTicket: vi.fn(() => current), retryTicket: vi.fn(), repository: 'example/project', commands: cli }
}

it('projects a quiet done card only for idle ready + exactly one bound PR', () => {
  const current = ticket()
  expect(ticketDecisions([current])[0]).toMatchObject({ actionMode: 'ticket_lifecycle', urgency: 'low', lifecycle: { kind: 'done', prNumber: 150, docsOnly: false } })
  for (const change of [
    { ended: { at, by: 'human', outcome: 'stopped' } }, { follows: [] }, { follows: [{ thread: 'github:150', own: false, closed: { at, outcome: 'closed' } }] },
    { follows: [{ thread: 'github:150', own: true }, { thread: 'github:151', own: true }] }, { undelivered: ['new'] },
  ]) expect(ticketDecisions([{ ...current, ...change } as Ticket]).some(item => item.lifecycle)).toBe(false)
  current.assignments[0]!.idleAt = undefined
  expect(ticketDecisions([current]).some(item => item.lifecycle)).toBe(false)
})
it('projects stuck Retry/Open issue and invalidates it after new progress or retry', async () => {
  const current = ticket(); current.follows = []; current.assignments[0]!.report = undefined
  current.inputs = [{ id: 'fallback', kind: 'note', text: 'Fell back to a configured model', at }]
  current.stallGuard = { assignmentId: 'a1', inputId: 'fallback', wokeAt: at, stuckAt: at }
  const item = ticketDecisions([current])[0]!
  expect(item.lifecycle?.kind).toBe('stuck')
  expect(item.choices.map(choice => choice.label)).toEqual(['Retry', 'Open issue'])
  const runtime = host(current)
  expect((await enrichLifecycle([item], undefined, 'example/project'))[0]?.lifecycle?.issueUrl).toBe('https://github.com/example/project/issues/143')
  expect(await lifecycleAction(runtime, item, 'open_issue')).toMatchObject({ url: 'https://github.com/example/project/issues/143', execution: 'not_executed' })
  expect(await lifecycleAction(runtime, item, 'retry')).toMatchObject({ execution: 'retried' })
  expect(runtime.retryTicket).toHaveBeenCalledWith('t1')
  current.assignments[0]!.report = { state: 'progress', summary: 'Working', at: '2026-11-05T10:01:00.000Z' }
  await expect(lifecycleAction(runtime, item, 'retry')).rejects.toThrow('state changed')
})
it.each(['stuck', 'done'] as const)('creates a new %s episode after a delivered input returns idle without progress, preserving stale history', kind => {
  const current = ticket()
  if (kind === 'stuck') {
    current.follows = []; current.assignments[0]!.report = undefined
    current.inputs = [{ id: 'fallback', kind: 'note', text: 'Fell back to a configured model', at }]
    current.stallGuard = { assignmentId: 'a1', inputId: 'fallback', wokeAt: at, stuckAt: at }
  }
  const db = new DatabaseSync(':memory:')
  try {
    const inbox = new DecisionInbox(db)
    const original = ticketDecisions([current])[0]!
    inbox.syncTickets([original], [current])
    current.assignments[0]!.deliveredAt = '2026-11-05T10:01:00.000Z'
    inbox.syncTickets(ticketDecisions([current]), [current])
    expect(inbox.get(original.id)?.status).toBe('stale')
    current.assignments[0]!.idleAt = '2026-11-05T10:02:00.000Z'
    const next = ticketDecisions([current])[0]!
    expect(next.id).not.toBe(original.id)
    inbox.syncTickets([next], [current])
    expect(inbox.get(original.id)?.status).toBe('stale')
    expect(inbox.get(next.id)?.status).toBe('pending')
    if (kind === 'stuck') expect(current.stallGuard).toEqual({ assignmentId: 'a1', inputId: 'fallback', wokeAt: at, stuckAt: at })
  } finally { db.close() }
})
it('never stages lifecycle controls as chat and preserves server lifecycle metadata across inbox sync', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const inbox = new DecisionInbox(db); const items = ticketDecisions([ticket()])
    inbox.syncTickets(items)
    expect(inbox.list()[0]?.actionMode).toBe('ticket_lifecycle')
    expect(() => inbox.stage(items[0]!.id, { attemptId: 'x', choiceId: 'try_it', draftText: 'Try it' })).toThrow('explicit lifecycle')
    inbox.syncTickets([], [])
    expect(inbox.list()[0]?.status).toBe('stale')
    expect(() => inbox.put({ ...items[0]!, id: 'life-forged', actionMode: 'stage_response', lifecycle: undefined })).toThrow('server-owned')
  } finally { db.close() }
})
it('verifies complete docs files and unchanged open non-draft head, not labels or summaries', async () => {
  expect(await verifiedDocsOnly(commands(), 150)).toBe(true)
  for (const files of [[{ filename: 'src/code.ts' }], [{ filename: 'docs/example.mdx' }], [{ filename: 'docs/guide.md', previous_filename: 'src/code.ts' }], [{ invalid: 'docs/guide.md' }], []]) {
    expect(await verifiedDocsOnly(commands(files), 150)).toBe(false)
  }
  expect(await verifiedDocsOnly(undefined, 150)).toBe(false)
  expect(await verifiedDocsOnly(commands(undefined, { draft: true }), 150)).toBe(false)
  expect(await verifiedDocsOnly(commands(undefined, { state: 'closed' }), 150)).toBe(false)
  expect(await verifiedDocsOnly(commands(undefined, { changed_files: 2 }), 150)).toBe(false)
  const changing = commands(); changing.api.mockImplementationOnce(async schema => schema.parse({ state: 'open', draft: false, head: { sha: 'old' }, changed_files: 1 }))
  expect(await verifiedDocsOnly(changing, 150)).toBe(false)
  expect(documentationPath('../docs/a.md')).toBe(false)
  expect(documentationPath('docs/.hidden/a.md')).toBe(false)
})
it('offers Merge only after verification and rechecks on each explicit merge request', async () => {
  const current = ticket(), item = ticketDecisions([current])[0]!
  const enriched = await enrichLifecycle([item], commands())
  expect(enriched[0]?.choices.map(choice => choice.id)).toEqual(['merge', 'try_it', 'changes_needed'])
  expect((await enrichLifecycle([item]))[0]?.choices.map(choice => choice.id)).toEqual(['try_it', 'changes_needed'])
  const runtime = host(current)
  expect(await lifecycleAction(runtime, item, 'merge')).toMatchObject({ execution: 'not_executed', url: 'https://github.com/example/project/pull/150#partial-pull-merging' })
  expect(runtime.retryTicket).not.toHaveBeenCalled()
  runtime.commands = commands([{ filename: 'src/main.ts' }])
  await expect(lifecycleAction(runtime, { ...item, lifecycle: { ...item.lifecycle!, docsOnly: true } }, 'merge')).rejects.toThrow('Try it first')
  await expect(lifecycleAction(runtime, item, 'retry')).rejects.toThrow('Only a stuck')
  expect(await lifecycleAction(runtime, item, 'try_it')).toMatchObject({ execution: 'not_executed', url: 'https://github.com/example/project/pull/150/files' })
  expect(await lifecycleAction(runtime, item, 'changes_needed')).toMatchObject({ execution: 'not_executed' })
})
it('caches display checks for 30s but never uses display cache to authorize merge', async () => {
  const cli = commands(), item = ticketDecisions([ticket()])[0]!
  await enrichLifecycle([item], cli); await enrichLifecycle([item], cli)
  expect(cli.api).toHaveBeenCalledTimes(3)
  await lifecycleAction(host(ticket(), cli), item, 'merge')
  expect(cli.api).toHaveBeenCalledTimes(6)
})
it('supports adopted PRs and rejects native busy workers without dispatching actions', async () => {
  const current = ticket(); current.follows![0]!.own = false
  const item = ticketDecisions([current])[0]!
  expect(item.lifecycle?.kind).toBe('done')
  const runtime = { ...host(current), busy: () => true }
  await expect(lifecycleAction(runtime, item, 'try_it')).rejects.toThrow('Worker is active')
  expect(runtime.retryTicket).not.toHaveBeenCalled()
})
it('rejects stopped, reassigned and concurrently changed tickets before returning merge controls', async () => {
  const current = ticket(), item = ticketDecisions([current])[0]!, runtime = host(current)
  runtime.getTicket.mockReturnValueOnce(current).mockReturnValueOnce({ ...current, ended: { at, by: 'human', outcome: 'stopped' } })
  await expect(lifecycleAction(runtime, item, 'merge')).rejects.toThrow('changed during verification')
  current.assignments[0]!.id = 'new-assignment'
  await expect(lifecycleAction(host(current), item, 'try_it')).rejects.toThrow('state changed')
})
