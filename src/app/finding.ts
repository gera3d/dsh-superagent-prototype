/** Durable pre-work findings. Confirmation grants only the recorded bounded task, never pins or permissions. */
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { PendingDecisionItem } from '../core/decision.ts'

const Text = z.string().trim().min(1).max(16_384)
const Identity = z.string().trim().min(1).max(512)
export const FindingChoiceSchema = z.enum(['fix_now', 'queue_next', 'defer'])
export type FindingChoiceKind = z.infer<typeof FindingChoiceSchema>
export const FindingIntakeSchema = z.object({
  dedupKey: Identity, title: z.string().trim().min(1).max(512), problem: Text,
  scope: Text, owner: Identity, kind: z.enum(['fix', 'verification']),
  requirements: z.array(Text).min(1).max(100), repository: Identity,
  occurrence: z.object({ id: Identity, reference: Text, evidence: Text, at: z.iso.datetime().optional() }).strict(),
  existingDeliveryId: Identity.optional(), sourceIssue: z.number().int().positive().optional(), sessionId: Identity.optional(),
}).strict()
export type FindingIntake = z.infer<typeof FindingIntakeSchema>
export const FindingConfirmSchema = z.object({ revision: z.number().int().positive(), choiceId: FindingChoiceSchema }).strict()
export type FindingConfirm = z.infer<typeof FindingConfirmSchema>
export const FindingReviewSchema = z.object({ revision: z.number().int().positive(),
  decision: z.enum(['accept_evidence', 'retry_scope', 'defer']), evidenceReference: Text.optional(),
  requirements: z.array(Text).min(1).max(100).optional(), outcome: z.enum(['verified', 'no_repair_needed']).optional() }).strict()
export type FindingReview = z.infer<typeof FindingReviewSchema>
export interface FindingRecommendation {
  choiceId: FindingChoiceKind; rationale: string; provider: string; recordedAt: string; revision: number
}
export interface FindingProvenance { source: 'operator' | 'model' | 'external'; reference: string; actor?: string }
export interface FindingEvidence {
  reference: string; evidence: string; nextDecision: string; at: string; jobId?: string
  state?: 'ready' | 'blocked' | 'failed' | 'dropped' | 'verified' | 'evidence'
  /** The full native report remains at reference; this is only its bounded display excerpt. */
  summaryTruncated?: boolean; originalLength?: number; reportSummarySha256?: string
  /** Idempotent newer-work signal, scoped to this evidence's native job. */
  currencyToken?: string
}
export interface Finding {
  id: string; dedupKey: string; title: string; problem: string; scope: string; owner: string
  kind: 'fix' | 'verification'; requirements: string[]; repository: string
  occurrences: { id: string; reference: string; evidence: string; at: string }[]
  existingDeliveryId?: string; sourceIssue?: number; sessionId?: string; revision: number
  state: 'awaiting_decision' | 'queued' | 'deferred' | 'running' | 'blocked' | 'resolved'
  choices: { id: FindingChoiceKind; kind: FindingChoiceKind; label: string }[]
  recommendation?: FindingRecommendation; recommendationError?: string
  confirmation?: FindingConfirm & { actor: string; at: string }
  job?: { id: string; ticketId?: string; assignmentId?: string }
  priorJobs?: { id: string; ticketId?: string; assignmentId?: string }[]
  resolution?: { outcome: 'verified' | 'no_repair_needed'; evidenceReference: string; requirements: string[]; at: string; actor: 'local-operator'; jobId: string }
  blocker?: string; reports: FindingEvidence[]
  audit: { event: string; actor: string; at: string; detail?: string; source?: FindingProvenance['source']; reference?: string }[]
  createdAt: string; updatedAt: string
}
/** HTTP-safe missing-record, stale-revision and bounded finding authority errors. */
export class FindingError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'FindingError' }
}
const choices: Finding['choices'] = [
  { id: 'fix_now', kind: 'fix_now', label: 'Fix now' },
  { id: 'queue_next', kind: 'queue_next', label: 'Queue next' },
  { id: 'defer', kind: 'defer', label: 'Defer' },
]
const immutable = ['title', 'problem', 'scope', 'owner', 'kind', 'requirements', 'repository', 'existingDeliveryId', 'sourceIssue'] as const

