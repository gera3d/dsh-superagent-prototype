/** Runtime integration and the single projection consumed by Conversation, Decisions and Workstream. */
import type { PendingDecisionItem } from '../core/decision.ts'
import type { Ticket } from '../core/model.ts'
import { publicationCompleted } from '../core/publication-queue.ts'
import { DeliveryConflict, DeliveryCoordinator, DeliveryStore, deliveryFingerprint, sameDeliveryRefs, type Delivery, type DeliveryAction, type DeliveryCapabilityAdapters } from './feature-delivery.ts'
import type { LifecyclePublication } from './lifecycle-publication.ts'
import { publicationConversation } from './lifecycle-publication.ts'
import { ticketDecisions, type DecisionInbox } from './decision-inbox.ts'
import type { Store } from './store.ts'
import type { FindingStore } from './finding.ts'
import { deriveDeliveryWork, readDeliveryWorkers, workerTicket } from './delivery-currency.ts'
import { publicationProof, snapshotProof } from './publication-proof.ts'

export function deliveryDecision(delivery: Delivery): PendingDecisionItem {
  const action = delivery.work?.state === 'superseded' ? undefined : delivery.nextAction
  const model = action && delivery.recommendation?.actionId === action.id && delivery.recommendation.kind === action.kind && delivery.recommendation.fingerprint === action.fingerprint ? delivery.recommendation : undefined
  const terminal = ['accepted', 'cancelled', 'abandoned'].includes(delivery.state)
  return {
    id: `delivery-${delivery.id}`, ticketId: delivery.workers[0],
    ...(delivery.workers[0] ? { sessionId: `worker-${delivery.workers[0]}` } : {}),
    ticketTitle: delivery.title, trigger: 'Durable feature delivery',
    status: delivery.work?.state === 'superseded' ? 'stale' : terminal ? 'resolved' : 'pending', actionMode: 'feature_delivery', delivery,
    ...(delivery.work?.state === 'superseded' ? { staleReason: delivery.work.nextStep } : {}),
    urgency: delivery.state === 'blocked' ? 'medium' : 'low',
    createdAt: Date.parse(delivery.audit[0]?.at ?? '') || 0,
    context: delivery.work ? `${delivery.work.state}; owner: ${delivery.work.owner}; ${delivery.work.progress ?? ''} ${delivery.work.nextStep}` : delivery.blocker ?? `${delivery.stage}: ${delivery.state}; owner: ${delivery.owner}`,
    question: delivery.work?.nextStep ?? delivery.blocker ?? action?.label ?? `${delivery.stage}: ${delivery.state}`,
    choices: action ? [{ id: action.id, label: action.label, actionKind: 'lifecycle' }] : [],
    recommendation: { recommendedValue: model?.disposition === 'take' ? model.actionId : '', confidence: 0,
      rationale: model?.rationale ?? delivery.recommendationError?.message ?? (action ? 'Eligible action; Senior Developer advice is not available.' : 'No executable action is currently available.'),
      distribution: [], provider: model?.provider ?? 'Not evaluated', latencyMs: 0 },
  }
}

/** Only source-empty generated advice is retired, never a real unresolved chat question. */
export function reconcileDeliveryAdvice(items: PendingDecisionItem[], deliveries: Delivery[] = []): PendingDecisionItem[] {
  const settled = new Map<string, number>()
  for (const delivery of deliveries) {
    if (delivery.stage === 'implementation') continue
    const time = Math.max(0, ...delivery.evidence.filter(e => deliveryFingerprint(e.bindings) === deliveryFingerprint(delivery.bindings) && (e.generation ?? 0) === delivery.generation && (['review', 'publication', 'verification', 'rollback'].includes(e.kind) || (e.kind === 'implementation' && delivery.audit.some(a => a.event.startsWith('backfill:'))))).map(e => Date.parse(e.recordedAt) || 0))
    for (const worker of delivery.workers) if (time) settled.set(`worker-${worker}`, Math.max(time, settled.get(`worker-${worker}`) ?? 0))
  }
  for (const item of items) {
    const publication = item.lifecycle?.publication
    if (!item.sessionId || !publication || !publicationCompleted(item)) continue
    const time = Math.max(...publication.outcomes.map(o => Date.parse(o.finishedAt ?? o.startedAt ?? '') || 0), 0)
    if (time) settled.set(item.sessionId, Math.max(time, settled.get(item.sessionId) ?? 0))
  }
  return items.map(item => {
    if (item.status !== 'pending' || !item.id.startsWith('chat-') || !item.advisor?.key || item.context.trim()
      || item.question !== 'Choose the next step for this thread' || item.staging || !item.sessionId
      || !(item.createdAt <= (settled.get(item.sessionId) ?? 0))) return item
    return { ...item, status: 'stale', staleReason: 'Generated advice is superseded by linked delivery progress or a settled publication attempt; retained as history, not current delivery authority.' }
  })
}

