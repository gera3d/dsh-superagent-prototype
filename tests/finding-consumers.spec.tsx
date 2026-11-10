// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { FindingStore, findingDecision } from '../src/app/finding.ts'
import { PublicationDock } from '../src/client/publication-cards.tsx'
import { InlineDecision } from '../src/client/inline-decision.tsx'
import { deliveryMatchesSession, findingMatchesSession } from '../src/client/finding-association.ts'
const fixture = vi.hoisted(() => ({ items: [] as any[], call: vi.fn() }))
vi.mock('../src/client/api.ts', () => ({ caller: () => fixture.call, usePoll: () => ({ data: { items: fixture.items }, reload: vi.fn() }) }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let cleanup = () => {}
afterEach(() => { cleanup(); fixture.items = []; fixture.call.mockReset() })
function dispatched() {
  const db = new DatabaseSync(':memory:'); const store = new FindingStore(db)
  let record = store.observe({ dedupKey: 'external-verification', title: 'Verify reported visibility', problem: 'Reported observation needs verification', scope: 'Bounded visibility verification', kind: 'verification', owner: 'Senior Developer', repository: 'example/repo', requirements: ['Preserve correction'], occurrence: { id: 'o', reference: 'external issue', evidence: 'Observation plus correction' } })
  record = store.confirm(record.id, { revision: record.revision, choiceId: 'fix_now' })
  record = store.markDispatched(record.id, 'ticket-current', 'assignment-current')
  const item = findingDecision(record); db.close(); return item
}
async function mounted() {
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node)
  cleanup = () => { act(() => root.unmount()); node.remove() }
  const render = async (sessionId: string) => { await act(async () => { root.render(<PublicationDock sessionId={sessionId} />) }) }
  return { node, root, render }
}
it('actual no-origin FindingStore handoff projects into the worker dock and follows mounted conversation switches', async () => {
  const item = dispatched(); expect(item.sessionId).toBeUndefined(); fixture.items = [item]
  const view = await mounted(); await view.render('unrelated')
  expect(view.node.textContent).toBe('')
  await view.render('worker-ticket-current')
  expect(view.node.textContent).toContain('Verify reported visibility')
  expect(view.node.textContent).toContain('assignment-current')
  await view.render('unrelated'); expect(view.node.textContent).toBe('')
  await view.render('ticket-current'); expect(view.node.textContent).toContain('Work dispatched')
})
it('preserves origin and prior-job worker attribution without leaking to unrelated sessions', async () => {
  const item = dispatched(); item.sessionId = 'origin'; item.finding!.priorJobs = [{ id: 'prior-job', ticketId: 'worker-ticket-prior' }]
  for (const id of ['origin', 'worker-ticket-current', 'ticket-current', 'worker-ticket-prior', 'ticket-prior']) expect(findingMatchesSession(item, id)).toBe(true)
  expect(findingMatchesSession(item, 'unrelated')).toBe(false)
  fixture.items = [item]; const view = await mounted(); await view.render('ticket-prior')
  expect(view.node.textContent).toContain('Verify reported visibility')
})
it('associated no-origin dispatched finding suppresses inline generic synthesis and older suggestion controls', async () => {
  const item = dispatched()
  fixture.items = [item, { id: 'generic', sessionId: 'worker-ticket-current', status: 'pending', question: 'Generic', choices: [{ id: 'continue', label: 'Continue' }], recommendation: { recommendedValue: '' } }]
  const view = await mounted()
  const chat = { legacy: { nodes: [{ kind: 'assistant', seq: 1, turn: 1, messageId: 'm', blocks: [{ kind: 'text', text: '1. Run tests\n2. Inspect diff' }] }] }, timeline: { turns: new Map([[1, { status: 'closed' }]]) } }
  await act(async () => { view.root.render(<InlineDecision {...{ session: { sessionId: 'worker-ticket-current', running: false, openState: 'open', pendingSubmissions: [] }, input: { phase: 'plain', draft: '', attachmentIds: [] }, inputActions: {}, useConversation: (select: any) => select({ views: new Map([['chat', chat]]) }) } as any} />) })
  expect(view.node.textContent).toBe(''); expect(fixture.call).not.toHaveBeenCalled()
})

it('keeps dispatched evidence forms collapsed in chat across polling and bounds the opened dock', async () => {
  const item = dispatched(); fixture.items = [item]
  const view = await mounted(); await view.render('worker-ticket-current')
  const disclosure = view.node.querySelector('.dt-finding-card > details') as HTMLDetailsElement
  expect(disclosure).not.toBeNull()
  expect(disclosure.open).toBe(false)
  expect(disclosure.querySelector(':scope > summary')?.textContent).toContain('In progress')
  expect(disclosure.querySelector('[aria-label="Record operator evidence"]')).not.toBeNull()
  expect(view.node.querySelector('.dt-finding-card')?.getAttribute('style')).toBeNull()
  await act(async () => { disclosure.open = true })
  const draft = disclosure.querySelector('[aria-label="Durable evidence reference"]') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(draft, 'ci:preserved-draft'); draft.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => { disclosure.open = false })
  item.finding!.revision++; await view.render('worker-ticket-current')
  expect(disclosure.open).toBe(false)
  expect(draft.value).toBe('ci:preserved-draft')
  expect(fixture.call).not.toHaveBeenCalled()
  expect(disclosure.querySelector('.dt-delivery-body')).not.toBeNull()
})

