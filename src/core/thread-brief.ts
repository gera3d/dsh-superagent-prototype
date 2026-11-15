/**
 * Thread Brief domain model and context adapter (Issue #216).
 *
 * Implements immutable verbatim original ask, explicitly unconfirmed inferred scope/criteria,
 * monotonic criterion ID allocation across batches, proposals, and history, staged proposals,
 * immutable isolated getters, revision history, evidence-backed status transitions, and prompt/continuation context generation.
 */
import { latestReport, type Ticket } from './model.ts'
import { ticketStage } from './stage.ts'

export type CriterionStatus = 'pending' | 'in_progress' | 'satisfied'

export type EvidenceType = 'test_result' | 'artifact' | 'observation'

export interface CriterionEvidence {
  type: EvidenceType
  reference: string
  summary: string
  recorded_at?: string
}

export interface ThreadBriefCriterion {
  id: string
  description: string
  status: CriterionStatus
  evidence?: CriterionEvidence
  is_inferred: boolean
  confirmed: boolean
}

export interface ThreadBriefScopeItem {
  text: string
  is_inferred: boolean
  confirmed: boolean
}

export interface ThreadBriefProposal {
  proposal_id: string
  description: string
  proposed_by: string
  timestamp: string
  status: 'pending' | 'accepted' | 'rejected'
  added_scope?: ThreadBriefScopeItem[]
  added_criteria?: ThreadBriefCriterion[]
}

export interface FallbackEventItem {
  timestamp?: string
  requested_model: string
  substituted_model: string
  reason: string
  attempt_count?: number
}

export interface ModelContext {
  current_model: string
  fallback_events?: FallbackEventItem[]
}

export interface ThreadBriefRevision {
  revision_id: number
  objective: string
  scope: ThreadBriefScopeItem[]
  criteria: ThreadBriefCriterion[]
  created_at: string
  confirmed_by: string
}

export interface ThreadBriefState {
  thread_id: string
  ticket_id?: string
  raw_original_ask: string
  objective: string
  current_state: string
  next_action: string
  task_status: 'open' | 'closed'
  revision_id: number
  criteria: ThreadBriefCriterion[]
  scope: ThreadBriefScopeItem[]
  pending_proposals: ThreadBriefProposal[]
  revision_history: ThreadBriefRevision[]
  model_context?: ModelContext
}

export interface ThreadBriefView {
  thread_id: string
  ticket_id?: string
  raw_original_ask: string
  revision_id: number
  objective: string
  current_state: string
  next_action: string
  task_status: 'open' | 'closed'
  criteria: ThreadBriefCriterion[]
  scope: ThreadBriefScopeItem[]
  pending_proposals: ThreadBriefProposal[]
  model_context: ModelContext
}

/** Owns an isolated brief revision, its proposals, evidence and continuation context. */
export class ThreadBriefManager {
  private state: ThreadBriefState

  constructor(initialState: ThreadBriefState) {
    this.state = JSON.parse(JSON.stringify(initialState))
  }

  /**
   * Factory creating a brief from a user request.
   * Preserves raw_original_ask verbatim without trimming or stripping.
   * Marks all inferred items as unconfirmed.
   * Does NOT fabricate model routes when genuine model context is unavailable.
   */
  static fromRequest(params: {
    thread_id: string
    ticket_id?: string
    raw_request: string
    objective?: string
    inferred_scope?: string[]
    inferred_criteria?: string[]
    model_context?: ModelContext
  }): ThreadBriefManager {
    const raw_original_ask = params.raw_request // Preserved verbatim, no .trim()

    let nextId = 1
    const criteria: ThreadBriefCriterion[] = (params.inferred_criteria || []).map(desc => ({
      id: `CRIT-${nextId++}`,
      description: desc,
      status: 'pending',
      is_inferred: true,
      confirmed: false,
    }))

    const scope: ThreadBriefScopeItem[] = (params.inferred_scope || []).map(text => ({
      text,
      is_inferred: true,
      confirmed: false,
    }))

    const defaultObjective = params.objective || (params.raw_request.trim().split('\n')[0] || 'Unspecified task')

    return new ThreadBriefManager({
      thread_id: params.thread_id,
      ticket_id: params.ticket_id,
      raw_original_ask,
      objective: defaultObjective,
      current_state: 'Initialized',
      next_action: 'Review brief and begin execution',
      task_status: 'open',
      revision_id: 1,
      criteria,
      scope,
      pending_proposals: [],
      revision_history: [],
      model_context: params.model_context || {
        current_model: 'unknown',
        fallback_events: [],
      },
    })
  }

