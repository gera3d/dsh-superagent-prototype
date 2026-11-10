import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { registerHttp } from '../src/app/http.ts'
import type { HttpHost } from '../src/app/http.ts'
import { MakeBetterInput, SECTION_ICONS, SectionError, SectionStore, type Member } from '../src/app/sections.ts'
import { sectionsOverview, taskKnown } from '../src/app/views/sections.ts'
import type { Ticket } from '../src/core/index.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const clean of cleanup.splice(0).reverse()) clean() })
const at = '2026-11-10T08:00:00.000Z'

function ticket(id: string, state: 'running' | 'ready' | 'ended' = 'running'): Ticket {
  return { id, title: `Task ${id}`, decisionId: 'd', mandate: {} as never, origin: { triggerId: 't', triggerIds: ['t'] }, createdAt: at, updatedAt: at,
    channels: [], inputs: [], undelivered: [], follows: [],
    ...state === 'ended' ? { ended: { at, by: 'pull' as never, outcome: 'merged' as const } } : {},
    assignments: [{ id: 'a', state: 'running', createdAt: at, ...state === 'ready' ? { idleAt: at, report: { state: 'ready' as const, summary: 'Done', at } } : {} }] } as Ticket
}
function open(path: string) {
  const store = new Store(path)
  cleanup.push(() => store.close())
  return { store, sections: new SectionStore(store.db), known: taskKnown({ store }) }
}
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'sections-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, path: join(dir, 'state.sqlite') }
}
const t = (id: string): Member => ({ kind: 'ticket', id })
const plan = (...ids: string[]) => ({ project: 'ws-1', sections: [
  { name: 'Front door', icon: 'door-open' as const, goal: 'Intake', members: ids.slice(0, 2).map(t) },
  { name: 'Autopilot', icon: 'zap' as const, members: ids.slice(2).map(t) },
] })

it('keeps a proposal inert until the one-time approval, then persists stable identities across a restart', () => {
  const { path } = fresh()
  const first = open(path)
  for (const id of ['a', 'b', 'c']) first.store.tickets.save(ticket(id))
  const proposal = first.sections.propose(plan('a', 'b', 'c'), first.known)
  // Proposing changes no section and moves no task.
  expect(first.sections.list('ws-1')).toEqual([])
  expect(first.sections.sectionOf('ws-1', t('a'))).toBeUndefined()
  expect(first.sections.pending('ws-1')?.id).toBe(proposal.id)
  const approved = first.sections.approve('ws-1', proposal.id, first.known)
  expect(approved.map(section => [section.name, section.icon, section.members.map(member => member.id)])).toEqual([
    ['Front door', 'door-open', ['a', 'b']], ['Autopilot', 'zap', ['c']]])
  const ids = approved.map(section => section.id)
  first.store.close(); cleanup.pop()

  const second = open(path)
  const restored = second.sections.list('ws-1')
  expect(restored.map(section => section.id)).toEqual(ids)
  expect(restored[0]).toMatchObject({ name: 'Front door', icon: 'door-open', goal: 'Intake' })
  expect(restored[0]!.members).toEqual([t('a'), t('b')])
  expect(second.sections.pending('ws-1')).toBeUndefined()
  expect(second.sections.events('ws-1').map(event => event.kind)).toEqual(['approved', 'proposed'])
})

it('rejects invalid proposals and invalid approvals without partial writes', () => {
  const { path } = fresh()
  const { store, sections, known } = open(path)
  store.tickets.save(ticket('a')); store.tickets.save(ticket('b'))
  expect(() => sections.propose(plan('a', 'a', 'b'), known)).toThrow(/more than one section/)
  expect(() => sections.propose(plan('a', 'missing', 'b'), known)).toThrow(/Ticket not found: missing/)
  expect(() => sections.propose({ project: 'ws-1', sections: [{ name: 'X', icon: 'zap', members: [] }, { name: 'x', icon: 'bell', members: [] }] }, known)).toThrow(/Duplicate section name/)
  expect(() => sections.propose({ project: 'ws-1', sections: [{ name: 'X', icon: 'rocket' as never, members: [] }] }, known)).toThrow()
  expect(() => sections.propose({ project: 'ws-1', sections: [] }, known)).toThrow()
  expect(() => sections.propose({ project: 'ws-1', sections: [{ name: 'X', icon: 'zap', members: [{ kind: 'session', id: 'bad id!' }] }] }, known)).toThrow(/Invalid session id/)
  expect(sections.pending('ws-1')).toBeUndefined()

  const proposal = sections.propose(plan('a', 'b'), known)
  expect(() => sections.approve('ws-other', proposal.id, known)).toThrow(/not found for this project/)
  expect(() => sections.approve('ws-1', 'prop_nope', known)).toThrow(SectionError)
  // A superseded proposal can no longer be approved; only the newest is current.
  const newer = sections.propose(plan('a', 'b'), known)
  expect(() => sections.approve('ws-1', proposal.id, known)).toThrow(/already superseded/)
  // A referenced ticket disappearing before approval aborts the whole approval.
  store.db.exec("DELETE FROM ticket WHERE id='b'")
  expect(() => sections.approve('ws-1', newer.id, known)).toThrow(/Ticket not found: b/)
  expect(sections.list('ws-1')).toEqual([])
  expect(sections.pending('ws-1')?.id).toBe(newer.id)
  sections.reject('ws-1', newer.id)
  expect(sections.pending('ws-1')).toBeUndefined()
  expect(() => sections.approve('ws-1', newer.id, known)).toThrow(/already rejected/)
})

