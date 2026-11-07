// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { PendingDecisionItem } from '../src/core/decision.ts'
const state = vi.hoisted(() => ({ items: [] as PendingDecisionItem[], call: vi.fn() }))
vi.mock('../src/client/api.ts', () => ({ caller: () => state.call, usePoll: () => ({ data: { items: state.items } }) }))
import { PublicationDock } from '../src/client/publication-cards.tsx'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
it('keeps superseded typed delivery history in its actual old conversation while mounted switching shows the active owner', async () => {
  const delivery = { id: 'old', title: 'Same title', revision: 1, generation: 0, state: 'blocked' as const, stage: 'implementation' as const, owner: 'old', bindings: { repository: 'org/repo', sourceIssue: 171, headSha: '', baseSha: '' }, requirements: [], authorities: [], workers: ['old'], evidence: [], audit: [], attempts: { review: 0, fix: 0, maxReview: 3, maxFix: 2 } }
  const metadata = { ticketTitle: 'Same title', trigger: 'Durable feature delivery', urgency: 'low' as const, createdAt: 0,
    context: 'Actual ownership fixture', question: 'Current owner and next step', choices: [],
    recommendation: { recommendedValue: '', confidence: 0, rationale: 'No action offered', distribution: [], provider: 'Not evaluated', latencyMs: 0 } }
  state.items = [{ ...metadata, id: 'delivery-old', sessionId: 'worker-old', ticketId: 'old', actionMode: 'feature_delivery', status: 'stale', delivery: { ...delivery, nextAction: { id: 'old-action', kind: 'review', label: 'Obsolete review request', revision: 1, fingerprint: 'old' }, recommendationError: { kind: 'review', fingerprint: 'old', message: 'Obsolete advice failure', attempts: 1 }, work: { state: 'superseded', owner: 'worker-active', supersededBy: 'active', nextStep: 'Follow worker-active for the replacement outcome.' } } },
    { ...metadata, id: 'delivery-active', sessionId: 'worker-active', ticketId: 'active', actionMode: 'feature_delivery', status: 'pending', delivery: { ...delivery, id: 'active', workers: ['active'], work: { state: 'owned', owner: 'worker-active', progress: 'Serial process running; collecting results.', nextStep: 'Worker continues; no new user confirmation is needed.', replaces: ['old'] } } }]
  const container = document.createElement('div'), root = createRoot(container)
  try {
    await act(async () => root.render(<PublicationDock sessionId="worker-old" />))
    expect(container.textContent).toContain('Superseded history'); expect(container.textContent).toContain('Superseded by worker-active')
    expect(container.textContent).not.toContain('Obsolete review request'); expect(container.textContent).not.toContain('Obsolete advice failure')
    await act(async () => root.render(<PublicationDock sessionId="worker-active" />))
    expect(container.textContent).not.toContain('Superseded history'); expect(container.textContent).toContain('Latest worker report: Serial process running')
    expect(container.textContent).toContain('no new user confirmation is needed'); expect(container.querySelectorAll('button')).toHaveLength(0)
    state.items[1]!.delivery!.scopeBinding = { reason: 'Missing release binding', sourceTriggerId: 'source' } as any
    state.items[1]!.delivery!.work = { state: 'awaiting_direction', owner: 'user', nextStep: 'Choose a Senior Developer next step in this conversation.' }
    await act(async () => root.render(<PublicationDock sessionId="worker-active" />))
    expect(container.textContent).toContain('Ready for your next step')
    expect(container.textContent).toContain('Preparing a reply does not merge or publish it')
    expect(container.textContent).not.toContain('owned / in progress')
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(state.call).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()) }
})