  /**
   * Deserializes brief manager from persisted JSON string or state object.
   */
  static deserialize(serialized: string | ThreadBriefState): ThreadBriefManager {
    const parsed: ThreadBriefState = typeof serialized === 'string' ? JSON.parse(serialized) : serialized
    return new ThreadBriefManager(parsed)
  }

  serialize(): string {
    return JSON.stringify(this.state)
  }

  toJSON(): ThreadBriefState {
    return this.getState()
  }

  getState(): ThreadBriefState {
    return JSON.parse(JSON.stringify(this.state))
  }

  get rawOriginalAsk(): string {
    return this.state.raw_original_ask
  }

  get revisionId(): number {
    return this.state.revision_id
  }

  /**
   * Read-only getter returning an isolated snapshot to prevent external
   * tampering or bypassing evidence verification rules.
   */
  get criteria(): ThreadBriefCriterion[] {
    return JSON.parse(JSON.stringify(this.state.criteria))
  }

  /**
   * Read-only getter returning an isolated snapshot to prevent external tampering.
   */
  get scope(): ThreadBriefScopeItem[] {
    return JSON.parse(JSON.stringify(this.state.scope))
  }

  /**
   * Read-only getter returning an isolated snapshot to prevent external tampering.
   */
  get pendingProposals(): ThreadBriefProposal[] {
    return JSON.parse(JSON.stringify(this.state.pending_proposals))
  }

  /**
   * Monotonically allocate next criterion ID scanning active criteria,
   * all proposals (pending, accepted, rejected), historical revisions,
   * and any ephemeral IDs allocated within the current batch to prevent collisions.
   */
  allocateCriterionId(extraIdsInBatch: string[] = []): string {
    let maxId = 0
    const scanId = (idStr?: string) => {
      if (!idStr) return
      const match = idStr.match(/^CRIT-(\d+)$/)
      if (match && match[1]) {
        const num = parseInt(match[1], 10)
        if (!Number.isNaN(num) && num > maxId) maxId = num
      }
    }

    // Active criteria
    for (const c of this.state.criteria) {
      scanId(c.id)
    }

    // All staged proposals (pending, accepted, or rejected)
    for (const prop of this.state.pending_proposals) {
      if (prop.added_criteria) {
        for (const c of prop.added_criteria) {
          scanId(c.id)
        }
      }
    }

    // Historical revisions
    for (const rev of this.state.revision_history) {
      for (const c of rev.criteria) {
        scanId(c.id)
      }
    }

    // Additional IDs in the currently allocated batch
    for (const idStr of extraIdsInBatch) {
      scanId(idStr)
    }

    return `CRIT-${maxId + 1}`
  }

  /**
   * Stage an unconfirmed proposal.
   * Allocates unique monotonic IDs across the entire batch without collision.
   * Does NOT mutate active brief or bump revision.
   */
  stageProposal(params: {
    description: string
    proposed_by: string
    added_scope?: string[]
    added_criteria?: string[]
  }): ThreadBriefProposal {
    const proposal_id = `PROP-${Date.now()}-${this.state.pending_proposals.length + 1}`
    const added_scope: ThreadBriefScopeItem[] = (params.added_scope || []).map(text => ({
      text,
      is_inferred: true,
      confirmed: false,
    }))

    const added_criteria: ThreadBriefCriterion[] = []
    const allocatedInBatch: string[] = []
    for (const description of params.added_criteria || []) {
      const id = this.allocateCriterionId(allocatedInBatch)
      allocatedInBatch.push(id)
      added_criteria.push({
        id,
        description,
        status: 'pending',
        is_inferred: true,
        confirmed: false,
      })
    }

    const proposal: ThreadBriefProposal = {
      proposal_id,
      description: params.description,
      proposed_by: params.proposed_by,
      timestamp: new Date().toISOString(),
      status: 'pending',
      added_scope,
      added_criteria,
    }

    this.state.pending_proposals.push(proposal)
    return JSON.parse(JSON.stringify(proposal))
  }