it('validates moves, renames, icons and base-thread relations', () => {
  const { path } = fresh()
  const { store, sections, known } = open(path)
  for (const id of ['a', 'b', 'c']) store.tickets.save(ticket(id))
  const [one, two] = sections.approve('ws-1', sections.propose(plan('a', 'b', 'c'), known).id, known)
  expect(() => sections.propose(plan('a'), known)).toThrow(/already has an approved/)

  const moved = sections.move('ws-1', t('a'), two!.id, known)
  expect(moved[1]!.members).toEqual([t('c'), t('a')])
  expect(moved[0]!.members).toEqual([t('b')])
  // Idempotent move; a task is never in two sections.
  sections.move('ws-1', t('a'), two!.id, known)
  expect(sections.list('ws-1').flatMap(section => section.members).filter(member => member.id === 'a')).toHaveLength(1)
  expect(() => sections.move('ws-1', t('ghost'), two!.id, known)).toThrow(/Ticket not found/)
  expect(() => sections.move('ws-1', t('a'), 'sec_unknown', known)).toThrow(/Section not found/)
  expect(() => sections.move('ws-2', t('a'), two!.id, known)).toThrow(/another project/)
  expect(() => sections.move('ws-1', { kind: 'ticket', id: '' }, two!.id, known)).toThrow()
  // Unassigning keeps the ticket itself untouched.
  sections.move('ws-1', t('a'), null, known)
  expect(sections.sectionOf('ws-1', t('a'))).toBeUndefined()
  expect(store.tickets.get('a')).toBeDefined()
  expect(() => sections.move('ws-1', t('a'), null, known)).not.toThrow()

  expect(sections.update(one!.id, { name: 'Intake', icon: 'bell' })).toMatchObject({ id: one!.id, name: 'Intake', icon: 'bell' })
  expect(() => sections.update(one!.id, { name: ' autopilot ' })).toThrow(/Duplicate section name/)
  expect(() => sections.update(one!.id, {})).toThrow()
  expect(() => sections.update(one!.id, { icon: 'nope' as never })).toThrow()
  expect(() => sections.update('sec_unknown', { name: 'x' })).toThrow(/Section not found/)

  expect(sections.setBaseThread(one!.id, 'session-123').baseThread).toBe('session-123')
  expect(() => sections.setBaseThread(two!.id, 'session-123')).toThrow(/already the base thread/)
  expect(() => sections.setBaseThread(two!.id, '../etc')).toThrow(/Invalid session id/)
  expect(sections.setBaseThread(one!.id, null).baseThread).toBeUndefined()
  expect(Object.keys(SECTION_ICONS)).toHaveLength(8)
})

it('builds a readable overview from canonical tickets with progress, and lists only live unassigned tickets', () => {
  const { path } = fresh()
  const { store, sections, known } = open(path)
  store.tickets.save(ticket('run')); store.tickets.save(ticket('rev', 'ready')); store.tickets.save(ticket('done', 'ended')); store.tickets.save(ticket('loose'))
  const host = { store, sources: { kind: () => undefined } as never, links: {} as never }
  expect(sectionsOverview(host, sections, 'ws-1')).toMatchObject({ structure: 'none', sections: [], unassigned: { total: 0 } })
  sections.propose({ project: 'ws-1', sections: [{ name: 'Core', icon: 'compass', members: [t('run'), t('rev'), t('done'), { kind: 'session', id: 'chat-1' }] }] }, known)
  expect(sectionsOverview(host, sections, 'ws-1')).toMatchObject({ structure: 'proposed', sections: [] })
  sections.approve('ws-1', sections.pending('ws-1')!.id, known)
  const view = sectionsOverview(host, sections, 'ws-1')
  expect(view.structure).toBe('approved')
  expect(view.sections[0]).toMatchObject({ icon: { name: 'compass', glyph: '🗺️' }, progress: { total: 4, working: 1, person: 1, ended: 1, unknown: 1, percent: 25 } })
  expect(view.sections[0]!.tasks.map(task => task.stage)).toEqual(['working', 'person', 'ended', 'unknown'])
  expect(view.unassigned.items.map(item => item.id)).toEqual(['loose'])
  expect(() => sectionsOverview(host, sections, '')).toThrow(SectionError)
})

