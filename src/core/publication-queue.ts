/** Publication completion is operational history, never fabricated chat resolution/submission proof. */
import type { PendingDecisionItem } from './decision.ts'
export function publicationCompleted(item: PendingDecisionItem): boolean {
  const p = item.lifecycle?.publication
  if (!p || !Array.isArray(p.outcomes) || ['queued', 'running'].includes(p.coordination?.status ?? '')
    || p.outcomes.some(outcome => outcome.status === 'running')) return false
  const stage = p.status === 'published' ? 'verify' : p.status === 'rolled_back' ? 'rollback' : undefined
  return !!stage && p.outcomes.filter(outcome => outcome.stage === stage).at(-1)?.status === 'succeeded'
}
export function decisionNeedsAttention(item: PendingDecisionItem): boolean {
  if (publicationCompleted(item)) return false
  return item.status === 'pending' || !!item.lifecycle?.recovery
}
export function decisionInHistory(item: PendingDecisionItem): boolean {
  return publicationCompleted(item) || item.status === 'resolved' && !item.lifecycle?.recovery
}
