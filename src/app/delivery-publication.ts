/** Delivery bridge into the existing protected publication route; never grants model/delegated publication authority. */
import type { PendingDecisionItem } from '../core/decision.ts'
import { ticketDecisions } from './decision-inbox.ts'
import { publicationAction, type LifecyclePublication } from './lifecycle-publication.ts'
import { deliveryFingerprint, sameDeliveryRefs, type DeliveryCapabilityAdapters, type DeliveryLease, type DeliveryResult, type DeliveryStore } from './feature-delivery.ts'
import type { Store } from './store.ts'

export function deliveryPublicationCapabilities(store: DeliveryStore, tickets: Store['tickets'], publication?: LifecyclePublication): DeliveryCapabilityAdapters {
  const exactScope = (lease: DeliveryLease): boolean => {
    const prepared = store.get(lease.deliveryId)?.preparedPublication
    if (!publication || !prepared?.scopeSha256) return false
    const scope = publication.scopeFor?.(prepared.repository, prepared.pr)
    return !!scope && scope.manifestSha256 === prepared.scopeSha256 && scope.environment === lease.bindings.environment
      && sameDeliveryRefs(lease.bindings.refs, scope.refs)
  }
  const binding = async (lease: DeliveryLease): Promise<PendingDecisionItem | undefined> => {
    const delivery = store.get(lease.deliveryId)
    if (!delivery || deliveryFingerprint(delivery.bindings) !== deliveryFingerprint(lease.bindings)) return
    // Only an existing explicitly prepared manifest can enter the protected publication workflow.
    const prepared = delivery.preparedPublication
    if (!prepared || !lease.bindings.environment || !publication || !exactScope(lease)) return
    for (const worker of delivery.workers) {
      const ticket = tickets.get(worker)
      if (!ticket || ticket.ended) continue // Preserve the existing active-release-owner fence.
      const item = ticketDecisions([ticket]).find(i => i.lifecycle?.kind === 'done')
      if (!item || item.id !== prepared.decisionId || worker !== prepared.ticketId) continue
      const snapshot = await publication.service.snapshot(worker)
      if (snapshot?.id !== prepared.id || snapshot.patchSha256 !== prepared.patchSha256 || snapshot.repository !== lease.bindings.repository || snapshot.headSha !== lease.bindings.headSha) continue
      if (!lease.bindings.refs?.some(ref => ref.repository === snapshot.repository && ref.pr === snapshot.prNumber && ref.headSha === snapshot.headSha)) continue
      return item
    }
  }
  const reconcile = async (lease: DeliveryLease): Promise<DeliveryResult> => {
    const delivery = store.get(lease.deliveryId)
    if (!publication || !delivery?.preparedPublication) return { outcome: 'failed', blocker: 'No bound protected publication capability or prepared manifest.' }
    const prepared = delivery.preparedPublication
    if (!exactScope(lease)) return { outcome: 'uncertain', blocker: 'Trusted multi-repository publication scope or deployment target changed; reconcile the manifest before accepting any outcome.' }
    const snapshots = await Promise.all(delivery.workers.map(worker => publication.service.snapshot(worker)))
    const snapshot = snapshots.find(p => p?.id === prepared.id && p.patchSha256 === prepared.patchSha256)
    if (!snapshot || snapshot.headSha !== lease.bindings.headSha || snapshot.repository !== lease.bindings.repository) return { outcome: 'uncertain', blocker: 'Publication outcome cannot be reconciled against the exact prepared manifest.' }
    const evidence = (kind: 'publication' | 'rollback', outcome: 'passed' | 'failed') => [{ id: `publication:${snapshot.id}:${snapshot.updatedAt}:${kind}`, kind, bindings: lease.bindings, recordedAt: snapshot.updatedAt, reference: `publication:${snapshot.id}`, outcome }]
    if (snapshot.coordination && ['queued', 'running'].includes(snapshot.coordination.status)) return { outcome: 'pending' }
    if (snapshot.status === 'rolled_back') return { outcome: 'failed', blocker: 'Publication verification failed and was rolled back. Feature acceptance remains unresolved.', evidence: evidence('rollback', 'passed') }
    if (snapshot.status === 'published' && (!snapshot.coordination || snapshot.coordination.status === 'completed')) {
      if (snapshot.requests[lease.id]?.action !== 'publish' || snapshot.requests[lease.id]?.actorId !== lease.authorization.actor) return { outcome: 'uncertain', blocker: 'Published outcome is not linked to this exact durable confirmation; reconcile without replay.' }
      return { outcome: 'passed', evidence: evidence('publication', 'passed') }
    }
    return { outcome: 'uncertain', blocker: `Protected publication requires reconciliation (${snapshot.status}); no mutation replay.` }
  }
  return {
    publish: {
      execute: async lease => {
        const item = await binding(lease)
        if (!item || !publication) return { outcome: 'failed', blocker: 'No current active release owner with the exact prepared publication, heads and deployment target. Prepare/review a finite release through the existing protected publication workflow.' }
        const prepared = store.get(lease.deliveryId)!.preparedPublication!
        const authority = lease.authorization
        if (authority.source !== 'local_operator' || authority.scope !== lease.action.fingerprint) return { outcome: 'failed', blocker: 'Publication requires the exact trusted local confirmation; a model recommendation or delegated intake is not publication authority.' }
        lease.signal?.throwIfAborted()
        await publicationAction(publication, item, lease.bindings.repository, 'publish', { publicationId: prepared.id, requestId: lease.id }, authority.actor, () => {
          const current = store.get(lease.deliveryId)
          const ticket = item.ticketId ? tickets.get(item.ticketId) : undefined
          return !lease.signal?.aborted && !!current && !!ticket && !ticket.ended && exactScope(lease) && deliveryFingerprint(current.bindings) === deliveryFingerprint(lease.bindings)
            && deliveryFingerprint(current.preparedPublication) === deliveryFingerprint(prepared)
            && current.audit.some(a => a.actionId === lease.action.id && a.actor === authority.actor)
        })
        return reconcile(lease)
      }, reconcile,
    },
    verify: {
      execute: async () => ({ outcome: 'failed', blocker: 'Required native/browser acceptance capability is not configured. Successful HTTP publication verification is not native acceptance; Codex must record the required live evidence.' }),
    },
  }
}