export function projectDeliveries(store: DeliveryStore, items: PendingDecisionItem[]): PendingDecisionItem[] {
  const stored = store.list()
  const work = deriveDeliveryWork(stored, readDeliveryWorkers(store.db))
  const deliveries = stored.map(delivery => ({ ...delivery, work: delivery.workers.map(worker => work.get(workerTicket(worker))).find(Boolean) }))
  const ids = new Set(deliveries.map(d => `delivery-${d.id}`))
  const workers = new Set(deliveries.flatMap(d => d.workers))
  return [...reconcileDeliveryAdvice(items, deliveries).filter(i => !ids.has(i.id)
    && !(i.lifecycle && !i.lifecycle.publication && i.status === 'pending' && i.ticketId && workers.has(i.ticketId))), ...deliveries.map(deliveryDecision)]
}

/** Persist currency before any canonical producer/lookup or native staging can use old advice. */
export function reconcileInboxCurrency(inbox: DecisionInbox, deliveries: DeliveryStore, publication?: LifecyclePublication, findings?: FindingStore): void {
  const original = inbox.list()
  const recorded = deliveries.list()
  // An accepted delivery is authoritative completion, unlike a worker report, merged PR or resolved finding.
  // Retire only advice from before acceptance. Later user conversations and newly active work remain usable.
  for (const item of original) {
    if (item.status !== 'pending' || !item.canonical || !item.sessionId || !Number.isFinite(item.createdAt)) continue
    const linked = recorded.filter(delivery => delivery.workers.some(worker => workerTicket(worker) === workerTicket(item.sessionId!)))
    if (linked.some(delivery => !['accepted', 'cancelled', 'abandoned'].includes(delivery.state))) continue
    const completed = linked.filter(delivery => delivery.state === 'accepted' && delivery.acceptance
      && Number.isFinite(Date.parse(delivery.acceptance.at)) && item.createdAt <= Date.parse(delivery.acceptance.at))
      .sort((a, b) => Date.parse(b.acceptance!.at) - Date.parse(a.acceptance!.at))[0]
    if (completed) inbox.invalidate(item, `Work completed: delivery ${completed.id} was verified and accepted at ${completed.acceptance!.at}. No further release action is needed; earlier recommendations are retained as history.`)
  }
  const work = deriveDeliveryWork(recorded, readDeliveryWorkers(deliveries.db))
  const findingWorkers = new Map<string, string>()
  for (const finding of findings?.list() ?? []) {
    for (const job of [finding.job, ...(finding.priorJobs ?? [])]) if (job?.ticketId) {
      const ticket = job.ticketId.replace(/^worker-/, '')
      findingWorkers.set(ticket, finding.id)
    }
  }
  const projected = reconcileDeliveryAdvice(publication?.project?.(original) ?? original, deliveries.list()).map(item => {
    const finding = item.sessionId && findingWorkers.get(item.sessionId.replace(/^worker-/, ''))
    const owned = item.sessionId && work.get(workerTicket(item.sessionId))
    if ((!finding && !owned) || item.status !== 'pending' || !item.id.startsWith('chat-') || !item.advisor?.key || item.context.trim()
      || item.question !== 'Choose the next step for this thread' || item.staging) return item
    return { ...item, status: 'stale' as const, staleReason: finding
      ? `Generic generated advice is superseded by canonical finding ${finding}; retained as history, not execution authority.`
      : `Generic generated advice is superseded by current delivery owner ${owned && owned.owner}. ${owned && owned.nextStep}` }
  })
  for (const item of projected) {
    if (item.status !== 'stale' || !item.staleReason) continue
    const stored = inbox.get(item.id)
    if (stored?.status === 'pending' && !stored.staging) inbox.invalidate(stored, item.staleReason)
  }
}

