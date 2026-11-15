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
import type { Ticket } from '../src/core/index.ts'
import { SetupError } from '../src/setup.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1', services: Record<string, unknown> = {}) {
  let handler: Handler = async () => {}
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const ctx = { on: () => () => {}, sessionPersistence: { flush: async () => {}, list: async () => [] },
    logger: { error: () => {}, warn: () => {} },
    ...services,
    webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), configured: () => false, ...runtime, store: { db, ...(runtime.store as object) } } as unknown as HttpHost)
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

it('serves compact helper drafts behind the management header and loopback Host gate', async () => {
  const options = [{ id: 'verify', label: 'Run tests', prompt: 'Run tests and inspect the diff.', recommended: true },
    { id: 'review', label: 'Review edge cases', prompt: 'Inspect error handling.', recommended: false }]
  const resolveCallConfig = vi.fn(async (route: unknown) => route)
  const call = serve({ store: { settings: () => SettingsSchema.parse({ models: { hierarchy: [{ provider: 'test', model: 'fast' }] } }) } },
    '127.0.0.1', { llm: { resolveCallConfig, async *stream() {
      yield { type: 'text-delta', text: JSON.stringify({ options }) }; yield { type: 'finish', reason: { kind: 'stop' } }
    } } })
  const digest = { summary: 'A fix is in progress.', latestTurn: 'Implemented the change without tests.' }
  for (const headers of [{ 'x-orchestrator-request': undefined }, { 'x-orchestrator-request': '0' },
    { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' }, { origin: 'http://evil.example' }]) {
    expect(await call('POST', 'helper/suggest', digest, headers)).toMatchObject({ status: 403 })
  }
  expect(resolveCallConfig).not.toHaveBeenCalled()
  expect(await call('GET', 'helper/suggest')).toMatchObject({ status: 404 })
  for (const invalid of [{ ...digest, summary: 'x'.repeat(1500) }, { ...digest, latestTurn: 'x'.repeat(12001) },
    { ...digest, latestTurn: ' ' }, { ...digest, events: [{ type: 'message' }] }, { summary: '', latestTurn: [] }]) {
    expect(await call('POST', 'helper/suggest', invalid)).toMatchObject({ status: 400 })
  }
  expect(await call('POST', 'helper/suggest', '{bad json')).toMatchObject({ status: 400 })
  expect(await call('POST', 'helper/suggest', 'x'.repeat(65537))).toMatchObject({ status: 400, body: { error: 'Request exceeds 65536 bytes' } })
  expect(resolveCallConfig).not.toHaveBeenCalled()
  expect(await call('POST', 'helper/suggest', { ...digest, summary: 'x'.repeat(1499) })).toEqual({ status: 200, body: { options, specialist: { profileId: 'senior-developer', basis: 'default', unavailable: [] } } })
  expect(await call('POST', 'helper/suggest', digest, { host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
})

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
  expect(res.status).toBe(409)
  expect(prompt).not.toHaveBeenCalled()
  const inbox = await call('GET', 'decisions/inbox')
  expect((inbox.body.items as any[]).find((entry: any) => entry.id === item.id)).toMatchObject({ status: 'pending' })
})

it('projects a stuck lifecycle card and retries it once through the explicit HTTP endpoint', async () => {
  const at = '2026-11-05T20:00:00.000Z'
  const ticket: Ticket = { id: 'stalled', title: 'Original issue task', decisionId: 'd',
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'github', id: 'owner' }, scope: 'fix' },
    channels: [{ source: 'github', thread: '143', address: { number: '143' } }], origin: { triggerId: 'issue', triggerIds: ['issue'] },
    createdAt: at, updatedAt: at, undelivered: [], inputs: [{ id: 'fallback', kind: 'note', text: 'Fell back to available ladder model (p/m): offline.', at }],
    assignments: [{ id: 'a', state: 'running', createdAt: at, idleAt: at, report: { state: 'waiting', summary: 'Idle', at } }],
    stallGuard: { assignmentId: 'a', inputId: 'resume', wokeAt: at, stuckAt: at } }
  const retryTicket = vi.fn(() => { ticket.ended = { by: 'executor', at, outcome: 'completed' } })
  const call = serve({ configured: () => true, deployment: { repository: 'example/repo' },
    executor: { running: () => false }, store: { tickets: { get: () => ticket, open: () => ticket.ended ? [] : [ticket] } }, engine: { retryTicket } })
  const list = await call('GET', 'decisions/inbox')
  expect(list.status).toBe(200)
  const item = (list.body.items as any[])[0]!
  expect(item).toMatchObject({ lifecycle: { kind: 'stuck', issueUrl: 'https://github.com/example/repo/issues/143' } })
  expect(await call('POST', `decisions/${item.id}/resolve`, { choiceId: 'retry' })).toMatchObject({ status: 409 })
  expect(await call('POST', `decisions/${item.id}/lifecycle`, { action: 'retry' })).toMatchObject({ status: 200, body: { execution: 'retried' } })
  expect(await call('POST', `decisions/${item.id}/lifecycle`, { action: 'retry' })).toMatchObject({ status: 409 })
  expect(retryTicket).toHaveBeenCalledExactlyOnceWith('stalled')
})

it('requires the trusted local browser envelope for exact-card publication approval and rejects body authority', async () => {
  const at = new Date().toISOString()
  const ticket: Ticket = { id: 'publish-http', title: 'Harmless publication', decisionId: 'd', mandate: {} as Ticket['mandate'],
    origin: { triggerId: 'origin', triggerIds: ['origin'] }, createdAt: at, updatedAt: at, channels: [], inputs: [], undelivered: [],
    follows: [{ thread: 'github:159', own: true }], assignments: [{ id: 'a', state: 'running', createdAt: at, idleAt: at,
      report: { state: 'ready', summary: 'Reviewed fixture', at } }] }
  const { ticketDecisions } = await import('../src/app/decision-inbox.ts')
  const { publicationConversation } = await import('../src/app/lifecycle-publication.ts')
  const item = ticketDecisions([ticket])[0]!
  const pins = { repository: 'example/repo', prNumber: 159, headSha: 'a'.repeat(40), patchSha256: 'b'.repeat(64) }
  const snapshot = { ...pins, id: '00000000-0000-4000-8000-000000000001', ticketId: ticket.id, conversationId: publicationConversation(item),
    status: 'prepared', createdAt: at, updatedAt: at, outcomes: [], audit: [], requests: {},
    evidence: { ...pins, observedAt: at, checks: 'passed', review: 'approved', mergeable: true, state: 'open' } }
  const enqueue = vi.fn(async () => snapshot)
  const call = serve({ configured: () => true, deployment: { repository: pins.repository }, executor: { running: () => false },
    store: { tickets: { get: () => ticket, open: () => [ticket] } }, engine: {},
    publication: { service: { snapshot: async () => snapshot }, pinsFor: () => pins, enqueue } })
  await call('GET', 'decisions/inbox')
  const approval = { publicationId: snapshot.id, requestId: '00000000-0000-4000-8000-000000000002' }
  expect(await call('POST', `decisions/${item.id}/lifecycle`, { action: 'publish', approval })).toMatchObject({ status: 403 })
  expect(await call('POST', `decisions/${item.id}/lifecycle`, { action: 'publish', approval, authority: { authorized: true } })).toMatchObject({ status: 400 })
  expect(enqueue).not.toHaveBeenCalled()
  const browser = { origin: 'http://127.0.0.1:3082', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }
  expect(await call('POST', `decisions/${item.id}/lifecycle`, { action: 'publish', approval }, browser)).toMatchObject({ status: 200 })
  expect(enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ publicationId: snapshot.id, requestId: approval.requestId }),
    expect.objectContaining({ kind: 'human_click', actorId: 'local-operator', authorized: true }))
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

it('routes typed parked-handoff recovery through the local operator boundary without replaying execute', async () => {
  const { FeatureDeliveryRuntime } = await import('../src/app/delivery-runtime.ts')
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const runtime = new FeatureDeliveryRuntime({ db, tickets: { get: () => undefined } } as never)
  const created = runtime.store.create({ id: 'recover-http', title: 'Recover', owner: 'owner', workers: [], authorities: ['local-operator'], requirements: ['native'],
    bindings: { repository: 'org/repo', sourceIssue: 167, baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40) } })
  const ready = runtime.store.compareAndSwap(created.id, created.revision, d => { d.stage = 'review' })
  runtime.store.confirm(ready.id, { revision: ready.revision, actionId: ready.nextAction!.id }, { actor: 'local-operator', source: 'local_operator', reference: 'original-confirmation', scope: ready.nextAction!.fingerprint })
  await runtime.coordinator.runOnce('initial')
  const parked = runtime.store.get(created.id)!
  expect(parked.reconciliation).toBeDefined()
  const execute = vi.fn(async () => { throw new Error('must never execute again') })
  const reconcile = vi.fn(async (lease: import('../src/app/feature-delivery.ts').DeliveryLease) => ({ outcome: 'passed' as const, evidence: [{ id: 'observed-review', kind: 'review' as const, bindings: lease.bindings, recordedAt: '2026-11-06T10:00:00Z', reference: 'https://example.test/actual-review', outcome: 'passed' as const }] }))
  runtime.coordinator.capabilities.review = { execute, reconcile }
  const call = serve({ deliveries: runtime })
  const request = { revision: parked.revision, actionId: parked.reconciliation!.actionId }
  const browser = { origin: 'http://127.0.0.1:3082', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }
  expect(await call('POST', `deliveries/${parked.id}/reconcile`, request)).toMatchObject({ status: 403 })
  expect(await call('POST', `deliveries/${parked.id}/reconcile`, { ...request, command: 'anything' }, browser)).toMatchObject({ status: 400 })
  expect(await call('POST', `deliveries/${parked.id}/reconcile`, request, browser)).toMatchObject({ status: 200 })
  await runtime.request()
  expect(reconcile).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled()
  expect(await call('POST', `deliveries/${parked.id}/reconcile`, request, browser)).toMatchObject({ status: 409 })
  expect(runtime.store.get(parked.id)?.audit.some(a => a.authorization?.source === 'local_operator' && a.authorization.reference.startsWith('orchestrator-http:reconcile:'))).toBe(true)
  await runtime.stop()
})

