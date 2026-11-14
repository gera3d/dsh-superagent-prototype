/** Durable publication orchestration. Authority must be supplied by a trusted server boundary, never an agent/request body. */
import { randomUUID } from 'node:crypto'
import { publicationProcessIdentity } from './publication-process.ts'

export type PublicationStage = 'merge' | 'apply' | 'build' | 'restart' | 'verify' | 'rollback'
export type PublicationAction = 'merge' | 'publish' | 'rollback'
export interface PublicationPins { repository: string; prNumber: number; headSha: string; patchSha256: string }
export interface PublicationEvidence extends PublicationPins {
  observedAt: string
  checks: 'passed' | 'failed' | 'pending'
  review: 'approved' | 'changes_requested' | 'required'
  mergeable: boolean
  state: 'open' | 'merged' | 'closed'
  local?: { reviewer: string; reportSha256: string; reviewExcerpt?: string; checks: { name: string; reportSha256: string; completedAt: string; outputExcerpt?: string }[]; limitations: string[] }
}
export interface PublicationAdapter {
  evidence(pins: PublicationPins, signal?: AbortSignal, onSpawn?: (pid: number) => void): Promise<PublicationEvidence>
  /** Must implement exact-pin operations; operationId is durable and stable, not an authorization token. */
  perform(stage: PublicationStage, pins: PublicationPins, operationId: string, signal?: AbortSignal, onSpawn?: (pid: number) => void): Promise<{ detail: string }>
}
export interface PublicationPrepareInput extends PublicationPins { ticketId: string; conversationId: string }
export interface PublicationActInput {
  ticketId: string; conversationId: string; publicationId: string; requestId: string; action: PublicationAction
}
export interface PublicationAuthority {
  kind: 'human_click' | 'operator_instruction'; actorId: string; authorized: true
  ticketId: string; conversationId: string; publicationId: string; action: PublicationAction
  /** Trusted server closure; rechecked after asynchronous evidence and before each effect. Never deserialize from a request. */
  isCurrent?: () => boolean
  /** Internal detached-worker grant identity; never deserialize from an untrusted payload. */
  workerGrantId?: string
  sourceProof?: PublicationInstructionProof
}
export interface PublicationInstructionProof {
  recordPath: string; recordSha256: string; reference: string; instruction: string
}
export type PublicationDiagnosticPhase = 'confirmation' | 'validation' | 'enqueue' | 'execution'
export type PublicationFailureCategory =
  | 'before_effect_rejection'
  | 'stale_pins'
  | 'authority_mismatch'
  | 'canonical_ticket_changed'
  | 'idempotency_conflict'
  | 'concurrency_blocked'
  | 'pre_enqueue_binding_failed'
  | 'worker_launch_failed'
  | 'stage_failed'
  | 'execution_interrupted'
  | 'rollback_outcome'

export type PublicationFailureCause =
  | 'stale_configuration_pins'
  | 'authority_missing_or_mismatched'
  | 'canonical_ticket_or_decision_changed'
  | 'idempotency_key_reused'
  | 'concurrency_grant_active'
  | 'interrupted_grant_pending_reconciliation'
  | 'pre_enqueue_binding_serialization_failed'
  | 'worker_launch_process_failed'
  | 'stage_execution_failed'
  | 'execution_interrupted_unknown_outcome'
  | 'rollback_completed'
  | 'rollback_failed'
  | 'before_effect_rejected'

