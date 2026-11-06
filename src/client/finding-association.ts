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