it('serves sections over HTTP with operator-only changes, preview-only steering and no side effects on tasks', async () => {
  const { path } = fresh()
  const { store } = open(path)
  for (const id of ['a', 'b']) store.tickets.save(ticket(id))
  store.tickets.save(ticket('blocked'))
  const calls: string[] = []
  let handler: (req: unknown, res: unknown) => Promise<void> = async () => {}
  const ctx = { on: () => () => {}, logger: { error() {}, warn() {} },
    webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: typeof handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), configured: () => false, store, sources: { kind: () => undefined }, links: () => ({}),
    engine: { retryTicket: () => { calls.push('retry') }, stopTicket: () => { calls.push('stop') } } } as unknown as HttpHost)
  const call = async (method: string, route: string, body?: unknown, operator = true) => {
    let status = 0, text = ''
    const headers: Record<string, string> = { host: '127.0.0.1:3082', 'x-orchestrator-request': '1',
      ...operator ? { origin: 'http://127.0.0.1:3082', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } : {} }
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    await handler({ method, url: `/orchestrator/api/${route}`, headers, async *[Symbol.asyncIterator]() { yield* chunks } },
      { writeHead: (code: number) => { status = code }, end: (data?: string) => { if (data) text = data } })
    return { status, body: (text ? JSON.parse(text) : undefined) as any }
  }

  expect((await call('GET', 'sections?project=ws-1')).body).toMatchObject({ structure: 'none' })
  expect((await call('GET', 'sections')).status).toBe(400)
  const body = { project: 'ws-1', sections: [{ name: 'One', icon: 'bell', members: [t('a')] }, { name: 'Two', icon: 'flask', members: [t('b')] }] }
  expect((await call('POST', 'sections/propose', body, false)).status).toBe(403)
  expect((await call('POST', 'sections/propose', { ...body, extra: 1 })).status).toBe(400)
  expect((await call('POST', 'sections/propose', { ...body, sections: [{ name: 'One', icon: 'bell', members: [t('nope')] }] })).status).toBe(404)
  const proposed = await call('POST', 'sections/propose', body)
  expect(proposed.status).toBe(200)
  expect((await call('GET', 'sections?project=ws-1')).body).toMatchObject({ structure: 'proposed', proposal: { id: proposed.body.proposal.id } })
  expect((await call('POST', 'sections/approve', { project: 'ws-1', proposalId: proposed.body.proposal.id }, false)).status).toBe(403)
  const approved = await call('POST', 'sections/approve', { project: 'ws-1', proposalId: proposed.body.proposal.id })
  expect(approved.body).toMatchObject({ structure: 'approved' })
  expect((await call('POST', 'sections/approve', { project: 'ws-1', proposalId: proposed.body.proposal.id })).status).toBe(409)

  const [one, two] = approved.body.sections as { id: string }[]
  expect((await call('POST', 'sections/move', { project: 'ws-1', member: t('a'), to: two!.id }, false)).status).toBe(403)
  const moved = await call('POST', 'sections/move', { project: 'ws-1', member: t('a'), to: two!.id })
  expect(moved.body.sections[1].tasks.map((task: { id: string }) => task.id)).toEqual(['b', 'a'])
  expect((await call('POST', 'sections/move', { project: 'ws-1', member: t('zzz'), to: two!.id })).status).toBe(404)
  expect((await call('POST', 'sections/update', { name: 'x' })).status).toBe(404)
  expect((await call('POST', `sections/${one!.id}/update`, { name: 'Renamed' })).body.sections[0].name).toBe('Renamed')
  expect((await call('POST', `sections/${one!.id}/base-thread`, { sessionId: 'session-9' })).body.sections[0].baseThread).toBe('session-9')
  expect((await call('POST', `sections/${two!.id}/base-thread`, { sessionId: 'session-9' })).status).toBe(409)

  // Steering is a truthful preview: no worker action, no stored instruction, no authority.
  const forward = await call('POST', `sections/${two!.id}/press-forward`, undefined, false)
  expect(forward.body).toMatchObject({ state: 'preview', execution_authorized: false, running: 2 })
  const better = await call('POST', `sections/${two!.id}/make-better`, { instruction: 'add tests' }, false)
  expect(better.body).toMatchObject({ state: 'preview', execution_authorized: false, instruction: 'add tests' })
  expect((await call('POST', `sections/${two!.id}/make-better`, { instruction: ' ' })).status).toBe(400)
  expect(MakeBetterInput.safeParse({ instruction: 'x', extra: true }).success).toBe(false)
  expect(calls).toEqual([])
  expect(store.tickets.get('a')).toMatchObject({ assignments: [{ state: 'running' }] })
})