  /**
   * Confirm a staged proposal by operator.
   * Records prior revision in history, bumps revision_id, merges additions as confirmed.
   */
  confirmProposal(proposalId: string, confirmedBy: string): boolean {
    const index = this.state.pending_proposals.findIndex(p => p.proposal_id === proposalId)
    if (index === -1) return false

    const proposal = this.state.pending_proposals[index]
    if (!proposal || proposal.status !== 'pending') return false

    // 1. Archive current revision in history
    this.state.revision_history.push({
      revision_id: this.state.revision_id,
      objective: this.state.objective,
      scope: JSON.parse(JSON.stringify(this.state.scope)),
      criteria: JSON.parse(JSON.stringify(this.state.criteria)),
      created_at: new Date().toISOString(),
      confirmed_by: confirmedBy,
    })

    // 2. Bump revision id
    this.state.revision_id += 1

    // 3. Merge additions marked confirmed: true
    if (proposal.added_scope) {
      for (const item of proposal.added_scope) {
        this.state.scope.push({
          ...item,
          confirmed: true,
        })
      }
    }

    if (proposal.added_criteria) {
      for (const item of proposal.added_criteria) {
        this.state.criteria.push({
          ...item,
          confirmed: true,
        })
      }
    }

    proposal.status = 'accepted'
    return true
  }

  /**
   * Reject a staged proposal. Retains proposal in record to avoid ID reuse.
   */
  rejectProposal(proposalId: string): boolean {
    const proposal = this.state.pending_proposals.find(p => p.proposal_id === proposalId)
    if (!proposal || proposal.status !== 'pending') return false
    proposal.status = 'rejected'
    return true
  }

  /**
   * Record structured evidence for a criterion.
   * Rejects empty or invalid evidence fields.
   * Transitions status to satisfied subject to coordinator/operator verification.
   */
  recordEvidence(criterionId: string, evidence: CriterionEvidence): { success: boolean; error?: string } {
    const criterion = this.state.criteria.find(c => c.id === criterionId)
    if (!criterion) {
      return { success: false, error: `Criterion ${criterionId} not found` }
    }

    if (!evidence.reference || !evidence.reference.trim()) {
      return { success: false, error: 'Evidence reference is required and cannot be blank' }
    }

    if (!evidence.summary || !evidence.summary.trim()) {
      return { success: false, error: 'Evidence summary is required and cannot be blank' }
    }

    const validTypes: EvidenceType[] = ['test_result', 'artifact', 'observation']
    if (!validTypes.includes(evidence.type)) {
      return { success: false, error: `Invalid evidence type: ${evidence.type}` }
    }

    criterion.evidence = {
      type: evidence.type,
      reference: evidence.reference.trim(),
      summary: evidence.summary.trim(),
      recorded_at: evidence.recorded_at || new Date().toISOString(),
    }
    criterion.status = 'satisfied'
    return { success: true }
  }

  /**
   * Explicitly reject unverified agent claims that attempt to satisfy a criterion without evidence.
   */
  evaluateAgentClaim(criterionId: string, claimText: string): { accepted: boolean; message: string } {
    return {
      accepted: false,
      message: `Agent claim "${claimText}" rejected for ${criterionId}: requires verifiable evidence (test_result, artifact, observation).`,
    }
  }

  /**
   * Check whether all criteria have verified evidence recorded.
   * Does NOT auto-accept task completion; requires explicit audit.
   */
  canCloseTask(): { allowed: boolean; pending: string[]; requires_audit: boolean } {
    const pending = this.state.criteria
      .filter(c => c.status !== 'satisfied' || !c.evidence)
      .map(c => c.id)
    return {
      allowed: pending.length === 0,
      pending,
      requires_audit: true,
    }
  }

  updateState(stateDescription: string, nextAction: string): void {
    this.state.current_state = stateDescription
    this.state.next_action = nextAction
  }

