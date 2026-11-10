import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { FeatureDeliveryRuntime, deliveryDecision, reconcileInboxCurrency } from '../src/app/delivery-runtime.ts'
import { DecisionInbox, ticketDecisions } from '../src/app/decision-inbox.ts'
import { publicationConversation, type LifecyclePublication } from '../src/app/lifecycle-publication.ts'
import type { Ticket } from '../src/core/model.ts'
import type { Delivery, DeliveryAction } from '../src/app/feature-delivery.ts'

const cleanup: (() => void)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const done of cleanup.splice(0).reverse()) done() })
const at = '2026-11-06T10:00:00.000Z'
function fixture(capabilities: ConstructorParameters<typeof FeatureDeliveryRuntime>[1] = {}, options: ConstructorParameters<typeof FeatureDeliveryRuntime>[2] = {}) {
  const path = mkdtempSync(join(tmpdir(), 'delivery-runtime-'))
  const store = new Store(join(path, 'test.sqlite')); cleanup.push(() => { store.close(); rmSync(path, { recursive: true, force: true }) })
  const runtime = new FeatureDeliveryRuntime(store, capabilities, options)
  const worker = (id: string, ended = true) => {
    const ticket: Ticket = { id, title: id, decisionId: 'source-decision', mandate: {} as never, origin: { triggerId: 'source', triggerIds: ['source'] }, createdAt: at, updatedAt: at,
      channels: [], inputs: [], undelivered: [], follows: [{ thread: 'github:12', own: true, ...(ended ? { closed: { at, outcome: 'merged' as const } } : {}) }],
      ...(ended ? { ended: { at, by: 'pull' as never, outcome: 'merged' as const } } : {}),
      assignments: [{ id: 'a', state: 'running', createdAt: at, idleAt: at, report: { state: 'ready', summary: 'Actual recorded ready report', at } }] }
    store.tickets.save(ticket); return ticket
  }
  const intake = (id: string, workers: string[], delegatedActions: ('review' | 'fix')[] = []) => runtime.store.create({ id, title: id, owner: 'integration-owner', workers, delegatedActions,
    authorities: ['operator'], requirements: ['native-click'], bindings: { repository: 'org/repo', sourceIssue: 159, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), environment: 'isolated',
      refs: [{ repository: 'org/repo', pr: 12, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }] } })
  return { store, runtime, worker, intake }
}
it('ready unbound task has an executable in-thread preparation handoff', async () => {
 const {runtime,worker}=fixture()
 const ticket=worker('ready-source')
 runtime.store.trackUnbound({ticketId:ticket.id,title:ticket.title,owner:'source-owner',repository:'org/repo',triggerId:'source'})
 try {
  await runtime.request()
  const item=runtime.project([])[0]!
  const {createElement}=await import('react')
  const {renderToStaticMarkup}=await import('react-dom/server')
  const {DeliveryCard}=await import('../src/client/delivery-card.tsx')
  const html=renderToStaticMarkup(createElement(DeliveryCard,{item,onConfirm:async()=>{}}))
  expect(html).toMatch(/<button\b/)
 } finally {await runtime.stop()}
})
