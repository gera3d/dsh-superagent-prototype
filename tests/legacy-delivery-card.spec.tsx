// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { Delivery } from '../src/app/feature-delivery.ts'
import type { PendingDecisionItem } from '../src/core/decision.ts'
import { DeliveryCard } from '../src/client/delivery-card.tsx'
import { decisionNeedsAttention, decisionInHistory } from '../src/core/publication-queue.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const reconciledDelivery: Delivery = {
  id: 'auto-1aa9568a8df574db0cef146a58004c4b',
  title: 'Add temporary subscription conservation and restore-priority settings',
  owner: 'worker:1aa9568a8df574db0cef146a58004c4b',
  bindings: {
    repository: 'gera3d/superagent-sandbox',
    sourceIssue: 184,
    baseSha: '',
    headSha: '',
    refs: [],
  },
  requirements: ['intake:acceptance-requirements-unconfirmed'],
  authorities: [],
  delegatedActions: [],
  followFixHeads: false,
  authorizedFixScopes: [],
  generation: 0,
  workers: ['1aa9568a8df574db0cef146a58004c4b'],
  revision: 4,
  stage: 'review',
  state: 'blocked',
  scopeBinding: {
    reason: 'Operator-confirmed delivery scope, target and acceptance requirements are missing',
    sourceTriggerId: 'trigger-1aa',
  },
  attempts: { review: 0, fix: 0, maxReview: 3, maxFix: 2 },
  evidence: [],
  audit: [
    {
      at: '2026-11-06T23:49:39.824Z',
      event: 'tracked-unbound:trigger-1aa',
      actor: 'worker:1aa9568a8df574db0cef146a58004c4b',
    },
    {
      at: '2026-11-09T22:55:00.000Z',
      event: 'historical-reconciliation:hash:ref',
      actor: 'local-operator',
    },
  ],
  historicalCompletion: {
    reconciledAt: '2026-11-09T22:55:00.000Z',
    operator: 'local-operator',
    attestation: 'Operator confirmed historical completion via verified later release PR #33; closed source issue #184. No typed acceptance or publication grant.',
    evidenceReference: 'https://github.com/gera3d/dsh-superagent-prototype/pull/33',
    sourceIssue: 184,
    releasePr: 33,
    releaseMergedSha: 'fb591843c3f9ff19965a49e45a4157ed195fc890',
    caption: 'Delivered by later release PR #33 (fb59184); source issue #184 closed. Retained as completed/superseded history; not typed delivery acceptance.',
    fingerprint: 'test-fingerprint',
  },
}

const item = (d: Delivery = reconciledDelivery): PendingDecisionItem => ({
  id: `delivery-${d.id}`,
  delivery: d,
  actionMode: 'feature_delivery',
  status: 'stale',
  ticketTitle: d.title,
  urgency: 'low',
  trigger: 'Durable feature delivery',
  question: d.historicalCompletion?.caption ?? 'Review',
  context: d.historicalCompletion?.caption ?? '',
  createdAt: 1,
  choices: [],
  recommendation: {
    recommendedValue: '',
    confidence: 0,
    rationale: 'Nonactionable completed history delivered by later release.',
    distribution: [],
    provider: 'Not evaluated',
    latencyMs: 0,
  },
})

let root: ReturnType<typeof createRoot> | undefined
const container = document.createElement('div')
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container.replaceChildren()
  vi.unstubAllGlobals()
})

async function render(
  value: PendingDecisionItem,
  onConfirm = vi.fn(),
  onRecheck?: (request: { revision: number }) => Promise<unknown>,
  onReconcile?: (request: { revision: number; actionId: string }) => Promise<unknown>
) {
  root = createRoot(container)
  await act(async () => root!.render(<DeliveryCard item={value} onConfirm={onConfirm} onRecheck={onRecheck} onReconcile={onReconcile} />))
  return onConfirm
}

it('renders reconciled historical delivery card without executable actions', async () => {
  const onConfirm = await render(item())
  expect(container.querySelector('#delivery-auto-1aa9568a8df574db0cef146a58004c4b')).not.toBeNull()

  // Header summary displays completed history status and hint
  const summary = container.querySelector('.dt-delivery-summary')!
  expect(summary.textContent).toContain('Delivery')
  expect(summary.textContent).toContain('Delivered by later release')
  expect(summary.textContent).toContain('Completed history')

  // Body contains caption and historical details
  const body = container.querySelector('.dt-delivery-body')!
  expect(body.textContent).toContain('Delivered by later release PR #33 (fb59184)')
  expect(body.textContent).toContain('Retired to completed history via later release')

  // No confirm or action buttons exist
  expect(container.querySelectorAll('button')).toHaveLength(0)

  // Queue predicates show item is retired to history
  expect(decisionNeedsAttention(item())).toBe(false)
  expect(decisionInHistory(item())).toBe(true)

  // Expand disclosure and verify details
  const details = container.querySelector<HTMLDetailsElement>('.dt-delivery-disclosure')!
  expect(details.open).toBe(false)
  await act(async () => { summary.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  expect(onConfirm).not.toHaveBeenCalled()
})
