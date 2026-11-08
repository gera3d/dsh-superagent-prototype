// @vitest-environment jsdom
import { act, useState, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError, caller, usePoll } from '../src/client/api.ts'
import { apply, inject } from '../src/client/index.tsx'
import type { PendingDecisionItem } from '../src/core/decision.ts'
import type { PublicationCards } from '../src/client/publication-cards.tsx'
import { zh } from '../src/client/locales.ts'
import { SettingsSchema } from '../src/policy.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Entry = { options: { name: string; id?: string; key?: string; order?: number; locale?: string; label?: () => string }; component: ComponentType<Record<string, unknown>> }
const t = ((key: keyof typeof zh) => zh[key] ?? key) as never
const fixtureDisposers: (() => void)[] = []
function fixture(listed: string[]) {
  const entries: Entry[] = []
  const dictionaries: Record<string, unknown> = {}
  const services = new Map<string, unknown>()
  const cleanups: (() => void)[] = []
  const dispose = () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() }
  fixtureDisposers.push(dispose)
  const ctx = {
    slots: { inject: (_name: string, register: () => void) => register(), register: (options: Entry['options'], component: Entry['component']) => { entries.push({ options, component }); return () => {} } },
    locale: { register: (ns: string, value: unknown) => { dictionaries[ns] = value; return () => {} }, bind: () => t },
    effect: (effect: () => unknown) => { const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup as () => void) },
    provide: vi.fn((name: string, service: unknown) => {
      services.set(name, service)
      return vi.fn(() => { if (services.get(name) === service) services.delete(name) })
    }),
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: Object.fromEntries(listed.map(id => [id, {}])) }) }, refresh: vi.fn(async () => {}) },
    uiWorkspace: { openSession: vi.fn() },
    uiConversation: { events: { register: vi.fn(() => () => {}) }, views: { register: vi.fn(() => () => {}) } },
    // Omit config form service so Deployment renders read-only.
    get: (name: string) => services.get(name),
  }
  apply(ctx as never)
  const entry = (name: string) => entries.find(item => item.options.name === name)!
  return { ctx, entries, dictionaries, dispose, main: entry('main'), nav: entry('sidebar.panellist') }
}
async function render(entry: Entry, props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<entry.component {...props} />) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { container, dispose: () => { act(() => { root.unmount() }); container.remove() } }
}
const openMaster = async (container: HTMLElement) => {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === zh.openMaster)!
  await act(async () => { button.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const serve = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
  if (path === 'overview') return Response.json({ problems: [], person: [], executor: { running: 0, queued: 0, maxWorkers: 3, idle: 0 }, flow: { triggers: 0, filtered: 0, judged: 0, accepted: 0, evaluating: 0 }, policyVersion: 'v' })
  if (path === 'state') return Response.json({ masterId: 'master', settings: SettingsSchema.parse({}), revisions: { policy: 0, eval: 0, executor: 0 }, sources: [], policy_version: 'v', health: {}, outgoing: [], load: { running: 0, queued: 0 },
    setup: { machine: { stateDir: '/srv/state', worktreeRoot: '/srv/state/worktrees', blockedCommands: [], promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }, problem: null, feishuProblem: null, accounts: null } })
  return Response.json({ error: 'unavailable' }, { status: 503 })
}))
afterEach(() => {
  for (const dispose of fixtureDisposers.splice(0).reverse()) dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('registers a localized main panel, sidebar entry and Plugin Manager row page, and no settings section', () => {
  const { entries, dictionaries, main, nav, ctx } = fixture([])
  expect(ctx.uiConversation.events.register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'superagent-worker-report', target: 'superagent-worker-report' }))
  expect(ctx.uiConversation.views.register).toHaveBeenCalledWith(expect.objectContaining({ target: 'superagent-worker-report' }))
  expect(inject).toEqual(['slots', 'locale', 'sessions', 'uiWorkspace', 'conversation', 'uiConversation'])
  expect(entries.map(entry => entry.options.name)).toEqual([
    'conversation.input.dock',
    'conversation.input.dock',
    'conversation.input.dock',
    'conversation.input.dock',
    'conversation.session.header.actions',
    'sidebar.brand.mark',
    'sidebar.brand.name',
    'main',
    'sidebar.panellist',
    'plugins.row.config',
  ])
  expect(entries[0]!.options).toMatchObject({ id: 'dsh-superagent.worker-report', order: 7 })
  expect(entries[1]!.options).toMatchObject({ id: 'dsh-superagent.publications', order: 8 })
  expect(entries[2]!.options).toMatchObject({ id: 'dsh-superagent.decision-handoff', order: 5 })
  expect(entries[3]!.options).toMatchObject({ id: 'dsh-superagent.inline-decision', order: 10 })
  expect(entries[4]!.options).toMatchObject({ id: 'dsh-superagent.account-allowance', order: 15 })
  expect(entries[5]!.options).toMatchObject({ name: 'sidebar.brand.mark', priority: -1 })
  expect(entries[6]!.options).toMatchObject({ name: 'sidebar.brand.name', priority: -1 })
  expect(entries[9]!.options).toMatchObject({ key: 'dsh-superagent#dsh-superagent', locale: 'dshSuperagent' })
  expect(Object.keys(dictionaries)).toEqual(['dshSuperagent'])
  expect(main.options).toMatchObject({ key: 'dsh-superagent', locale: 'dshSuperagent' })
  expect(nav.options).toMatchObject({ id: 'dsh-superagent', order: 10, locale: 'dshSuperagent' })
  expect(nav.options.label?.()).toBe('Superagent')
})

