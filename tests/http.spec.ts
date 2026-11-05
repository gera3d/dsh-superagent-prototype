import { expect, it, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const ctx = { on: () => () => {}, sessionPersistence: { flush: async () => {}, list: async () => [] },
    logger: { error: () => {}, warn: () => {} },
    webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime, store: { db, ...(runtime.store as object) } } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = '', location: string | undefined
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, {
      writeHead: (code: number, h?: Record<string, string>) => { status = code; if (h?.Location) location = h.Location },
      end: (data?: string) => { if (data) text = data }
    })
    let parsed: unknown
    try { parsed = text ? JSON.parse(text) : undefined } catch { parsed = text }
    return { status, body: parsed as Record<string, unknown>, ...(location ? { location } : {}) }
  }
}

it('validates chat decisions and never retries a worker for a chat choice', async () => {
  let retries = 0
  const call = serve({ store: { tickets: { get: () => undefined } }, engine: { retryTicket: () => { retries++ } } })
  const item = { id: 'inline:session:message', sessionId: 'session', sourceMessageId: 'message',
    ticketTitle: 'Conversation decision', trigger: 'Explicit alternatives', status: 'pending', urgency: 'low', createdAt: Date.now(),
    context: 'Context', question: 'Which direction?', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    recommendation: { recommendedValue: '', confidence: 0, rationale: 'Unavailable', distribution: [], provider: 'Not evaluated', latencyMs: 0 } }
  expect(await call('POST', 'decisions/inbox', {})).toMatchObject({ status: 400 })
  expect(await call('POST', 'decisions/inbox', item)).toMatchObject({ status: 200 })
  expect(await call('POST', 'decisions/inline:session:message/resolve', { choiceId: 'bad' })).toMatchObject({ status: 400 })
  expect(await call('POST', 'decisions/inline:session:message/resolve', { choiceId: 'a' })).toMatchObject({ status: 409, body: { error: expect.stringContaining('Linked native submission required') } })
  expect(await call('POST', 'decisions/inline:session:message/resolve', { choiceId: 'a' })).toMatchObject({ status: 409, body: { error: expect.stringContaining('Linked native submission required') } })
  expect(await call('POST', 'decisions/inline:session:message/resolve', { choiceId: 'b' })).toMatchObject({ status: 409 })
  expect(await call('POST', 'decisions/missing/resolve', { choiceId: 'a' })).toMatchObject({ status: 404 })
  expect(await call('POST', 'decisions/missing/restart', { sessionId: 'session' })).toMatchObject({ status: 404 })
  expect(await call('POST', 'decisions/inline:session:message/restart', {})).toMatchObject({ status: 400 })
  expect(await call('POST', 'decisions/inline:session:message/restart', { sessionId: 'session', restartAfterSeq: 0 })).toMatchObject({ status: 400 })
  expect(await call('POST', 'decisions/inline:session:message/restart', { sessionId: 'other' })).toMatchObject({ status: 409 })
  expect(await call('POST', 'decisions/inline:session:message/restart', { sessionId: 'session' })).toMatchObject({ status: 409, body: { error: expect.stringContaining('Only a recorded') } })
  expect(retries).toBe(0)
})

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('serves /orchestrator/api/branding/raw with only a loopback Host and refuses other hosts', async () => {
  const call = serve({
    store: {
      settings: () => ({
        ...SettingsSchema.parse({}),
        branding: { logo: 'https://why57.com/images/57_wht_notext.png', logoDark: '', logoLight: '' },
      }),
    },
  })
  // Refuses requests from non-loopback host even with custom header
  expect(await call('GET', 'branding/raw', undefined, { host: 'evil.example:3082' })).toEqual({
    status: 403,
    body: { error: 'Same-origin management request required' },
  })
  expect(await call('GET', 'branding/raw', undefined, { host: '127.0.0.1:9999' })).toEqual({
    status: 403,
    body: { error: 'Same-origin management request required' },
  })

  // Serves on 127.0.0.1 loopback host without custom headers
  const res127 = await call('GET', 'branding/raw', undefined, { host: '127.0.0.1:3082', 'x-orchestrator-request': undefined })
  expect(res127.status).toBe(302)
  expect(res127.location).toBe('https://why57.com/images/57_wht_notext.png')

  // Serves on localhost loopback host without custom headers
  const resLocal = await call('GET', 'branding/raw', undefined, { host: 'localhost:3082', 'x-orchestrator-request': undefined })
  expect(resLocal.status).toBe(302)
  expect(resLocal.location).toBe('https://why57.com/images/57_wht_notext.png')
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})

