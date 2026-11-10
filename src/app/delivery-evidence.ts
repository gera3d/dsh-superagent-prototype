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

export interface LiveAttestationRequest { revision: number; requirements: string[]; reference: string; outcome?: 'passed' | 'failed' }
/**
 * In-thread operator live attestation. The protected local click supplies authority for the exact evidence built here: it maps
 * only the requirements the operator named (a subset of the intake) to an HTTPS provenance reference. It is distinct from the
 * runner's automated verification, which asserts no intake requirement, and it never accepts the delivery.
 */
export function recordLiveAttestation(store: DeliveryStore, id: string, request: LiveAttestationRequest, actor: string, now = new Date().toISOString()): Delivery {
  const current = store.get(id)
  if (!current) reject('Unknown delivery')
  if (!object(request) || !Array.isArray(request.requirements) || !request.requirements.length || request.requirements.some(r => !text(r)) || !text(request.reference) || !Number.isInteger(request.revision)) reject('Live attestation requires named requirements and an HTTPS evidence reference')
  const outcome = request.outcome ?? 'passed'
  if (!['passed', 'failed'].includes(outcome)) reject('Invalid attestation outcome')
  const requirements = [...new Set(request.requirements.map(r => r.trim()))]
  const evidence: DeliveryEvidence = { id: `operator-live:${id}:${request.revision}:${deliveryFingerprint({ requirements, reference: request.reference, outcome }).slice(0, 16)}`,
    kind: 'verification', bindings: current!.bindings, recordedAt: now, reference: request.reference.trim(), outcome, requirements }
  // Clear a failure only after every failed requirement has an explicit passing recheck recorded after that failure.
  // Append order is authoritative even when observations share a timestamp. Unrelated passes cannot resurrect old coverage.
  const relevant = current!.evidence.filter(e => (e.generation ?? 0) === current!.generation && same(e.bindings, current!.bindings))
  const failed = outcome === 'passed' ? relevant.flatMap((e, index) => {
    if (!e.id.startsWith('operator-live:') || e.kind !== 'verification' || e.outcome !== 'failed' || !e.requirements?.length) return []
    const rechecked = new Set([...requirements, ...relevant.slice(index + 1)
      .filter(p => p.outcome === 'passed' && ['verification', 'acceptance'].includes(p.kind)).flatMap(p => p.requirements ?? [])])
    return e.requirements.every(r => rechecked.has(r)) ? [e.id] : []
  }) : []
  if (failed.length) evidence.supersedes = failed
  const operatorRequest: OperatorEvidenceRequest = { deliveryId: id, revision: request.revision, evidence: [evidence] }
  const hash = deliveryFingerprint(operatorRequest)
  return recordOperatorEvidence(store, operatorRequest, hash, { source: 'local_operator', actor, reference: `orchestrator-http:live:${id}:${request.revision}`, scope: hash }, now)
}

/** Read-only provenance for advice. An operator-looking ID alone is not proof: reconstruct the exact audited request. */
export function protectedLiveEvidenceFacts(delivery: Delivery) {
  return delivery.evidence.flatMap(evidence => {
    const prefix = `operator-live:${delivery.id}:`
    if (!evidence.id.startsWith(prefix) || evidence.kind !== 'verification' || (evidence.generation ?? 0) !== delivery.generation || !same(evidence.bindings, delivery.bindings)) return []
    const suffix = /^(\d+):[a-f0-9]{16}$/.exec(evidence.id.slice(prefix.length))
    if (!suffix) return []
    const revision = Number(suffix[1])
    const { generation: _generation, ...original } = evidence
    const hash = deliveryFingerprint({ deliveryId: delivery.id, revision, evidence: [original] })
    const event = `operator-evidence:${hash}:orchestrator-http:live:${delivery.id}:${revision}`
    const audit = delivery.audit.find(a => a.event === event && a.at === evidence.recordedAt && delivery.authorities.includes(a.actor))
    if (!audit) return []
    return [{ evidenceId: evidence.id, actor: audit.actor, recordedAt: audit.at, revision, outcome: evidence.outcome, requirements: evidence.requirements ?? [], reference: evidence.reference, source: 'protected-local-operator-live-attestation' as const }]
  })
}