/** Uses the owner's shared SQLite connection, so native dispatch and markDispatched can commit atomically. */
export class FindingStore {
  private depth = 0
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS finding (id TEXT PRIMARY KEY, dedup_key TEXT NOT NULL UNIQUE, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS finding_queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, finding_id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL UNIQUE);
      CREATE INDEX IF NOT EXISTS finding_state ON finding(json_extract(value, '$.state'));`)
  }
  private atomic<T>(operation: () => T): T {
    const name = `finding_atomic_${this.depth++}`
    this.db.exec(`SAVEPOINT ${name}`)
    try { const result = operation(); this.db.exec(`RELEASE ${name}`); return result }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`); throw error }
    finally { this.depth-- }
  }
  get(id: string): Finding | undefined {
    const row = this.db.prepare('SELECT value FROM finding WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) as Finding : undefined
  }
  list(): Finding[] {
    return this.db.prepare('SELECT value FROM finding ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as Finding)
  }
  private require(id: string): Finding {
    const record = this.get(id)
    if (!record) throw new FindingError(404, 'Finding not found')
    return record
  }
  private save(record: Finding): Finding {
    record.updatedAt = new Date().toISOString()
    this.db.prepare('UPDATE finding SET value=? WHERE id=?').run(JSON.stringify(record), record.id)
    return record
  }
  private audit(record: Finding, event: string, detail?: string, actor = 'local-operator', provenance?: FindingProvenance): void {
    record.audit.push({ event, actor, at: new Date().toISOString(), ...(detail ? { detail } : {}),
      ...(provenance ? { source: provenance.source, reference: provenance.reference } : {}) })
  }
  observe(raw: FindingIntake, provenance?: FindingProvenance): Finding {
    const input = FindingIntakeSchema.parse(raw)
    const origin = z.object({ source: z.enum(['operator', 'model', 'external']), reference: Text, actor: Identity.optional() }).strict()
      .parse(provenance ?? { source: 'external', reference: input.occurrence.reference, actor: 'unattributed-observer' })
    const observer = origin.source === 'operator' ? 'local-operator' : `${origin.source}:${origin.actor ?? 'observer'}`
    return this.atomic(() => {
      const row = this.db.prepare('SELECT id FROM finding WHERE dedup_key=?').get(input.dedupKey)
      const at = new Date().toISOString()
      const occurrence = { ...input.occurrence, at: input.occurrence.at ?? at }
      if (row) {
        const record = this.require(String(row.id))
        if (immutable.some(field => (field !== 'existingDeliveryId' && field !== 'sourceIssue' || input[field] !== undefined)
          && JSON.stringify(record[field]) !== JSON.stringify(input[field])))
          throw new FindingError(409, 'Dedup key already belongs to a different bounded finding')
        const previous = record.occurrences.find(item => item.id === occurrence.id)
        if (previous) {
          if (previous.reference !== occurrence.reference || previous.evidence !== occurrence.evidence || input.occurrence.at && previous.at !== occurrence.at)
            throw new FindingError(409, 'Occurrence identity already has different evidence')
          return record
        }
        record.occurrences.push(occurrence)
        // A new pre-confirmation observation changes the decision context. Confirmed work identity is never replaced.
        if (record.state === 'awaiting_decision') {
          record.revision++
          delete record.recommendation
          delete record.recommendationError
        }
        this.audit(record, 'observed', occurrence.id, observer, origin)
        return this.save(record)
      }
      const { occurrence: _, ...fields } = input
      const record: Finding = { ...fields, id: randomUUID(), occurrences: [occurrence], revision: 1,
        state: 'awaiting_decision', choices: choices.map(choice => ({ ...choice,
          label: input.kind === 'verification' && choice.kind === 'fix_now' ? 'Run verification' : choice.label })), reports: [],
        audit: [{ event: 'observed', actor: observer, source: origin.source, reference: origin.reference, at, detail: occurrence.id }], createdAt: at, updatedAt: at }
      this.db.prepare('INSERT INTO finding(id,dedup_key,value) VALUES(?,?,?)').run(record.id, record.dedupKey, JSON.stringify(record))
      return record
    })
  }
  setRecommendation(id: string, revision: number, raw: Omit<FindingRecommendation, 'revision' | 'recordedAt'> & { recordedAt?: string }): Finding {
    const recommendation = z.object({ choiceId: FindingChoiceSchema, rationale: Text, provider: Identity,
      recordedAt: z.iso.datetime().optional() }).strict().parse(raw)
    return this.atomic(() => {
      const record = this.require(id)
      if (record.revision !== revision || record.state !== 'awaiting_decision') throw new FindingError(409, 'Finding decision changed')
      record.recommendation = { ...recommendation, recordedAt: recommendation.recordedAt ?? new Date().toISOString(), revision }
      delete record.recommendationError
      this.audit(record, 'recommendation_recorded', recommendation.provider, `model:${recommendation.provider}`)
      return this.save(record)
    })
  }
  recommendationFailed(id: string, revision: number, message: string): Finding {
    return this.atomic(() => {
      const record = this.require(id)
      if (record.revision !== revision || record.state !== 'awaiting_decision') throw new FindingError(409, 'Finding decision changed')
      delete record.recommendation
      record.recommendationError = Text.parse(message)
      this.audit(record, 'recommendation_failed', message, 'model-service')
      return this.save(record)
    })
  }
  confirm(id: string, raw: FindingConfirm, actor = 'local-operator'): Finding {
    const input = FindingConfirmSchema.parse(raw)
    if (actor !== 'local-operator') throw new FindingError(403, 'Only local-operator may confirm findings')
    return this.atomic(() => {
      const record = this.require(id)
      if (record.confirmation?.revision === input.revision && record.confirmation.choiceId === input.choiceId) return record
      if (record.revision !== input.revision || record.state !== 'awaiting_decision' || record.confirmation)
        throw new FindingError(409, 'Finding confirmation is stale or conflicts with the recorded choice')
      record.confirmation = { ...input, actor: 'local-operator', at: new Date().toISOString() }
      if (input.choiceId === 'defer') record.state = 'deferred'
      else {
        record.state = 'queued'
        record.job = { id: `finding:${record.id}:r${record.revision}` }
        this.db.prepare('INSERT INTO finding_queue(finding_id,job_id) VALUES(?,?)').run(id, record.job.id)
      }
      this.audit(record, 'confirmed', input.choiceId)
      return this.save(record)
    })
  }
  /** Read-only candidate; owner must select, native-dispatch and markDispatched in the same outer Store.atomic. */
  nextQueued(): Finding | undefined {
    if (this.db.prepare("SELECT 1 FROM finding WHERE json_extract(value,'$.state')='running' LIMIT 1").get()) return undefined
    const row = this.db.prepare(`SELECT f.value FROM finding_queue q JOIN finding f ON f.id=q.finding_id
      WHERE json_extract(f.value,'$.state')='queued' ORDER BY q.seq LIMIT 1`).get()
    return row ? JSON.parse(String(row.value)) as Finding : undefined
  }
  markDispatched(id: string, ticketId: string, assignmentId: string): Finding {
    Identity.parse(ticketId); Identity.parse(assignmentId)
    return this.atomic(() => {
      const record = this.require(id)
      if (record.job?.ticketId) {
        if (record.job.ticketId === ticketId && record.job.assignmentId === assignmentId) return record
        throw new FindingError(409, 'Finding job is already bound to another dispatch')
      }
      if (record.state !== 'queued' || !record.job || this.nextQueued()?.id !== id)
        throw new FindingError(409, 'Finding is not the next dispatchable queued job')
      record.job.ticketId = ticketId; record.job.assignmentId = assignmentId
      record.state = 'running'
      this.audit(record, 'dispatched', `${ticketId}/${assignmentId}`)
      return this.save(record)
    })
  }
  markBlocked(id: string, message: string): Finding {
    return this.atomic(() => {
      const record = this.require(id)
      if (record.state !== 'running' && record.state !== 'queued' && record.state !== 'blocked') throw new FindingError(409, 'Finding has no active work')
      const blocker = Text.parse(message)
      if (record.state === 'blocked' && record.blocker === blocker) return record
      record.state = 'blocked'; record.blocker = blocker; record.revision++
      this.audit(record, 'blocked', message, 'finding-runtime')
      return this.save(record)
    })
  }
  private reopen(record: Finding): void {
    if (record.job) (record.priorJobs ??= []).push(structuredClone(record.job))
    this.db.prepare('DELETE FROM finding_queue WHERE finding_id=?').run(record.id)
    record.state = 'awaiting_decision'; record.revision++
    delete record.job; delete record.confirmation; delete record.recommendation; delete record.recommendationError; delete record.blocker
  }
  /** Explicit local operator review only. Acceptance affects this finding, never its attached delivery. */
  review(id: string, raw: FindingReview, actor = 'local-operator'): Finding {
    const input = FindingReviewSchema.parse(raw)
    if (actor !== 'local-operator') throw new FindingError(403, 'Only local-operator may review findings')
    return this.atomic(() => {
      const record = this.require(id)
      if (record.revision !== input.revision || record.state !== 'blocked') throw new FindingError(409, 'Finding review is stale or not awaiting evidence review')
      if (input.decision === 'accept_evidence') {
        const latestReport = record.job && record.reports.filter(report => report.jobId === record.job!.id).at(-1)
        if (!latestReport || !input.evidenceReference || latestReport.reference !== input.evidenceReference
          || (latestReport.state !== 'ready' && latestReport.state !== 'verified'))
          throw new FindingError(409, 'Acceptance requires latest current-job linked report evidence with a ready or explicitly verified outcome')
        const supplied = input.requirements
        if (!supplied || supplied.length !== record.requirements.length || new Set(supplied).size !== supplied.length
          || !record.requirements.every(requirement => supplied.includes(requirement)))
          throw new FindingError(409, 'Acceptance requires explicit confirmation of the exact full requirements set')
        record.resolution = { outcome: input.outcome ?? 'verified', evidenceReference: input.evidenceReference,
          requirements: [...supplied], at: new Date().toISOString(), actor: 'local-operator', jobId: record.job!.id }
        record.state = 'resolved'; delete record.blocker
        this.audit(record, record.resolution.outcome === 'no_repair_needed' ? 'no_repair_needed' : 'requirements_verified', input.evidenceReference)
      } else if (input.decision === 'retry_scope') this.reopen(record)
      else { record.state = 'deferred'; delete record.blocker }
      this.audit(record, 'reviewed', JSON.stringify(input))
      return this.save(record)
    })
  }
  /** Only an explicit revisit reopens a deferred decision; repeated observations never do. */
  revisit(id: string): Finding {
    return this.atomic(() => {
      const record = this.require(id)
      if (record.state !== 'deferred') throw new FindingError(409, 'Only deferred findings may be revisited')
      this.reopen(record)
      this.audit(record, 'revisited')
      return this.save(record)
    })
  }
  /** New current-job human/CI input or progress invalidates old readiness without replacing the assignment. */
  markWorking(id: string, raw: { reference: string; evidence: string; at: string; token: string }): Finding {
    const input = z.object({ reference: Text, evidence: z.string().refine(value => value.trim().length > 0, 'Working evidence must be nonempty'),
      at: z.iso.datetime(), token: Identity }).strict().parse(raw)
    return this.atomic(() => {
      const record = this.require(id)
      if (!record.job?.ticketId || !record.job.assignmentId || (record.state !== 'running' && record.state !== 'blocked'))
        throw new FindingError(409, 'Working evidence requires an active dispatched finding job')
      if (record.reports.some(report => report.jobId === record.job!.id && report.currencyToken === input.token)) return record
      record.reports.push({ reference: input.reference, evidence: input.evidence.slice(0, 16_384), at: input.at,
        nextDecision: 'Await fresh current-job evidence after the newer human/CI input or work progress.', jobId: record.job.id,
        state: 'evidence', currencyToken: input.token, summaryTruncated: input.evidence.length > 16_384,
        originalLength: input.evidence.length, reportSummarySha256: createHash('sha256').update(input.evidence).digest('hex') })
      record.state = 'running'; delete record.blocker; record.revision++
      this.audit(record, 'working_evidence', input.reference, 'finding-runtime')
      return this.save(record)
    })
  }
  /** Worker outcomes only request evidence review; they are never acceptance of the finding. */
  markReview(id: string, raw: { reference: string; summary: string; recordedAt: string; state: 'ready' | 'blocked' | 'failed' | 'dropped' }): Finding {
    const input = z.object({ reference: Text, summary: z.string().refine(value => value.trim().length > 0, 'Native report summary must be nonempty'), recordedAt: z.iso.datetime(),
      state: z.enum(['ready', 'blocked', 'failed', 'dropped']) }).strict().parse(raw)
    const reportSummarySha256 = createHash('sha256').update(input.summary).digest('hex')
    return this.atomic(() => {
      const record = this.require(id)
      if (!record.job?.ticketId) throw new FindingError(409, 'Review requires a dispatched job')
      if (record.reports.some(report => report.reference === input.reference && report.at === input.recordedAt
        && (report.reportSummarySha256 ?? createHash('sha256').update(report.evidence).digest('hex')) === reportSummarySha256
        && report.jobId === record.job!.id && report.state === input.state)) return record
      if (record.state === 'resolved') throw new FindingError(409, 'Resolved findings cannot be reopened by worker reports')
      const nextDecision = input.state === 'ready' ? 'Review the linked evidence and explicitly accept or request further work.'
        : `Inspect the ${input.state} work report and decide the next bounded recovery step.`
      record.reports.push({ reference: input.reference, evidence: input.summary.slice(0, 16_384), at: input.recordedAt, nextDecision,
        jobId: record.job.id, state: input.state, summaryTruncated: input.summary.length > 16_384,
        originalLength: input.summary.length, reportSummarySha256 })
      record.state = 'blocked'; record.blocker = nextDecision; record.revision++
      this.audit(record, 'review_required', input.state, `worker:${record.job.ticketId}`)
      return this.save(record)
    })
  }
  /** Evidence is explicit, linked, and does not infer resolution from worker idle/end/merge. */
  reportEvidence(id: string, raw: { reference: string; evidence: string; nextDecision: string; at?: string; verified?: boolean }): Finding {
    const report = z.object({ reference: Text, evidence: Text, nextDecision: Text, at: z.iso.datetime().optional(), verified: z.boolean().optional() }).strict().parse(raw)
    return this.atomic(() => {
      const record = this.require(id)
      const { verified, ...fields } = report
      record.reports.push({ ...fields, at: report.at ?? new Date().toISOString(), jobId: record.job?.id, state: verified ? 'verified' : 'evidence' })
      record.revision++
      this.audit(record, 'evidence_reported', report.reference)
      return this.save(record)
    })
  }
  /** Compatibility helper; uses the same explicit blocked-review and full-requirements boundary. */
  resolve(id: string, evidenceReference: string, requirements: string[]): Finding {
    return this.review(id, { revision: this.require(id).revision, decision: 'accept_evidence', evidenceReference, requirements })
  }
}

/** Canonical finding snapshot on the shared decision surface. */
export type FindingDecisionItem = PendingDecisionItem & { actionMode: 'finding_triage'; finding: Finding }
export function findingDecision(record: Finding): PendingDecisionItem {
  const triage = record.state === 'awaiting_decision'
  const recommendation = triage && record.recommendation?.revision === record.revision ? record.recommendation : undefined
  const pending = triage || record.state === 'blocked' || record.state === 'queued' || record.state === 'running'
  const item: FindingDecisionItem = {
    id: `finding-${record.id}`, ticketId: record.job?.ticketId, sessionId: record.sessionId,
    ticketTitle: record.title, trigger: 'finding', actionMode: 'finding_triage', finding: record,
    status: pending ? 'pending' : 'resolved', urgency: 'medium', createdAt: Date.parse(record.createdAt),
    context: `${record.problem}\n\nScope: ${record.scope}\nOwner: ${record.owner}\nRequirements:\n${record.requirements.join('\n')}\n\n${record.reports.at(-1)?.nextDecision ?? 'Confirm a bounded next step.'}`,
    question: 'What should happen with this finding?',
    choices: triage ? record.choices.map(choice => ({ id: choice.id, label: choice.label, actionKind: 'approve' })) : [],
    recommendation: { recommendedValue: recommendation?.choiceId ?? '', confidence: 0,
      rationale: recommendation?.rationale ?? record.recommendationError ?? 'Recommendation not yet available; no model recommendation has been generated.',
      distribution: [], provider: recommendation?.provider ?? 'Recommendation unavailable', latencyMs: 0 },
    ...(!pending && record.confirmation ? { resolvedChoice: record.confirmation.choiceId, resolvedAt: Date.parse(record.confirmation.at) } : {}),
  }
  return item
}
/** Replace old projections by identity, preserving non-finding decisions and full finding history. */
export function projectFindings(store: FindingStore, items: PendingDecisionItem[]): PendingDecisionItem[] {
  const records = store.list()
  const ids = new Set(records.map(record => `finding-${record.id}`))
  const unresolvedDeliveries = new Set(records.filter(record => record.state !== 'resolved').map(record => record.existingDeliveryId).filter(Boolean))
  const projected = items.filter(item => !ids.has(item.id)).map(item => {
    if (item.delivery?.nextAction?.kind !== 'accept' || !unresolvedDeliveries.has(item.delivery.id)) return item
    const delivery = structuredClone(item.delivery)
    delete delivery.nextAction; delete delivery.recommendation
    const blocker = 'Linked finding evidence review remains outstanding'
    delivery.state = 'blocked'; delivery.blocker = blocker
    return { ...item, delivery, choices: [], recommendation: { recommendedValue: '', confidence: 0,
      rationale: blocker, distribution: [], provider: 'Recommendation unavailable', latencyMs: 0 } }
  })
  return [...projected, ...records.map(findingDecision)]
}
