// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { FindingStore, findingDecision } from '../src/app/finding.ts'
import { PublicationDock } from '../src/client/publication-cards.tsx'
import { InlineDecision } from '../src/client/inline-decision.tsx'
import { findingMatchesSession } from '../src/client/finding-association.ts'
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
