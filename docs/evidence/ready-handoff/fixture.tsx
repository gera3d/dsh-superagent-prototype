import React from 'react'
import { createRoot } from 'react-dom/client'
import { DeliveryCard } from '../../../src/client/delivery-card.tsx'
import { deriveDeliveryWork as before } from './baseline-helper.ts'
import { deriveDeliveryWork as after } from '../../../src/app/delivery-currency.ts'

// Identical deterministic auto-unbound review snapshot; a native running assignment reported ready.
const at = '2026-11-06T18:10:00Z'
const ticket = { id: 'ready-worker', title: 'Issue171 ready handoff', mandate: { strength: 'explicit' },
  origin: { triggerId: 'source' }, assignments: [{ id: 'same-native-assignment', state: 'running',
    report: { state: 'ready', summary: 'Implementation reported ready with collected serial test evidence; release review remains.', at } }] }
const delivery = { id: 'auto-ready-worker', title: ticket.title, owner: 'release-owner', revision: 2,
  stage: 'review', state: 'blocked', workers: [ticket.id],
  scopeBinding: { reason: 'Operator-confirmed delivery scope, target and acceptance requirements are missing', sourceTriggerId: 'source' },
  blocker: 'Operator-confirmed delivery scope, target and acceptance requirements are missing',
  bindings: { repository: 'org/repo', sourceIssue: 171, baseSha: '', headSha: '', refs: [] },
  requirements: ['intake:acceptance-requirements-unconfirmed'], authorities: [], evidence: [],
  attempts: { review: 0, fix: 0, maxReview: 3, maxFix: 2 },
  audit: [{ at: '2026-11-06T17:40:26Z', event: 'tracked-unbound:source', actor: 'release-owner' }] }
const variant = (window as any).variant as 'before' | 'after'
const work = (variant === 'before' ? before : after)([delivery] as any, { tickets: [ticket], triggers: [] } as any).get(ticket.id)
const item = { id: delivery.id, actionMode: 'feature_delivery', status: 'pending', delivery: { ...delivery, work } }
;(window as any).projection = { input: { delivery, ticket }, work: work ?? null }
createRoot(document.getElementById('root')!).render(<main style={{ maxWidth: 1120, margin: '32px auto' }}>
  <header style={{ marginBottom: 24 }}><strong>ISOLATED COMPONENT FIXTURE · NOT LIVE ACCEPTANCE</strong>
    <h1>{variant === 'before' ? 'Before · merged baseline helper' : 'After · ready-handoff helper correction'}</h1>
    <p>Same review-stage auto-unbound delivery · same running native assignment · report: ready</p>
    <small>Baseline: 4972e30cd711 · unchanged DeliveryCard · 1280 × 1200 · dark · UTC</small></header>
  <DeliveryCard item={item as any} onConfirm={async () => { throw new Error('Fixture: no actions authorized') }} />
</main>)