  updateModelContext(modelContext: Partial<ModelContext>): void {
    this.state.model_context = {
      ...this.state.model_context,
      current_model: modelContext.current_model || this.state.model_context?.current_model || 'unknown',
      fallback_events: modelContext.fallback_events || this.state.model_context?.fallback_events || [],
    }
  }

  /**
   * Format context injection for session continuation/handoff/recovery prompt.
   * Emphasizes objective, state, criteria status, and model fallback history.
   */
  composeContextPrompt(): string {
    const lines: string[] = [
      `[Active Thread Brief Rev ${this.state.revision_id}]`,
      `Objective: ${this.state.objective}`,
      `Current State: ${this.state.current_state}`,
      `Next Action: ${this.state.next_action}`,
    ]

    if (this.state.scope && this.state.scope.length > 0) {
      lines.push(`Scope:`)
      for (const s of this.state.scope) {
        const tag = s.confirmed ? '(confirmed)' : '(inferred/unconfirmed)'
        lines.push(`  - ${tag} ${s.text}`)
      }
    }

    if (this.state.criteria && this.state.criteria.length > 0) {
      lines.push(`Criteria:`)
      for (const c of this.state.criteria) {
        const authTag = c.confirmed ? '(confirmed)' : '(inferred/unconfirmed)'
        const ev = c.evidence ? ` [Evidence: ${c.evidence.type} - ${c.evidence.summary}]` : ''
        lines.push(`  - [${c.id}] ${authTag} (${c.status}): ${c.description}${ev}`)
      }
    }

    if (this.state.model_context && this.state.model_context.fallback_events && this.state.model_context.fallback_events.length > 0) {
      lines.push(`Model Fallback Routing:`)
      for (const ev of this.state.model_context.fallback_events) {
        lines.push(`  - ${ev.requested_model} -> ${ev.substituted_model} (${ev.reason})`)
      }
    }

    return lines.join('\n')
  }

  /**
   * View representation for the compact client header.
   */
  toView(): ThreadBriefView {
    return {
      thread_id: this.state.thread_id,
      ticket_id: this.state.ticket_id,
      raw_original_ask: this.state.raw_original_ask,
      revision_id: this.state.revision_id,
      objective: this.state.objective,
      current_state: this.state.current_state,
      next_action: this.state.next_action,
      task_status: this.state.task_status,
      criteria: JSON.parse(JSON.stringify(this.state.criteria)),
      scope: JSON.parse(JSON.stringify(this.state.scope)),
      pending_proposals: JSON.parse(JSON.stringify(this.state.pending_proposals)),
      model_context: {
        current_model: this.state.model_context?.current_model || 'unknown',
        fallback_events: JSON.parse(JSON.stringify(this.state.model_context?.fallback_events || [])),
      },
    }
  }

  /**
   * Persists the current brief state to store under the designated key.
   * Throws if store.set fails or is unavailable, ensuring callers do not assume durability on write error.
   */
  save(store: BriefStoreLike, storageKey?: string): void {
    const key = storageKey || (this.state.ticket_id ? `ticket-brief:${this.state.ticket_id}` : `thread-brief:${this.state.thread_id}`)
    if (!store.set) {
      throw new Error(`Store does not support set operations for ${key}`)
    }
    store.set(key, this.getState())
  }
}

export interface BriefTriggerLike {
  id: string
  text: string
  at?: string
  url?: string
}

export interface BriefTicketLike {
  id: string
  title: string
  origin?: { triggerId: string; triggerIds?: string[] }
  mandate?: { scope?: string; strength?: string }
  channels?: { thread?: string; id?: string }[]
  ended?: { outcome: string; at: string; reason?: string; by?: string }
  attention?: { question: string }
  delivery?: { error: string; at: string }
  assignments?: {
    id?: string
    state?: string
    report?: { state?: string; summary?: string; at?: string }
  }[]
  inputs?: unknown[]
  undelivered?: string[]
}

export interface BriefThreadLike {
  key: string
  ref?: { source: string; id: string }
  createdAt?: string
  lastAt?: string
  meta?: Record<string, unknown>
  evaluating?: unknown
  subscriptions?: string[]
  context?: string[]
  pending?: string[]
  correlated?: string[]
}

