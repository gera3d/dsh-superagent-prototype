/** Durable feature-delivery aggregate. Worker tickets are evidence, never acceptance. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type DeliveryStage = 'implementation' | 'review' | 'ready_to_publish' | 'publishing' | 'verifying' | 'accepted'
export type DeliveryState = 'running' | 'awaiting_decision' | 'blocked' | 'accepted' | 'cancelled' | 'abandoned'
export type DeliveryActionKind = 'implement' | 'review' | 'fix' | 'publish' | 'verify' | 'accept'
export interface DeliveryBindings { repository: string; sourceIssue: number; baseSha: string; headSha: string; artifact?: string; environment?: string; refs?: { repository: string; pr: number; headSha: string; baseSha?: string; diffSha256?: string }[] }
export interface DeliveryEvidence {
  id: string; kind: 'implementation' | 'review' | 'publication' | 'verification' | 'acceptance' | 'rollback'
  bindings: DeliveryBindings; recordedAt: string; reference: string; outcome: 'passed' | 'failed' | 'uncertain'
  /** Explicit intake requirement IDs independently verified by this evidence. */
  requirements?: string[]
  /** Review/fix generation; omitted legacy evidence belongs to generation zero. */
  generation?: number
  /** Explicit reconciled evidence IDs superseded in the same bound attempt; history remains intact. */
  supersedes?: string[]
}
export interface DeliveryRecommendation { kind: DeliveryActionKind; fingerprint: string; actionId: string; disposition: 'take' | 'hold'; rationale: string; provider: string; recordedAt: string }
export interface DeliveryScopeBinding { reason: string; sourceTriggerId: string }
export interface DeliveryUnboundInput { ticketId: string; title: string; owner: string; repository: string; sourceIssue?: number; triggerId: string }
export interface DeliveryAction { id: string; kind: DeliveryActionKind; label: string; revision: number; fingerprint: string }
export interface DeliveryAudit { at: string; event: string; actor: string; actionId?: string; authorization?: DeliveryConfirmationAuthority }
export interface DeliveryReconciliation { id: string; actionId: string; revision: number; label: string }
export interface Delivery {
  id: string; title: string; revision: number; stage: DeliveryStage; state: DeliveryState; owner: string
  /** Read-only native ownership projection; never persisted as an execution grant. */
  work?: import('./delivery-currency.ts').DeliveryWork
  nextAction?: DeliveryAction; blocker?: string; scopeBinding?: DeliveryScopeBinding; bindings: DeliveryBindings; requirements: string[]
  /** Derived recovery control for an existing parked outbox row; never a new mutation grant. */
  reconciliation?: DeliveryReconciliation
  recommendation?: DeliveryRecommendation
  recommendationError?: { kind: DeliveryActionKind; fingerprint: string; message: string; attempts: number; nextRetryAt?: number }
  preparation?: { fingerprint: string; message: string; attempts: number; nextRetryAt?: number }
  preparedPublication?: { id: string; ticketId: string; decisionId: string; repository: string; pr: number; headSha: string; patchSha256: string; environment: string; preparedAt: string; scopeSha256?: string; components?: string[]; effects?: string[]; refs?: DeliveryBindings['refs']
    /** Bounded descriptors of the review/check evidence the trusted adapter recorded for these exact pins; `proof.verified` states whether checks passed and the review was approved. */
    proof?: import('./publication-proof.ts').PublicationProof }
  acceptance?: { evidenceIds: string[]; fingerprint: string; at: string; actor: string }
  attempts: { review: number; fix: number; maxReview: number; maxFix: number }
  evidence: DeliveryEvidence[]; workers: string[]; audit: DeliveryAudit[]
  /** Immutable, recorded authority for confirmation; not caller-supplied permissions. */
  authorities: string[]
  delegatedActions?: DeliveryActionKind[]
  delegatedScope?: string
  followFixHeads?: boolean
  authorizedFixScopes?: string[]
  generation: number
}
export interface DeliveryCreate {
  id: string; title: string; owner: string; bindings: DeliveryBindings; requirements: string[]; authorities: string[]
  workers?: string[]; maxReview?: number; maxFix?: number; delegatedActions?: Exclude<DeliveryActionKind, 'accept'>[]; followFixHeads?: boolean; scopeBinding?: DeliveryScopeBinding
}
export interface DeliveryConfirmationAuthority {
  actor: string; source: 'local_operator' | 'github' | 'recorded_intake' | 'delegation'; reference: string; scope: string
}
export interface DeliveryLease {
  id: string; deliveryId: string; action: DeliveryAction; bindings: DeliveryBindings; authorization: DeliveryConfirmationAuthority; token: string; worker: string
  expiresAt: number; reconcile: boolean; signal?: AbortSignal
}
export interface DeliveryResult { outcome: 'passed' | 'failed' | 'uncertain' | 'pending'; evidence?: DeliveryEvidence[]; blocker?: string; nextRetryAt?: number; updatedBindings?: DeliveryBindings }
export interface DeliveryCapabilityAdapter {
  execute(lease: DeliveryLease): Promise<DeliveryResult>
  /** Must inspect the remote mutation using lease.id as idempotency key; never blindly replay. */
  reconcile?(lease: DeliveryLease): Promise<DeliveryResult>
}
export type DeliveryCapabilityAdapters = Partial<Record<Exclude<DeliveryActionKind, 'accept'>, DeliveryCapabilityAdapter>>
export interface DeliveryBackfillRecord {
  sourceIssue: number; id: string; title: string; owner: string; bindings: DeliveryBindings; requirements: string[]
  workers: { id: string; ended: boolean; merged: boolean }[]; evidence: DeliveryEvidence[]
}
/** Signals stale revisions, lease fencing, or an ineligible delivery authority/scope. */
export class DeliveryConflict extends Error {}
const unconfirmedRequirements = ['intake:acceptance-requirements-unconfirmed']
function validateIntake(input: DeliveryCreate): void {
  const b = input.bindings
  const invalidCommon = (b.refs !== undefined && new Set(b.refs.map(r => `${r.repository}:${r.pr}`)).size !== b.refs.length) || !input.id || !input.title || !input.owner || !b.repository || !Number.isInteger(b.sourceIssue) || input.requirements.some(r => !r.trim()) || [input.maxReview ?? 3, input.maxFix ?? 2].some(n => !Number.isInteger(n) || n < 1 || n > 10)
  if (input.scopeBinding) {
    if (invalidCommon || !input.scopeBinding.reason || !input.scopeBinding.sourceTriggerId || b.sourceIssue < 0 || b.headSha !== '' || b.baseSha !== '' || b.refs?.length || b.artifact !== undefined || b.environment !== undefined || stable(input.requirements) !== stable(unconfirmedRequirements) || input.authorities.length || input.delegatedActions?.length || input.followFixHeads) throw new Error('Invalid unbound delivery intake')
  } else if (invalidCommon || b.sourceIssue < 1 || !b.headSha || !b.baseSha || !input.requirements.length || input.requirements.includes(unconfirmedRequirements[0]!) || !input.authorities.length || input.authorities.some(a => !a.trim()) || input.delegatedActions?.some(k => !['implement', 'review', 'fix', 'publish', 'verify'].includes(k)) || b.refs?.some(r => !r.repository || !r.headSha || !Number.isInteger(r.pr) || r.pr < 1)) throw new Error('Invalid delivery intake')
}
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export const deliveryFingerprint = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex')
/** Publication comparison is a nonempty exact set, never an every/some subset match. */
export function sameDeliveryRefs(bound: DeliveryBindings['refs'], scope: DeliveryBindings['refs']): boolean {
  const canonical = (refs: DeliveryBindings['refs']): string | undefined => {
    if (!refs?.length || refs.some(r => !r.repository || !Number.isInteger(r.pr) || r.pr < 1 || !r.headSha) || new Set(refs.map(r => `${r.repository}:${r.pr}`)).size !== refs.length) return undefined
    return stable(refs.map(({ repository, pr, headSha, baseSha }) => ({ repository, pr, headSha, baseSha })).sort((a, b) => a.repository.localeCompare(b.repository) || a.pr - b.pr))
  }
  const a = canonical(bound); const b = canonical(scope)
  return a !== undefined && b !== undefined && a === b
}
const bindingMatches = (a: DeliveryBindings, b: DeliveryBindings) => stable(a) === stable(b)
const terminal = (d: Delivery) => ['accepted', 'cancelled', 'abandoned'].includes(d.state)
const fingerprint = (d: Delivery) => deliveryFingerprint({ bindings: d.bindings, evidence: d.evidence, requirements: d.requirements, preparedPublication: d.preparedPublication })
const currentEvidence = (d: Delivery) => {
  const relevant = d.evidence.filter(e => (e.generation ?? 0) === d.generation && bindingMatches(e.bindings, d.bindings))
  const superseded = new Set(relevant.filter(e => e.outcome === 'passed').flatMap(e => e.supersedes ?? []))
  return relevant.filter(e => !superseded.has(e.id))
}
const passed = (d: Delivery, kind: DeliveryEvidence['kind']) => currentEvidence(d).some(e => e.kind === kind && e.outcome === 'passed')
const acceptanceReady = (d: Delivery): boolean => {
  if (d.scopeBinding || d.requirements.includes('intake:acceptance-requirements-unconfirmed')) return false
  const relevant = currentEvidence(d)
  if (relevant.some(e => e.outcome === 'uncertain' || e.kind === 'rollback')) return false
  return passed(d, 'publication') && passed(d, 'verification') && d.requirements.length > 0 && d.requirements.every(r => relevant.some(e => ['verification', 'acceptance'].includes(e.kind) && e.outcome === 'passed' && e.requirements?.includes(r)))
}
function nextKind(d: Delivery): DeliveryActionKind | undefined {
  if (d.scopeBinding || terminal(d) || d.blocker || d.state === 'running') return undefined
  if (d.stage === 'implementation') return 'implement'
  if (d.stage === 'review') return passed(d, 'review') ? undefined : currentEvidence(d).some(e => e.kind === 'review' && e.outcome === 'failed') ? 'fix' : 'review'
  if (d.stage === 'ready_to_publish') return 'publish'
  if (d.stage === 'verifying') return acceptanceReady(d) ? 'accept' : 'verify'
  return undefined
}
function refresh(d: Delivery): Delivery {
  delete d.nextAction
  const kind = nextKind(d)
  if ((kind === 'review' && d.attempts.review >= d.attempts.maxReview) || (kind === 'fix' && d.attempts.fix >= d.attempts.maxFix)) { d.state = 'blocked'; d.blocker = 'Review/fix retry budget exhausted'; return d }
  if (kind) {
    const fp = fingerprint(d)
    d.nextAction = { id: `${d.id}:${d.revision}:${kind}:${fp.slice(0, 16)}`, kind, label: ({ implement: 'Implement', review: 'Review', fix: 'Fix review findings', publish: 'Publish bound artifact', verify: 'Verify intake requirements', accept: 'Accept verified delivery' })[kind], revision: d.revision, fingerprint: fp }
  }
  if (d.recommendationError && d.recommendationError.fingerprint !== fingerprint(d)) delete d.recommendationError
  if (d.preparation && d.preparation.fingerprint !== fingerprint(d)) delete d.preparation
  if (d.recommendation && (!d.nextAction || d.recommendation.actionId !== d.nextAction.id || d.recommendation.kind !== d.nextAction.kind || d.recommendation.fingerprint !== d.nextAction.fingerprint)) delete d.recommendation
  return d
}

