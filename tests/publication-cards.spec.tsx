// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { PendingDecisionItem } from '../src/core/decision.ts'
const state = vi.hoisted(() => ({ items: [] as PendingDecisionItem[], call: vi.fn() }))
vi.mock('../src/client/api.ts', () => ({ caller: () => state.call, usePoll: () => ({ data: { items: state.items } }) }))
import { LifecycleCard } from '../src/client/lifecycle-card.tsx'
import { PublicationDock } from '../src/client/publication-cards.tsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: ReturnType<typeof createRoot> | undefined
const container = document.createElement('div')
afterEach(() => { act(() => root?.unmount()); root = undefined; state.items = []; state.call.mockReset(); container.replaceChildren() })
function item(sessionId = 'worker-example'): PendingDecisionItem { return { id: 'life-example', sessionId, ticketId: 'example', ticketTitle: 'Harmless example', trigger: 'Ready',
  status: 'pending', urgency: 'low', createdAt: 1, question: 'Ready to review', context: 'Ready', actionMode: 'ticket_lifecycle',
  lifecycle: { kind: 'done', assignmentId: 'a', prNumber: 12 }, choices: [{ id: 'prepare_publication', label: 'Review publication', actionKind: 'approve' }],
  recommendation: { recommendedValue: '', confidence: 0, rationale: '', distribution: [], provider: '', latencyMs: 0 } } }
async function render(sessionId = 'worker-example', removed = false) { root = createRoot(container); await act(async () => root!.render(<PublicationDock sessionId={sessionId} removed={removed} />)) }
it('renders only this conversation lifecycle and never submits or acts on mount', async () => {
  state.items = [item(), item('different-conversation'), { ...item(), id: 'chat', lifecycle: undefined, actionMode: 'stage_response' }]
  await render()
  expect(container.querySelectorAll('.dt-lifecycle-card')).toHaveLength(1)
  expect(state.call).not.toHaveBeenCalled()
  expect(container.textContent).not.toContain('View ticket')
})
it('explicit inspection uses the lifecycle endpoint, never staging/native send', async () => {
  state.items = [item()]; state.call.mockResolvedValue({ execution: 'not_executed', ticketId: 'example', message: 'Fixture inspected' })
  await render()
  const inspect = [...container.querySelectorAll('button')].find(button => button.textContent === 'Inspect publication')!
  await act(async () => inspect.click())
  expect(state.call).toHaveBeenCalledExactlyOnceWith('POST decisions/:id/lifecycle', { id: 'life-example', body: { action: 'prepare_publication' } })
})
it('keeps server-marked recovery visible after stale original lifecycle but not unrelated stale history', async () => {
  state.items = [{ ...item(), status: 'stale', lifecycle: { ...item().lifecycle!, recovery: true } },
    { ...item(), id: 'old', status: 'stale' }]
  await render()
  expect(container.querySelectorAll('.dt-lifecycle-card')).toHaveLength(1)
  expect(container.textContent).toContain('Publication evidence unavailable')
})
it('renders settled rolled-back attempts as history without irrelevant disabled approval controls, even with no choices', async () => {
  const value = { ...item(), choices: [], status: 'stale' as const, lifecycle: { ...item().lifecycle!, recovery: true, publication: {
    id: 'settled', status: 'rolled_back', repository: 'org/repo', prNumber: 166, headSha: 'head', patchSha256: 'digest', audit: [],
    outcomes: [{ stage: 'verify', status: 'failed' }, { stage: 'rollback', status: 'succeeded' }],
    coordination: { status: 'completed' },
  } } } as unknown as PendingDecisionItem
  root = createRoot(container)
  await act(async () => root!.render(<LifecycleCard item={value} onAction={state.call} />))
  expect(container.textContent).toContain('Publication history · rolled back')
  expect(container.textContent).toContain('Rollback is not feature acceptance')
  expect(container.textContent).not.toContain('Approve + publish')
  expect(container.textContent).not.toContain('Recovery only:')
  expect(container.querySelectorAll('button')).toHaveLength(0)
  expect(state.call).not.toHaveBeenCalled()
})
it('renders the same canonical delivery for every bound worker, never a composer choice', async () => {
  state.items = [{ ...item('other-worker'), id: 'delivery-shared', lifecycle: undefined, actionMode: 'feature_delivery', choices: [], delivery: {
    id: 'shared', title: 'Shared feature', revision: 2, generation: 0, state: 'running', stage: 'review', owner: 'reviewer',
    bindings: { repository: 'org/repo', sourceIssue: 159, baseSha: 'base', headSha: 'head' }, requirements: [],
    attempts: { review: 0, fix: 0, maxReview: 2, maxFix: 2 }, workers: ['other-worker', 'worker-example'], evidence: [], audit: [], authorities: ['owner'],
  } }]
  await render()
  expect(container.querySelectorAll('.dt-delivery-card')).toHaveLength(1)
  expect(container.querySelector('#delivery-shared')).not.toBeNull()
  expect(state.call).not.toHaveBeenCalled()
})
it('does not render a removed conversation', async () => { state.items = [item()]; await render('worker-example', true); expect(container.textContent).toBe('') })