export interface BriefStoreLike {
  triggers?: {
    get(id: string): BriefTriggerLike | undefined
    of?(threadKey: string): BriefTriggerLike[]
  }
  tickets?: {
    get(id: string): any
    list?(): any[]
  }
  threads?: {
    get(key: string): any
    list?(): any[]
  }
  read?: {
    firstTrigger?(threadKeyValue: string, humanOnly?: boolean): any
    threadTriggers?(threadKeyValue: string, limit?: number, before?: any, after?: any): any[]
  }
  get?<V>(key: string): V | undefined
  set?<V>(key: string, value: V): void
}

function deriveThreadTitle(store: BriefStoreLike, thread: BriefThreadLike, firstTrigger?: BriefTriggerLike): string {
  const label = thread.meta?.label
  if (typeof label === 'string' && label) return label
  if (label && typeof (label as any).en === 'string') return (label as any).en
  if (label && typeof (label as any).zh === 'string') return (label as any).zh
  if (firstTrigger?.text) {
    const trimmed = firstTrigger.text.trim().split('\n')[0] || ''
    return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed
  }
  return thread.key
}

/**
 * Resolves or constructs the single authoritative ThreadBriefManager for a Ticket.
 * Preserves verbatim original ask from trigger (distinct from title).
 * Loads persisted revisions and criteria across rereads/reloads.
 * Does not fabricate criteria or mark criteria satisfied on ticket closure.
 */
export function resolveTicketBriefManager(
  store: BriefStoreLike,
  ticket: BriefTicketLike,
  modelContext?: ModelContext
): ThreadBriefManager {
  const briefKey = `ticket-brief:${ticket.id}`
  const persisted = store.get ? store.get<ThreadBriefState>(briefKey) : undefined

  let manager: ThreadBriefManager
  if (persisted) {
    manager = ThreadBriefManager.deserialize(persisted)
  } else {
    const originTrigger = ticket.origin?.triggerId && store.triggers ? store.triggers.get(ticket.origin.triggerId) : undefined
    const raw_request = originTrigger !== undefined ? originTrigger.text : 'unavailable'
    const objective = ticket.title || (originTrigger ? originTrigger.text.trim().split('\n')[0] : '') || 'Unspecified task'
    const inferred_scope = ticket.mandate?.scope ? [ticket.mandate.scope] : []

    const channelRef = ticket.channels?.[0]
    const thread_id = channelRef?.thread || channelRef?.id || `ticket:${ticket.id}`

    manager = ThreadBriefManager.fromRequest({
      thread_id,
      ticket_id: ticket.id,
      raw_request,
      objective,
      inferred_scope,
      inferred_criteria: [],
      model_context: modelContext,
    })

    if (store.set) {
      try {
        manager.save(store, briefKey)
      } catch {
        // Storage write failed - state remains in-memory
      }
    }
  }

  // Real Ticket state classification via ticketStage
  const safeTicket = { assignments: [], inputs: [], undelivered: [], ...ticket } as Ticket
  const stage = ticketStage(safeTicket)
  if (stage.stage === 'ended') {
    manager.updateState(`ended:${ticket.ended?.outcome ?? 'ended'}`, 'None (task ended)')
    ;(manager as any).state.task_status = 'closed'
  } else if (stage.stage === 'person') {
    if (stage.action === 'delivery') {
      manager.updateState('person:delivery', ticket.delivery?.error || 'Awaiting delivery recovery')
    } else if (stage.action === 'answer') {
      manager.updateState('person:answer', ticket.attention?.question || 'Awaiting operator response')
    } else if (stage.action === 'review') {
      manager.updateState('person:review', 'Review ready report')
    } else if (stage.action === 'blocked') {
      const rep = latestReport(safeTicket)
      manager.updateState('person:blocked', rep?.summary || 'Awaiting operator response to unblock')
    } else if (stage.action === 'failed') {
      const rep = latestReport(safeTicket)
      manager.updateState('person:failed', rep?.summary || 'Awaiting operator review of failure')
    }
    ;(manager as any).state.task_status = 'open'
  } else if (stage.stage === 'idle') {
    const rep = latestReport(safeTicket)
    const stateDesc = rep?.state === 'waiting' ? 'waiting' : 'idle'
    const nextAct = rep?.state === 'waiting' ? 'Waiting for trigger' : 'Idle between turns'
    manager.updateState(stateDesc, nextAct)
    ;(manager as any).state.task_status = 'open'
  } else if (stage.stage === 'working') {
    if (stage.action === 'queued') {
      manager.updateState('queued', 'Waiting for worker execution')
    } else {
      manager.updateState('working', 'Execute assignment')
    }
    ;(manager as any).state.task_status = 'open'
  }

  if (modelContext) {
    manager.updateModelContext(modelContext)
  }

  return manager
}

