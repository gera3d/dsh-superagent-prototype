/** Publication completion is operational history, never fabricated chat resolution/submission proof. */
import type { PendingDecisionItem } from './decision.ts'
export function publicationCompleted(item: PendingDecisionItem): boolean {
  const p = item.lifecycle?.publication
  if (!p || !Array.isArray(p.outcomes) || p.coordination && p.coordination.status !== 'completed'
    || p.outcomes.some(outcome => outcome.status === 'running')) return false
  const stage = p.status === 'published' ? 'verify' : p.status === 'rolled_back' ? 'rollback' : undefined
  return !!stage && p.outcomes.filter(outcome => outcome.stage === stage).at(-1)?.status === 'succeeded'
}
export function findingCompleted(item: PendingDecisionItem): boolean {
  if (item.finding?.state === 'resolved') return true
  if (item.status === 'stale' && (item.parentFinding?.state === 'resolved' || Boolean(item.staleReason && /parent finding|prior attempt/i.test(item.staleReason)))) return true
  return false
}
export function decisionNeedsAttention(item: PendingDecisionItem): boolean {
  if (item.delivery) return item.status === 'pending' && !['accepted', 'cancelled', 'abandoned'].includes(item.delivery.state) && !item.invalidation
  if (publicationCompleted(item) || findingCompleted(item)) return false
  return item.status === 'pending' || !!item.lifecycle?.recovery
}
export function decisionInHistory(item: PendingDecisionItem): boolean {
  if (item.delivery) return !decisionNeedsAttention(item)
  return publicationCompleted(item) || findingCompleted(item) || item.status === 'resolved' && !item.lifecycle?.recovery
}