export function sanitizeDiagnosticMessage(message: unknown): string {
  if (typeof message !== 'string') message = message instanceof Error ? message.message : String(message ?? '')
  let text = (message as string).trim()
  if (!text) return 'Unknown error'
  text = text.replace(/:\/\/[^/:]+:[^/@]+@/g, '://[REDACTED_CREDENTIALS]@')
  text = text.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|Bearer\s+[A-Za-z0-9\-._~+/]+=*|sk-[a-zA-Z0-9]{20,}|key-[a-zA-Z0-9]{16,})\b/gi, '[REDACTED_SECRET]')
  text = text.replace(/((?:authorization|token|secret|password|api[_-]?key)\s*[:=]\s*)(["'])(?:(?!\2)[\s\S])*?\2/gi, '$1$2[REDACTED]$2')
  text = text.replace(/((?:authorization|token|secret|password|api[_-]?key)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;"']+/gi, '$1[REDACTED]')
  text = text.replace(/(\b(?:raw\s+provider\s+response|raw\s+response|provider\s+response|payload|body|data)\s*:\s*)(\{[\s\S]*?\}|\[[\s\S]*?\])/gi, '$1[REDACTED_PAYLOAD]')
  text = text.replace(/\{[^{}]*\}/g, '[REDACTED_PAYLOAD]')
  text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi, '[REDACTED_EMAIL]')
  text = text.replace(/(?:customer(?:Email|Id|Name)?|private(?:Content)?|content)\s*[:=]\s*(?:["'][^"']*["']|[^\s,;}]+)/gi, '[REDACTED_CONTENT]')
  if (text.length > 500) text = text.slice(0, 497) + '...'
  return text
}

const ALLOWED_STAGE_DETAILS = new Set([
  'merge', 'apply', 'build', 'restart', 'verify', 'rollback',
  'merge succeeded', 'merge complete', 'merge failed',
  'apply succeeded', 'apply complete', 'apply failed',
  'build succeeded', 'build complete', 'build failed', 'Build failed',
  'restart succeeded', 'restart complete', 'restart failed',
  'verify succeeded', 'verify complete', 'verify failed',
  'rollback completed clean', 'rollback succeeded', 'rollback complete', 'rollback failed',
])

export function safeStageDetail(raw: unknown, stage: PublicationStage, status: 'succeeded' | 'failed', category?: PublicationFailureCategory, operationId?: string): string {
  const str = typeof raw === 'string' ? raw.trim() : (raw instanceof Error ? raw.message.trim() : '')
  if (str && ALLOWED_STAGE_DETAILS.has(str)) return str
  if (status === 'succeeded') return `${stage}: succeeded${operationId ? ` [op=${operationId}]` : ''}`
  return `${stage}: failed${category ? ` (${category})` : ''}${operationId ? ` [op=${operationId}]` : ''}`
}

export function classifyPublicationError(error: unknown): {
  category: PublicationFailureCategory
  status: number
  cause: PublicationFailureCause
  message: string
} {
  const msg = error instanceof Error ? error.message : String(error ?? '')
  const status = error instanceof PublicationError ? error.status : 500
  let category: PublicationFailureCategory = 'before_effect_rejection'
  let cause: PublicationFailureCause = 'before_effect_rejected'

  if (/stale|changed|mismatch/i.test(msg) && /pins|configuration|manifest|card|review/i.test(msg)) {
    category = 'stale_pins'
    cause = 'stale_configuration_pins'
  } else if (/idempotency|reused/i.test(msg)) {
    category = 'idempotency_conflict'
    cause = 'idempotency_key_reused'
  } else if (/binding|capture|pre-enqueue/i.test(msg)) {
    category = 'pre_enqueue_binding_failed'
    cause = 'pre_enqueue_binding_serialization_failed'
  } else if (/authority|permission|forbidden|approval/i.test(msg) && !/ticket/i.test(msg)) {
    category = 'authority_mismatch'
    cause = 'authority_missing_or_mismatched'
  } else if (/canonical|ticket/i.test(msg)) {
    category = 'canonical_ticket_changed'
    cause = 'canonical_ticket_or_decision_changed'
  } else if (/interrupted.*reconciliation/i.test(msg)) {
    category = 'concurrency_blocked'
    cause = 'interrupted_grant_pending_reconciliation'
  } else if (/in progress|interrupted|unsettled|locked|busy/i.test(msg)) {
    category = 'concurrency_blocked'
    cause = 'concurrency_grant_active'
  } else if (/worker launch/i.test(msg)) {
    category = 'worker_launch_failed'
    cause = 'worker_launch_process_failed'
  }
  const message = `${category}: ${cause}`
  return { category, status, cause, message }
}

export interface PublicationOutcome {
  stage: PublicationStage; operationId: string; status: 'running' | 'succeeded' | 'failed' | 'interrupted'
  startedAt: string; finishedAt?: string; detail?: string
  category?: PublicationFailureCategory
}
export interface PublicationAudit {
  at: string; event: string; detail: string; requestId?: string; actorId?: string; authorityKind?: PublicationAuthority['kind']
  phase?: PublicationDiagnosticPhase
  category?: PublicationFailureCategory
  cause?: PublicationFailureCause | string
}
export interface PublicationSnapshot extends PublicationPrepareInput {
  id: string
  status: 'prepared' | 'merged' | 'published' | 'rolled_back' | 'blocked' | 'failed' | 'interrupted'
  createdAt: string; updatedAt: string
  evidence?: PublicationEvidence
  outcomes: PublicationOutcome[]
  audit: PublicationAudit[]
  requests: Record<string, { action: PublicationAction; actorId: string }>
  coordination?: PublicationCoordination
}
export interface PublicationCoordination {
  grantId: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'expired'
  createdAt: string; updatedAt: string; detail?: string
}
export interface PublicationWorkerGrant extends PublicationCoordination {
  publicationId: string; ticketId: string; conversationId: string; requestId: string; action: 'publish' | 'rollback'
  pins: PublicationPins; actorId: string; authorityKind: PublicationAuthority['kind']; manifestSha256: string
  expiresAt: string; ticketBinding: unknown; claimedAt?: string; finishedAt?: string
  ownerPid?: number; ownerIdentity?: string; settledAt?: string; reconciliation?: { at: string; actorId: string; detail: string; sourceProof?: PublicationInstructionProof }
  processGroups?: { pid: number; startIdentity?: string; stage: PublicationStage | 'evidence'; startedAt: string; settledAt?: string }[]
  sourceProof?: PublicationInstructionProof
}
export interface PublicationDocument {
  version: 1; publications: Record<string, PublicationSnapshot>; tickets: Record<string, string>
  workerGrants?: Record<string, PublicationWorkerGrant>
}
/** exclusive must serialize ALL tickets across processes for the whole asynchronous operation. save must durably commit before returning. */
export interface PublicationPersistence {
  exclusive<T>(work: () => Promise<T>): Promise<T>
  load(): PublicationDocument
  /** Optional lock-free read of the last atomically committed document, for progress polling while busy. */
  peek?(): PublicationDocument
  save(document: PublicationDocument): void
  onCompromised?(listener: (error: Error) => void): () => void
}
/** HTTP-compatible fail-closed conflict/authority error without executing publication effects. */
export class PublicationError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'PublicationError' }
}
const samePins = (a: PublicationPins, b: PublicationPins) => a.repository === b.repository && a.prNumber === b.prNumber && a.headSha === b.headSha && a.patchSha256 === b.patchSha256
const clone = <T>(value: T): T => structuredClone(value)
const validKey = (s: string) => typeof s === 'string' && s.length > 0 && s.length <= 512 && s !== 'prototype' && !Object.hasOwn(Object.prototype, s)