it('provides the shared decision submission bridge and disposes it with the plugin effects', () => {
  const { ctx, dispose } = fixture([])
  const publications = ctx.get('publicationCards') as PublicationCards
  const bridge = ctx.get('decisionSubmission') as { watch: () => unknown; stage: () => unknown; discard: () => unknown; dispose: () => void }
  expect(ctx.provide).toHaveBeenCalledTimes(2)
  expect(ctx.provide).toHaveBeenNthCalledWith(1, 'publicationCards', publications)
  expect(ctx.provide).toHaveBeenNthCalledWith(2, 'decisionSubmission', bridge)
  expect(publications).toMatchObject({ render: expect.any(Function) })
  expect(bridge).toMatchObject({ watch: expect.any(Function), stage: expect.any(Function), discard: expect.any(Function), dispose: expect.any(Function) })
  expect(ctx.get('configForms')).toBeUndefined()
  const stop = vi.spyOn(bridge, 'dispose')
  const unprovidePublications = ctx.provide.mock.results[0]!.value
  const unprovideSubmission = ctx.provide.mock.results[1]!.value
  dispose()
  expect(unprovidePublications).toHaveBeenCalledOnce()
  expect(unprovideSubmission).toHaveBeenCalledOnce()
  expect(stop).toHaveBeenCalledOnce()
  expect(ctx.get('publicationCards')).toBeUndefined()
  expect(ctx.get('decisionSubmission')).toBeUndefined()
  dispose()
  expect(unprovidePublications).toHaveBeenCalledOnce()
  expect(unprovideSubmission).toHaveBeenCalledOnce()
  expect(stop).toHaveBeenCalledOnce()
})

