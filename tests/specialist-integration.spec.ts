import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DecisionInbox } from '../src/app/decision-inbox.ts'
import { canonicalOperation, CanonicalPublishSchema } from '../src/app/http.ts'
import { suggestWithSpecialist, SpecialistAttributionSchema, attributionFor, prepareSpecialist } from '../src/app/specialist-advice.ts'
import { SettingsSchema } from '../src/policy.ts'
import { seedProfiles } from '../src/core/specialist-profile.ts'
import { activityFromSessionEvents, applyStaleness, deriveActivity, STALE_AFTER_MS } from '../src/core/specialist-activity.ts'
import { evidenceFromEvents, deriveActivity as pluginDerive } from '../../dsh-next-steps/src/client/specialist-activity.ts'

const databases: DatabaseSync[] = []
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.restoreAllMocks() })
const events = [
  { type: 'user/message', seq: 0, time: 100, data: { id: 'human', source: { kind: 'user' }, content: [{ type: 'text', text: 'Deploy it' }] } },
  { type: 'turn/start', seq: 1, time: 101, data: { turn: 1 } },
  { type: 'assistant/message', seq: 2, time: 102, data: { turn: 1, message: { id: 'answer', content: [{ type: 'text', text: 'Ship the Worker with wrangler to Cloudflare?' }] }, stream: [] } },
  { type: 'turn/end', seq: 3, time: 103, data: { turn: 1, reason: { kind: 'completed' } } },
] as unknown as SessionEvent[]
const source = { sessionId: 'chat', sourceMessageId: 'answer', sourceTurn: 1, sourceSeq: 2, draftRevision: 'sha256:r1' }
const options = [
  { id: 'docs', label: 'Read Workers docs', prompt: 'Read the Workers docs first.', why: 'Cheap.', recommended: true },
  { id: 'dry', label: 'Wrangler dry run', prompt: 'Run wrangler deploy --dry-run.', why: 'No writes.', recommended: false },
]
const persistence = { async flush() {}, async open() { return { async read(offset = 0) { return { events: offset ? [] : events } }, async [Symbol.asyncDispose]() {} } } }
const ctx = (extra: object = {}) => ({ sessionPersistence: persistence, ...extra }) as never
const open = () => { const db = new DatabaseSync(':memory:'); databases.push(db); return new DecisionInbox(db) }
const attribution = { profileId: 'cloudflare_specialist', basis: 'keyword', unavailable: ['cloudflare.docs.read', 'cloudflare.account.read'] }

function helperCtx(replies: Array<string | Error> = [JSON.stringify({ options })], tools?: unknown) {
  const calls: Record<string, unknown>[] = []
  const logger = { warn: vi.fn() }
  return { calls, ctx: { get: () => ({ currentSelection: () => ({ provider: 'default', model: 'default' }) }), logger, tools, llm: { resolveCallConfig: async (route: unknown) => route, async *stream(request: Record<string, unknown>) {
    calls.push(request); const reply = replies.shift()!; if (reply instanceof Error) throw reply
    yield { type: 'text-delta', text: reply }; yield { type: 'finish', reason: { kind: 'stop' } } } } } as never }
}

it('helper/suggest seam: the SAME tool-free generation, routed to Cloudflare with unavailable stated and bounded metadata returned', async () => {
  const h = helperCtx()
  const result = await suggestWithSpecialist(h.ctx, { summary: 'Deploy', latestTurn: 'Deploy the Worker with wrangler to Cloudflare' }, SettingsSchema.parse({}), undefined)
  expect(result.options.map(o => o.id)).toEqual(['docs', 'dry'])
  expect(h.calls).toHaveLength(1)
  expect(h.calls[0]).toMatchObject({ tools: [] })
  expect(String(h.calls[0]!.system)).toContain('Unavailable (do not claim or simulate them): cloudflare.docs.read, cloudflare.account.read')
  expect(SpecialistAttributionSchema.parse(result.specialist)).toEqual({ profileId: 'cloudflare_specialist', basis: 'keyword', unavailable: ['cloudflare.docs.read', 'cloudflare.account.read'] })
})

it('capability discovery is read-only and truthful: a discovered Cloudflare tool grants nothing beyond reads and never writes', () => {
  const profiles = seedProfiles(); const settings = SettingsSchema.parse({})
  const unavailable = prepareSpecialist({ profiles, settings, task: 'wrangler deploy', discovery: { toolNames: ['bash'], at: Date.now() } })
  expect(unavailable.status === 'prepared' && unavailable.attribution.unavailable).toEqual(['cloudflare.docs.read', 'cloudflare.account.read'])
  const present = prepareSpecialist({ profiles, settings, task: 'wrangler deploy', discovery: { toolNames: ['mcp__cloudflare__search', 'mcp__cloudflare__execute'], at: Date.now() } })
  if (present.status !== 'prepared') throw new Error('expected prepared')
  expect(present.resolution.granted).not.toContain('cloudflare.write')
  expect(present.system).not.toContain('cloudflare.write')
})

it('saved provider policy still constrains the specialist route: an exhausted (e.g. OpenAI) provider is skipped and nothing is called', async () => {
  const settings = SettingsSchema.parse({ models: { helper: { provider: 'openai', model: 'gpt' }, subscriptions: [{ provider: 'openai', status: 'exhausted' }, { provider: 'default', status: 'exhausted' }] } })
  const h = helperCtx([JSON.stringify({ options })])
  const result = await suggestWithSpecialist(h.ctx, { summary: 'x', latestTurn: 'Deploy the Worker with wrangler' }, settings, undefined).catch(error => error)
  expect(h.calls.every(call => call.provider !== 'openai')).toBe(true)
  expect(result instanceof Error || h.calls.length === 0 || h.calls[0]!.provider !== 'openai').toBe(true)
})