/** Serialized exact-pin orchestration with write-ahead outcomes, explicit authority and conservative recovery. */
export class PublicationService {
  private readonly now: () => number
  private readonly freshnessMs: number
  constructor(private readonly options: { store: PublicationPersistence; adapter: PublicationAdapter; now?: () => number; freshnessMs?: number; signal?: AbortSignal; workerGrantId?: string; evidenceRetryDelayMs?: number }) {
    this.now = options.now ?? Date.now
    this.freshnessMs = options.freshnessMs ?? 60_000
    if (!(this.freshnessMs > 0 && this.freshnessMs <= 300_000)) throw new Error('Freshness must be between 0 and 300000 ms')
  }
  private at() { return new Date(this.now()).toISOString() }
  private async transaction<T>(work: (d: PublicationDocument) => Promise<T>): Promise<T> {
    return this.options.store.exclusive(async () => {
      const d = this.options.store.load()
      let recovered = false
      for (const p of Object.values(d.publications)) for (const o of p.outcomes) if (o.status === 'running') {
        o.status = 'interrupted'; o.finishedAt = this.at(); o.detail = 'Process interrupted; outcome unknown. No automatic replay.'
        o.category = 'execution_interrupted'
        p.status = 'interrupted'; p.updatedAt = this.at()
        p.audit.push({ at: this.at(), event: 'interrupted', detail: `${o.stage}: outcome unknown; explicit reconciliation/rollback required`, phase: 'execution', category: 'execution_interrupted', cause: 'execution_interrupted_unknown_outcome' })
        recovered = true
      }
      if (recovered) this.options.store.save(d)
      return work(d)
    })
  }
  async snapshot(ticketId: string): Promise<PublicationSnapshot | undefined> {
    if (!validKey(ticketId)) throw new PublicationError(400, 'Invalid ticket id')
    const project = (d: PublicationDocument) => { const id = d.tickets[ticketId]; return id ? clone(d.publications[id]) : undefined }
    try { return await this.transaction(async d => project(d)) } catch (error) {
      // Never mistake a live owner's write-ahead record for an interrupted process.
      if (error instanceof PublicationError && error.status === 409 && this.options.store.peek) return project(this.options.store.peek())
      throw error
    }
  }
  /**
   * Pure, lock-free advice read of the last atomically committed publication. Unlike snapshot() it never recovers running
   * outcomes, saves, appends audit or waits for the publication lock; unavailable or malformed state reads as unknown.
   */
  peek(ticketId: string): PublicationSnapshot | undefined {
    if (!validKey(ticketId)) throw new PublicationError(400, 'Invalid ticket id')
    try {
      const document = this.options.store.peek?.()
      const id = document?.tickets?.[ticketId]
      const candidate = id ? document!.publications[id] : undefined
      if (!candidate || typeof candidate !== 'object') return undefined
      if (!validKey(String(candidate.id ?? '')) || !validKey(String(candidate.repository ?? '')) || !Number.isSafeInteger(candidate.prNumber)
        || typeof candidate.headSha !== 'string' || !/^[a-f0-9]{40}$/i.test(candidate.headSha)
        || typeof candidate.patchSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.patchSha256)
        || typeof candidate.ticketId !== 'string' || candidate.ticketId !== ticketId) return undefined
      return clone(candidate)
    } catch { return undefined }
  }
  async prepare(input: PublicationPrepareInput): Promise<PublicationSnapshot> {
    if (!validKey(input.ticketId) || !validKey(input.conversationId) || !/^[\w.-]+\/[\w.-]+$/.test(input.repository)
      || !Number.isSafeInteger(input.prNumber) || input.prNumber < 1 || !/^[a-f0-9]{40}$/i.test(input.headSha) || !/^[a-f0-9]{64}$/i.test(input.patchSha256)) throw new PublicationError(400, 'Invalid publication binding or pins')
    return this.transaction(async d => {
      if (Object.values(d.workerGrants ?? {}).some(g => g.ticketId === input.ticketId && ['queued', 'running'].includes(g.status))) throw new PublicationError(409, 'Approved external publication is in progress')
      const oldId = d.tickets[input.ticketId], old = oldId ? d.publications[oldId] : undefined
      if (old) {
        if (old.conversationId === input.conversationId && samePins(old, input)) {
          if (!['published', 'rolled_back'].includes(old.status) && !old.outcomes.some(o => ['failed', 'interrupted'].includes(o.status))) {
            if (await this.gate(old, 'prepare', d)) old.status = old.outcomes.some(o => o.stage === 'merge' && o.status === 'succeeded') ? 'merged' : 'prepared'
            old.updatedAt = this.at(); this.options.store.save(d)
          }
          return clone(old)
        }
        if (old.outcomes.length && !['published', 'rolled_back'].includes(old.status)) throw new PublicationError(409, 'Previous publication has unresolved side effects; reconcile before repinning')
        // Safe new canonical decision/release: archive the old immutable binding and its entire audit trail.
      }
      const p: PublicationSnapshot = { ...input, id: randomUUID(), status: 'prepared', createdAt: this.at(), updatedAt: this.at(), outcomes: [], audit: [], requests: {} }
      p.audit.push({ at: this.at(), event: 'prepared', detail: 'Pinned repository, PR, head and sha256 patch; no authority granted', phase: 'validation' })
      d.publications[p.id] = p; d.tickets[p.ticketId] = p.id
      await this.gate(p, 'prepare', d)
      this.options.store.save(d)
      return clone(p)
    })
  }
  private trackProcesses(d: PublicationDocument, stage: PublicationStage | 'evidence') {
    const tracked: NonNullable<PublicationWorkerGrant['processGroups']> = []
    const onSpawn = this.options.workerGrantId ? (pid: number) => {
      const g = d.workerGrants?.[this.options.workerGrantId!]
      if (!g || g.status !== 'running' || !Number.isSafeInteger(pid) || pid < 1) throw new Error('Cannot durably fence publication subprocess')
      const startIdentity = publicationProcessIdentity(pid)
      if (!startIdentity) throw new Error('Cannot identify publication subprocess start identity before command gate')
      const processGroup = { pid, startIdentity, stage, startedAt: this.at() }
      ;(g.processGroups ??= []).push(processGroup); tracked.push(processGroup)
      this.options.store.save(d) // executor MUST await this synchronous journal before releasing command startup gate
    } : undefined
    return { onSpawn, settled: () => {
      if (!tracked.length) return
      for (const group of tracked) group.settledAt = this.at()
      this.options.store.save(d) // adapter promise settles only after process-group TERM/KILL cleanup
    } }
  }
  private async gate(p: PublicationSnapshot, action: PublicationAction | 'prepare', d: PublicationDocument): Promise<boolean> {
    const propagatingMerge = action === 'publish' && p.outcomes.some(o => o.stage === 'merge' && o.status === 'succeeded')
    const attempts = propagatingMerge ? 4 : 1
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const processes = this.trackProcesses(d, 'evidence')
      let received = false
      try {
        this.options.signal?.throwIfAborted()
        const e = await this.options.adapter.evidence({ repository: p.repository, prNumber: p.prNumber, headSha: p.headSha, patchSha256: p.patchSha256 }, this.options.signal, processes.onSpawn)
        received = true
        this.options.signal?.throwIfAborted()
        p.evidence = clone(e)
        const age = this.now() - Date.parse(e.observedAt)
        if (!samePins(p, e)) throw new Error('Repository/PR/head/patch changed')
        if (!Number.isFinite(age) || age < -1000 || age > this.freshnessMs) throw new Error('Evidence is not fresh')
        const pendingPropagation = e.state === 'open' || e.checks === 'pending'
        if (propagatingMerge && pendingPropagation && e.checks !== 'failed' && e.review !== 'changes_requested' && attempt < attempts) {
          p.audit.push({ at: this.at(), event: 'evidence_retry', detail: `Waiting for merged/check propagation (${attempt}/${attempts}); no mutation replay` })
        } else {
          if (e.checks !== 'passed' || e.review !== 'approved' || e.state === 'closed' || (e.state === 'open' && !e.mergeable)) throw new Error('Checks, review or mergeability gate failed')
          if (action === 'merge' && e.state !== 'open') throw new Error('PR is no longer open')
          if (action === 'publish' && e.state !== 'merged') throw new Error('Publish requires the pinned PR to be merged')
          p.audit.push({ at: this.at(), event: 'gates_passed', detail: `Fresh ${action} evidence for pinned head and patch` })
          return true
        }
      } catch (error) {
        if (!received && propagatingMerge && !this.options.signal?.aborted && attempt < attempts) {
          p.audit.push({ at: this.at(), event: 'evidence_retry', detail: `Transient post-merge read (${attempt}/${attempts}): ${error instanceof Error ? error.message : String(error)}` })
        } else {
          p.status = 'blocked'; p.updatedAt = this.at()
          p.audit.push({ at: this.at(), event: 'gates_blocked', detail: error instanceof Error ? error.message : String(error) })
          return false
        }
      } finally { processes.settled() }
      const retryDelay = Math.max(0, Math.min(this.options.evidenceRetryDelayMs ?? 250, 1000)) * attempt
      await new Promise<void>(resolve => setTimeout(resolve, retryDelay))
    }
    return false
  }
  async act(input: PublicationActInput, authority: PublicationAuthority): Promise<PublicationSnapshot> {
    if (!validKey(input.requestId) || !validKey(input.ticketId) || !validKey(input.conversationId) || !validKey(input.publicationId) || !['merge', 'publish', 'rollback'].includes(input.action)) throw new PublicationError(400, 'Invalid action or request id')
    return this.transaction(async d => {
      const p = d.publications[input.publicationId]
      if (!p || d.tickets[input.ticketId] !== p.id) throw new PublicationError(404, 'Publication not found')
      if (p.ticketId !== input.ticketId || p.conversationId !== input.conversationId) throw new PublicationError(403, 'Publication conversation binding mismatch')
      if (!authority || authority.authorized !== true || !['human_click', 'operator_instruction'].includes(authority.kind) || !validKey(authority.actorId)
        || authority.ticketId !== p.ticketId || authority.conversationId !== p.conversationId || authority.publicationId !== p.id || authority.action !== input.action) {
        p.audit.push({ at: this.at(), event: 'authority_denied', detail: 'Missing explicit bound human/operator authority', requestId: input.requestId, phase: 'validation', category: 'authority_mismatch', cause: 'authority_missing_or_mismatched' })
        this.options.store.save(d)
        throw new PublicationError(403, 'Explicit bound human/operator authority required')
      }
      if (Object.values(d.workerGrants ?? {}).some(g => g.status === 'interrupted' && !g.settledAt)) throw new PublicationError(409, 'Unknown coordinator descendants require explicit operator reconciliation before ANY effects, including rollback')
      const activeGrant = Object.values(d.workerGrants ?? {}).find(g => ['queued', 'running'].includes(g.status))
      if (activeGrant) {
        const expectedRequest = input.action === 'merge' ? `${activeGrant.requestId}:merge` : activeGrant.requestId
        if (activeGrant.status !== 'running' || authority.workerGrantId !== activeGrant.grantId || activeGrant.publicationId !== p.id
          || activeGrant.actorId !== authority.actorId || activeGrant.authorityKind !== authority.kind || !samePins(activeGrant.pins, p)
          || input.requestId !== expectedRequest || (activeGrant.action === 'rollback' ? input.action !== 'rollback' : !['merge', 'publish'].includes(input.action))) {
          throw new PublicationError(409, 'Publication is reserved for its detached coordinator grant')
        }
      } else if (authority.workerGrantId) throw new PublicationError(403, 'Worker grant is no longer active')
      const previous = p.requests[input.requestId]
      if (previous) {
        if (previous.action !== input.action || previous.actorId !== authority.actorId) throw new PublicationError(409, 'Idempotency key reused for another action or actor')
        return clone(p)
      }
      const unresolved = Object.values(d.publications).find(other => other.id !== p.id && other.status !== 'rolled_back' && (
        other.outcomes.some(o => o.status === 'failed' || o.status === 'interrupted')
        || other.outcomes.some(o => o.stage === 'apply' && o.status === 'succeeded') && !other.outcomes.some(o => o.stage === 'verify' && o.status === 'succeeded')
      ))
      if (unresolved && input.action !== 'rollback') throw new PublicationError(409, `Publication ${unresolved.id} requires reconciliation/rollback before another publication can operate`)
      if (input.action !== 'rollback' && (p.status === 'interrupted' || p.outcomes.some(o => o.status === 'failed' || o.status === 'interrupted'))) throw new PublicationError(409, 'Uncertain/failed operation requires explicit rollback; no automatic replay')
      if (p.status === 'rolled_back') throw new PublicationError(409, 'Publication was rolled back')
      if (input.action === 'rollback' && !p.outcomes.some(o => o.stage !== 'rollback')) throw new PublicationError(409, 'Nothing to roll back')
      if (input.action === 'rollback' && p.outcomes.some(o => o.stage === 'rollback')) throw new PublicationError(409, 'Rollback already attempted; reconcile its outcome before any further operation')
      p.requests[input.requestId] = { action: input.action, actorId: authority.actorId }
      p.audit.push({ at: this.at(), event: 'authorized', detail: input.action, requestId: input.requestId, actorId: authority.actorId, authorityKind: authority.kind, phase: 'confirmation' })
      this.options.store.save(d)
      const stages: PublicationStage[] = input.action === 'publish' ? ['apply', 'build', 'restart', 'verify'] : [input.action]
      for (const stage of stages) {
        if (p.outcomes.some(o => o.stage === stage && o.status === 'succeeded')) continue
        // Rollback must remain available when repository checks/head are broken.
        if (input.action !== 'rollback' && !await this.gate(p, input.action, d)) { this.options.store.save(d); return clone(p) }
        if (authority.isCurrent && !authority.isCurrent()) {
          p.status = 'blocked'; p.updatedAt = this.at()
          p.audit.push({ at: this.at(), event: 'authority_invalidated', detail: 'Canonical ticket/decision changed before effect', requestId: input.requestId, phase: 'execution', category: 'canonical_ticket_changed', cause: 'canonical_ticket_or_decision_changed' })
          this.options.store.save(d); return clone(p)
        }
        const o: PublicationOutcome = { stage, operationId: `${p.id}:${stage}`, status: 'running', startedAt: this.at() }
        p.outcomes.push(o); p.updatedAt = this.at()
        p.audit.push({ at: this.at(), event: 'stage_started', detail: stage, requestId: input.requestId, phase: 'execution' })
        this.options.store.save(d) // write-ahead: a crash from here is unknown, NEVER blindly retried
        const processes = this.trackProcesses(d, stage)
        try {
          this.options.signal?.throwIfAborted()
          const result = await this.options.adapter.perform(stage, { repository: p.repository, prNumber: p.prNumber, headSha: p.headSha, patchSha256: p.patchSha256 }, o.operationId, this.options.signal, processes.onSpawn)
          this.options.signal?.throwIfAborted()
          o.status = 'succeeded'
          if (stage === 'rollback') o.category = 'rollback_outcome'
          o.detail = safeStageDetail(result.detail, stage, 'succeeded', o.category, o.operationId)
        } catch (error) {
          o.status = 'failed'
          o.category = stage === 'rollback' ? 'rollback_outcome' : 'stage_failed'
          o.detail = safeStageDetail(error, stage, 'failed', o.category, o.operationId)
          p.status = 'failed'
        }
        finally { processes.settled() }
        o.finishedAt = this.at(); p.updatedAt = this.at()
        p.audit.push({
          at: this.at(),
          event: `stage_${o.status}`,
          detail: `${stage}: ${o.status === 'succeeded' ? 'succeeded' : 'failed'} [op=${o.operationId}]`,
          requestId: input.requestId,
          phase: 'execution',
          category: o.status === 'failed' ? (stage === 'rollback' ? 'rollback_outcome' : 'stage_failed') : (stage === 'rollback' ? 'rollback_outcome' : undefined),
          cause: o.status === 'failed' ? (stage === 'rollback' ? 'rollback_failed' : 'stage_execution_failed') : (stage === 'rollback' ? 'rollback_completed' : undefined),
        })
        if (o.status === 'succeeded') {
          if (stage === 'merge') p.status = 'merged'
          if (stage === 'verify') p.status = 'published'
          if (stage === 'rollback') p.status = 'rolled_back'
        }
        this.options.store.save(d)
        if (o.status !== 'succeeded') break
      }
      return clone(p)
    })
  }
}
