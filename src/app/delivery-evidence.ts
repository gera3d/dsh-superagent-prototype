/** Trusted local-operator boundary for external evidence; never a worker/deployment adapter. */
import { DeliveryConflict, DeliveryStore, deliveryFingerprint } from './feature-delivery.ts'
import type { Delivery, DeliveryConfirmationAuthority, DeliveryEvidence } from './feature-delivery.ts'

export interface OperatorEvidenceRequest {
  deliveryId: string
  revision: number
  evidence: DeliveryEvidence[]
  /** Explicit acceptance is separate from merely recording evidence. */
  accept?: boolean
}
const same = (a: unknown, b: unknown) => deliveryFingerprint(a) === deliveryFingerprint(b)
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim()
function reject(message: string): never { throw new DeliveryConflict(message) }

/** Atomic ingestion/reevaluation with immutable history, provenance, authority and revision fencing. */
export function recordOperatorEvidence(store: DeliveryStore, request: OperatorEvidenceRequest, expectedHash: string, authority: DeliveryConfirmationAuthority, now = new Date().toISOString()): Delivery {
  if (!object(request) || Object.keys(request).some(k => !['deliveryId', 'revision', 'evidence', 'accept'].includes(k)) || !text(request.deliveryId) || !Number.isInteger(request.revision) || request.revision < 1 || !Array.isArray(request.evidence) || !request.evidence.length || (request.accept !== undefined && typeof request.accept !== 'boolean') || !Number.isFinite(Date.parse(now))) reject('Invalid operator evidence request')
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || deliveryFingerprint(request) !== expectedHash || authority.source !== 'local_operator' || authority.scope !== expectedHash || !text(authority.actor) || !text(authority.reference)) reject('Exact reviewed hash and structured local operator authority required')
  // A savepoint includes optional acceptance, so a failed acceptance never partially imports evidence.
  store.db.exec('SAVEPOINT operator_external_evidence')
  try {
    const current = store.get(request.deliveryId)
    if (!current || !current.authorities.includes(authority.actor)) reject('Operator authority is not recorded for this intake')
    const marker = `operator-evidence:${expectedHash}:${authority.reference}`
    const evidence: DeliveryEvidence[] = []
    const ids = new Set<string>()
    for (const item of request.evidence) {
      if (!object(item) || Object.keys(item).some(k => !['id', 'kind', 'bindings', 'recordedAt', 'reference', 'outcome', 'requirements', 'generation', 'supersedes'].includes(k)) || !text(item.id) || ids.has(item.id) || !['publication', 'verification', 'acceptance', 'rollback'].includes(item.kind) || !['passed', 'failed', 'uncertain'].includes(item.outcome) || !text(item.recordedAt) || !Number.isFinite(Date.parse(item.recordedAt)) || !text(item.reference) || !same(item.bindings, current.bindings) || (item.generation !== undefined && item.generation !== current.generation)) reject('Invalid, duplicate, or wrong-bound external evidence')
      let url: URL
      try { url = new URL(item.reference) } catch { reject('Evidence reference must be an HTTPS provenance URL') }
      if (url.protocol !== 'https:' || url.username || url.password) reject('Evidence reference must be an HTTPS provenance URL')
      if (item.requirements !== undefined && (!Array.isArray(item.requirements) || new Set(item.requirements).size !== item.requirements.length || item.requirements.some(r => !text(r) || !current.requirements.includes(r)))) reject('Evidence requirements must be an exact intake subset')
      if (['verification', 'acceptance'].includes(item.kind) && item.outcome === 'passed' && !item.requirements?.length) reject('Passed native evidence must identify intake requirements')
      if (item.supersedes !== undefined && (!Array.isArray(item.supersedes) || new Set(item.supersedes).size !== item.supersedes.length || item.supersedes.some(id => !text(id)))) reject('Invalid explicit supersession IDs')
      for (const id of item.supersedes ?? []) {
        const target = current.evidence.find(e => e.id === id)
        if (!target || target.id === item.id || item.outcome !== 'passed' || (target.generation ?? 0) !== current.generation || !same(target.bindings, current.bindings) || (target.kind === 'rollback' ? item.kind !== 'publication' : target.outcome === 'passed' || target.kind !== item.kind)) reject('Invalid explicit bound evidence reconciliation')
      }
      ids.add(item.id)
      const normalized = { ...structuredClone(item), generation: current.generation }
      const previous = current.evidence.find(e => e.id === item.id)
      if (previous && !same(previous, normalized)) reject('Evidence ID reused with changed content')
      evidence.push(normalized)
    }
    if (current.audit.some(a => a.event === marker && a.actor === authority.actor)) {
      if (evidence.some(e => !current.evidence.some(p => same(p, e)))) reject('Recorded request evidence no longer matches')
      store.db.exec('RELEASE operator_external_evidence')
      return current
    }
    if (current.revision !== request.revision) reject('Stale delivery revision')
    if (current.stage !== 'verifying' || !['blocked', 'awaiting_decision'].includes(current.state)) reject('External evidence requires an unsettled verifying intake')
    if (evidence.some(e => current.evidence.some(p => p.id === e.id))) reject('Existing evidence requires exact original request replay')
    // Never clear an outstanding mutation/uncertain lease or dispatch its replacement.
    if (store.db.prepare("SELECT id FROM feature_delivery_outbox WHERE delivery_id=? AND status IN ('pending','leased','blocked') LIMIT 1").get(current.id)) reject('Outstanding handoff requires its own reconciliation')
    let updated = store.compareAndSwap(current.id, current.revision, d => {
      d.evidence.push(...evidence)
      const bound = d.evidence.filter(e => (e.generation ?? 0) === d.generation && same(e.bindings, d.bindings))
      const superseded = new Set(bound.filter(e => e.outcome === 'passed').flatMap(e => e.supersedes ?? []))
      const active = bound.filter(e => !superseded.has(e.id))
      if (active.some(e => e.outcome !== 'passed' || e.kind === 'rollback')) {
        d.state = 'blocked'; d.blocker = 'External evidence recorded; unresolved failed, uncertain or rolled-back historical evidence'
      } else { d.state = 'awaiting_decision'; delete d.blocker }
      d.audit.push({ at: now, actor: authority.actor, event: marker })
    })
    if (request.accept) {
      if (updated.nextAction?.kind !== 'accept') reject('Explicit acceptance requires full current publication and native verification evidence')
      updated = store.confirm(updated.id, { revision: updated.revision, actionId: updated.nextAction.id }, { ...authority, scope: updated.nextAction.fingerprint })
    }
    store.db.exec('RELEASE operator_external_evidence')
    return updated
  } catch (error) {
    store.db.exec('ROLLBACK TO operator_external_evidence; RELEASE operator_external_evidence')
    throw error
  }
}