it('preserves a genuine unresolved chat question after its implementation worker ends without bypassing native submission proof', async () => {
  const call = serve({ sessions: { prompt: vi.fn() }, store: { tickets: { get: () => ({ id: 'ended-t1', ended: { at: '2026-11-04T12:00:00Z', outcome: 'completed' } }), open: () => [] } } })
  const item = { id: 'chat-genuine-question', sessionId: 'worker-ended-t1', sourceMessageId: 'real-question', sourceSeq: 5,
    ticketTitle: 'Ended implementation', trigger: 'Question', status: 'pending', urgency: 'low', createdAt: Date.now(),
    context: 'Which acceptance requirement is missing?', question: 'Which acceptance requirement is missing?',
    choices: [{ id: 'explain', label: 'Explain' }, { id: 'inspect', label: 'Inspect' }],
    recommendation: { recommendedValue: '', confidence: 0, rationale: 'Not evaluated', distribution: [], provider: 'Not evaluated', latencyMs: 0 } }
  expect(await call('POST', 'decisions/inbox', item)).toMatchObject({ status: 200 })
  expect(await call('GET', 'decisions/inbox')).toMatchObject({ status: 200, body: { items: [expect.objectContaining({ id: item.id, status: 'pending' })] } })
  expect(await call('POST', `decisions/${item.id}/resolve`, { choiceId: 'explain' })).toMatchObject({ status: 409, body: { error: expect.stringContaining('Linked native submission required') } })
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

it('grounds helper advice in the native worker delivery rather than client-supplied authority', async () => {
  const systems: string[] = []
  const ticket = { id: 'ready', title: 'Cost summary', mandate: { strength: 'explicit', scope: 'Prepare an artifact; no deployment.' }, assignments: [{ state: 'running', report: { state: 'ready' } }] }
  const call = serve({ store: { tickets: { get: (id: string) => id === 'ready' ? ticket : undefined }, settings: () => SettingsSchema.parse({ models: { hierarchy: [{ provider: 'test', model: 'fast' }] } }) },
    deliveries: { store: { list: () => [{ id: 'd', revision: 1, workers: ['ready'], scopeBinding: { reason: 'Unbound' }, stage: 'review', state: 'blocked', requirements: [], evidence: [], bindings: { repository: 'org/repo', sourceIssue: 1, baseSha: '', headSha: '' } }] } } },
    '127.0.0.1', { llm: { resolveCallConfig: async (route: unknown) => route, async *stream(request: { system: string }) {
      systems.push(request.system)
      yield { type: 'text-delta', text: JSON.stringify({ options: [{ id: 'review', label: 'Prepare release handoff', prompt: 'Review the patch and prepare a release candidate.', recommended: true }, { id: 'defer', label: 'Defer', prompt: 'Defer this artifact.', recommended: false }] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } })
  const payload = { summary: 'Ready', latestTurn: 'Capture the live page now', sessionId: 'worker-ready' }
  expect(await call('POST', 'helper/suggest', payload)).toMatchObject({ status: 200 })
  expect(systems[0]).toContain('RELEASE OBJECTIVE:')
  expect(systems[0]).toContain('\"scopeBound\":false')
  expect(await call('POST', 'helper/suggest', { ...payload, sessionId: 'worker-other' })).toMatchObject({ status: 200 })
  expect(systems[1]).not.toContain('RELEASE OBJECTIVE:')
  expect(await call('POST', 'helper/suggest', { ...payload, handoff: 'Already approved' })).toMatchObject({ status: 400 })
})

it('shares the same release facts between helper, fallback-context endpoint and ranker, retaining them for long turns', async () => {
  const requests: any[] = []
  const deliveryDb = new DatabaseSync(':memory:'); databases.push(deliveryDb)
  const options = [{ id: 'release', label: 'Finish release package', prompt: 'Finish remaining permitted preparation and hand off to the release operator.', recommended: true }, { id: 'wait', label: 'Wait', prompt: 'Explain the actual blocker.', recommended: false }]
  const ticket = { id: 'ready', title: 'Cost summary', mandate: { strength: 'explicit', scope: 'Prepare the artifact; do not deploy.' }, assignments: [{ report: { state: 'ready', at: 'old', summary: 'Original artifact ready' } }] }
  const delivery = { id: 'd', revision: 1, workers: ['ready'], scopeBinding: { reason: 'Missing binding' }, stage: 'review', state: 'blocked', requirements: [], evidence: [], bindings: { repository: 'org/repo', sourceIssue: 190, headSha: '', baseSha: '' } }
  const call = serve({ store: { tickets: { get: () => ticket }, settings: () => SettingsSchema.parse({ models: { hierarchy: [{ provider: 'test', model: 'fast' }] } }) }, deliveries: { store: { db: deliveryDb, list: () => [delivery] } } },
    '127.0.0.1', { agents: { get: () => ({ session: { requestHeader: () => ({ config: { provider: 'test', model: 'fast' } }) } }) }, llm: { resolveCallConfig: async (route: unknown) => route, async *stream(request: any) {
      requests.push(request)
      const answer = request.system.includes('recommendation evaluator') ? { recommended_value: 'release', confidence: .8, rationale: 'Completes the next release stage.', distribution: [{ id: 'release', probability: .8 }, { id: 'wait', probability: .2 }] } : { options }
      yield { type: 'text-delta', text: JSON.stringify(answer) }; yield { type: 'finish', reason: { kind: 'stop' } }
    } } })
  const context = await call('POST', 'helper/context', { sessionId: 'worker-ready' })
  expect(context.status).toBe(200)
  expect(await call('POST', 'helper/context', { sessionId: 'worker-ready', authority: 'publish' })).toMatchObject({ status: 400 })
  expect(await call('POST', 'helper/context', { sessionId: 'worker-ready' }, { 'x-orchestrator-request': undefined })).toMatchObject({ status: 403 })
  expect(await call('POST', 'helper/suggest', { sessionId: 'worker-ready', summary: 'Goal: release cost summary.', latestTurn: 'RC and review are now complete; only the PR body placeholder remains.' })).toMatchObject({ status: 200 })
  expect(requests[0].system).toContain(context.body.context)
  const result = await call('POST', 'decisions/evaluate', { sessionId: 'worker-ready', context: 'x'.repeat(30000), question: 'Next outcome?', choices: options.map(o => ({ id: o.id, label: o.label, prompt: o.prompt })) })
  expect(result.status).toBe(200)
  const ranked = JSON.parse(requests.at(-1).messages[0].content[0].text)
  expect(ranked.context).toContain(context.body.context)
  expect(ranked.context.length).toBeLessThanOrEqual(24000)
  expect(ranked.choices[0].prompt).toBe(options[0]!.prompt)
})


it('derives exact-pin prepared proof for helper context on a pre-upgrade card without rewriting it', async () => {
  const evidence = { repository: 'org/repo', prNumber: 12, headSha: 'a'.repeat(40), patchSha256: 'd'.repeat(64), observedAt: '2026-11-06T10:00:00.000Z',
    checks: 'passed' as const, review: 'approved' as const, mergeable: true, state: 'open' as const,
    local: { reviewer: 'Codex', reportSha256: '1'.repeat(64), reviewExcerpt: 'Recorded review excerpt.',
      checks: [{ name: 'pnpm test', reportSha256: '2'.repeat(64), completedAt: '2026-11-06T10:00:00.000Z', outputExcerpt: 'Suite passed.' }],
      limitations: ['Native acceptance remains separate.'] } }
  const preparedPublication = { id: 'manifest', ticketId: 'ready', decisionId: 'decision', repository: 'org/repo', pr: 12, headSha: 'a'.repeat(40),
    patchSha256: 'd'.repeat(64), environment: 'isolated', preparedAt: '2026-11-06T10:00:00.000Z',
    refs: [{ repository: 'org/repo', pr: 12, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }] }
  const delivery = { id: 'd', revision: 1, workers: ['ready'], owner: 'release-operator', authorities: ['local-operator'], stage: 'ready_to_publish',
    state: 'awaiting_decision', requirements: [], evidence: [], bindings: { repository: 'org/repo', sourceIssue: 1, baseSha: 'b'.repeat(40),
      headSha: 'a'.repeat(40), refs: preparedPublication.refs }, preparedPublication }
  const peek = vi.fn(() => ({ ...preparedPublication, prNumber: 12, conversationId: 'c', status: 'prepared',
    createdAt: '2026-11-06T10:00:00.000Z', updatedAt: '2026-11-06T10:00:00.000Z', outcomes: [], audit: [], requests: {}, evidence }))
  const call = serve({ store: { tickets: { get: () => ({ id: 'ready', title: 'Cost summary', mandate: { strength: 'explicit', scope: 'Prepare.' }, assignments: [] }) },
    settings: () => SettingsSchema.parse({ models: { hierarchy: [{ provider: 'test', model: 'fast' }] } }) },
    deliveries: { store: { list: () => [delivery] } }, publication: { service: { peek }, pinsFor: () => undefined } }, '127.0.0.1')
  const context = await call('POST', 'helper/context', { sessionId: 'worker-ready' })
  expect(context.status).toBe(200)
  expect(context.body.context).toContain('"verified":true')
  expect(context.body.context).toContain('Recorded review excerpt.')
  expect(peek).toHaveBeenCalledWith('ready')
  // The advice copy carries the observation; the recorded card is not rewritten.
  expect(delivery.preparedPublication).not.toHaveProperty('proof')
})

it('does not gate target-validated native stage on unrelated historical recovery', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const call = serve({}, '127.0.0.1', { sessionPersistence: { flush: async () => {}, list: async () => { await gate; return [] } } })
  try {
    const response = await Promise.race([call('POST', 'decisions/not-found/stage', { choiceId: 'a', attemptId: '00000000-0000-4000-8000-000000000001', draftText: 'A' }), new Promise(resolve => setTimeout(() => resolve('timeout'), 1000))])
    expect(response).toMatchObject({ status: 404, body: { error: 'Decision not found' } })
  } finally { release() }
})

it('evaluates advice while unrelated historical recovery is blocked', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const call = serve({ store: { settings: () => SettingsSchema.parse({ models: { helper: { provider: 'configured', model: 'advice' } } }) } }, '127.0.0.1', {
    sessionPersistence: { flush: async () => {}, list: async () => { await gate; return [] } },
    agents: { get: () => undefined }, get: () => undefined,
    llm: { resolveCallConfig: async (route: unknown) => route, async *stream() {
      yield { type: 'text-delta', text: JSON.stringify({ recommended_value: 'a', confidence: .7, rationale: 'Recorded next step.', distribution: [{ id: 'a', probability: .7 }, { id: 'b', probability: .3 }] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  })
  try {
    const response = await Promise.race([call('POST', 'decisions/evaluate', { context: 'Read-only advice.', question: 'Choose?', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }), new Promise(resolve => setTimeout(() => resolve('timeout'), 1000))])
    expect(response).toMatchObject({ status: 200, body: { recommendedValue: 'a', distribution: [{ id: 'a', probability: .7 }, { id: 'b', probability: .3 }] } })
  } finally { release() }
})

it('gates usage reading so in-flight running tickets do not read or flush usage while ended tickets do', async () => {
  const usageOf = vi.fn(async () => ({
    sessionId: 'worker-t1',
    routes: [],
    totals: { uncachedInputTokens: 10, outputTokens: 5, totalTokens: 15 },
    coverage: { attempts: 1, reported: 1, cacheRead: 'unreported' as const, cacheWrite: 'unreported' as const, attribution: 'complete' as const },
    cost: { kind: 'unavailable' as const, reason: 'noRecordedPrice' as const },
  }))
  const runningTicket = {
    id: 't-running',
    title: 'Running job',
    decisionId: 'd',
    mandate: { strength: 'explicit' as const, policyVersion: 'p', actor: { source: 'local' as const, id: 'u' }, scope: 'Run', basis: { via: 'addressed' as const } },
    assignments: [{ id: 'a1', state: 'running' as const, startedAt: '2026-11-08T00:00:00Z', createdAt: '2026-11-08T00:00:00Z' }],
    inputs: [],
    undelivered: [],
    channels: [],
    createdAt: '2026-11-08T00:00:00Z',
    updatedAt: '2026-11-08T00:00:00Z',
  }
  const endedTicket = {
    ...runningTicket,
    id: 't-ended',
    ended: { at: '2026-11-08T01:00:00Z', by: 'executor' as const, outcome: 'merged' as const },
  }
  const tickets = new Map<string, unknown>([
    ['t-running', runningTicket],
    ['t-ended', endedTicket],
  ])
  const call = serve({
    machine: { stateDir: '/nonexistent/state' },
    usage: { of: usageOf },
    links: () => [],
    store: {
      tickets: { get: (id: string) => tickets.get(id) },
      decisions: { get: () => undefined },
      triggers: { get: () => undefined, disposition: () => undefined },
      read: { threadsOfTicket: () => [], firstTrigger: () => undefined, subscribedThreads: () => [] },
      settings: () => SettingsSchema.parse({ models: { hierarchy: [{ provider: 'test', model: 'fast' }] } }),
    },
    sources: { of: () => undefined, kind: () => undefined },
  })

  // Poll in-flight ticket: usage.of must NOT be called
  const runningRes = await call('GET', 'tickets/t-running')
  expect(runningRes.status).toBe(200)
  expect(runningRes.body.usage).toBeUndefined()
  expect(usageOf).not.toHaveBeenCalled()

  // Poll ended ticket: usage.of IS called and returned
  const endedRes = await call('GET', 'tickets/t-ended')
  expect(endedRes.status).toBe(200)
  expect(endedRes.body.usage).toMatchObject({ sessionId: 'worker-t1' })
  expect(usageOf).toHaveBeenCalledWith('worker-t-ended')
})

it('records full-length persisted finding requirements through the protected live-evidence route', async () => {
  const { DeliveryStore } = await import('../src/app/feature-delivery.ts')
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const store = new DeliveryStore(db)
  // Findings permit 16,384 characters; the native form sends the exact saved text, not a shortened label.
  const requirement = 'Verify '.padEnd(16_384, 'x')
  const bindings = { repository: 'org/repo', sourceIssue: 1, baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40) }
  const created = store.create({ id: 'long-live', title: 'Long saved requirement', owner: 'owner', authorities: ['local-operator'], requirements: [requirement], bindings })
  const verifying = store.compareAndSwap(created.id, created.revision, d => {
    d.stage = 'verifying'; d.state = 'awaiting_decision'
    for (const kind of ['publication', 'verification'] as const) d.evidence.push({ id: kind, kind, bindings, recordedAt: '2026-11-10T00:00:00.000Z', reference: 'publication:test', outcome: 'passed', generation: 0 })
  })
  const call = serve({ deliveries: { store, request: async () => {} } })
  const browser = { origin: 'http://127.0.0.1:3082', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }
  const body = { revision: verifying.revision, requirements: [requirement], reference: 'https://example.test/actual-live-evidence' }
  expect(await call('POST', 'deliveries/long-live/evidence', body)).toMatchObject({ status: 403 })
  expect(await call('POST', 'deliveries/long-live/evidence', { ...body, requirements: ['unknown'] }, browser)).toMatchObject({ status: 409 })
  expect(await call('POST', 'deliveries/long-live/evidence', { ...body, requirements: ['x'.repeat(16_385)] }, browser)).toMatchObject({ status: 400 })
  expect(await call('POST', 'deliveries/long-live/evidence', body, browser)).toMatchObject({ status: 200, body: { delivery: { stage: 'verifying', state: 'awaiting_decision', nextAction: { kind: 'accept' } } } })
  expect(store.get('long-live')!.evidence.at(-1)!.requirements).toEqual([requirement])
  expect(store.get('long-live')!.acceptance).toBeUndefined()
  expect(await call('POST', 'deliveries/long-live/evidence', body, browser)).toMatchObject({ status: 409 })
})