it('also keeps legacy publication history out of the chat viewport without removing its evidence', async () => {
  const item = dispatched(); delete item.finding; item.actionMode = 'ticket_lifecycle'; item.sessionId = 'publication-worker'; item.status = 'stale'
  item.lifecycle = { kind: 'done', assignmentId: 'original-assignment', docsOnly: false, recovery: true, publication: { id: 'pub-closed', ticketId: 'ticket-current', conversationId: 'publication-worker', repository: 'example/repo', prNumber: 1, headSha: 'a'.repeat(40), patchSha256: 'b'.repeat(64), status: 'published', createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T01:00:00Z', outcomes: [{ stage: 'verify', operationId: 'verify', status: 'succeeded', startedAt: '2026-11-07T01:00:00Z' }], audit: [], requests: {} } }
  fixture.items = [item]; const view = await mounted(); await view.render('publication-worker')
  const disclosure = view.node.querySelector('.dt-delivery-disclosure') as HTMLDetailsElement
  expect(disclosure.open).toBe(false)
  expect(disclosure.querySelector(':scope > summary')?.textContent).toContain('Publication')
  expect(disclosure.querySelector('.dt-lifecycle-card')?.getAttribute('style')).toBeNull()
  expect(disclosure.textContent).toContain('Publication history · published')
  expect(disclosure.textContent).toContain('verify: succeeded')
  expect(fixture.call).not.toHaveBeenCalled()
})

it('matches delivery sessions across bare/worker prefixes and links through active findings', async () => {
  const deliveryItem = {
    id: 'del-1',
    status: 'pending' as const,
    actionMode: 'feature_delivery' as const,
    ticketTitle: 'Delivery feature',
    delivery: {
      id: 'd-123',
      title: 'Delivery feature',
      revision: 1,
      stage: 'verifying' as const,
      state: 'awaiting_decision' as const,
      owner: 'operator',
      workers: ['ticket-worker-alpha'],
      requirements: ['req-1'],
      bindings: { repository: 'org/repo', sourceIssue: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
      attempts: { review: 1, fix: 0, maxReview: 3, maxFix: 2 },
      evidence: [],
      audit: [],
      authorities: ['operator'],
      generation: 0,
      nextAction: { id: 'act-1', kind: 'accept' as const, label: 'Accept', revision: 1, fingerprint: 'fp' },
    },
  }

  // 1. Matches bare session or worker-prefixed session directly from delivery.workers
  expect(deliveryMatchesSession(deliveryItem as any, 'worker-ticket-worker-alpha')).toBe(true)
  expect(deliveryMatchesSession(deliveryItem as any, 'ticket-worker-alpha')).toBe(true)
  expect(deliveryMatchesSession(deliveryItem as any, 'unrelated')).toBe(false)

  // 2. Matches worker ticket or worker session
  expect(deliveryMatchesSession(deliveryItem as any, 'ticket-worker-alpha')).toBe(true)
  expect(deliveryMatchesSession(deliveryItem as any, 'worker-ticket-worker-alpha')).toBe(true)
  expect(deliveryMatchesSession(deliveryItem as any, 'unrelated')).toBe(false)

  // 3. Mounts DeliveryCard in PublicationDock for the matching thread session
  fixture.items = [deliveryItem]
  const view = await mounted()
  await view.render('worker-ticket-worker-alpha')
  expect(view.node.textContent).toContain('Delivery feature')
  expect(view.node.textContent).toContain('Proceed without recommendation: Accept')
})
