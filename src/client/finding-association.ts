import type { PendingDecisionItem } from '../core/decision.ts'
/** Finding work may begin without an origin conversation. Preserve current and prior job attribution. */
export function findingMatchesSession(item: PendingDecisionItem, sessionId: string): boolean {
  const finding = item.finding
  if (!finding) return false
  const bare = (id: string) => id.startsWith('worker-') ? id.slice(7) : id
  return item.sessionId === sessionId || finding.sessionId === sessionId
    || [finding.job, ...(finding.priorJobs ?? [])].some(job => !!job?.ticketId && bare(job.ticketId) === bare(sessionId))
}
export function activeFindingForSession(item: PendingDecisionItem, sessionId: string): boolean {
  return findingMatchesSession(item, sessionId) && !item.invalidation && !['resolved', 'deferred'].includes(item.finding!.state)
}
/** Delivery match handles bare or worker-prefixed session identities and finding links. */
export function deliveryMatchesSession(item: PendingDecisionItem, sessionId: string): boolean {
  const delivery = item.delivery
  if (!delivery) return false
  const bare = (id: string) => id.startsWith('worker-') ? id.slice(7) : id
  const target = bare(sessionId)
  if (item.sessionId && bare(item.sessionId) === target) return true
  if (item.ticketId && bare(item.ticketId) === target) return true
  if (delivery.workers?.some(w => bare(w) === target)) return true
  return false
}
export function activeDeliveryForSession(item: PendingDecisionItem, sessionId: string): boolean {
  if (!item.delivery || item.delivery.historicalCompletion || item.status === 'stale' || item.delivery.work?.state === 'superseded') return false
  return deliveryMatchesSession(item, sessionId) && !item.invalidation && !['accepted', 'cancelled', 'abandoned'].includes(item.delivery.state)
}
