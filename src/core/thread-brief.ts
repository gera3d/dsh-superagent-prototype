/**
 * Thread Brief domain model and context adapter (Issue #216).
 *
 * Implements immutable verbatim original ask, explicitly unconfirmed inferred scope/criteria,
 * monotonic criterion ID allocation, staged proposals, revision history, evidence-backed
 * status transitions, and prompt/continuation context generation.
 */

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

export class ThreadBriefManager {
  private state: ThreadBriefState

  constructor(initialState: ThreadBriefState) {
    this.state = JSON.parse(JSON.stringify(initialState))
  }

  /**
   * Factory creating a brief from a user request.
   * Preserves raw_original_ask verbatim without trimming or stripping.
   * Marks all inferred items as unconfirmed.
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
        current_model: 'deepseek/deepseek-chat',
        fallback_events: [],
      },
    })
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

  get criteria(): ThreadBriefCriterion[] {
    return this.state.criteria
  }

  get scope(): ThreadBriefScopeItem[] {
    return this.state.scope
  }

  get pendingProposals(): ThreadBriefProposal[] {
    return this.state.pending_proposals
  }

  /**
   * Monotonically allocate next criterion ID scanning active criteria,
   * pending proposals, and historical revisions to avoid collision.
   */
  allocateCriterionId(): string {
    let maxId = 0
    const scanId = (idStr: string) => {
      const match = idStr.match(/^CRIT-(\d+)$/)
      if (match) {
        const num = parseInt(match[1], 10)
        if (num > maxId) maxId = num
      }
    }

    for (const c of this.state.criteria) {
      scanId(c.id)
    }

    for (const prop of this.state.pending_proposals) {
      if (prop.added_criteria) {
        for (const c of prop.added_criteria) {
          scanId(c.id)
        }
      }
    }

    for (const rev of this.state.revision_history) {
      for (const c of rev.criteria) {
        scanId(c.id)
      }
    }

    return `CRIT-${maxId + 1}`
  }

  /**
   * Stage an unconfirmed proposal.
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

    const added_criteria: ThreadBriefCriterion[] = (params.added_criteria || []).map(description => ({
      id: this.allocateCriterionId(),
      description,
      status: 'pending',
      is_inferred: true,
      confirmed: false,
    }))

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
    return proposal
  }

  /**
   * Confirm a staged proposal by operator.
   * Records prior revision in history, bumps revision_id, merges additions as confirmed.
   */
  confirmProposal(proposalId: string, confirmedBy: string): boolean {
    const index = this.state.pending_proposals.findIndex(p => p.proposal_id === proposalId)
    if (index === -1) return false

    const proposal = this.state.pending_proposals[index]
    if (proposal.status !== 'pending') return false

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
   * Record verified evidence for a criterion.
   * Rejects empty or invalid evidence.
   * Transitions status to satisfied only when valid evidence provided.
   */
  recordEvidence(criterionId: string, evidence: CriterionEvidence): { success: boolean; error?: string } {
    const criterion = this.state.criteria.find(c => c.id === criterionId)
    if (!criterion) {
      return { success: false, error: `Criterion ${criterionId} not found` }
    }

    if (!evidence.reference || !evidence.reference.trim()) {
      return { success: false, error: 'Evidence reference is required' }
    }

    if (!evidence.summary || !evidence.summary.trim()) {
      return { success: false, error: 'Evidence summary is required' }
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
   * Reject unverified agent claims that attempt to satisfy a criterion without evidence.
   */
  evaluateAgentClaim(criterionId: string, claimText: string): { accepted: boolean; message: string } {
    return {
      accepted: false,
      message: `Agent claim "${claimText}" rejected for ${criterionId}: requires verifiable evidence (test_result, artifact, observation).`,
    }
  }

  /**
   * Check whether all criteria are satisfied with evidence.
   * Agent claims do not close the task.
   */
  canCloseTask(): { allowed: boolean; pending: string[] } {
    const pending = this.state.criteria
      .filter(c => c.status !== 'satisfied' || !c.evidence)
      .map(c => c.id)
    return {
      allowed: pending.length === 0,
      pending,
    }
  }

  updateState(stateDescription: string, nextAction: string): void {
    this.state.current_state = stateDescription
    this.state.next_action = nextAction
  }

  updateModelContext(modelContext: Partial<ModelContext>): void {
    this.state.model_context = {
      ...this.state.model_context,
      current_model: modelContext.current_model || this.state.model_context?.current_model || 'deepseek/deepseek-chat',
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
      `Scope:`,
    ]

    for (const s of this.state.scope) {
      const tag = s.confirmed ? '(confirmed)' : '(inferred/unconfirmed)'
      lines.push(`  - ${tag} ${s.text}`)
    }

    lines.push(`Criteria:`)
    for (const c of this.state.criteria) {
      const ev = c.evidence ? ` [Evidence: ${c.evidence.type} - ${c.evidence.summary}]` : ''
      lines.push(`  - [${c.id}] (${c.status}): ${c.description}${ev}`)
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
        current_model: this.state.model_context?.current_model || 'deepseek/deepseek-chat',
        fallback_events: JSON.parse(JSON.stringify(this.state.model_context?.fallback_events || [])),
      },
    }
  }
}