/** SQLite delivery aggregate and transactional handoff outbox, separate from worker tickets. */
export class DeliveryStore {
  readonly db: DatabaseSync
  private readonly ownsDb: boolean
  constructor(path: string | DatabaseSync) {
    this.ownsDb = typeof path === 'string'
    if (typeof path === 'string') { if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); this.db = new DatabaseSync(path) } else this.db = path
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS feature_delivery(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feature_delivery_outbox(id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, value TEXT NOT NULL,
        status TEXT NOT NULL, token TEXT, worker TEXT, expires INTEGER NOT NULL DEFAULT 0, uncertain INTEGER NOT NULL DEFAULT 0, polls INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS feature_delivery_due ON feature_delivery_outbox(status,expires);`)
    if (!this.db.prepare('PRAGMA table_info(feature_delivery_outbox)').all().some(r => r.name === 'polls')) this.db.exec('ALTER TABLE feature_delivery_outbox ADD COLUMN polls INTEGER NOT NULL DEFAULT 0')
  }
  close(): void { if (this.ownsDb) this.db.close() }
  private atomic<T>(fn: () => T): T {
    this.db.exec('SAVEPOINT delivery_atomic')
    try { const value = fn(); this.db.exec('RELEASE delivery_atomic'); return value }
    catch (error) {
      this.db.exec('ROLLBACK TO delivery_atomic; RELEASE delivery_atomic')
      if (error && typeof error === 'object' && 'errcode' in error && [5, 6, 517].includes(Number(error.errcode))) throw new DeliveryConflict('Concurrent SQLite write; retry from current delivery revision')
      throw error
    }
  }
  private project(delivery: Delivery): Delivery {
    const d = refresh(delivery); delete d.reconciliation
    if (d.state !== 'blocked' || d.scopeBinding) return d
    const row = this.db.prepare("SELECT id,value FROM feature_delivery_outbox WHERE delivery_id=? AND status='blocked' ORDER BY rowid DESC LIMIT 1").get(d.id)
    if (!row) return d
    let payload: { action?: DeliveryAction; bindings?: DeliveryBindings; authorization?: DeliveryConfirmationAuthority; preparedPublication?: Delivery['preparedPublication'] } | null
    try { payload = JSON.parse(String(row.value)) as typeof payload } catch { return d }
    // Unknown/legacy journal payloads remain blocked history, never an executable recovery identity.
    if (!payload?.action || !payload.bindings || !payload.authorization || typeof payload.action.fingerprint !== 'string' || !payload.action.fingerprint
      || payload.action.id !== String(row.id) || !bindingMatches(payload.bindings, d.bindings) || payload.authorization.scope !== payload.action.fingerprint
      || stable(payload.preparedPublication) !== stable(d.preparedPublication)) return d
    const scope = deliveryFingerprint({ id: d.id, revision: d.revision, fingerprint: fingerprint(d), outboxId: String(row.id), payload })
    d.reconciliation = { id: String(row.id), actionId: `${d.id}:${d.revision}:reconcile:${scope}`, revision: d.revision, label: 'Reconcile recorded handoff' }
    return d
  }
  get(id: string): Delivery | undefined {
    const row = this.db.prepare('SELECT value FROM feature_delivery WHERE id=?').get(id)
    return row ? this.project(JSON.parse(String(row.value)) as Delivery) : undefined
  }
  list(): Delivery[] { return this.db.prepare('SELECT value FROM feature_delivery ORDER BY id').all().map(row => this.project(JSON.parse(String(row.value)) as Delivery)) }
  create(input: DeliveryCreate): Delivery {
    validateIntake(input)
    return this.atomic(() => {
      const existing = this.get(input.id)
      if (existing) {
        if (!bindingMatches(existing.bindings, input.bindings) || stable(existing.requirements) !== stable(input.requirements) || existing.owner !== input.owner || stable(existing.authorities) !== stable(input.authorities) || stable(existing.delegatedActions ?? []) !== stable(input.delegatedActions ?? []) || existing.followFixHeads !== (input.followFixHeads ?? false) || stable(existing.scopeBinding) !== stable(input.scopeBinding)) throw new DeliveryConflict('Delivery ID already bound to another intake')
        return existing
      }
      const d = refresh({ id: input.id, title: input.title, owner: input.owner, bindings: structuredClone(input.bindings), requirements: [...input.requirements], authorities: [...input.authorities], delegatedActions: [...(input.delegatedActions ?? [])], delegatedScope: input.scopeBinding ? undefined : deliveryFingerprint({ bindings: input.bindings, requirements: input.requirements }), followFixHeads: input.followFixHeads ?? false, authorizedFixScopes: [], generation: 0, workers: [...new Set(input.workers ?? [])], revision: 1, stage: 'implementation', state: input.scopeBinding ? 'blocked' : 'awaiting_decision', scopeBinding: input.scopeBinding ? structuredClone(input.scopeBinding) : undefined, blocker: input.scopeBinding?.reason, attempts: { review: 0, fix: 0, maxReview: input.maxReview ?? 3, maxFix: input.maxFix ?? 2 }, evidence: [], audit: [{ at: new Date().toISOString(), event: input.scopeBinding ? `tracked-unbound:${input.scopeBinding.sourceTriggerId}` : 'created', actor: input.owner }] })
      this.db.prepare('INSERT INTO feature_delivery VALUES(?,?,?)').run(d.id, d.revision, JSON.stringify(d))
      return d
    })
  }
  /** New-ticket tracking only: no historical sweep, fabricated pins, acceptance, or grants. */
  trackUnbound(input: DeliveryUnboundInput): Delivery {
    if (!input.ticketId || !input.triggerId || !input.title || !input.owner || !input.repository || (input.sourceIssue !== undefined && (!Number.isInteger(input.sourceIssue) || input.sourceIssue < 0))) throw new Error('Unbound tracking requires actual ticket, source and trigger IDs')
    const id = `auto-${input.ticketId}`
    const existing = this.get(id)
    if (existing) {
      if (existing.bindings.repository !== input.repository || !existing.workers.includes(input.ticketId) || ((input.sourceIssue ?? 0) > 0 && existing.bindings.sourceIssue !== input.sourceIssue)) throw new DeliveryConflict('Automatic tracking ID belongs to another source')
      return existing
    }
    return this.create({ id, title: input.title, owner: input.owner, bindings: { repository: input.repository, sourceIssue: input.sourceIssue ?? 0, baseSha: '', headSha: '', refs: [] }, requirements: [...unconfirmedRequirements], authorities: [], workers: [input.ticketId], scopeBinding: { reason: 'Operator-confirmed delivery scope, target and acceptance requirements are missing', sourceTriggerId: input.triggerId } })
  }
  /** Explicit trusted operator intake replaces unknown scope, never a worker report or model guess. */
  bindScope(id: string, revision: number, input: DeliveryCreate, authority: DeliveryConfirmationAuthority): Delivery {
    validateIntake(input)
    if (input.id !== id || input.scopeBinding || authority.source !== 'local_operator' || !authority.actor || !authority.reference || !input.authorities.includes(authority.actor) || authority.scope !== deliveryFingerprint(input)) throw new DeliveryConflict('Scope binding requires exact reviewed intake and local operator authority')
    return this.update(id, revision, d => {
      if (!d.scopeBinding || terminal(d) || d.bindings.repository !== input.bindings.repository || (d.bindings.sourceIssue > 0 && d.bindings.sourceIssue !== input.bindings.sourceIssue)) throw new DeliveryConflict('Delivery source is already bound or differs from original intake')
      d.title = input.title; d.owner = input.owner; d.bindings = structuredClone(input.bindings); d.requirements = [...input.requirements]; d.authorities = [...input.authorities]
      d.delegatedActions = [...(input.delegatedActions ?? [])]; d.followFixHeads = input.followFixHeads ?? false
      d.delegatedScope = deliveryFingerprint({ bindings: d.bindings, requirements: d.requirements }); d.authorizedFixScopes = []
      d.workers = [...new Set([...d.workers, ...(input.workers ?? [])])]
      d.attempts = { review: 0, fix: 0, maxReview: input.maxReview ?? 3, maxFix: input.maxFix ?? 2 }
      delete d.scopeBinding; delete d.blocker; delete d.preparation; delete d.preparedPublication; delete d.recommendation; delete d.recommendationError
      d.stage = 'implementation'; d.state = 'awaiting_decision'
      d.audit.push({ at: new Date().toISOString(), event: `scope-bound:${authority.source}:${authority.reference}:${authority.scope}`, actor: authority.actor })
    }, false, true)
  }
  compareAndSwap(id: string, revision: number, mutate: (delivery: Delivery) => void): Delivery {
    return this.update(id, revision, mutate)
  }
  private update(id: string, revision: number, mutate: (delivery: Delivery) => void, allowFixRebind = false, allowScopeBind = false): Delivery {
    return this.atomic(() => {
      const d = this.get(id)
      if (!d || d.revision !== revision) throw new DeliveryConflict('Stale delivery revision')
      delete d.reconciliation
      const before = structuredClone(d)
      mutate(d)
      delete d.reconciliation
      if (d.bindings.refs && new Set(d.bindings.refs.map(r => `${r.repository}:${r.pr}`)).size !== d.bindings.refs.length) throw new DeliveryConflict('Duplicate delivery reference identities')
      if (d.id !== id || (!allowScopeBind && (stable(d.scopeBinding) !== stable(before.scopeBinding) || stable(d.authorities) !== stable(before.authorities) || stable(d.delegatedActions) !== stable(before.delegatedActions) || d.delegatedScope !== before.delegatedScope || d.followFixHeads !== before.followFixHeads || stable(d.requirements) !== stable(before.requirements) || d.owner !== before.owner || (before.scopeBinding && !bindingMatches(d.bindings, before.bindings))))) throw new DeliveryConflict('Immutable intake changed')
      if (before.state === 'running' && !allowFixRebind && !allowScopeBind && (!bindingMatches(d.bindings, before.bindings) || stable(d.preparedPublication) !== stable(before.preparedPublication))) throw new DeliveryConflict('In-flight scope and prepared publication are immutable')
      if (before.evidence.some(e => !d.evidence.some(next => next.id === e.id && stable(next) === stable(e))) || stable(d.audit.slice(0, before.audit.length)) !== stable(before.audit)) throw new DeliveryConflict('Evidence and audit history are append-only')
      if ((!allowScopeBind && (d.attempts.maxReview !== before.attempts.maxReview || d.attempts.maxFix !== before.attempts.maxFix || d.attempts.review < before.attempts.review || d.attempts.fix < before.attempts.fix)) || d.generation < before.generation || d.generation > before.generation + 1) throw new DeliveryConflict('Retry budgets and generations cannot be reset')
      if (terminal(before) && stable({ ...d, nextAction: undefined }) !== stable({ ...before, nextAction: undefined })) throw new DeliveryConflict('Settled delivery is immutable')
      if (d.state === 'accepted' && (!acceptanceReady(d) || !d.acceptance || d.acceptance.fingerprint !== fingerprint(d))) throw new DeliveryConflict('Acceptance lacks exact verified evidence')
      d.revision = revision + 1; refresh(d)
      if (!this.db.prepare('UPDATE feature_delivery SET revision=?,value=? WHERE id=? AND revision=?').run(d.revision, JSON.stringify(d), id, revision).changes) throw new DeliveryConflict('Concurrent delivery revision')
      return this.project(d)
    })
  }
  /** Advice is metadata, not execution authority: do not revise the action it evaluated. */
  setRecommendation(id: string, revision: number, recommendation: DeliveryRecommendation): Delivery {
    return this.atomic(() => {
      const d = this.get(id); const action = d?.nextAction
      if (!d || d.revision !== revision || !action || recommendation.actionId !== action.id || recommendation.kind !== action.kind || recommendation.fingerprint !== action.fingerprint || !['take', 'hold'].includes(recommendation.disposition) || !recommendation.rationale || !recommendation.provider || !Number.isFinite(Date.parse(recommendation.recordedAt))) throw new DeliveryConflict('Recommendation is not bound to the current exact action')
      d.recommendation = structuredClone(recommendation); delete d.recommendationError
      if (!this.db.prepare('UPDATE feature_delivery SET value=? WHERE id=? AND revision=?').run(JSON.stringify(d), id, revision).changes) throw new DeliveryConflict('Concurrent recommendation revision')
      return d
    })
  }
  /** Ingest actual ended-worker evidence without treating the worker report as acceptance. */
  recordImplementation(id: string, revision: number, evidence: DeliveryEvidence, workerIds: readonly string[] = []): Delivery {
    return this.compareAndSwap(id, revision, d => {
      if (d.scopeBinding || d.stage !== 'implementation' || d.state === 'running' || evidence.kind !== 'implementation' || evidence.outcome !== 'passed' || !evidence.id || !evidence.reference || !evidence.recordedAt || !bindingMatches(evidence.bindings, d.bindings) || (evidence.generation ?? d.generation) !== d.generation) throw new DeliveryConflict('Implementation evidence is not eligible or exactly bound')
      if (d.evidence.some(e => e.id === evidence.id)) throw new DeliveryConflict('Evidence ID reused')
      d.evidence.push({ ...structuredClone(evidence), generation: d.generation }); d.workers = [...new Set([...d.workers, ...workerIds])]
      d.stage = 'review'; d.state = 'awaiting_decision'; delete d.blocker
      d.audit.push({ at: new Date().toISOString(), event: 'implementation-evidence-recorded', actor: d.owner })
    })
  }
  eligibleActions(id: string): DeliveryAction[] { const action = this.get(id)?.nextAction; return action ? [action] : [] }
  confirm(id: string, request: { revision: number; actionId: string }, authority: string | DeliveryConfirmationAuthority): Delivery {
    return this.atomic(() => {
      const d = this.get(id)
      if (!d || d.revision !== request.revision || !d.nextAction || d.nextAction.id !== request.actionId || d.nextAction.fingerprint !== fingerprint(d)) throw new DeliveryConflict('Stale or ineligible delivery action')
      const action = d.nextAction
      const authorization: DeliveryConfirmationAuthority = typeof authority === 'string' ? { actor: authority, source: 'recorded_intake', reference: `intake:${id}`, scope: action.fingerprint } : structuredClone(authority)
      if (!['local_operator', 'github', 'recorded_intake', 'delegation'].includes(authorization.source) || !d.authorities.includes(authorization.actor) || !authorization.reference || authorization.scope !== action.fingerprint) throw new DeliveryConflict('Authority not recorded for this exact intake scope')
      if (authorization.source === 'delegation') {
        const scope = deliveryFingerprint({ bindings: d.bindings, requirements: d.requirements })
        if (action.kind === 'accept' || !d.delegatedActions?.includes(action.kind) || (d.delegatedScope !== scope && !(d.followFixHeads && action.kind !== 'publish' && d.authorizedFixScopes?.includes(scope)))) throw new DeliveryConflict('Action has no exact recorded delegation')
      }
      return this.compareAndSwap(id, request.revision, value => {
        value.audit.push({ at: new Date().toISOString(), event: `confirmed:${action.kind}:${authorization.source}:${authorization.reference}`, actor: authorization.actor, actionId: action.id })
        if (action.kind === 'accept') {
          if (!acceptanceReady(value)) throw new DeliveryConflict('Unresolved acceptance requirements')
          value.state = 'accepted'; value.stage = 'accepted'; value.acceptance = { evidenceIds: value.evidence.map(e => e.id), fingerprint: fingerprint(value), at: new Date().toISOString(), actor: authorization.actor }
        } else {
          if ((action.kind === 'review' && ++value.attempts.review > value.attempts.maxReview) || (action.kind === 'fix' && ++value.attempts.fix > value.attempts.maxFix)) throw new DeliveryConflict('Retry budget exhausted')
          value.state = 'running'; if (action.kind === 'publish') value.stage = 'publishing'
          this.db.prepare('INSERT INTO feature_delivery_outbox(id,delivery_id,value,status) VALUES(?,?,?,?)').run(action.id, id, JSON.stringify({ action, bindings: value.bindings, authorization, preparedPublication: value.preparedPublication }), 'pending')
        }
      })
    })
  }
  /** Dispatch only intake-recorded delegation; acceptance always needs an explicit confirmation. */
  dispatchAuthorized(id: string): Delivery | undefined {
    const d = this.get(id)
    if (!d?.nextAction || d.nextAction.kind === 'accept' || !d.delegatedActions?.includes(d.nextAction.kind)) return undefined
    const scope = deliveryFingerprint({ bindings: d.bindings, requirements: d.requirements })
    if (d.delegatedScope !== scope && !(d.followFixHeads && d.nextAction.kind !== 'publish' && d.authorizedFixScopes?.includes(scope))) return undefined
    return this.confirm(id, { revision: d.revision, actionId: d.nextAction.id }, { actor: d.authorities[0]!, source: 'delegation', reference: `intake:${id}:${d.nextAction.kind}`, scope: d.nextAction.fingerprint })
  }
  /** Resume only reconciliation of the original immutable handoff; never authorize mutation replay. */
  resume(id: string, revision: number, authority: string | DeliveryConfirmationAuthority, recoveryActionId?: string): Delivery {
    return this.atomic(() => {
      const d = this.get(id); const recovery = d?.reconciliation
      if (!d || d.revision !== revision || d.state !== 'blocked' || !recovery || (recoveryActionId !== undefined && recoveryActionId !== recovery.actionId)) throw new DeliveryConflict('Resume requires the current exact parked reconciliation action')
      const authorization: DeliveryConfirmationAuthority = typeof authority === 'string' ? { actor: authority, source: 'recorded_intake', reference: `intake:${id}`, scope: recovery.actionId } : structuredClone(authority)
      if (!d.authorities.includes(authorization.actor) || !['local_operator', 'github', 'recorded_intake'].includes(authorization.source) || !authorization.reference || authorization.scope !== recovery.actionId) throw new DeliveryConflict('Reconciliation requires recorded authority bound to the recovery scope')
      // Do not replace value/authorization: the original confirmation and idempotency key remain intact.
      if (!this.db.prepare("UPDATE feature_delivery_outbox SET status='pending',uncertain=1,polls=0,expires=0 WHERE id=? AND delivery_id=? AND status='blocked'").run(recovery.id, id).changes) throw new DeliveryConflict('Parked reconciliation changed')
      return this.compareAndSwap(id, revision, value => {
        value.state = 'running'; delete value.blocker
        value.audit.push({ at: new Date().toISOString(), event: 'resume-reconciliation', actor: authorization.actor, actionId: recovery.id, authorization })
      })
    })
  }
  /** Park unavailable adapters without claiming a remote mutation succeeded or was attempted. */
  blockLease(lease: DeliveryLease, blocker: string): Delivery {
    return this.complete(lease, { outcome: 'uncertain', blocker }, Date.now(), !lease.reconcile)
  }
  claim(worker: string, now = Date.now(), leaseMs = 30_000): DeliveryLease | undefined {
    if (!worker || !Number.isFinite(now) || !Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('Invalid lease')
    return this.atomic(() => {
      const row = this.db.prepare("SELECT * FROM feature_delivery_outbox WHERE (status='pending' OR status='leased') AND expires<=? ORDER BY rowid LIMIT 1").get(now)
      if (!row) return undefined
      const token = randomUUID(); const expiresAt = now + leaseMs
      const reconcile = row.status === 'leased' || Number(row.uncertain) === 1
      this.db.prepare("UPDATE feature_delivery_outbox SET status='leased',token=?,worker=?,expires=?,uncertain=? WHERE id=?").run(token, worker, expiresAt, reconcile ? 1 : 0, String(row.id))
      const payload = JSON.parse(String(row.value)) as { action: DeliveryAction; bindings: DeliveryBindings; authorization: DeliveryConfirmationAuthority }
      return { id: String(row.id), deliveryId: String(row.delivery_id), ...payload, worker, token, expiresAt, reconcile }
    })
  }
  /** Heartbeat only a still-owned, unexpired lease; cannot resurrect a fenced worker. */
  renew(lease: DeliveryLease, now = Date.now(), leaseMs = 30_000): boolean {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('Invalid lease duration')
    const expiresAt = now + leaseMs
    const changed = this.db.prepare("UPDATE feature_delivery_outbox SET expires=? WHERE id=? AND status='leased' AND token=? AND worker=? AND expires>?").run(expiresAt, lease.id, lease.token, lease.worker, now).changes
    if (changed) lease.expiresAt = expiresAt
    return !!changed
  }
  complete(lease: DeliveryLease, result: DeliveryResult, now = Date.now(), unattempted = false): Delivery {
    return this.atomic(() => {
      const row = this.db.prepare("SELECT * FROM feature_delivery_outbox WHERE id=? AND status='leased' AND token=? AND worker=? AND expires>?").get(lease.id, lease.token, lease.worker, now)
      if (!row) throw new DeliveryConflict('Lease expired or fenced')
      const payload = JSON.parse(String(row.value)) as { action: DeliveryAction; bindings: DeliveryBindings; authorization: DeliveryConfirmationAuthority; preparedPublication?: Delivery['preparedPublication'] }
      if ((Number(row.uncertain) === 1) !== lease.reconcile || String(row.delivery_id) !== lease.deliveryId || stable(payload.action) !== stable(lease.action) || stable(payload.authorization) !== stable(lease.authorization) || !bindingMatches(payload.bindings, lease.bindings)) throw new DeliveryConflict('Lease payload changed')
      const d = this.get(lease.deliveryId)!
      if (!bindingMatches(d.bindings, lease.bindings) || stable(payload.preparedPublication) !== stable(d.preparedPublication) || (!lease.reconcile && fingerprint(d) !== lease.action.fingerprint)) throw new DeliveryConflict('Mutation scope or evidence changed')
      const updated = this.update(d.id, d.revision, value => {
        if (result.updatedBindings) {
          const old = value.bindings; const next = result.updatedBindings
          const identities = (b: DeliveryBindings) => ({ repository: b.repository, sourceIssue: b.sourceIssue, baseSha: b.baseSha, environment: b.environment, refs: b.refs?.map(r => ({ repository: r.repository, pr: r.pr, baseSha: r.baseSha })) })
          if (lease.action.kind !== 'fix' || result.outcome !== 'passed' || stable(identities(old)) !== stable(identities(next)) || !next.headSha || next.refs?.some(r => !r.headSha) || next.artifact !== undefined || !result.evidence?.some(e => e.kind === 'implementation' && e.outcome === 'passed' && bindingMatches(e.bindings, next))) throw new DeliveryConflict('Corrected bindings require passed fix, identical scope identities and cleared artifact')
          value.bindings = structuredClone(next)
          delete value.preparedPublication; delete value.recommendation
          if (value.followFixHeads) value.authorizedFixScopes = [...new Set([...(value.authorizedFixScopes ?? []), deliveryFingerprint({ bindings: next, requirements: value.requirements })])]
        }
        const generation = value.generation + (lease.action.kind === 'fix' && result.outcome === 'passed' ? 1 : 0)
        const evidence = (result.evidence ?? []).map(e => ({ ...e, generation: e.generation ?? generation }))
        if (evidence.some(e => e.generation !== generation)) throw new DeliveryConflict('Evidence generation mismatch')
        if (evidence.some(e => !e.id || !e.reference || !e.recordedAt || !bindingMatches(e.bindings, value.bindings))) throw new DeliveryConflict('Evidence binding mismatch')
        for (const e of evidence) {
          if (e.supersedes?.some(id => {
            const target = value.evidence.find(p => p.id === id)
            return !target || e.outcome !== 'passed' || (target.generation ?? 0) !== generation || !bindingMatches(target.bindings, e.bindings) || (target.kind === 'rollback' ? e.kind !== 'publication' : target.outcome === 'passed' || target.kind !== e.kind)
          })) throw new DeliveryConflict('Invalid explicit evidence reconciliation')
          const previous = value.evidence.find(p => p.id === e.id)
          if (previous && stable(previous) !== stable(e)) throw new DeliveryConflict('Evidence ID reused')
          if (!previous) value.evidence.push(structuredClone(e))
        }
        value.state = 'awaiting_decision'; delete value.blocker
        if (result.outcome === 'pending') {
          if (evidence.length || result.blocker) throw new DeliveryConflict('Pending handoff cannot claim completed evidence or a blocker')
          if (Number(row.polls) >= 20) { value.state = 'blocked'; value.blocker = 'External handoff reconciliation budget exhausted' }
          else value.state = 'running'
        }
        else if (result.outcome === 'uncertain') { value.state = 'blocked'; value.blocker = result.blocker ?? 'Mutation uncertain; reconciliation required' }
        else if (result.blocker) { value.state = 'blocked'; value.blocker = result.blocker }
        else if (result.outcome === 'failed') {
          if (lease.action.kind !== 'review' || !evidence.some(e => e.kind === 'review' && e.outcome === 'failed')) { value.state = 'blocked'; value.blocker = `${lease.action.kind} failed; explicit intervention or recorded review evidence required` }
        } else {
          const expected = ({ implement: 'implementation', fix: 'implementation', review: 'review', publish: 'publication', verify: 'verification', accept: 'acceptance' } as const)[lease.action.kind]
          if (!evidence.some(e => e.kind === expected && e.outcome === 'passed')) { value.state = 'blocked'; value.blocker = `Missing recorded ${expected} evidence` }
          else if (lease.action.kind === 'implement' || lease.action.kind === 'fix') { value.stage = 'review'; value.generation = generation }
          else if (lease.action.kind === 'review') value.stage = 'ready_to_publish'
          else if (lease.action.kind === 'publish') value.stage = 'verifying'
          else if (lease.action.kind === 'verify' && !acceptanceReady(value)) { value.state = 'blocked'; value.blocker = 'Unresolved intake requirements, rollback, or uncertain evidence' }
        }
        if (value.state === 'awaiting_decision' && value.stage === 'review' && ((result.outcome === 'failed' && value.attempts.fix >= value.attempts.maxFix) || (result.outcome === 'passed' && value.attempts.review >= value.attempts.maxReview))) { value.state = 'blocked'; value.blocker = 'Review/fix retry budget exhausted' }
        value.audit.push({ at: new Date(now).toISOString(), event: `${lease.reconcile ? 'reconciled' : 'completed'}:${lease.action.kind}:${result.outcome}`, actor: lease.worker, actionId: lease.id })
      }, lease.action.kind === 'fix' && result.outcome === 'passed' && !!result.updatedBindings)
      const pending = result.outcome === 'pending' && updated.state === 'running'
      const due = pending ? Math.max(now + 1_000, Math.min(now + 300_000, Number.isFinite(result.nextRetryAt) ? result.nextRetryAt! : now + 5_000)) : 0
      this.db.prepare('UPDATE feature_delivery_outbox SET status=?,uncertain=?,token=NULL,worker=NULL,expires=?,polls=polls+? WHERE id=?').run(pending ? 'pending' : result.outcome === 'uncertain' || result.outcome === 'pending' ? 'blocked' : 'done', (result.outcome === 'uncertain' && !unattempted) || result.outcome === 'pending' ? 1 : 0, due, result.outcome === 'pending' ? 1 : 0, lease.id)
      return this.get(updated.id)!
    })
  }
  /** Apply only an explicitly reviewed exact preview. Never publishes or touches worker rows. */
  applyBackfill(records: readonly DeliveryBackfillRecord[], previewFingerprint: string, authority: DeliveryConfirmationAuthority): Delivery[] {
    this.previewBackfill(records)
    const expected = deliveryFingerprint(records)
    if (expected !== previewFingerprint || authority.scope !== expected || authority.source !== 'local_operator' || !authority.actor || !authority.reference) throw new DeliveryConflict('Backfill requires exact reviewed preview and local operator authority')
    if (new Set(records.map(r => r.id)).size !== records.length) throw new DeliveryConflict('Duplicate backfill delivery IDs')
    return this.atomic(() => records.map(record => {
      const existing = this.get(record.id)
      const marker = `backfill:${expected}:${authority.reference}`
      if (existing) {
        if (!existing.audit.some(a => a.event === marker && a.actor === authority.actor)) throw new DeliveryConflict('Backfill conflicts with existing delivery')
        return existing
      }
      const d = this.create({ id: record.id, title: record.title, owner: record.owner, bindings: record.bindings, requirements: record.requirements, authorities: [authority.actor], workers: record.workers.map(w => w.id) })
      return this.compareAndSwap(d.id, d.revision, value => {
        value.evidence = structuredClone(record.evidence); value.stage = 'verifying'; value.state = 'blocked'
        value.blocker = 'Backfilled historical evidence; explicit intake verification required'
        value.audit.push({ at: new Date().toISOString(), event: marker, actor: authority.actor })
      })
    }))
  }
  /** Pure preview: does not create deliveries, reopen workers, or queue publication. */
  previewBackfill(records: readonly DeliveryBackfillRecord[]): { sourceIssue: number; id: string; stage: DeliveryStage; state: DeliveryState; blocker: string; workers: string[]; evidence: DeliveryEvidence[] }[] {
    return records.map(record => {
      if (![159, 160].includes(record.sourceIssue) || record.bindings.sourceIssue !== record.sourceIssue) throw new Error('Backfill restricted to source issues #159 and #160')
      if (!record.id || !record.owner || !record.bindings.repository || !record.bindings.headSha || !record.bindings.baseSha || !record.requirements.length || record.requirements.some(r => !r.trim()) || !record.workers.length || record.workers.some(w => !w.id || !w.ended || !w.merged) || new Set(record.workers.map(w => w.id)).size !== record.workers.length || !record.evidence.length || new Set(record.evidence.map(e => e.id)).size !== record.evidence.length || record.evidence.some(e => !e.id || !e.reference || !Number.isFinite(Date.parse(e.recordedAt)) || !bindingMatches(e.bindings, record.bindings))) throw new Error('Backfill requires recorded, bound evidence and ended merged workers')
      return { sourceIssue: record.sourceIssue, id: record.id, stage: 'verifying' as const, state: 'blocked' as const, blocker: 'Read-only backfill preview; intake acceptance requires explicit verification', workers: record.workers.map(w => w.id), evidence: structuredClone(record.evidence) }
    })
  }
}

/** Executes only typed leased handoffs; renews ownership and reconciles rather than replaying mutations. */
export class DeliveryCoordinator {
  constructor(readonly store: DeliveryStore, readonly capabilities: DeliveryCapabilityAdapters, readonly options: { leaseMs?: number } = {}) {}
  async runOnce(worker: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false
    for (const d of this.store.list()) {
      try { this.store.dispatchAuthorized(d.id) } catch (error) { if (!(error instanceof DeliveryConflict)) throw error }
    }
    const leaseMs = this.options.leaseMs ?? 30_000
    const lease = this.store.claim(worker, Date.now(), leaseMs)
    if (!lease) return false
    const adapter = lease.action.kind === 'accept' ? undefined : this.capabilities[lease.action.kind]
    if (!adapter || (lease.reconcile && !adapter.reconcile)) {
      this.store.blockLease(lease, !adapter ? `Missing capability: ${lease.action.kind}` : `Missing reconciliation capability: ${lease.action.kind}`)
      return true
    }
    const controller = new AbortController(); lease.signal = controller.signal
    const stop = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', stop, { once: true })
    let resolveAbort!: (result: DeliveryResult) => void
    const aborted = new Promise<DeliveryResult>(resolve => { resolveAbort = resolve })
    const onAbort = () => resolveAbort({ outcome: 'uncertain', blocker: 'Coordinator stopped during capability; reconciliation required' })
    controller.signal.addEventListener('abort', onAbort, { once: true })
    let lost = false
    const heartbeat = setInterval(() => {
      try { if (!this.store.renew(lease, Date.now(), leaseMs)) { lost = true; controller.abort() } }
      catch { lost = true; controller.abort() }
    }, Math.max(1, Math.floor(leaseMs / 3)))
    heartbeat.unref()
    let result: DeliveryResult
    try { result = await Promise.race([lease.reconcile ? adapter.reconcile!(lease) : adapter.execute(lease), aborted]) }
    catch { result = { outcome: 'uncertain', blocker: 'Capability failed with uncertain mutation; reconciliation required' } }
    finally { clearInterval(heartbeat); signal?.removeEventListener('abort', stop); controller.signal.removeEventListener('abort', onAbort) }
    if (lost) throw new DeliveryConflict('Lease ownership lost; adapter aborted and reconciliation required')
    this.store.complete(lease, result)
    return true
  }
}
