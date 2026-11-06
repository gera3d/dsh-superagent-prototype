// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { Delivery } from '../src/app/feature-delivery.ts'
import type { PendingDecisionItem } from '../src/core/decision.ts'
import { DeliveryCard } from '../src/client/delivery-card.tsx'
import { confirmDelivery, recheckDelivery } from '../src/client/publication-cards.tsx'
import { decisionNeedsAttention, decisionInHistory } from '../src/core/publication-queue.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const d: Delivery = { generation: 0, id: 'feature-1', title: 'Actual feature', revision: 3, stage: 'review', state: 'awaiting_decision', owner: 'reviewer',
  bindings: { repository: 'org/repo', sourceIssue: 159, baseSha: 'base', headSha: 'head' }, requirements: ['visible acceptance'],
  nextAction: { id: 'review-3', kind: 'review', label: 'Review exact head', revision: 3, fingerprint: 'immutable-evidence' },
  attempts: { review: 0, fix: 0, maxReview: 2, maxFix: 2 }, evidence: [], workers: ['ended-worker'], audit: [], authorities: ['owner'] }
const item = (delivery = d): PendingDecisionItem => ({ id: 'delivery-feature-1', delivery, actionMode: 'feature_delivery', status: 'pending', ticketTitle: d.title,
  urgency: 'low', trigger: 'Delivery review', question: 'Review', context: '', createdAt: 1, choices: [],
  recommendation: { recommendedValue: '', confidence: 0, rationale: '', distribution: [], provider: '', latencyMs: 0 } })
