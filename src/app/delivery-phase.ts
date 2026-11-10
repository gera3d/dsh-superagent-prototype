/**
 * Typed canonical release-phase owner for finding-origin deliveries.
 *
 * A finding's implementation worker normally ENDS after its authentic ready report, so the legacy "active done ticket" owner
 * can never exist for it. The durable delivery (created by the protected release preparation, carrying `release` lineage) is
 * the supported phase owner instead. Nothing here invents a ticket, a done decision or a report: every check reads the stored
 * delivery, finding and (immutable, possibly ended) job ticket, and fails closed on any mismatch. Used identically at enqueue
 * (in-process) and inside the detached publication worker (read-only SQLite), so a changed job, head, patch, PR or a
 * cancelled/resolved/deferred finding invalidates the release before and during execution.
 */
import { DatabaseSync } from 'node:sqlite'
import type { Ticket } from '../core/index.ts'
import type { PendingDecisionItem } from '../core/decision.ts'
import { deliveryFingerprint, type Delivery } from './feature-delivery.ts'
import type { Finding } from './finding.ts'
import type { PublicationSnapshot } from './publication.ts'

export interface PublicationPhaseFence {
  version: 1
  kind: 'delivery-phase'
  deliveryId: string
  findingId: string
  jobId: string
  ticketId: string
  assignmentId: string
  conversationId: string
  prNumber: number
  repository: string
  headSha: string
  patchSha256: string
  sourceFingerprint: string
  scopeFingerprint: string
  publication?: { id: string; repository: string; headSha: string; patchSha256: string }
}

const PREFIX = 'delivery:'
/** The conversation of a delivery phase is a pure function of the delivery id, never of caller input. */
export const phaseConversation = (deliveryId: string): string => `${PREFIX}${deliveryId}:decision:delivery-phase:${deliveryId}`
export const isPhaseConversation = (conversationId: string): boolean => conversationId.startsWith(PREFIX)
export const phaseDeliveryId = (conversationId: string): string | undefined => {
  const m = /^delivery:(.+):decision:delivery-phase:(.+)$/.exec(conversationId)
  return m && m[1] === m[2] ? m[1] : undefined
}

/** The phase's decision-shaped handle for the protected publication route; derived from a stored release lineage only. */
export function deliveryPhaseItem(delivery: Delivery): PendingDecisionItem | undefined {
  const release = delivery.release
  if (!release) return
  return { id: `delivery-phase:${delivery.id}`, sessionId: `${PREFIX}${delivery.id}`, ticketId: release.ticketId, status: 'pending',
    lifecycle: { kind: 'done', assignmentId: release.assignmentId, prNumber: release.prNumber }, choices: [] } as unknown as PendingDecisionItem
}

type Facts = { delivery: Delivery; finding: Finding; ticket: Ticket }
function row<T>(db: DatabaseSync, sql: string, id: string): T | undefined {
  const r = db.prepare(sql).get(id)
  return r ? JSON.parse(String(r.value)) as T : undefined
}
/** Stored canonical facts, or the reason the phase is not current. Pure reads. */
export function phaseFacts(db: DatabaseSync, deliveryId: string): Facts | string {
  const delivery = row<Delivery>(db, 'SELECT value FROM feature_delivery WHERE id=?', deliveryId)
  const release = delivery?.release
  if (!delivery || !release) return 'Delivery has no recorded finding release lineage'
  if (delivery.historicalCompletion || ['cancelled', 'abandoned'].includes(delivery.state)) return `Delivery is ${delivery.historicalCompletion ? 'historical' : delivery.state}`
  const finding = row<Finding>(db, 'SELECT value FROM finding WHERE id=?', release.findingId)
  if (!finding) return 'Source finding no longer exists'
  if (finding.state !== 'blocked') return `Source finding is ${finding.state}`
  if (finding.revision !== release.findingRevision) return 'Source finding revision changed'
  if (finding.job?.id !== release.jobId || finding.job.ticketId?.replace(/^worker-/, '') !== release.ticketId || finding.job.assignmentId !== release.assignmentId) return 'Source finding job changed or was superseded'
  const ticket = row<Ticket>(db, 'SELECT value FROM ticket WHERE id=?', release.ticketId)
  if (!ticket || ticket.assignments.at(-1)?.id !== release.assignmentId) return 'Job ticket has a newer or different assignment'
  if (ticket.ended?.by === 'human') return 'Job was ended by a person'
  if (ticket.assignments.at(-1)?.report?.state !== 'ready') return 'Implementation report is no longer ready'
  if (finding.reports.filter(r => r.jobId === release.jobId).at(-1)?.state !== 'ready') return 'Current finding report is no longer ready'
  if (delivery.bindings.headSha !== release.headSha || !delivery.bindings.refs?.some(r => r.repository === delivery.bindings.repository && r.pr === release.prNumber && r.headSha === release.headSha)) return 'Delivery bindings no longer match the released head'
  return { delivery, finding, ticket }
}