it('succeeds on a live card pick by dispatching choice to the session and resolving with submission proof', async () => {
  const prompt = vi.fn().mockResolvedValue(undefined)
  const ticketsMap = new Map([
    ['active-t1', { id: 'active-t1', title: 'Active Ticket', stage: 'person', assignments: [] }],
  ])
  const call = serve({
    sessions: { prompt },
    store: {
      tickets: {
        get: (id: string) => ticketsMap.get(id),
        open: () => [...ticketsMap.values()],
      },
    },
    engine: { retryTicket: () => {} },
  })

  const item = {
    id: 'chat-live-pick-1',
    sessionId: 'worker-active-t1',
    sourceMessageId: 'msg-source-1',
    sourceSeq: 10,
    ticketTitle: 'Active Ticket',
    trigger: 'Next step',
    status: 'pending',
    urgency: 'low',
    createdAt: Date.now(),
    context: 'Context text',
    question: 'Which next action?',
    choices: [
      { id: 'opt-a', label: 'Option A', prompt: 'Do option A.' },
      { id: 'opt-b', label: 'Option B', prompt: 'Do option B.' },
    ],
    recommendation: {
      recommendedValue: 'opt-a',
      confidence: 0.88,
      rationale: 'Option A is recommended.',
      distribution: [{ id: 'opt-a', probability: 0.88 }, { id: 'opt-b', probability: 0.12 }],
      provider: 'OpenAI Decisions API',
      latencyMs: 15,
    },
  }

  expect(await call('POST', 'decisions/inbox', item)).toMatchObject({ status: 200 })

  const res = await call('POST', 'decisions/chat-live-pick-1/resolve', { choiceId: 'opt-a' })
  expect(res.status).toBe(200)
  expect(res.body).toMatchObject({
    resolved: true,
    choiceId: 'opt-a',
    execution: 'not_executed',
    item: {
      id: 'chat-live-pick-1',
      status: 'resolved',
      resolvedChoice: 'opt-a',
      resolutionBasis: 'submitted',
    },
  })
  expect(prompt).toHaveBeenCalledOnce()
  expect(prompt).toHaveBeenCalledWith(
    'worker-active-t1',
    expect.stringMatching(/^native-req-/),
    'Do option A.',
    'steer'
  )
})

it('retires an ended-session card with plain explanation instead of offering a failing button', async () => {
  const ticketsMap = new Map([
    ['ended-t1', { id: 'ended-t1', title: 'Ended Ticket', ended: { at: '2026-11-04T12:00:00Z', outcome: 'completed' }, stage: 'ended', assignments: [] }],
  ])
  const call = serve({
    sessions: { prompt: vi.fn() },
    store: {
      tickets: {
        get: (id: string) => ticketsMap.get(id),
        open: () => [],
      },
    },
    engine: { retryTicket: () => {} },
  })

  const item = {
    id: 'chat-ended-1',
    sessionId: 'worker-ended-t1',
    sourceMessageId: 'msg-source-ended',
    sourceSeq: 5,
    ticketTitle: 'Ended Ticket',
    trigger: 'Next step',
    status: 'pending',
    urgency: 'low',
    createdAt: Date.now() - 3600_000,
    context: 'Old context',
    question: 'Choose next action',
    choices: [
      { id: 'opt-1', label: 'Action 1' },
      { id: 'opt-2', label: 'Action 2' },
    ],
    recommendation: { recommendedValue: '', confidence: 0, rationale: 'Not evaluated.', distribution: [], provider: 'Not evaluated', latencyMs: 0 },
  }

  expect(await call('POST', 'decisions/inbox', item)).toMatchObject({ status: 200 })

  // GET decisions/inbox refreshes tickets and retires ended session cards
  const inboxRes = await call('GET', 'decisions/inbox')
  expect(inboxRes.status).toBe(200)
  const found = (inboxRes.body as any).items.find((i: any) => i.id === 'chat-ended-1')
  expect(found).toMatchObject({
    status: 'stale',
    staleReason: expect.stringContaining('originating session has ended'),
  })

  // Trying to resolve an ended card rejects with 409 and clear reason, never showing an unhandled error
  const resolveRes = await call('POST', 'decisions/chat-ended-1/resolve', { choiceId: 'opt-1' })
  expect(resolveRes.status).toBe(409)
  expect(resolveRes.body.error).toContain('originating session has ended')
})

it('rejects resolving a stale decision card with 409 and plain stale reason', async () => {
  const call = serve({
    sessions: { prompt: vi.fn() },
    store: { tickets: { get: () => undefined, open: () => [] } },
    engine: { retryTicket: () => {} },
  })

  const item = {
    id: 'chat-stale-card',
    sessionId: 'worker-dead-session',
    sourceMessageId: 'msg-source-stale',
    sourceSeq: 2,
    ticketTitle: 'Stale Ticket',
    trigger: 'Next step',
    status: 'pending',
    urgency: 'low',
    createdAt: Date.now() - 7200_000,
    context: 'Stale context',
    question: 'Pick an option',
    choices: [
      { id: 'opt-1', label: 'Action 1' },
      { id: 'opt-2', label: 'Action 2' },
    ],
    recommendation: { recommendedValue: '', confidence: 0, rationale: 'Not evaluated.', distribution: [], provider: 'Not evaluated', latencyMs: 0 },
  }

  expect(await call('POST', 'decisions/inbox', item)).toMatchObject({ status: 200 })

  // GET decisions/inbox marks it stale because ticket is ended/missing
  const inboxRes = await call('GET', 'decisions/inbox')
  expect(inboxRes.status).toBe(200)

  const resolveRes = await call('POST', 'decisions/chat-stale-card/resolve', { choiceId: 'opt-1' })
  expect(resolveRes.status).toBe(409)
  expect(resolveRes.body.error).toContain('Decision is stale')
  expect(resolveRes.body.error).toContain('originating session has ended')
})