let root: ReturnType<typeof createRoot> | undefined
const container = document.createElement('div')
afterEach(() => { act(() => root?.unmount()); root = undefined; container.replaceChildren(); vi.unstubAllGlobals() })
async function render(value: PendingDecisionItem, onConfirm = vi.fn(), onRecheck?: (request: { revision: number }) => Promise<unknown>) {
  root = createRoot(container); await act(async () => root!.render(<DeliveryCard item={value} onConfirm={onConfirm} onRecheck={onRecheck} />)); return onConfirm
}
it('renders canonical metadata and only confirms the immutable typed action once', async () => {
  const onConfirm = await render(item(), vi.fn().mockResolvedValue({ delivery: d }))
  expect(onConfirm).not.toHaveBeenCalled()
  expect(container.querySelector('#delivery-feature-1')).not.toBeNull()
  expect(container.textContent).toContain('Not accepted')
  expect([...container.querySelectorAll('code')].map(node => node.textContent)).toContain('head')
  expect(container.textContent).not.toContain('Prepare reply')
  const button = container.querySelector('button')!
  await act(async () => { button.click(); button.click() })
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ revision: 3, actionId: 'review-3' })
  expect(container.querySelector('button')).toBeNull()
})
it('leads with the recorded Senior Developer rationale and one confirm, keeping scope internals expandable', async () => {
  await render(item({ ...d, recommendation: { actionId: d.nextAction!.id, disposition: 'take', kind: 'review', fingerprint: d.nextAction!.fingerprint, rationale: 'Independent review must check the exact head before publication.', provider: 'configured-model', recordedAt: '2026-11-06T15:00:00Z' } }))
  expect(container.querySelector('[aria-label="Senior Developer recommendation"]')?.textContent).toContain('Independent review must check the exact head')
  expect(container.querySelectorAll('button')).toHaveLength(1)
  expect(container.querySelector<HTMLDetailsElement>('[aria-label="Pinned scope and publication references"]')?.textContent).toContain('immutable-evidence')
  expect(container.querySelector<HTMLDetailsElement>('[aria-label="Pinned scope and publication references"]')?.open).toBe(false)
})
it('does not substitute a stale model recommendation and names publication effects before confirmation', async () => {
  await render(item({ ...d, nextAction: { ...d.nextAction!, kind: 'publish', label: 'Publish pinned changes' }, recommendation: { actionId: 'old-action', disposition: 'take', kind: 'publish', fingerprint: 'old', rationale: 'Stale rationale', provider: 'model', recordedAt: 'then' }, preparedPublication: {
    id: 'pub', ticketId: 'worker', decisionId: 'life-worker', repository: 'org/target', pr: 42, headSha: 'head42', patchSha256: 'patch42', environment: 'test-env', preparedAt: 'now', components: ['orchestrator', 'workstream'], effects: ['Rebuild changed orchestrator bundle', 'Restart fixture service'], scopeSha256: 'all-scope', refs: [{ repository: 'org/one', pr: 12, headSha: 'one-head', diffSha256: 'one-diff' }, { repository: 'org/two', pr: 13, headSha: 'two-head', baseSha: 'two-base' }],
  } }))
  expect(container.textContent).not.toContain('Stale rationale')
  expect(container.textContent).toContain('org/target PR #42 in test-env')
  expect(container.querySelector('[aria-label="Publication effects"]')?.textContent).toContain('orchestrator, workstream')
  expect(container.querySelector('[aria-label="Publication effects"]')?.textContent).toContain('Restart fixture service')
  expect(container.querySelectorAll('[aria-label="All pinned publication references"] li')).toHaveLength(2)
  expect(container.querySelector<HTMLDetailsElement>('[aria-label="Pinned scope and publication references"]')?.textContent).toContain('two-head')
  expect(container.querySelector<HTMLDetailsElement>('[aria-label="Pinned scope and publication references"]')?.textContent).toContain('all-scope')
  expect(container.querySelector<HTMLDetailsElement>('[aria-label="Pinned scope and publication references"]')?.textContent).toContain('patch42')
})
it('holds publication advice without endorsing the eligible action and allows only explicit override', async () => {
  const action = { ...d.nextAction!, kind: 'publish' as const, label: 'Publish pinned changes' }
  const onConfirm = await render(item({ ...d, nextAction: action, recommendation: { actionId: action.id, disposition: 'hold', kind: 'publish', fingerprint: action.fingerprint, rationale: 'Wait for the deployment window.', provider: 'configured-model', recordedAt: 'now' } }))
  expect(container.textContent).toContain('Senior Developer recommends waiting')
  expect(container.textContent).toContain('Wait for the deployment window.')
  expect(container.querySelector('.dt-btn-primary')).toBeNull()
  expect(onConfirm).not.toHaveBeenCalled()
  const button = container.querySelector('button')!
  expect(button.closest('details')?.open).toBe(false)
  expect(button.textContent).toContain('Proceed without recommendation')
})
it('does not endorse advice for a different action ID even when scope and kind match', async () => {
  await render(item({ ...d, recommendation: { actionId: 'older-action', disposition: 'take', kind: 'review', fingerprint: d.nextAction!.fingerprint, rationale: 'Old endorsement', provider: 'model', recordedAt: 'then' } }))
  expect(container.textContent).not.toContain('Old endorsement')
  expect(container.querySelector('[aria-label="Senior Developer recommendation"]')).toBeNull()
})
it('never endorses legacy recommendation records missing disposition', async () => {
  const legacy = { ...d, recommendation: { actionId: d.nextAction!.id, disposition: 'take' as const, kind: 'review' as const, fingerprint: d.nextAction!.fingerprint, rationale: 'Legacy advice', provider: 'model', recordedAt: 'then' } }
  Reflect.deleteProperty(legacy.recommendation, 'disposition')
  await render(item(legacy))
  expect(container.querySelector('[aria-label="Senior Developer recommendation"]')).toBeNull()
  expect(container.querySelector('.dt-btn-primary')).toBeNull()
})
it('keeps advice failure nonblocking for an eligible action', async () => {
  await render(item({ ...d, recommendationError: { kind: 'review', fingerprint: 'immutable-evidence', message: 'Model timed out', attempts: 2 } }))
  expect(container.textContent).toContain('Senior Developer advice unavailable: Model timed out')
  expect(container.querySelector('button')?.disabled).toBe(false)
})
it('renders unbound scope without dummy SHAs and exposes no action', async () => {
  await render(item({ ...d, scopeBinding: { reason: 'Exact intake refs missing', sourceTriggerId: 'source-159' }, bindings: { ...d.bindings, baseSha: 'dummy-base', headSha: 'dummy-head' } }))
  expect(container.textContent).toContain('Scope unbound: Exact intake refs missing')
  expect(container.textContent).not.toContain('dummy-')
  expect(container.querySelector('button')).toBeNull()
})
it('rechecks only the current preparation blocker once with a typed revision', async () => {
  const recheck = vi.fn().mockResolvedValue({})
  await render(item({ ...d, state: 'blocked', nextAction: undefined, blocker: 'Target missing', preparation: { fingerprint: 'fp', message: 'Target missing', attempts: 1 } }), vi.fn(), recheck)
  expect(container.querySelector('button')?.textContent).toBe('Recheck publication configuration')
  await act(async () => { container.querySelector('button')!.click(); container.querySelector('button')!.click() })
  expect(recheck).toHaveBeenCalledExactlyOnceWith({ revision: 3 })
  expect(container.querySelector('button')).toBeNull()
})
it('never offers configuration recheck for an unrelated blocker', async () => {
  await render(item({ ...d, state: 'blocked', nextAction: undefined, blocker: 'Mutation uncertain', preparation: { fingerprint: 'fp', message: 'Old preparation failed', attempts: 1 } }), vi.fn(), vi.fn())
  expect(container.querySelector('button')).toBeNull()
})
it('posts recheck revision with management headers and never uses chat', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }); vi.stubGlobal('fetch', fetcher)
  await recheckDelivery('feature/1', { revision: 3 })
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('/orchestrator/api/deliveries/feature%2F1/recheck', expect.objectContaining({ method: 'POST', body: '{"revision":3}', headers: expect.objectContaining({ 'x-orchestrator-request': '1' }) }))
})
it('posts the exact delivery endpoint payload and never stages or resolves decisions', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ delivery: d }) }); vi.stubGlobal('fetch', fetcher)
  await confirmDelivery(d.id, { revision: d.revision, actionId: d.nextAction!.id })
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('/orchestrator/api/deliveries/feature-1/confirm', expect.objectContaining({ method: 'POST', body: '{"revision":3,"actionId":"review-3"}' }))
})
for (const state of ['running', 'blocked', 'accepted', 'cancelled', 'abandoned'] as const) it(`offers no confirmation for ${state}`, async () => {
  await render(item({ ...d, state })); expect(container.querySelector('button')).toBeNull()
  expect(decisionNeedsAttention(item({ ...d, state }))).toBe(['running', 'blocked'].includes(state))
  expect(decisionInHistory(item({ ...d, state }))).toBe(!['running', 'blocked'].includes(state))
})
it('fails closed for stale revision metadata', async () => {
  await render(item({ ...d, nextAction: { ...d.nextAction!, revision: 2 } })); expect(container.querySelector('button')).toBeNull()
})
it('does not replay a failed confirmation or imply acceptance', async () => {
  const onConfirm = await render(item(), vi.fn().mockRejectedValue(new Error('Conflict 409')))
  await act(async () => container.querySelector('button')!.click())
  expect(onConfirm).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('409')
  expect(container.textContent).toContain('Not accepted')
})