/**
 * Resolves or constructs the single authoritative ThreadBriefManager for a Thread.
 * Preserves verbatim initiating ask from first trigger.
 * Evaluates truthful thread state (evaluating, active, initialized).
 */
export function resolveThreadBriefManager(
  store: BriefStoreLike,
  thread: BriefThreadLike,
  canonicalFirstTrigger?: BriefTriggerLike | BriefTriggerLike[],
  modelContext?: ModelContext
): ThreadBriefManager {
  // 3. SINGLE AUTHORITY:
  // If thread has a subscribed ticket that exists in store, delegate to resolveTicketBriefManager
  // to ensure ticket, thread, and sessions prompt hook share the exact same authoritative brief state.
  const subscribedTicketId = thread.subscriptions?.find(id => store.tickets?.get(id))
  if (subscribedTicketId) {
    const ticket = store.tickets!.get(subscribedTicketId)
    if (ticket) {
      return resolveTicketBriefManager(store, ticket, modelContext)
    }
  }

  const briefKey = `thread-brief:${thread.key}`
  const persisted = store.get ? store.get<ThreadBriefState>(briefKey) : undefined

  let manager: ThreadBriefManager
  if (persisted) {
    manager = ThreadBriefManager.deserialize(persisted)
  } else {
    const initialTrigger = Array.isArray(canonicalFirstTrigger) ? canonicalFirstTrigger[0] : canonicalFirstTrigger
    const firstTrigger = initialTrigger
      || (store.read?.firstTrigger ? store.read.firstTrigger(thread.key) : undefined)
      || (store.triggers?.of ? store.triggers.of(thread.key)[0] : undefined)

    const raw_request = firstTrigger !== undefined ? firstTrigger.text : 'unavailable'
    const objective = deriveThreadTitle(store, thread, firstTrigger)
    const sourceKind = thread.ref?.source
    const inferred_scope = sourceKind ? [`Execute within ${sourceKind} thread parameters`] : []

    manager = ThreadBriefManager.fromRequest({
      thread_id: thread.key,
      raw_request,
      objective,
      inferred_scope,
      inferred_criteria: [],
      model_context: modelContext,
    })

    if (store.set) {
      try {
        manager.save(store, briefKey)
      } catch {
        // Storage write failed - state remains in-memory
      }
    }
  }

  // 2. REAL TYPES & STATE for Thread
  if (thread.meta?.pollError) {
    manager.updateState('error', 'Poll error recorded')
    ;(manager as any).state.task_status = 'open'
  } else if (thread.evaluating) {
    manager.updateState('evaluating', 'Awaiting evaluation result')
    ;(manager as any).state.task_status = 'open'
  } else if (thread.pending && thread.pending.length > 0) {
    manager.updateState('queued', 'Awaiting triage evaluation')
    ;(manager as any).state.task_status = 'open'
  } else if (thread.subscriptions && thread.subscriptions.length > 0) {
    const tickets = thread.subscriptions.map(id => store.tickets?.get(id)).filter(Boolean)
    const hasLive = tickets.some(t => !t.ended)
    if (hasLive) {
      manager.updateState('active', 'Execute thread tickets')
    } else if (tickets.length > 0) {
      manager.updateState('dormant', 'All subscribed tickets ended')
    } else {
      manager.updateState('active', 'Execute thread tickets')
    }
    ;(manager as any).state.task_status = 'open'
  } else {
    manager.updateState('unsubscribed', 'Awaiting triage or ticket subscription')
    ;(manager as any).state.task_status = 'open'
  }

  if (modelContext) {
    manager.updateModelContext(modelContext)
  }

  return manager
}
