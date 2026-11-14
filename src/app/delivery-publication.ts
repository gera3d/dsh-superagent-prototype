/** Delivery bridge into the existing protected publication route; never grants model/delegated publication authority. */
import type { PendingDecisionItem } from '../core/decision.ts'
import { ticketDecisions } from './decision-inbox.ts'
import { publicationAction, type LifecyclePublication } from './lifecycle-publication.ts'
import { deliveryFingerprint, sameDeliveryRefs, type DeliveryCapabilityAdapters, type DeliveryEvidence, type DeliveryLease, type DeliveryResult, type DeliveryStore } from './feature-delivery.ts'
import type { Store } from './store.ts'
import { deliveryPhaseItem, phaseFacts } from './delivery-phase.ts'
import { classifyPublicationError } from './publication.ts'

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
    if (delivery.release) {
      // Finding-origin delivery: the durable delivery is the typed phase owner; the ended implementation worker stays immutable history.
      const item = deliveryPhaseItem(delivery)
      if (!item || typeof phaseFacts(store.db, delivery.id) === 'string' || item.id !== prepared.decisionId || delivery.release.ticketId !== prepared.ticketId) return
      const snapshot = await publication.service.snapshot(prepared.ticketId)
      if (snapshot?.id !== prepared.id || snapshot.patchSha256 !== prepared.patchSha256 || snapshot.repository !== lease.bindings.repository || snapshot.headSha !== lease.bindings.headSha) return
      if (!lease.bindings.refs?.some(ref => ref.repository === snapshot.repository && ref.pr === snapshot.prNumber && ref.headSha === snapshot.headSha)) return
      return item
    }
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
    // Twenty one-minute observations allow a finite 20-minute window, longer than the runner's 15-minute per-phase maximum.
    // Exhaustion exposes explicit read-only recovery; it never authorizes replay of a phase.
    if (snapshot.coordination && ['queued', 'running'].includes(snapshot.coordination.status)) return { outcome: 'pending', nextRetryAt: Date.now() + 60_000 }
    if (snapshot.status === 'rolled_back') return { outcome: 'failed', blocker: 'Publication verification failed and was rolled back. Feature acceptance remains unresolved.', evidence: evidence('rollback', 'passed') }
    if (snapshot.status === 'published' && (!snapshot.coordination || snapshot.coordination.status === 'completed')) {
      if (snapshot.requests[lease.id]?.action !== 'publish' || snapshot.requests[lease.id]?.actorId !== lease.authorization.actor) return { outcome: 'uncertain', blocker: 'Published outcome is not linked to this exact durable confirmation; reconcile without replay.' }
      return { outcome: 'passed', evidence: evidence('publication', 'passed') }
    }
    return { outcome: 'uncertain', blocker: `Protected publication requires reconciliation (${snapshot.status}); no mutation replay.` }
  }
  const reconcileVerify = async (lease: DeliveryLease): Promise<DeliveryResult> => {
    const delivery = store.get(lease.deliveryId)
    if (!publication || !delivery?.preparedPublication) return { outcome: 'failed', blocker: 'No bound protected publication capability or prepared manifest.' }
    const prepared = delivery.preparedPublication
    if (!exactScope(lease)) return { outcome: 'uncertain', blocker: 'Trusted multi-repository publication scope or deployment target changed; reconcile the manifest before accepting any outcome.' }
    const snapshots = await Promise.all(delivery.workers.map(worker => publication.service.snapshot(worker)))
    const snapshot = snapshots.find(p => p?.id === prepared.id && p.patchSha256 === prepared.patchSha256)
    if (!snapshot || snapshot.headSha !== lease.bindings.headSha || snapshot.repository !== lease.bindings.repository) return { outcome: 'uncertain', blocker: 'Publication outcome cannot be reconciled against the exact prepared manifest.' }
    if (snapshot.coordination && ['queued', 'running'].includes(snapshot.coordination.status)) return { outcome: 'pending', nextRetryAt: Date.now() + 60_000 }
    if (snapshot.status === 'rolled_back') {
      const rollbackEvidence: DeliveryEvidence[] = [{ id: `publication:${snapshot.id}:${snapshot.updatedAt}:rollback`, kind: 'rollback', bindings: lease.bindings, recordedAt: snapshot.updatedAt, reference: `publication:${snapshot.id}`, outcome: 'passed' }]
      return { outcome: 'failed', blocker: 'Publication verification failed and was rolled back. Feature acceptance remains unresolved.', evidence: rollbackEvidence }
    }
    if (snapshot.status === 'published' && (!snapshot.coordination || snapshot.coordination.status === 'completed')) {
      const verifyOutcome = snapshot.outcomes.find(o => o.stage === 'verify' && o.status === 'succeeded')
      if (verifyOutcome) {
        const detail = verifyOutcome.detail ? `#verify:${verifyOutcome.detail}` : '#verify'
        // Runner verification is its own bounded automated fact (configured HTTP release verification). It never asserts an
        // intake requirement: requirement coverage comes only from explicit evidence-to-requirement IDs, i.e. operator attestation.
        const verifyEvidence: DeliveryEvidence[] = [{
          id: `publication:${snapshot.id}:${snapshot.updatedAt}:verification`,
          kind: 'verification',
          bindings: lease.bindings,
          recordedAt: verifyOutcome.finishedAt || snapshot.updatedAt,
          reference: `publication:${snapshot.id}${detail}`,
          outcome: 'passed',
        }]
        return { outcome: 'passed', evidence: verifyEvidence }
      }
      return { outcome: 'failed', blocker: 'Publication did not record a successful verification outcome.' }
    }
    return { outcome: 'uncertain', blocker: `Protected publication verification requires reconciliation (${snapshot.status}); no mutation replay.` }
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
        try {
          await publicationAction(publication, item, lease.bindings.repository, 'publish', { publicationId: prepared.id, requestId: lease.id }, authority.actor, () => {
            const current = store.get(lease.deliveryId)
            const ticket = item.ticketId ? tickets.get(item.ticketId) : undefined
            const owner = current?.release ? typeof phaseFacts(store.db, current.id) !== 'string' : !!ticket && !ticket.ended
            return !lease.signal?.aborted && !!current && owner && exactScope(lease) && deliveryFingerprint(current.bindings) === deliveryFingerprint(lease.bindings)
              && deliveryFingerprint(current.preparedPublication) === deliveryFingerprint(prepared)
              && current.audit.some(a => a.actionId === lease.action.id && a.actor === authority.actor)
          })
        } catch (error) {
          const snapshot = await publication.service.snapshot(prepared.ticketId)
          if (!snapshot || snapshot.id !== prepared.id) {
            return reconcile(lease)
          }
          const hasGrant = Boolean(snapshot.coordination?.grantId || snapshot.requests?.[lease.id])
          if (hasGrant) {
            return reconcile(lease)
          }
          const auditRejection = snapshot.audit?.find(a => a.event === 'before_effect_rejection' && a.requestId === lease.id)
          const configured = publication.pinsFor(prepared.repository, prepared.pr)
          const staleConfig = !configured || configured.headSha !== snapshot.headSha || configured.patchSha256 !== snapshot.patchSha256
          const isProvedPreEffect = Boolean(auditRejection || staleConfig)
          if (isProvedPreEffect) {
            const classified = classifyPublicationError(error)
            const category = auditRejection?.category ?? classified.category
            return { outcome: 'failed', blocker: `Publication rejected before effect: ${category} [req=${lease.id}]; zero mutations executed` }
          }
          return reconcile(lease)
        }
        return reconcile(lease)
      }, reconcile,
    },
    verify: {
      execute: async lease => reconcileVerify(lease),
      reconcile: reconcileVerify,
    },
  }
}
