/** One privileged lifecycle renderer for conversation, Decisions and optional companion surfaces. Never stages chat. */
import type { ReactNode } from 'react'
import type { PendingDecisionItem } from '../core/decision.ts'
import { LifecycleCard } from './lifecycle-card.tsx'
import { caller, usePoll } from './api.ts'

export interface PublicationCards { render(item: PendingDecisionItem, onTicket?: () => void): ReactNode }
declare module '@deepseek-ai/cordis' { interface Context { publicationCards: PublicationCards } }
const call = caller(() => ({ offline: 'Publication service is offline.', notRunning: 'Publication service is not running.',
  serverError: status => `Publication service error (${status}).`, requestFailed: status => `Publication request failed (${status}).`,
  setup: () => 'Publication setup is incomplete.', user: failure => `Publication rejected: ${failure.code}` }))

export function SharedLifecycleCard({ item, onTicket }: { item: PendingDecisionItem; onTicket?: () => void }) {
  return <LifecycleCard item={item} onTicket={onTicket} onAction={(action, approval) => call('POST decisions/:id/lifecycle',
    { id: item.id, body: { action, ...(approval ? { approval } : {}) } })} />
}
/** Independent privileged dock remains available even when Next steps owns ordinary suggestion rendering. */
export function PublicationDock({ sessionId, removed }: { sessionId: string; removed?: boolean }) {
  const { data } = usePoll(() => call('GET decisions/inbox'), [])
  const items = data?.items.filter(item => item.sessionId === sessionId && item.lifecycle
    && (item.status === 'pending' || item.lifecycle.recovery)) ?? []
  if (removed || !items.length) return null
  return <section aria-label="Senior Developer publications" style={{ display: 'grid', gap: 10 }}>
    {items.map(item => <SharedLifecycleCard key={item.id} item={item} />)}
  </section>
}
