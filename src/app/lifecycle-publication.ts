/** Server-only bridge from canonical ticket lifecycle records to pinned publication operations. */
import type { PublicationDeliveryScope } from '../infra/publication-runner.ts'
import type { PendingDecisionItem, DecisionChoice } from '../core/decision.ts'
import { PublicationError, type PublicationActInput, type PublicationAuthority, type PublicationPins, type PublicationService, type PublicationSnapshot } from './publication.ts'

export interface LifecyclePublication {
  service: PublicationService
  pinsFor(repository: string, prNumber: number): PublicationPins | undefined
  scopeFor?(repository: string, prNumber: number): PublicationDeliveryScope | undefined
  project?(items: PendingDecisionItem[]): PendingDecisionItem[]
  enqueue(input: PublicationActInput, authority: PublicationAuthority): Promise<PublicationSnapshot>
  refresh?(): Promise<void>
  canContinue?(item: PendingDecisionItem, snapshot: PublicationSnapshot): boolean
}
export interface PublicationApproval { publicationId: string; requestId: string }
export function publicationChoices(publication?: PublicationSnapshot): DecisionChoice[] {
  const choices: DecisionChoice[] = [{ id: 'prepare_publication', label: 'Review publication', actionKind: 'approve' }]
  if (publication && ['prepared', 'merged'].includes(publication.status) && publication.evidence?.checks === 'passed'
    && publication.evidence.review === 'approved' && publication.evidence.headSha === publication.headSha
    && publication.evidence.patchSha256 === publication.patchSha256) {
    choices.push({ id: 'publish', label: 'Approve and publish', actionKind: 'publish' })
  }
  if (publication?.outcomes.some(o => o.stage === 'apply') && publication.status !== 'rolled_back') {
    choices.push({ id: 'rollback', label: 'Roll back publication', actionKind: 'rollback' })
  }
  return choices
}
/** Binding comes from the current canonical decision, NOT from a caller-provided conversation or PR. */
export function publicationConversation(item: PendingDecisionItem): string {
  return `${item.sessionId ?? `ticket:${item.ticketId}`}:decision:${item.id}`
}
export async function publicationAction(host: LifecyclePublication, item: PendingDecisionItem, repository: string,
  action: 'prepare_publication' | 'publish' | 'rollback', approval: PublicationApproval | undefined,
  actorId: string | undefined, stillCurrent: () => boolean): Promise<PublicationSnapshot> {
  const ticketId = item.ticketId!, conversationId = publicationConversation(item)
  if (action === 'prepare_publication') {
    const pins = host.pinsFor(repository, item.lifecycle!.prNumber!)
    if (!pins) throw new PublicationError(409, 'No reviewed release manifest is configured for this repository and PR. Nothing was merged or deployed.')
    const prepared = await host.service.prepare({ ...pins, ticketId, conversationId })
    if (!stillCurrent()) throw new PublicationError(409, 'Ticket changed while preparing publication; refresh the review card')
    return prepared
  }
  if (!approval || !actorId) throw new PublicationError(403, 'An explicit local operator approval bound to this review card is required')
  if (!stillCurrent()) throw new PublicationError(409, 'Ticket changed; publication approval is stale')
  const input = { ticketId, conversationId, publicationId: approval.publicationId, requestId: approval.requestId, action: action === 'rollback' ? 'rollback' as const : 'publish' as const }
  const authority = (operation: 'merge' | 'publish' | 'rollback') => ({ kind: 'human_click' as const, actorId, authorized: true as const,
    ticketId, conversationId, publicationId: approval.publicationId, action: operation, isCurrent: stillCurrent })
  const current = await host.service.snapshot(ticketId)
  if (!current || current.id !== approval.publicationId || current.ticketId !== ticketId || current.conversationId !== conversationId
    || current.repository !== repository || current.prNumber !== item.lifecycle!.prNumber) {
    throw new PublicationError(409, 'Review card is stale or belongs to a different decision or PR; inspect the current publication')
  }
  if (action !== 'rollback') {
    const configured = host.pinsFor(repository, item.lifecycle!.prNumber!)
    if (!configured || configured.headSha !== current.headSha || configured.patchSha256 !== current.patchSha256) {
      throw new PublicationError(409, 'Reviewed release configuration changed; approval is stale')
    }
  }
  // One bound approval is handed off durably; the detached coordinator owns merge, deployment and host restart.
  return host.enqueue(input, authority(input.action))
}