export interface DeliveryRuntimeOptions {
  lifetime?: AbortSignal
  publication?: LifecyclePublication
  recommend?: (delivery: Delivery, action: DeliveryAction) => Promise<NonNullable<Delivery['recommendation']>>
}

/** Owns bounded delivery passes independently of the worker-ticket lifecycle. */
export class FeatureDeliveryRuntime {
  readonly store: DeliveryStore
  readonly coordinator: DeliveryCoordinator
  private running?: Promise<void>
  private stopped = false
  private readonly stopping = new AbortController()
  readonly signal: AbortSignal
  constructor(readonly tickets: Pick<Store, 'db' | 'tickets'>, capabilities: DeliveryCapabilityAdapters = {}, private readonly options: DeliveryRuntimeOptions = {}) {
    this.signal = options.lifetime ? AbortSignal.any([options.lifetime, this.stopping.signal]) : this.stopping.signal
    this.store = new DeliveryStore(tickets.db)
    this.coordinator = new DeliveryCoordinator(this.store, {
      implement: {
        execute: async lease => {
          const delivery = this.store.get(lease.deliveryId)!
          const workers = delivery.workers.map(id => tickets.tickets.get(id))
          if (!workers.length || workers.some(ticket => !ticket || !workerReady(ticket))) return { outcome: 'failed', blocker: 'Implementation workers have not all recorded a ready report; worker completion is not feature acceptance.' }
          return { outcome: 'passed', evidence: workers.map(ticket => {
            const assignment = ticket!.assignments.at(-1)!
            return { id: `worker-report:${ticket!.id}:${assignment.id}:${assignment.report!.at}`, kind: 'implementation' as const,
              bindings: lease.bindings, recordedAt: assignment.report!.at,
              reference: `ticket/${ticket!.id}/report/${assignment.id}`, outcome: 'passed' as const }
          }) }
        },
        // This adapter only reads durable reports; restart reconciliation performs the same safe read.
        reconcile: async lease => this.coordinator.capabilities.implement!.execute(lease),
      }, ...capabilities,
    })
  }
  project(items: PendingDecisionItem[]): PendingDecisionItem[] {
    return projectDeliveries(this.store, items)
  }
  /** A bounded pass; wakeups coalesce rather than concurrently dispatching the same handoff. */
  request(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return this.running ??= this.pass().finally(() => { this.running = undefined })
  }
  private synchronizeWorkers(): void {
    for (const delivery of this.store.list()) {
      if (['accepted', 'cancelled', 'abandoned'].includes(delivery.state)) continue
      const workers = delivery.workers.map(id => this.tickets.tickets.get(id))
      if (delivery.scopeBinding) {
        const blockedWorker = workers.find(ticket => ticket && (ticket.attention || ['blocked', 'failed'].includes(ticket.assignments.at(-1)?.report?.state ?? '')))
        const implementationReady = workers.some(ticket => ticket && (workerReady(ticket) || ticket.ended?.outcome === 'merged'))
        const finished = implementationReady || workers.some(ticket => ticket?.ended)
        const state = finished || blockedWorker ? 'blocked' : 'running'
        const stage = implementationReady ? 'review' : 'implementation'
        const blocker = blockedWorker ? blockedWorker.attention?.question ?? blockedWorker.assignments.at(-1)?.report?.summary ?? delivery.scopeBinding.reason
          : finished ? delivery.scopeBinding.reason : undefined
        if (delivery.state !== state || delivery.stage !== stage || delivery.blocker !== blocker) this.store.compareAndSwap(delivery.id, delivery.revision, d => {
          d.state = state; d.stage = stage
          if (blocker) d.blocker = blocker; else delete d.blocker
        })
        continue
      }
      if (delivery.stage !== 'implementation' || delivery.state === 'running' || ['cancelled', 'abandoned'].includes(delivery.state)) continue
      if (workers.length && workers.every(ticket => ticket && ticket.ended?.by !== 'human' && workerReady(ticket))) {
        const reports = workers.map(ticket => ({ ticket: ticket!.id, assignment: ticket!.assignments.at(-1)!.id, report: ticket!.assignments.at(-1)!.report! }))
        this.store.recordImplementation(delivery.id, delivery.revision, { id: `implementation:${deliveryFingerprint(reports)}`, kind: 'implementation',
          bindings: delivery.bindings, recordedAt: reports.map(r => r.report.at).sort().at(-1)!,
          reference: reports.map(r => `ticket/${r.ticket}/report/${r.assignment}`).join(', '), outcome: 'passed' })
      } else if (delivery.blocker !== 'Waiting for linked implementation reports; no new worker is started.') {
        this.store.compareAndSwap(delivery.id, delivery.revision, d => { d.state = 'blocked'; d.blocker = 'Waiting for linked implementation reports; no new worker is started.' })
      }
    }
  }
  private async prepareQualified(delivery: Delivery): Promise<void> {
    if (delivery.stage !== 'ready_to_publish' || delivery.state !== 'awaiting_decision' || delivery.preparedPublication) return
    const publication = this.options.publication
    if (!publication || !delivery.bindings.environment) throw new Error('No configured protected publication capability or explicit deployment target.')
    for (const worker of delivery.workers) {
      const ticket = this.tickets.tickets.get(worker)
      if (!ticket || ticket.ended) continue
      const item = ticketDecisions([ticket])[0]
      const ref = delivery.bindings.refs?.find(ref => ref.repository === delivery.bindings.repository && ref.headSha === delivery.bindings.headSha && ref.pr === item?.lifecycle?.prNumber)
      if (!item?.lifecycle || !ref) continue
      const pins = publication.pinsFor(ref.repository, ref.pr)
      if (!pins || pins.headSha !== ref.headSha) continue
      const scope = publication.scopeFor?.(ref.repository, ref.pr)
      if (!scope || scope.environment !== delivery.bindings.environment || !sameDeliveryRefs(delivery.bindings.refs, scope.refs)) {
        throw new Error('Trusted publication manifest does not prove the deployment target and every bound repository/PR head. No publication is authorized.')
      }
      const snapshot = await publication.service.prepare({ ...pins, ticketId: worker, conversationId: publicationConversation(item) })
      if (!['prepared', 'merged'].includes(snapshot.status)) throw new Error(`Configured publication is ${snapshot.status}; preserve its history and prepare a separately authorized finite scenario.`)
      this.signal.throwIfAborted()
      // Compact server-derived proof for advice: only evidence pinned to the same repository/PR/head/patch is recorded.
      const proof = publicationProof(snapshot.evidence, { repository: ref.repository, pr: ref.pr, headSha: pins.headSha, patchSha256: pins.patchSha256 })
      this.store.compareAndSwap(delivery.id, delivery.revision, d => {
        d.preparedPublication = { id: snapshot.id, ticketId: worker, decisionId: item.id, repository: ref.repository, pr: ref.pr,
          headSha: pins.headSha, patchSha256: pins.patchSha256, environment: scope.environment, preparedAt: snapshot.updatedAt,
          scopeSha256: scope.manifestSha256, components: scope.components, effects: scope.effects, refs: scope.refs, ...(proof ? { proof } : {}) }
        d.audit.push({ at: snapshot.updatedAt, event: 'prepared-existing-pinned-manifest', actor: 'delivery-runtime' })
      })
      return
    }
    throw new Error('No current active release owner and reviewed pinned manifest for these exact heads. No new release candidate was created.')
  }
  /**
   * Advice-only enrichment for cards prepared before proof was recorded: read the actual prepared publication snapshot and
   * accept only evidence for the exact recorded pins of that publication. The stored delivery, audit and action fingerprint stay untouched.
   */
  private async advise(delivery: Delivery): Promise<Delivery> {
    const prepared = delivery.preparedPublication
    const proof = await snapshotProof(prepared, this.options.publication)
    return proof && prepared ? { ...delivery, preparedPublication: { ...prepared, proof } } : delivery
  }
  private async abortable<T>(work: Promise<T>): Promise<T> {
    this.signal.throwIfAborted()
    let abort: () => void = () => {}
    const interrupted = new Promise<never>((_, reject) => { abort = () => reject(new Error('Delivery runtime stopped')); this.signal.addEventListener('abort', abort, { once: true }) })
    try { return await Promise.race([work, interrupted]) } finally { this.signal.removeEventListener('abort', abort) }
  }
  /** Explicit safe-read recovery; never resumes an uncertain mutation outbox. */
  recheck(id: string, revision: number): Delivery {
    return this.store.compareAndSwap(id, revision, d => {
      if (!d.preparation || d.state !== 'blocked' || d.blocker !== d.preparation.message) throw new DeliveryConflict('No unavailable preparation can be rechecked')
      delete d.preparation; delete d.blocker; d.state = 'awaiting_decision'
      d.audit.push({ at: new Date().toISOString(), event: 'preparation-recheck', actor: 'local-operator' })
    })
  }
  private async pass(): Promise<void> {
    this.synchronizeWorkers()
    // Coordinator adapters are typed deployment capabilities. Missing capabilities remain blockers.
    for (let count = 0; count < 16 && !this.stopped && !this.signal.aborted; count++) {
      if (!await this.coordinator.runOnce('runtime-delivery', this.signal)) break
    }
    for (const snapshot of this.store.list()) {
      if (this.signal.aborted) return
      let delivery = snapshot
      if (delivery.state === 'blocked' && delivery.preparation && delivery.blocker === delivery.preparation.message
        && delivery.preparation.attempts < 3 && (delivery.preparation.nextRetryAt ?? 0) <= Date.now()) {
        delivery = this.store.compareAndSwap(delivery.id, delivery.revision, d => { d.state = 'awaiting_decision'; delete d.blocker })
      }
      if (!delivery.nextAction) continue
      try { await this.abortable(this.prepareQualified(delivery)) }
      catch (error) {
        if (this.signal.aborted) return
        const current = this.store.get(delivery.id)!
        if (current.revision !== delivery.revision) continue
        const message = error instanceof Error ? error.message : String(error)
        this.store.compareAndSwap(current.id, current.revision, d => {
          d.state = 'blocked'; d.blocker = message
          const attempts = (d.preparation?.attempts ?? 0) + 1
          d.preparation = { fingerprint: delivery.nextAction!.fingerprint, message, attempts,
            ...(attempts < 3 ? { nextRetryAt: Date.now() + 5000 * 2 ** (attempts - 1) } : {}) }
        })
        continue
      }
      const current = this.store.get(delivery.id)!
      const action = current.nextAction
      const previous = current.recommendationError
      if (!action || current.recommendation || !this.options.recommend
        || (previous?.fingerprint === action.fingerprint && previous.kind === action.kind && (previous.attempts >= 3 || (previous.nextRetryAt ?? 0) > Date.now()))) continue
      try {
        // Pre-upgrade prepared cards have no recorded proof; enrich only the advice copy from the live exact-pin snapshot.
        const advice = await this.advise(current).catch(() => current)
        this.signal.throwIfAborted()
        const recommendation = await this.abortable(this.options.recommend(advice, action))
        this.signal.throwIfAborted()
        this.store.setRecommendation(current.id, current.revision, recommendation)
      } catch (error) {
        if (this.signal.aborted) return
        const latest = this.store.get(delivery.id)!
        if (latest.revision !== current.revision) continue
        // Advice is not an execution/approval gate. An unavailable model cannot veto a valid typed action.
        this.store.compareAndSwap(current.id, current.revision, d => {
          const attempts = previous?.fingerprint === action.fingerprint && previous.kind === action.kind ? previous.attempts + 1 : 1
          d.recommendationError = { kind: action.kind, fingerprint: action.fingerprint,
            message: error instanceof Error ? error.message : String(error), attempts,
            ...(attempts < 3 ? { nextRetryAt: Date.now() + 5000 * 2 ** (attempts - 1) } : {}) }
        })
      }
    }
  }
  async stop(): Promise<void> { this.stopped = true; this.stopping.abort(); await this.running }
}

export function workerReady(ticket: Ticket): boolean {
  return ticket.assignments.at(-1)?.report?.state === 'ready'
}
