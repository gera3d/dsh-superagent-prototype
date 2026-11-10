import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Store } from '../src/app/store.ts'
import { FeatureDeliveryRuntime } from '../src/app/delivery-runtime.ts'
import { HandoffBlocked } from '../src/app/delivery-handoff.ts'
import { recordLiveAttestation } from '../src/app/delivery-evidence.ts'
import { DeliveryStore } from '../src/app/feature-delivery.ts'
import { registerHttp, type HttpHost } from '../src/app/http.ts'
import { DeliveryCard } from '../src/client/delivery-card.tsx'
import type { Ticket } from '../src/core/model.ts'
import type { LifecyclePublication } from '../src/app/lifecycle-publication.ts'

const cleanup: (() => void)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const done of cleanup.splice(0).reverse()) done() })
const at = '2026-11-06T10:00:00.000Z'
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40)
const scope = (overrides: Record<string, unknown> = {}) => ({ environment: 'local-harness', refs: [{ repository: 'org/repo', pr: 12, headSha: HEAD, baseSha: BASE }], components: ['harness'], effects: ['restart'], manifestSha256: 'c'.repeat(64), ...overrides })
const prepare = vi.fn(async () => ({ id: 'manifest-1', status: 'prepared', updatedAt: at, evidence: [] }))
const publication = (profile: boolean, scopes = true): LifecyclePublication => ({
  service: { prepare },
  pinsFor: (repository: string, pr: number) => profile && repository === 'org/repo' && pr === 12 ? { repository, prNumber: 12, headSha: HEAD, patchSha256: 'd'.repeat(64) } : undefined,
  scopeFor: scopes ? (repository: string, pr: number) => profile && repository === 'org/repo' && pr === 12 ? scope() as never : undefined : undefined,
} as unknown as LifecyclePublication)

function fixture(opts: { profile?: boolean; scopes?: boolean; pr?: boolean; ready?: boolean } = {}) {
  const path = mkdtempSync(join(tmpdir(), 'delivery-handoff-'))
  const store = new Store(join(path, 'test.sqlite')); cleanup.push(() => { store.close(); rmSync(path, { recursive: true, force: true }) })
  const review = { execute: vi.fn(async (lease: import('../src/app/feature-delivery.ts').DeliveryLease) => ({ outcome: 'passed' as const, evidence: [{ id: `review:${lease.id}`, kind: 'review' as const, bindings: lease.bindings, recordedAt: at, reference: 'https://example.test/independent-review', outcome: 'passed' as const }] })) }
  const runtime = new FeatureDeliveryRuntime(store, { review }, { publication: publication(opts.profile ?? true, opts.scopes ?? true) })
  const ticket: Ticket = { id: 'src', title: 'Source task', decisionId: 'd', mandate: {} as never, origin: { triggerId: 'source', triggerIds: ['source'] }, createdAt: at, updatedAt: at,
    channels: [], inputs: [], undelivered: [], follows: opts.pr === false ? [] : [{ thread: 'github:12', own: true }],
    assignments: [{ id: 'a', state: 'running', createdAt: at, idleAt: at, report: { state: opts.ready === false ? 'progress' : 'ready', summary: 'Actual recorded ready report', at } }] }
  store.tickets.save(ticket)
  runtime.store.trackUnbound({ ticketId: ticket.id, title: ticket.title, owner: 'worker:src', repository: 'org/repo', triggerId: 'source' })
  return { store, runtime }
}