// Freeze the exact reviewed source and scope, while allowing publication outcomes and expected stage bookkeeping to advance.
const sourceFingerprint = (f: Facts): string => deliveryFingerprint({ findingRevision: f.finding.revision, job: f.finding.job,
  report: f.finding.reports.filter(r => r.jobId === f.delivery.release!.jobId).at(-1),
  assignment: f.ticket.assignments.at(-1), ended: f.ticket.ended })
const scopeFingerprint = (d: Delivery): string => deliveryFingerprint({ bindings: d.bindings, requirements: d.requirements,
  generation: d.generation, release: d.release, authorities: d.authorities, delegatedScope: d.delegatedScope,
  evidence: d.evidence.filter(e => e.kind === 'implementation' || e.kind === 'review'),
  prepared: d.preparedPublication && { id: d.preparedPublication.id, ticketId: d.preparedPublication.ticketId,
    decisionId: d.preparedPublication.decisionId, repository: d.preparedPublication.repository, pr: d.preparedPublication.pr,
    headSha: d.preparedPublication.headSha, patchSha256: d.preparedPublication.patchSha256,
    environment: d.preparedPublication.environment, scopeSha256: d.preparedPublication.scopeSha256 } })

const matches = (f: Facts, p: Pick<PublicationSnapshot, 'ticketId' | 'conversationId' | 'repository' | 'prNumber' | 'headSha' | 'patchSha256'>): boolean => {
  const r = f.delivery.release!
  return p.ticketId === r.ticketId && p.conversationId === phaseConversation(f.delivery.id) && p.prNumber === r.prNumber
    && p.headSha === r.headSha && p.patchSha256 === r.patchSha256 && p.repository === f.delivery.bindings.repository
}

/** Capture the exact fence for a publication; throws when the phase is not current or the publication is not this delivery's. */
export function capturePhaseFence(db: DatabaseSync, p: PublicationSnapshot): PublicationPhaseFence {
  const id = phaseDeliveryId(p.conversationId)
  const facts = id ? phaseFacts(db, id) : 'Publication conversation is not a delivery phase'
  if (typeof facts === 'string') throw new Error(`Release phase is not current: ${facts}`)
  if (!matches(facts, p)) throw new Error('Release phase does not match the exact publication')
  const prepared = facts.delivery.preparedPublication
  if (!prepared || prepared.id !== p.id || prepared.headSha !== p.headSha || prepared.patchSha256 !== p.patchSha256) throw new Error('Release phase has no matching prepared publication')
  const r = facts.delivery.release!
  return { version: 1, kind: 'delivery-phase', deliveryId: facts.delivery.id, findingId: r.findingId, jobId: r.jobId, ticketId: r.ticketId, assignmentId: r.assignmentId,
    conversationId: p.conversationId, prNumber: r.prNumber, repository: p.repository, headSha: r.headSha, patchSha256: r.patchSha256,
    sourceFingerprint: sourceFingerprint(facts), scopeFingerprint: scopeFingerprint(facts.delivery),
    publication: { id: p.id, repository: p.repository, headSha: p.headSha, patchSha256: p.patchSha256 } }
}

export function isPhaseFence(value: unknown): value is PublicationPhaseFence {
  return !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'delivery-phase'
}

/** Current only if the stored canonical facts still equal every field the operator confirmed. Fails closed. */
export function phaseCurrent(db: DatabaseSync, fence: PublicationPhaseFence, p: PublicationSnapshot): boolean {
  try {
    if (fence.version !== 1 || fence.kind !== 'delivery-phase' || phaseConversation(fence.deliveryId) !== fence.conversationId) return false
    const facts = phaseFacts(db, fence.deliveryId)
    if (typeof facts === 'string' || !matches(facts, p)) return false
    if (fence.sourceFingerprint !== sourceFingerprint(facts) || fence.scopeFingerprint !== scopeFingerprint(facts.delivery)) return false
    const prepared = facts.delivery.preparedPublication
    if (!prepared || prepared.id !== p.id || prepared.headSha !== p.headSha || prepared.patchSha256 !== p.patchSha256) return false
    const r = facts.delivery.release!
    if (fence.findingId !== r.findingId || fence.jobId !== r.jobId || fence.ticketId !== r.ticketId || fence.assignmentId !== r.assignmentId || fence.prNumber !== r.prNumber
      || fence.headSha !== r.headSha || fence.patchSha256 !== r.patchSha256 || fence.repository !== p.repository || p.conversationId !== fence.conversationId) return false
    return !fence.publication || (fence.publication.id === p.id && fence.publication.repository === p.repository && fence.publication.headSha === p.headSha && fence.publication.patchSha256 === p.patchSha256)
  } catch { return false }
}

export function readOnlyDb(databasePath: string): DatabaseSync { return new DatabaseSync(databasePath, { readOnly: true }) }
