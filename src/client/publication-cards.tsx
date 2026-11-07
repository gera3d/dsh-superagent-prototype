/** One privileged lifecycle renderer for conversation, Decisions and optional companion surfaces. Never stages chat. */
import type { ReactNode } from 'react'
import type { PendingDecisionItem } from '../core/decision.ts'
import { findingMatchesSession } from './finding-association.ts'
import { FindingCard } from './finding-card.tsx'
export { FindingCard, confirmFinding, revisitFinding, reviewFinding, type FindingConfirmation, type FindingReview } from './finding-card.tsx'
import { LifecycleCard } from './lifecycle-card.tsx'
import { DeliveryCard, type DeliveryConfirmation } from './delivery-card.tsx'
import { caller, usePoll } from './api.ts'

export interface PublicationCards { render(item: PendingDecisionItem, onTicket?: () => void): ReactNode }
declare module '@deepseek-ai/cordis' { interface Context { publicationCards: PublicationCards } }
const call = caller(() => ({ offline: 'Publication service is offline.', notRunning: 'Publication service is not running.',
  serverError: status => `Publication service error (${status}).`, requestFailed: status => `Publication request failed (${status}).`,
  setup: () => 'Publication setup is incomplete.', user: failure => `Publication rejected: ${failure.code}` }))

export async function confirmDelivery(id: string, request: DeliveryConfirmation) {
  const response = await fetch(`/orchestrator/api/deliveries/${encodeURIComponent(id)}/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' }, body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(`Delivery confirmation rejected (${response.status}). No action confirmed; do not replay automatically.`)
  return response.json()
}
export async function recheckDelivery(id: string, request: { revision: number }) {
  const response = await fetch(`/orchestrator/api/deliveries/${encodeURIComponent(id)}/recheck`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' }, body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(`Delivery recheck rejected (${response.status}). Refresh; no automatic replay.`)
  return response.json()
}
export async function reconcileDelivery(id: string, request: DeliveryConfirmation) {
  const response = await fetch(`/orchestrator/api/deliveries/${encodeURIComponent(id)}/reconcile`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' }, body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(`Delivery reconciliation rejected (${response.status}). Refresh; no mutation replay was requested automatically.`)
  return response.json()
}
export function SharedLifecycleCard({ item, onTicket, compactFindings = false }: { item: PendingDecisionItem; onTicket?: () => void; compactFindings?: boolean }) {
  if (item.actionMode === 'finding_triage' || item.finding) return <FindingCard item={item} compact={compactFindings} />
  if (item.actionMode === 'feature_delivery' || item.delivery) return <DeliveryCard item={item} onConfirm={request => confirmDelivery(item.delivery!.id, request)} onRecheck={request => recheckDelivery(item.delivery!.id, request)} onReconcile={request => reconcileDelivery(item.delivery!.id, request)} />
  return <LifecycleCard item={item} onTicket={onTicket} onAction={(action, approval) => call('POST decisions/:id/lifecycle',
    { id: item.id, body: { action, ...(approval ? { approval } : {}) } })} />
}
/** Independent privileged dock remains available even when Next steps owns ordinary suggestion rendering. */
export function PublicationDock({ sessionId, removed }: { sessionId: string; removed?: boolean }) {
  const { data } = usePoll(() => call('GET decisions/inbox'), [])
  const items = data?.items.filter(item => (findingMatchesSession(item, sessionId) || item.sessionId === sessionId || item.delivery?.workers.includes(sessionId)) && (item.finding || item.actionMode === 'finding_triage' || item.delivery || item.actionMode === 'feature_delivery' || item.lifecycle
    && (item.status === 'pending' || item.lifecycle.recovery))) ?? []
  if (removed || !items.length) return null
  return <section aria-label="Senior Developer publications" style={{ boxSizing: 'border-box', width: 'calc(100% - var(--dsh-composer-side-clearance, 24px) * 2)', maxWidth: 'var(--dsh-composer-card-max-width, 840px)', minWidth: 0, margin: '0 auto 4px', display: 'grid', gap: 6 }}>
    {items.map(item => <SharedLifecycleCard key={item.id} item={item} compactFindings />)}
  </section>
}