it('lists exact missing profile inputs, with owners, instead of calling the handoff implemented', async () => {
  const { runtime } = fixture({ profile: false })
  try {
    const item = runtime.project([])[0]!
    expect(item.delivery!.handoff).toMatchObject({ status: 'needs_inputs' })
    expect(item.delivery!.handoff!.missing[0]).toMatchObject({ field: 'pins', owner: expect.stringContaining('publication-runner.json'), detail: expect.stringContaining('pins.headSha') })
    expect(() => runtime.prepareHandoff('auto-src', { revision: item.delivery!.revision, requirements: ['live-check'] })).toThrow(HandoffBlocked)
    expect(runtime.store.get('auto-src')!.scopeBinding).toBeDefined()
  } finally { await runtime.stop() }
})
it('names deliveryScope fields when only pins exist, and a missing PR or ready report', async () => {
  expect(fixture({ scopes: false }).runtime.project([])[0]!.delivery!.handoff!.missing[0]).toMatchObject({ field: 'deliveryScope', detail: expect.stringContaining('deliveryScope.environment') })
  expect(fixture({ pr: false }).runtime.project([])[0]!.delivery!.handoff!.missing.map(m => m.field)).toContain('pull request')
  expect(fixture({ ready: false }).runtime.project([])[0]!.delivery!.handoff!.missing.map(m => m.field)).toContain('worker report')
})
it('one protected click binds verified facts and the coordinator really runs review, but never publishes or accepts', async () => {
  const { runtime, store } = fixture()
  try {
    const before = runtime.project([])[0]!
    expect(before.delivery!.handoff).toMatchObject({ status: 'ready', preview: { pr: 12, headSha: HEAD, baseSha: BASE, environment: 'local-harness' } })
    expect(() => runtime.prepareHandoff('auto-src', { revision: before.delivery!.revision, requirements: [] })).toThrow('acceptance requirements')
    expect(() => runtime.prepareHandoff('auto-src', { revision: before.delivery!.revision, requirements: ['intake:x'] })).toThrow('acceptance requirements')
    expect(() => runtime.prepareHandoff('auto-src', { revision: before.delivery!.revision + 5, requirements: ['live-check'] })).toThrow('Stale')
    runtime.prepareHandoff('auto-src', { revision: before.delivery!.revision, requirements: ['live-check'] })
    // Duplicate click: the delivery is no longer unbound, so replay is rejected rather than rebinding.
    expect(() => runtime.prepareHandoff('auto-src', { revision: before.delivery!.revision, requirements: ['live-check'] })).toThrow('Stale or already-bound')
    await runtime.request()
    const after = runtime.store.get('auto-src')!
    expect(after.scopeBinding).toBeUndefined()
    expect(after.bindings).toMatchObject({ repository: 'org/repo', headSha: HEAD, baseSha: BASE, environment: 'local-harness' })
    expect(after.authorities).toEqual(['local-operator'])
    expect(after.delegatedActions).toEqual(['review', 'fix', 'verify'])
    expect(after.audit.some(a => a.event.startsWith('scope-bound:local_operator:'))).toBe(true)
    expect(after.evidence.map(e => e.kind)).toEqual(expect.arrayContaining(['implementation', 'review']))
    expect(after.stage).toBe('ready_to_publish')
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ repository: 'org/repo', prNumber: 12, headSha: HEAD, ticketId: 'src' }))
    expect(after.preparedPublication).toMatchObject({ id: 'manifest-1', repository: 'org/repo', pr: 12, headSha: HEAD, environment: 'local-harness' })
    // The next step is the explicit publish confirmation: never auto-executed or delegated.
    expect(after.nextAction?.kind).toBe('publish')
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM feature_delivery_outbox WHERE value LIKE '%\"kind\":\"publish\"%'").get()).toMatchObject({ n: 0 })
  } finally { await runtime.stop() }
})
it('survives restart: the bound delegation continues from durable state', async () => {
  const { runtime, store } = fixture()
  const revision = runtime.store.get('auto-src')!.revision
  runtime.prepareHandoff('auto-src', { revision, requirements: ['live-check'] })
  await runtime.stop()
  const restarted = new FeatureDeliveryRuntime(store, { review: { execute: async lease => ({ outcome: 'passed' as const, evidence: [{ id: `review:${lease.id}`, kind: 'review' as const, bindings: lease.bindings, recordedAt: at, reference: 'https://example.test/r', outcome: 'passed' as const }] }) } }, { publication: publication(true) })
  try { await restarted.request(); expect(restarted.store.get('auto-src')!.stage).toBe('ready_to_publish') } finally { await restarted.stop() }
})
it('requires a local operator on the HTTP prepare and evidence routes', async () => {
  const { runtime } = fixture()
  const db = new DatabaseSync(':memory:'); cleanup.push(() => db.close())
  let handler: (req: unknown, res: unknown) => Promise<void> = async () => {}
  registerHttp({ on: () => () => {}, sessionPersistence: { flush: async () => {}, list: async () => [] }, logger: { error: () => {}, warn: () => {} },
    webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: typeof handler }) => { handler = route.handler; return () => {} } } } as never,
    { ready: Promise.resolve(), configured: () => false, deliveries: runtime, store: { db } } as unknown as HttpHost)
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    let status = 0, text = ''
    await handler({ method: 'POST', url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } },
      { writeHead: (code: number) => { status = code }, end: (data?: string) => { if (data) text = data } })
    return { status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
  }
  const browser = { origin: 'http://127.0.0.1:3082', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }
  try {
    const revision = runtime.store.get('auto-src')!.revision
    expect(await call('deliveries/auto-src/prepare', { revision, requirements: ['live-check'] })).toMatchObject({ status: 403 })
    expect(await call('deliveries/auto-src/prepare', { revision, requirements: ['live-check'], commands: ['rm -rf /'] }, browser)).toMatchObject({ status: 400 })
    expect(await call('deliveries/auto-src/prepare', { revision, requirements: ['live-check'] }, browser)).toMatchObject({ status: 200 })
    expect(await call('deliveries/auto-src/evidence', { revision, requirements: ['live-check'], reference: 'https://example.test/x' })).toMatchObject({ status: 403 })
    // Not yet verifying: operator evidence cannot be recorded early.
    const early = await call('deliveries/auto-src/evidence', { revision: runtime.store.get('auto-src')!.revision, requirements: ['live-check'], reference: 'https://example.test/x' }, browser)
    expect(early.status).toBe(409)
  } finally { await runtime.stop() }
})
it('operator live attestation maps only named intake requirements and never accepts', async () => {
  const db = new DatabaseSync(':memory:'); cleanup.push(() => db.close())
  const store = new DeliveryStore(db)
  const bindings = { repository: 'org/repo', sourceIssue: 1, baseSha: BASE, headSha: HEAD }
  const created = store.create({ id: 'v', title: 'v', owner: 'o', workers: [], authorities: ['local-operator'], requirements: ['a', 'b'], bindings })
  const verifying = store.compareAndSwap(created.id, created.revision, d => {
    d.stage = 'verifying'; d.state = 'awaiting_decision'
    d.evidence.push({ id: 'pub', kind: 'publication', bindings, recordedAt: at, reference: 'publication:x', outcome: 'passed', generation: 0 },
      { id: 'auto', kind: 'verification', bindings, recordedAt: at, reference: 'publication:x#verify', outcome: 'passed', generation: 0 })
  })
  expect(verifying.nextAction).toBeUndefined()
  expect(verifying.awaitingOperatorEvidence).toEqual(['a', 'b'])
  expect(() => recordLiveAttestation(store, 'v', { revision: verifying.revision, requirements: ['zzz'], reference: 'https://example.test/e' }, 'local-operator')).toThrow('intake subset')
  expect(() => recordLiveAttestation(store, 'v', { revision: verifying.revision, requirements: ['a'], reference: 'http://example.test/e' }, 'local-operator')).toThrow('HTTPS')
  const failed = recordLiveAttestation(store, 'v', { revision: verifying.revision, requirements: ['a'], reference: 'https://example.test/e', outcome: 'failed' }, 'local-operator')
  expect(failed.state).toBe('blocked')
  const partial = recordLiveAttestation(store, 'v', { revision: failed.revision, requirements: ['a'], reference: 'https://example.test/e2' }, 'local-operator')
  expect(partial.nextAction).toBeUndefined()
  expect(partial.awaitingOperatorEvidence).toEqual(['b'])
  const full = recordLiveAttestation(store, 'v', { revision: partial.revision, requirements: ['b'], reference: 'https://example.test/e3' }, 'local-operator')
  expect(full.state).toBe('awaiting_decision')
  expect(full.nextAction?.kind).toBe('accept')
  expect(full.acceptance).toBeUndefined()
})
it('renders an executable handoff control and an evidence control', async () => {
  const { runtime } = fixture()
  try {
    const card = (item: never, extra = {}) => renderToStaticMarkup(createElement(DeliveryCard, { item, onConfirm: async () => {}, ...extra }))
    const html = card(runtime.project([])[0]! as never)
    expect(html).toContain('Start review, tests and release preparation')
    expect(html).toContain('Next owner:')
    const missing = fixture({ profile: false }).runtime.project([])[0]!
    const blocked = card(missing as never)
    expect(blocked).toMatch(/<button\b/)
    expect(blocked).toContain('pins.headSha')
    const evidence = { ...runtime.project([])[0]!, delivery: { ...runtime.project([])[0]!.delivery!, scopeBinding: undefined, awaitingOperatorEvidence: ['live-check'] } }
    const html2 = card(evidence as never)
    expect(html2).toContain('Record live evidence: passed')
    expect(html2).toContain('proves none of your requirements')
  } finally { await runtime.stop() }
})