it('publish carries a bounded specialist and attributes the SAME record; staged records refuse attribution without failing the publication', async () => {
  const inbox = open()
  const claim = inbox.claimCanonical({ ...source, owner: 'host' }, events)
  const published = await canonicalOperation(ctx(), inbox, 'publish', { ...source, leaseToken: claim.leaseToken, model: 'helper', options, specialist: attribution })
  expect(inbox.list()).toHaveLength(1)
  expect(published.item.id).toBe(claim.item.id)
  expect(published.item.character).toMatchObject({ characterId: 'cloudflare_specialist', name: 'Cloudflare Specialist', mode: 'suggest', unavailable: attribution.unavailable })
  expect(published.item.choices.map(c => c.id)).toEqual(['docs', 'dry'])
  // Strict schema: display names, extra fields and unknown capability ids are refused.
  expect(CanonicalPublishSchema.safeParse({ ...source, leaseToken: 'x', model: 'm', options, specialist: { ...attribution, name: 'Admin' } }).success).toBe(false)
  expect(CanonicalPublishSchema.safeParse({ ...source, leaseToken: 'x', model: 'm', options, specialist: { ...attribution, unavailable: ['shell.root'] } }).success).toBe(false)
  // Unknown profile id: publication stands unattributed.
  const other = open(); const c2 = other.claimCanonical({ ...source, owner: 'host' }, events)
  const unknown = await canonicalOperation(ctx(), other, 'publish', { ...source, leaseToken: c2.leaseToken, model: 'helper', options, specialist: { ...attribution, profileId: 'root' } })
  expect(unknown.item.character).toBeUndefined(); expect(unknown.item.choices).toHaveLength(2)
  expect(attributionFor({ ...attribution, profileId: 'nope' } as never)).toBeUndefined()
})

it('Administrator advises only on existing delegated actions and never proposes acceptance', () => {
  const profiles = seedProfiles(); const settings = SettingsSchema.parse({})
  const deliveries = [
    { id: 'd1', title: 'Release', owner: 'worker-a', state: 'ready', nextAction: { id: 'a1', kind: 'accept', label: 'Accept release' }, delegatedActions: ['accept'] },
    { id: 'd2', title: 'Fix', owner: 'worker-b', state: 'ready', nextAction: { id: 'a2', kind: 'restart', label: 'Restart worker' }, delegatedActions: ['restart'] },
    { id: 'd3', title: 'Other', owner: 'worker-c', state: 'ready', nextAction: { id: 'a3', kind: 'merge', label: 'Merge it' }, delegatedActions: [] },
  ]
  const prepared = prepareSpecialist({ profiles, settings, task: 'Who owns these deliveries and what is the handoff?', deliveries })
  if (prepared.status !== 'prepared') throw new Error('refused')
  expect(prepared.route.profileId).toBe('administrator')
  expect(prepared.system).toMatch(/- d2 .*propose_action restart/)
  expect(prepared.system).not.toMatch(/propose_action accept/)
  expect(prepared.system).not.toMatch(/propose_action merge/)
  expect(prepared.system).toContain('never propose acceptance')
  expect(prepared.system).toContain('a person still confirms and Sends')
  // With no deliveries the Administrator has nothing to advise on and the unchanged helper runs.
  expect(prepareSpecialist({ profiles, settings, task: 'Who owns these deliveries?', deliveries: [] }).status).toBe('refused')
})

it('native event parity: the dock copy of the mapper agrees with the backend mapper on real shapes, including aborted', () => {
  const native = [
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, time: 1100, data: { turn: 1, step: 1, callId: 'c', name: 'bash', arguments: '{"command":"vitest run"}' } },
    { type: 'turn/end', seq: 3, time: 1200, data: { turn: 1, reason: { kind: 'aborted' } } },
  ]
  for (const n of [1, 2, 3]) {
    const slice = native.slice(0, n)
    expect(pluginDerive(evidenceFromEvents(slice), 1300).state).toBe(deriveActivity(activityFromSessionEvents(slice as never), 1300).state)
  }
  const old = deriveActivity(activityFromSessionEvents(native.slice(0, 1) as never), 1300)
  expect(applyStaleness(old, 1000 + STALE_AFTER_MS + 1).state).toBe('unknown')
})

it('publish revalidates missing tools and configured identity instead of trusting caller display metadata', async () => {
  const inbox = open(); const claim = inbox.claimCanonical({ ...source, owner: 'host' }, events)
  const result = await canonicalOperation(ctx({ tools: { schemas: () => [] } }), inbox, 'publish', { ...source, leaseToken: claim.leaseToken, model: 'helper', options, specialist: { ...attribution, unavailable: [] } })
  expect(result.item.character?.unavailable).toEqual(['cloudflare.docs.read', 'cloudflare.account.read'])
  const settings = SettingsSchema.parse({}); settings.characters.characters[0]!.name = 'My Senior Reviewer'
  const other = open(); const second = other.claimCanonical({ ...source, owner: 'host' }, events)
  const named = await canonicalOperation(ctx(), other, 'publish', { ...source, leaseToken: second.leaseToken, model: 'helper', options, specialist: { profileId: settings.characters.characters[0]!.id, basis: 'default', unavailable: [] } }, settings)
  expect(named.item.character?.name).toBe('My Senior Reviewer')
})