const publicationItem: PendingDecisionItem = {
  id: 'publication-decision', sessionId: 'publication-session', ticketId: 'publication-ticket', ticketTitle: 'Exact-head publication',
  trigger: 'Ready', question: 'Review publication', context: 'Server-reviewed publication manifest', status: 'pending', urgency: 'low', createdAt: 1,
  actionMode: 'ticket_lifecycle', choices: [{ id: 'publish', label: 'Approve and publish', actionKind: 'publish' }],
  recommendation: { recommendedValue: '', confidence: 0, rationale: '', distribution: [], provider: '', latencyMs: 0 },
  lifecycle: { kind: 'done', assignmentId: 'assignment-1', prNumber: 150, publication: {
    id: '6ed29d9a-8bae-4715-97da-9f3995ad0cb3', ticketId: 'publication-ticket', conversationId: 'publication-session', repository: 'example/project', prNumber: 150,
    headSha: 'a'.repeat(40), patchSha256: 'b'.repeat(64), status: 'prepared', createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z',
    evidence: { repository: 'example/project', prNumber: 150, headSha: 'a'.repeat(40), patchSha256: 'b'.repeat(64),
      observedAt: '2026-11-06T00:00:00Z', checks: 'passed', review: 'approved', mergeable: true, state: 'open' },
    outcomes: [], audit: [], requests: {},
  } },
}
it('renders real privileged publication evidence through the registered service and never stages chat', async () => {
  const fetch = vi.fn(async () => Response.json({ execution: 'not_executed', ticketId: publicationItem.ticketId, message: 'Publication request checked.' }))
  vi.stubGlobal('fetch', fetch)
  const { ctx } = fixture([])
  const publications = ctx.get('publicationCards') as PublicationCards
  const stage = vi.spyOn(ctx.get('decisionSubmission') as { stage: () => unknown }, 'stage')
  const onTicket = vi.fn()
  const view = await render({ options: { name: 'publication-service-test' }, component: () => <>{publications.render(publicationItem, onTicket)}</> }, {})
  try {
    expect(view.container.querySelector('[aria-label="Publication evidence"]')).not.toBeNull()
    expect(view.container.textContent).toContain('example/project #150')
    expect(view.container.textContent).toContain(publicationItem.lifecycle!.publication!.headSha)
    expect(view.container.textContent).toContain(publicationItem.lifecycle!.publication!.patchSha256)
    expect(view.container.textContent).not.toContain('Stage response')
    expect(fetch).not.toHaveBeenCalled()
    const buttons = [...view.container.querySelectorAll('button')]
    await act(async () => { buttons.find(button => button.textContent === 'View ticket')!.click() })
    expect(onTicket).toHaveBeenCalledOnce()
    await act(async () => { buttons.find(button => button.textContent === 'Approve + publish')!.click() })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, request] = vi.mocked(globalThis.fetch).mock.calls[0]!
    expect(url).toBe('/orchestrator/api/decisions/publication-decision/lifecycle')
    expect(request).toMatchObject({ method: 'POST', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' } })
    expect(JSON.parse(String(request!.body))).toEqual({ action: 'publish', approval: { publicationId: publicationItem.lifecycle!.publication!.id,
      requestId: expect.stringMatching(/^[\da-f-]{36}$/i) } })
    expect(stage).not.toHaveBeenCalled()
  } finally { view.dispose() }
})
it('renders actual lifecycle cards in the publication dock only for its current conversation', async () => {
  const elsewhere = { ...publicationItem, id: 'elsewhere', sessionId: 'different-session', ticketTitle: 'Other conversation publication' }
  const ordinary = { ...publicationItem, id: 'ordinary', lifecycle: undefined, actionMode: 'stage_response', ticketTitle: 'Ordinary staged response' }
  const fetch = vi.fn(async () => Response.json({ items: [publicationItem, elsewhere, ordinary] }))
  vi.stubGlobal('fetch', fetch)
  const { entries } = fixture([])
  const dock = entries.find(entry => entry.options.id === 'dsh-superagent.publications')!
  const view = await render(dock, { session: { sessionId: publicationItem.sessionId } })
  try {
    expect(view.container.querySelector('[aria-label="Senior Developer publications"]')).not.toBeNull()
    expect(view.container.querySelector('[aria-label="Publication evidence"]')).not.toBeNull()
    expect(view.container.textContent).toContain('Exact-head publication')
    expect(view.container.textContent).toContain('example/project #150')
    expect(view.container.textContent).not.toContain('Other conversation publication')
    expect(view.container.textContent).not.toContain('Ordinary staged response')
    expect(view.container.textContent).not.toContain('Stage response')
    expect([...view.container.querySelectorAll('button')].map(button => button.textContent)).toContain('Approve + publish')
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/orchestrator/api/decisions/inbox', { method: 'GET', headers: { 'x-orchestrator-request': '1' } })
  } finally { view.dispose() }
})
it('opens a listed Session through the workspace from the main panel', async () => {
  serve()
  const { ctx, main } = fixture(['master'])
  const view = await render(main, { t })
  await openMaster(view.container)
  expect(ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith('master')
  view.dispose()
})

it('reports a Session missing from the catalog in the interface language', async () => {
  serve()
  const { ctx, main } = fixture([])
  const view = await render(main, { t })
  await openMaster(view.container)
  expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(zh.sessionNotListed)
  view.dispose()
})

it('polls one request at a time, keeps the data while new dependencies load, and polls less while hidden', async () => {
  vi.useFakeTimers()
  const calls: { limit: number; done: (value: string[]) => void }[] = []
  let shown: { data?: string[]; limit: number } = { limit: 0 }
  let setLimit = (_limit: number) => {}
  function Harness() {
    const [limit, update] = useState(1)
    setLimit = update
    const { data } = usePoll(() => new Promise<string[]>(done => { calls.push({ limit, done }) }), [limit], 1000)
    shown = { ...data ? { data } : {}, limit }
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => { root.render(<Harness />) })
  expect(calls).toHaveLength(1)
  // A slow response holds the next poll back instead of overlapping.
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(1)
  await act(async () => { calls[0]!.done(['a']) })
  expect(shown.data).toEqual(['a'])
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(calls).toHaveLength(2)
  await act(async () => { setLimit(2) })
  expect(shown).toEqual({ data: ['a'], limit: 2 })
  await act(async () => { calls[2]!.done(['a', 'b']) })
  expect(shown.data).toEqual(['a', 'b'])
  // A late response to the superseded request must not replace the newer result.
  await act(async () => { calls[1]!.done(['stale']) })
  expect(shown.data).toEqual(['a', 'b'])
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  await act(async () => { calls[3]!.done(['a', 'b']) })
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(4)
  hidden.mockRestore()
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(calls).toHaveLength(5)
  act(() => { root.unmount() })
  vi.useRealTimers()
})

it('tells a dsh-superagent that does not answer from a record it does not have, and words each failure by what failed', async () => {
  const messages = { offline: 'offline', notRunning: 'not running', serverError: (status: number) => `server ${status}`,
    requestFailed: (status: number) => `request ${status}`, setup: () => 'setup', user: ({ code }: { code: string }) => `user ${code}` }
  const call = caller(() => messages)
  const failure = async (answer: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(answer))
    const error = await call('GET tickets/:id', { id: 't1' }).then(() => undefined, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ApiError)
    const { message, status, missing, details } = error as ApiError
    return { message, status, missing, unreachable: !!details.unreachable }
  }
  expect(await failure(async () => { throw new TypeError('Failed to fetch') })).toEqual({ message: 'offline', status: 0, missing: false,
    unreachable: true })
  // DSH's web server answers an empty 404 while dsh-superagent's routes are unregistered.
  expect(await failure(async () => new Response(null, { status: 404 }))).toEqual({ message: 'not running', status: 404, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response(null, { status: 502 }))).toEqual({ message: 'server 502', status: 502, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response('<html>Bad request</html>', { status: 400 }))).toEqual({ message: 'request 400',
    status: 400, missing: false, unreachable: false })
  expect(await failure(async () => Response.json({ error: 'Unknown ticket', code: 'unknownTicket' }, { status: 404 }))).toEqual({
    message: 'user unknownTicket', status: 404, missing: true, unreachable: false })
})
