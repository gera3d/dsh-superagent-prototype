/** Durable, server-wide capture of explicit end-of-turn questions. No choice executes or sends anything. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { AdvisorDecision, DecisionEvaluationResult, DecisionOptionSet, DecisionStaging, PendingDecisionItem } from '../core/decision.ts'
import { normalizeChoices } from '../core/options.ts'
import { ticketStage, latestReport, type Ticket } from '../core/index.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { parseInlineAlternatives } from '../client/inline-alternatives.ts'

/** Same ticket projection for the regular runtime and independently loaded inbox provider. */
export function ticketDecisions(tickets: Ticket[]): PendingDecisionItem[] {
  return tickets.filter(ticket => ticketStage(ticket).stage === 'person').map(ticket => {
    const context = ticket.attention?.question || latestReport(ticket)?.summary || 'Awaiting operator input to unblock ticket.'
    const question = (decisionQuestion(context) || context.split(/\n\s*\n/)[0] || context).slice(0, 500)
    const fingerprint = createHash('sha256').update(context).digest('hex').slice(0, 16)
    return { id: `dec-${ticket.id}-${fingerprint}`, ticketId: ticket.id, sessionId: ticket.assignments.some(a => a.startedAt) ? workerSessionId(ticket.id) : undefined,
      ticketTitle: ticket.title, trigger: question, status: 'pending', urgency: 'medium', createdAt: Date.parse(ticket.updatedAt),
      context: context.slice(-30000), question, actionMode: 'stage_response',
      choices: [{ id: 'request_human_review', label: 'Request human review', description: 'Draft a request for human review; no worker is restarted.' },
        { id: 'respond', label: 'Draft a response', description: 'Open the source session and edit your response before sending.' }], recommendation }
  })
}

/** Expected inbox lookup, validation or stale-conflict failure, serialized to its HTTP status. */
export class InboxError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message) }
}
export interface DecisionResolution {
  resolved: true
  choiceId: string
  execution: 'not_executed'
  draft: { sessionId?: string; text: string }
  item: PendingDecisionItem
}
export interface DecisionStagingResult { item: PendingDecisionItem; staging: DecisionStaging; execution: 'not_executed' }
export interface DecisionDiscardResult { item: PendingDecisionItem; execution: 'not_executed' }
export interface RestartDecisionRequest { sessionId: string }
export interface DecisionRestartResult { item: PendingDecisionItem; execution: 'not_executed' }
export interface StageDecisionRequest { choiceId: string; attemptId: string; draftText: string }
export interface BindDecisionSubmission { attemptId: string; submissionId: string; retryOf?: string }
/** Full serialized plaintext fingerprint shared with the native browser submission journal. */
export function draftFingerprint(text: string): string { return `sha256:${createHash('sha256').update(JSON.stringify(text), 'utf8').digest('hex')}` }
function choicesFingerprint(item: Pick<PendingDecisionItem, 'choices'>): string { return draftFingerprint(JSON.stringify(item.choices)) }
function choicePrompt(item: PendingDecisionItem, choiceId: string): string {
  const choice = item.choices.find(choice => choice.id === choiceId)!
  return choice.prompt ?? (choiceId === 'respond' ? `Regarding your question:\n${item.question}\n\nMy response: `
    : choiceId === 'continue' ? `Please continue with the next step you offered:\n${item.question}`
    : choiceId === 'discuss' ? `Before proceeding, please clarify:\n${item.question}` : choice.label)
}
function decisionSourceTurn(item: PendingDecisionItem, events: readonly SessionEvent[]): number | undefined {
  if (item.sourceTurn !== undefined) return item.sourceTurn
  const source = events.find(event => event.type === 'assistant/message' && event.seq === item.sourceSeq && event.data.message.id === item.sourceMessageId)
  return source?.type === 'assistant/message' ? source.data.turn : undefined
}
/** A restart cannot consume or be invalidated by its parent's historical submission. */
function decisionBoundary(item: PendingDecisionItem): number {
  return Math.max(item.sourceSeq ?? -1, item.restartAfterSeq ?? -1)
}
function nativeAdmission(event: SessionEvent): { submissionId: string; messageId: string; text: string } | undefined {
  if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
  const source = event.data.source as { kind: 'user'; rpcId?: unknown }
  if (typeof source.rpcId !== 'string' || !source.rpcId || typeof event.data.id !== 'string' || !event.data.id || !Number.isFinite(event.time)) return
  return { submissionId: source.rpcId, messageId: String(event.data.id), text: event.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n') }
}
const recommendation = { recommendedValue: '', confidence: 0, rationale: 'Not evaluated. Choosing an option only stages a response for your review.', distribution: [], provider: 'Not evaluated', latencyMs: 0 }

/** Exclude code, quoted material and reported questions; capture direct asks and explicit next-step offers. */
export function decisionQuestion(text: string): string | undefined {
  const masked: string[] = []
  const mask = (value: string) => { const token = `§${masked.length}§`; masked.push(value); return token }
  const prose = text.replace(/(?:```|~~~)[\s\S]*?(?:(?:```|~~~)|$)/g, '').replace(/`[^`\n]*`/g, mask)
    .replace(/https?:\/\/\S+/g, url => { const punctuation = /[.!?]$/.exec(url)?.[0] ?? ''; return mask(punctuation ? url.slice(0, -1) : url) + punctuation })
    .split('\n').filter(line => !/^\s*>/.test(line)).join('\n')
  const sentences = prose.split(/(?<=[.!?])\s+|\n+/).map(line => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim()).filter(Boolean)
  const asks = sentences.filter(line => /\?/.test(line) && /^(?:(?:would|do|can|could|will) you\b|(?:should|shall|may|can|could) (?:I|we)\b|which\b|(?:what|how|where|when|who)\s+(?:would|do|should|will|could|can)\b|please\b|want me to\b|is (?:this|that|it)\b|are you\b|(?:proceed|continue)\s*\?)/i.test(line.replace(/^\*\*/, '')))
  const offers = sentences.filter(line => /^(?:if you(?:'d| would)? (?:like|want|prefer),?\s+(?:I can|I could|we can)|I can\b|I could\b|let me know (?:if|whether|which|what)|tell me (?:if|whether|which|what)|please (?:choose|confirm|decide|select)\b)/i.test(line)
    && !/^I (?:can|could)(?:['’]t|\s+(?:not|confirm|see|tell|verify|report|understand)\b)/i.test(line))
  return [...new Set([...asks, ...offers])].join('\n').replace(/§(\d+)§/g, (_match, index) => masked[Number(index)] ?? '').slice(0, 4000) || undefined
}

function cloneOptionSet(set: DecisionOptionSet): DecisionOptionSet {
  return { ...set, choices: set.choices.map(choice => ({ ...choice })),
    ...(set.hiddenOptions ? { hiddenOptions: set.hiddenOptions.map(choice => ({ ...choice })) } : {}),
    recommendation: structuredClone(set.recommendation) }
}
/** Seed history from a legacy row's shown set so the first regenerate never loses it. */
function optionHistory(existing: PendingDecisionItem | undefined): DecisionOptionSet[] {
  if (existing?.optionSets?.length) return existing.optionSets.map(set => cloneOptionSet(set))
  if (!existing?.choices.length) return []
  return [{ revision: 1, createdAt: existing.createdAt, ...(existing.advisor?.model ? { model: existing.advisor.model } : {}),
    choices: existing.choices.map(choice => ({ ...choice })),
    ...(existing.hiddenOptions?.length ? { hiddenOptions: existing.hiddenOptions.map(choice => ({ ...choice })) } : {}),
    recommendation: structuredClone(existing.recommendation) }]
}

/** SQLite-backed shared decisions with CAS staging, durable native submission proof and preserved resolution history. */
export class DecisionInbox {
  constructor(private readonly db: DatabaseSync, private readonly changed?: (item: PendingDecisionItem) => void) {
    db.exec(`CREATE TABLE IF NOT EXISTS decision_inbox (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decision_inbox_cursor (session TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS decision_inbox_native_submission_guard BEFORE UPDATE OF value ON decision_inbox
      WHEN json_extract(OLD.value, '$.resolutionPolicy') = 'on_send'
      BEGIN
        SELECT CASE WHEN COALESCE(json_extract(NEW.value, '$.resolutionRevision'), -1) <> COALESCE(json_extract(OLD.value, '$.resolutionRevision'), 0) + 1
          THEN RAISE(ABORT, 'Native resolution revision must advance; legacy lost update rejected') END;
        SELECT CASE WHEN COALESCE(json_extract(NEW.value, '$.resolutionPolicy'), '') <> 'on_send'
          THEN RAISE(ABORT, 'Native resolution policy cannot be removed by a legacy writer') END;
        SELECT CASE WHEN json_extract(OLD.value, '$.status') = 'pending' AND json_extract(NEW.value, '$.status') = 'stale'
          AND json_type(NEW.value, '$.invalidation') IS NOT 'object'
          THEN RAISE(ABORT, 'Native staged decisions require proof-aware invalidation') END;
        SELECT CASE WHEN json_extract(OLD.value, '$.status') = 'resolved' AND json_extract(NEW.value, '$.status') IS NOT 'resolved'
          THEN RAISE(ABORT, 'Confirmed native resolution history cannot be erased') END;
      END;
      CREATE TRIGGER IF NOT EXISTS decision_inbox_no_unlinked_resolution BEFORE UPDATE OF value ON decision_inbox
      WHEN json_extract(OLD.value, '$.status') = 'pending' AND json_extract(NEW.value, '$.status') = 'resolved'
      BEGIN
        SELECT CASE WHEN COALESCE(json_extract(NEW.value, '$.resolutionBasis') = 'submitted'
          AND json_extract(NEW.value, '$.resolvedChoice') = json_extract(OLD.value, '$.staging.choiceId')
          AND length(json_extract(NEW.value, '$.submittedMessageId')) > 0
          AND json_extract(NEW.value, '$.submittedSeq') > json_extract(OLD.value, '$.sourceSeq')
          AND json_type(NEW.value, '$.resolvedAt') IN ('integer', 'real')
          AND (json_extract(NEW.value, '$.submissionId') = json_extract(OLD.value, '$.staging.submissionId')
            OR EXISTS (SELECT 1 FROM json_each(json_extract(OLD.value, '$.staging.submissionIds')) WHERE value = json_extract(NEW.value, '$.submissionId'))), 0) = 0
        THEN RAISE(ABORT, 'Linked native submission proof required; legacy staged resolution rejected') END;
      END;
      CREATE TRIGGER IF NOT EXISTS decision_inbox_restart_guard BEFORE UPDATE OF value ON decision_inbox
      WHEN json_type(OLD.value, '$.restartAfterSeq') = 'integer'
      BEGIN
        SELECT CASE WHEN json_extract(NEW.value, '$.restartAfterSeq') IS NOT json_extract(OLD.value, '$.restartAfterSeq')
          OR json_extract(NEW.value, '$.parentDecisionId') IS NOT json_extract(OLD.value, '$.parentDecisionId')
          OR json_extract(NEW.value, '$.restartExcludedSubmissionIds') IS NOT json_extract(OLD.value, '$.restartExcludedSubmissionIds')
          THEN RAISE(ABORT, 'Decision restart lineage and checkpoint are immutable') END;
        SELECT CASE WHEN json_extract(OLD.value, '$.status') = 'pending' AND json_extract(NEW.value, '$.status') = 'resolved'
          AND COALESCE(json_extract(NEW.value, '$.submittedSeq') > json_extract(OLD.value, '$.restartAfterSeq'), 0) = 0
          THEN RAISE(ABORT, 'Restart requires a submission after its history checkpoint') END;
      END;`)
  }
  list(): PendingDecisionItem[] {
    return this.db.prepare('SELECT value FROM decision_inbox').all().map(row => JSON.parse(String(row.value)) as PendingDecisionItem)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  }
  get(id: string): PendingDecisionItem | undefined {
    const row = this.db.prepare('SELECT value FROM decision_inbox WHERE id = ?').get(id)
    return row ? JSON.parse(String(row.value)) as PendingDecisionItem : undefined
  }
  private save(item: PendingDecisionItem, previous?: PendingDecisionItem): void {
    if (item.resolutionPolicy === 'on_send') item.resolutionRevision = (previous?.resolutionRevision ?? 0) + 1
    if (previous) {
      const changed = this.db.prepare('UPDATE decision_inbox SET value=? WHERE id=? AND value=?').run(JSON.stringify(item), item.id, JSON.stringify(previous))
      if (!changed.changes) throw new InboxError(409, 'Decision changed concurrently; reload before retrying')
    } else if (!this.db.prepare('INSERT INTO decision_inbox(id,value) VALUES (?,?) ON CONFLICT(id) DO NOTHING').run(item.id, JSON.stringify(item)).changes) throw new InboxError(409, 'Decision was created concurrently; reload before retrying')
    this.changed?.(item)
  }
  /** Explicit, idempotent restart. The parent and its native proof are never updated. */
  startNewDecision(id: string, events: readonly SessionEvent[]): PendingDecisionItem {
    const parent = this.get(id)
    if (!parent) throw new InboxError(404, 'Decision not found')
    if (parent.status !== 'resolved') throw new InboxError(409, 'Only a recorded decision can be restarted')
    const childId = `restart-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`
    const existing = this.get(childId)
    if (existing) {
      if (existing.parentDecisionId !== id || existing.sessionId !== parent.sessionId || existing.restartAfterSeq === undefined) throw new InboxError(409, 'Restart identity conflicts with an unrelated decision')
      return existing
    }
    if (!parent.sessionId || !parent.sourceMessageId || parent.sourceSeq === undefined || !parent.choices.length) throw new InboxError(409, 'Decision has no reusable source or choices')
    if (!events.some(event => event.type === 'assistant/message' && event.seq === parent.sourceSeq && event.data.message.id === parent.sourceMessageId)) throw new InboxError(409, 'Original source history is unavailable')
    const end = events.findLast(event => event.type === 'turn/end')
    const current = end?.type === 'turn/end' ? events.findLast(event => event.type === 'assistant/message' && event.data.turn === end.data.turn) : undefined
    if (end?.type !== 'turn/end' || end.data.reason.kind !== 'completed' || current?.type !== 'assistant/message' || current.data.interrupted
      || events.some(event => event.seq > end.seq && (event.type === 'turn/start' || event.type === 'user/message' && event.data.source.kind === 'user'))) throw new InboxError(409, 'Wait for the conversation to finish before restarting')
    const restartAfterSeq = events.reduce((last, event) => Math.max(last, event.seq), -1)
    if (restartAfterSeq < (parent.submittedSeq ?? parent.sourceSeq)) throw new InboxError(409, 'Complete parent submission history is unavailable')
    const item: PendingDecisionItem = {
      id: childId, parentDecisionId: parent.id, restartAfterSeq,
      restartExcludedSubmissionIds: [...new Set(events.flatMap(event => { const admission = nativeAdmission(event); return admission ? [admission.submissionId] : [] }))],
      sessionId: parent.sessionId, sourceMessageId: parent.sourceMessageId, sourceSeq: parent.sourceSeq, sourceTurn: parent.sourceTurn,
      ticketTitle: parent.ticketTitle, trigger: 'Explicitly restarted decision', status: 'pending', actionMode: 'stage_response', resolutionPolicy: 'on_send',
      urgency: parent.urgency, createdAt: Math.max(Date.now(), parent.createdAt + 1), question: parent.question, context: parent.context,
      choices: parent.choices.map(choice => ({ ...choice })), recommendation: structuredClone(parent.recommendation),
      ...(parent.hiddenOptions?.length ? { hiddenOptions: parent.hiddenOptions.map(choice => ({ ...choice })) } : {}),
      ...(parent.optionSets?.length ? { optionSets: parent.optionSets.map(set => cloneOptionSet(set)) } : {}),
      advisor: parent.advisor?.status === 'ready' ? { ...parent.advisor } : undefined,
    }
    // Deterministic identity also deduplicates concurrent requests from separate connections.
    this.db.prepare('INSERT INTO decision_inbox(id,value) VALUES (?,?) ON CONFLICT(id) DO NOTHING').run(item.id, JSON.stringify({ ...item, resolutionRevision: 1 }))
    const saved = this.get(childId)!
    this.changed?.(saved)
    return saved
  }
  /** Compatibility ingestion: dedupe on source identity, never resurrect a stale/resolved item. */
  put(item: PendingDecisionItem): PendingDecisionItem {
    const existing = this.list().find(row => row.id === item.id || (item.sessionId && item.sourceMessageId && row.sessionId === item.sessionId && row.sourceMessageId === item.sourceMessageId))
    if (existing) {
      // Capture may win the race with the inline evaluator. Enrich that same
      // canonical record, never create a second card or resurrect a decision.
      if (!existing.parentDecisionId && existing.status === 'pending' && !existing.recommendation.recommendedValue
        && item.recommendation.recommendedValue
        && existing.choices.some(choice => choice.id === item.recommendation.recommendedValue)
        && existing.choices.length === item.choices.length
        && existing.choices.every(choice => item.choices.some(candidate => candidate.id === choice.id && candidate.label === choice.label))) {
        const enriched = { ...existing, recommendation: item.recommendation }
        this.save(enriched, existing)
        return enriched
      }
      return existing
    }
    const saved = { ...item, actionMode: 'stage_response' as const }
    this.save(saved)
    return saved
  }
  findSource(source: { sessionId: string; sourceMessageId?: string; sourceTurn?: number }): PendingDecisionItem | undefined {
    // list() places newer descendants ahead of their parents (strictly increasing createdAt).
    return this.list().find(item => item.sessionId === source.sessionId && (
      !!source.sourceMessageId && item.sourceMessageId === source.sourceMessageId
      || source.sourceTurn !== undefined && item.sourceTurn === source.sourceTurn))
  }
  advisorState(id: string, advisor: NonNullable<PendingDecisionItem['advisor']>): void {
    const item = this.get(id)
    if (item?.status === 'pending') this.save({ ...item, advisor }, item)
  }
  /** Capture a user-visible completed task before advising it; empty choices explicitly mean not yet advised. */
  ensureAdvisor(input: Omit<AdvisorDecision, 'options' | 'model'>): PendingDecisionItem {
    const existing = this.findSource(input)
    if (existing) return existing
    const id = `chat-${createHash('sha256').update(`${input.sessionId}\0${input.sourceMessageId ?? `turn:${input.sourceTurn ?? input.key}`}`).digest('hex').slice(0, 32)}`
    const item: PendingDecisionItem = { id, sessionId: input.sessionId, sourceMessageId: input.sourceMessageId,
      sourceTurn: input.sourceTurn, sourceSeq: input.sourceSeq, question: input.question, context: input.context.slice(-30000),
      ticketTitle: input.title ?? 'Conversation next steps', trigger: 'Task-specific next steps', status: 'pending', urgency: 'low',
      createdAt: input.createdAt, actionMode: 'stage_response', choices: [], recommendation, advisor: { status: 'pending', key: input.key } }
    this.save(item)
    return item
  }
  /** Publish the real advisor output as a new option-set revision, never overwrite or revive a closed item. */
  publishAdvisor(input: AdvisorDecision): PendingDecisionItem {
    const existing = this.findSource(input)
    if (existing && (existing.status !== 'pending' || existing.parentDecisionId)) return existing
    if (!input.options.length || input.options.some(option => !option.id || !option.label?.trim() || !option.prompt?.trim())
      || input.options.filter(option => option.recommended).length !== 1) throw new InboxError(400, 'Invalid advisor choices')
    const selected = input.options.find(option => option.recommended)!
    // Keep the recommendation visible: it is always first, whatever the caller's order.
    const ordered = [selected, ...input.options.filter(option => option !== selected)].map(option => ({ id: option.id,
      label: option.label, description: option.why, prompt: option.prompt, ...(option.added ? { added: true } : {}) }))
    const { choices, hiddenOptions } = normalizeChoices(ordered)
    const recommendation: DecisionEvaluationResult = { recommendedValue: selected.id, confidence: 0, rationale: selected.why, distribution: [], provider: input.model, latencyMs: 0 }
    const id = existing?.id ?? `chat-${createHash('sha256').update(`${input.sessionId}\0${input.sourceMessageId ?? `turn:${input.sourceTurn ?? input.key}`}`).digest('hex').slice(0, 32)}`
    const item: PendingDecisionItem = { ...(existing ?? {}), id, sessionId: input.sessionId,
      sourceMessageId: input.sourceMessageId, sourceTurn: input.sourceTurn, sourceSeq: input.sourceSeq,
      ticketTitle: existing?.ticketTitle ?? input.title ?? 'Conversation next steps', trigger: 'Task-specific next steps',
      question: existing?.question ?? input.question, context: existing?.context ?? input.context.slice(-30000),
      createdAt: existing?.createdAt ?? input.createdAt, urgency: existing?.urgency ?? 'low', status: 'pending', actionMode: 'stage_response',
      choices, ...(hiddenOptions.length ? { hiddenOptions } : {}),
      recommendation, advisor: { status: 'ready', model: input.model, key: input.key } }
    if (existing?.staging && (choicesFingerprint(existing) !== choicesFingerprint(item)
      || existing.sourceMessageId !== item.sourceMessageId || existing.sourceSeq !== item.sourceSeq || existing.sourceTurn !== item.sourceTurn)) throw new InboxError(409, 'Choices or source changed while a draft is staged; discard staging before reevaluating')
    const history = optionHistory(existing)
    const revision = Math.max(0, ...history.map(set => set.revision)) + 1
    item.optionSets = [...history, { revision, key: input.key, model: input.model,
      createdAt: Math.max(Date.now(), (history.at(-1)?.createdAt ?? 0) + 1), choices: choices.map(choice => ({ ...choice })),
      ...(hiddenOptions.length ? { hiddenOptions: hiddenOptions.map(choice => ({ ...choice })) } : {}), recommendation: { ...recommendation } }]
    this.save(item, existing)
    return item
  }
  /** Restore an earlier set by appending it as a new revision; no recorded set is erased. */
  restoreOptionSet(id: string, revision: number): PendingDecisionItem {
    const item = this.get(id)
    if (!item) throw new InboxError(404, 'Decision not found')
    if (item.status !== 'pending' || item.invalidation) throw new InboxError(409, 'Only a pending decision can restore an earlier option set')
    if (item.staging) throw new InboxError(409, 'Choices cannot change while a draft is staged; discard staging first')
    const selected = item.optionSets?.find(set => set.revision === revision)
    if (!selected) throw new InboxError(404, 'Option set not found')
    const history = optionHistory(item)
    const next = { ...item, choices: selected.choices.map(choice => ({ ...choice })),
      recommendation: structuredClone(selected.recommendation),
      optionSets: [...history, { ...cloneOptionSet(selected), revision: Math.max(0, ...history.map(set => set.revision)) + 1,
        createdAt: Math.max(Date.now(), (history.at(-1)?.createdAt ?? 0) + 1), restoredFrom: selected.revision }] } as PendingDecisionItem
    if (selected.hiddenOptions?.length) next.hiddenOptions = selected.hiddenOptions.map(choice => ({ ...choice }))
    else delete next.hiddenOptions
    this.save(next, item)
    return next
  }
  syncTickets(items: PendingDecisionItem[]): void {
    const active = new Set(items.map(item => item.id))
    for (const item of this.list()) if (item.ticketId && item.status === 'pending' && !active.has(item.id)) {
      this.invalidate(item, 'Ticket no longer needs this input, or its question changed.')
    }
    for (const item of items) this.put(item)
  }
  private invalidate(item: PendingDecisionItem, reason: string, sourceSeq?: number, at = Date.now()): void {
    if (item.status === 'stale' || item.invalidation) return
    this.save({ ...item, ...(item.status === 'pending' ? { status: 'stale' as const, staleReason: reason } : {}), invalidation: { at, reason, ...(sourceSeq === undefined ? {} : { sourceSeq }) } }, item)
  }
  stale(sessionId: string, reason: string): void {
    for (const item of this.list()) if (item.sessionId === sessionId) this.invalidate(item, reason)
  }
  stage(id: string, request: StageDecisionRequest): DecisionStagingResult {
    const item = this.get(id)
    if (!item) throw new InboxError(404, 'Decision not found')
    if (item.status !== 'pending' || item.invalidation) throw new InboxError(409, 'Decision is stale or closed; no staging is allowed')
    if (!item.sessionId || !item.sourceMessageId || item.sourceSeq === undefined) throw new InboxError(409, 'A current native source identity and sequence are required for linked submission')
    if (!item.choices.some(choice => choice.id === request.choiceId)) throw new InboxError(400, 'Unknown decision choice')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.attemptId) || !request.draftText) throw new InboxError(400, 'A UUID staging attempt and complete draft text are required')
    if (item.staging && (item.staging.attemptId !== request.attemptId || item.staging.choiceId !== request.choiceId)) throw new InboxError(409, 'A conflicting staging attempt already exists; discard that attempt explicitly')
    const expectedPrompt = choicePrompt(item, request.choiceId).trim()
    if (!expectedPrompt || !request.draftText.includes(expectedPrompt)) throw new InboxError(409, 'Selected choice prompt changed or is absent from the complete draft; refresh before staging')
    const fingerprint = draftFingerprint(request.draftText), choiceFingerprint = choicesFingerprint(item)
    if (item.staging) {
      if (item.staging.attemptId !== request.attemptId || item.staging.choiceId !== request.choiceId || item.staging.draftFingerprint !== fingerprint || item.staging.choiceFingerprint !== choiceFingerprint) throw new InboxError(409, 'A conflicting staging attempt or changed choices already exist; discard that attempt explicitly')
      if (item.resolutionPolicy !== 'on_send') {
        const next = { ...item, resolutionPolicy: 'on_send' as const }; this.save(next, item)
        return { item: next, staging: item.staging, execution: 'not_executed' }
      }
      return { item, staging: item.staging, execution: 'not_executed' }
    }
    const staging: DecisionStaging = { attemptId: request.attemptId, choiceId: request.choiceId, draftFingerprint: fingerprint, choiceFingerprint, stagedAt: Date.now() }
    const next = { ...item, staging, resolutionPolicy: 'on_send' as const }
    this.save(next, item)
    return { item: next, staging, execution: 'not_executed' }
  }
  discardStaging(id: string, attemptId: string): DecisionDiscardResult {
    const item = this.get(id)
    if (!item) throw new InboxError(404, 'Decision not found')
    if (item.status !== 'pending') throw new InboxError(409, 'Decision is stale or closed')
    if (!item.staging) return { item, execution: 'not_executed' }
    if (item.staging.attemptId !== attemptId) throw new InboxError(409, 'Staging attempt changed; reload before discarding')
    const next = { ...item }; delete next.staging
    this.save(next, item)
    return { item: next, execution: 'not_executed' }
  }
  /** Record explicit native intent before I/O; a queued request identity alone never resolves. */
  linkSubmission(id: string, request: BindDecisionSubmission): DecisionStagingResult {
    const item = this.get(id)
    if (!item) throw new InboxError(404, 'Decision not found')
    if (!item.staging || item.staging.attemptId !== request.attemptId) throw new InboxError(409, 'Staging attempt is missing or changed')
    if (!request.submissionId || request.submissionId.length > 300) throw new InboxError(400, 'Native submission requestId is required')
    if (item.restartExcludedSubmissionIds?.includes(request.submissionId)) throw new InboxError(409, 'A submission before the restart checkpoint cannot resolve this decision')
    if (item.status === 'resolved' && item.resolutionBasis === 'submitted' && (item.staging.submissionIds ?? [item.staging.submissionId]).includes(request.submissionId)) return { item, staging: item.staging, execution: 'not_executed' }
    if (item.status !== 'pending' || item.invalidation) throw new InboxError(409, 'Decision is stale or closed')
    if (!item.sessionId || !item.sourceMessageId || item.sourceSeq === undefined) throw new InboxError(409, 'Native source identity is unavailable')
    if (item.staging.choiceFingerprint !== choicesFingerprint(item)) { this.invalidate(item, 'Choices changed after staging.'); throw new InboxError(409, 'The staged source was invalidated because its choices changed') }
    const staging = item.staging!
    const ids = staging.submissionIds ?? (staging.submissionId ? [staging.submissionId] : [])
    if (!ids.includes(request.submissionId)) {
      if (staging.submissionId ? request.retryOf !== staging.submissionId : request.retryOf !== undefined) throw new InboxError(409, 'Conflicting native submission binding; explicit retryOf must match the current requestId')
      if (ids.length >= 16) throw new InboxError(409, 'Native submission retry limit reached; review staging explicitly')
      const next = { ...item, staging: { ...staging, submissionId: request.submissionId, submissionIds: [...ids, request.submissionId] } }
      this.save(next, item)
    }
    const result = this.get(id)!
    return { item: result, staging: result.staging!, execution: 'not_executed' }
  }
  bindSubmission(id: string, request: BindDecisionSubmission, events: readonly SessionEvent[]): DecisionStagingResult {
    const item = this.get(id)
    if (!item) throw new InboxError(404, 'Decision not found')
    if (item.restartAfterSeq !== undefined && !events.some(event => event.seq === item.restartAfterSeq)) throw new InboxError(409, 'Complete restart checkpoint history is unavailable')
    if (item.restartAfterSeq !== undefined && events.some(event => event.seq <= item.restartAfterSeq! && nativeAdmission(event)?.submissionId === request.submissionId)) throw new InboxError(409, 'A submission before the restart checkpoint cannot resolve this decision')
    if (item.status === 'pending') {
      if (!events.some(event => event.type === 'assistant/message' && event.seq === item.sourceSeq && event.data.message.id === item.sourceMessageId)) throw new InboxError(409, 'The complete durable source history is unavailable or does not match this decision')
      this.reconcileSubmissions(item.sessionId!, events)
      if (this.get(id)?.status === 'stale') throw new InboxError(409, 'The staged source was invalidated before this submission binding')
    }
    const linked = this.linkSubmission(id, request)
    if (linked.item.status === 'resolved') return linked
    this.reconcileSubmissions(item.sessionId!, events)
    const result = this.get(id)!
    if (result.status === 'stale') throw new InboxError(409, 'Native submission does not prove this staged choice; source is stale')
    return { item: result, staging: result.staging!, execution: 'not_executed' }
  }
  /** Only an explicitly bound native request and exact full plaintext can confirm a selected choice. */
  reconcileSubmissions(sessionId: string, events: readonly SessionEvent[]): void {
    for (const initial of this.list()) {
      if (initial.sessionId !== sessionId) continue
      if (initial.status === 'resolved') {
        const obsolete = events.find(event => event.seq > (initial.submittedSeq ?? initial.sourceSeq ?? Infinity) && (event.type === 'user/message' && event.data.source.kind === 'user' || event.type === 'turn/end' && event.data.turn !== decisionSourceTurn(initial, events)))
        if (obsolete) this.invalidate(initial, obsolete.type === 'user/message' ? 'A newer human message continued this conversation.' : 'A newer turn superseded this question.', obsolete.seq, obsolete.time)
        continue
      }
      if (initial.status !== 'pending') continue
      if (!initial.staging) {
        if (initial.restartAfterSeq !== undefined) {
          const obsolete = events.find(event => event.seq > decisionBoundary(initial) && (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'user/message' && event.data.source.kind === 'user'))
          if (obsolete) this.invalidate(initial, 'Conversation continued after this decision was restarted.', obsolete.seq, obsolete.time)
        }
        continue
      }
      const staging = initial.staging
      if (initial.restartAfterSeq !== undefined && !events.some(event => event.seq === initial.restartAfterSeq)) continue
      if (!events.some(event => event.type === 'assistant/message' && event.seq === initial.sourceSeq && event.data.message.id === initial.sourceMessageId)) continue
      if (staging.choiceFingerprint !== choicesFingerprint(initial) || !initial.choices.some(choice => choice.id === staging.choiceId)) { this.invalidate(initial, 'Choices changed after staging.'); continue }
      const bindings = staging.submissionIds ?? (staging.submissionId ? [staging.submissionId] : [])
      let candidate: DecisionStaging['candidateSubmission']
      for (const event of events.filter(event => event.seq > decisionBoundary(initial)).sort((a, b) => a.seq - b.seq)) {
        if (initial.restartAfterSeq !== undefined && !candidate && event.type === 'turn/start') {
          this.invalidate(initial, 'Conversation continued after this decision was restarted.', event.seq, event.time)
          break
        }
        if (event.type === 'user/message' && event.data.source.kind === 'user') {
          const admission = nativeAdmission(event)
          const matching = admission && draftFingerprint(admission.text) === staging.draftFingerprint
          if (candidate || !matching) { this.invalidate(initial, 'A newer unrelated human message continued this conversation.', event.seq, event.time); break }
          if (bindings.includes(admission.submissionId)) {
            const resolved: PendingDecisionItem = { ...initial, status: 'resolved', resolvedChoice: staging.choiceId, resolvedAt: event.time,
              resolutionBasis: 'submitted', submissionId: admission.submissionId, submittedMessageId: admission.messageId, submittedSeq: event.seq }
            this.save(resolved, initial)
            const obsolete = events.find(later => later.seq > event.seq && (later.type === 'user/message' && later.data.source.kind === 'user' || later.type === 'turn/end' && later.data.turn !== decisionSourceTurn(initial, events)))
            if (obsolete) this.invalidate(resolved, obsolete.type === 'user/message' ? 'A newer human message continued this conversation.' : 'A newer turn superseded this question.', obsolete.seq, obsolete.time)
            break
          }
          // This fingerprint match is NOT proof. Hold only until an explicit native request binding or invalidation.
          candidate = { submissionId: admission.submissionId, messageId: admission.messageId, seq: event.seq, acceptedAt: event.time }
        }
        if (!candidate && event.type === 'turn/end' && event.data.turn !== decisionSourceTurn(initial, events)) { this.invalidate(initial, 'A newer turn superseded this question.', event.seq, event.time); break }
      }
      if (candidate && this.get(initial.id)?.status === 'pending' && JSON.stringify(candidate) !== JSON.stringify(staging.candidateSubmission)) this.save({ ...initial, staging: { ...staging, candidateSubmission: candidate } }, initial)
    }
  }
  /** Reconcile a complete immutable session snapshot. A watermark prevents cold reads racing newer live events. */
  capture(sessionId: string, events: readonly SessionEvent[], title = 'Conversation decision'): void {
    this.reconcileSubmissions(sessionId, events)
    const lastSeq = events.at(-1)?.seq ?? -1
    const cursor = Number(this.db.prepare('SELECT seq FROM decision_inbox_cursor WHERE session = ?').get(sessionId)?.seq ?? -1)
    if (lastSeq <= cursor) return
    this.db.exec('SAVEPOINT capture_decision')
    try {
      const fresh = events.filter(event => event.seq > cursor)
      for (const event of fresh) if (event.type === 'user/message' && event.data.source.kind === 'user') {
        for (const item of this.list()) if (item.sessionId === sessionId && event.seq > decisionBoundary(item)
          && item.staging?.candidateSubmission?.seq !== event.seq && item.submittedSeq !== event.seq) this.invalidate(item, 'A newer human message continued this conversation.', event.seq, event.time)
      }
      // Only the newest completed turn can request input; tool-step commentary and interrupted prefixes are not asks.
      const end = events.findLast(event => event.type === 'turn/end')
      if (end?.type === 'turn/end' && end.seq > cursor) {
        for (const item of this.list()) if (item.sessionId === sessionId && end.seq > decisionBoundary(item) && end.data.turn !== decisionSourceTurn(item, events)
          && !(item.status === 'pending' && item.staging?.candidateSubmission)) this.invalidate(item, 'A newer turn superseded this question.', end.seq, end.time)
        const message = events.findLast(event => event.type === 'assistant/message' && event.data.turn === end.data.turn)
        if (end.data.reason.kind === 'completed' && message?.type === 'assistant/message' && !message.data.interrupted) {
          const text = message.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
          const alternatives = parseInlineAlternatives(text)
          const question = alternatives?.question ?? decisionQuestion(text)
          const laterHuman = events.some(event => event.seq > end.seq && event.type === 'user/message' && event.data.source.kind === 'user')
          if (question && !laterHuman) {
            const sourceMessageId = message.data.message.id
            const id = `chat-${createHash('sha256').update(`${sessionId}\0${sourceMessageId}`).digest('hex').slice(0, 32)}`
            // Explicit alternatives stay verbatim; either path is padded to the option minimum.
            const { choices, hiddenOptions } = normalizeChoices(alternatives?.choices ?? [])
            this.put({ id, sessionId, sourceMessageId, sourceTurn: end.data.turn, sourceSeq: message.seq,
              ticketTitle: title, trigger: 'Explicit chat follow-up', status: 'pending', urgency: 'low', createdAt: end.time,
              context: text.slice(-30000), question, recommendation, advisor: { status: 'pending' },
              choices, ...(hiddenOptions.length ? { hiddenOptions } : {}) })
          }
        }
      }
      this.db.prepare('INSERT INTO decision_inbox_cursor(session,seq) VALUES (?,?) ON CONFLICT(session) DO UPDATE SET seq=excluded.seq').run(sessionId, lastSeq)
      this.db.exec('RELEASE capture_decision')
    } catch (error) { this.db.exec('ROLLBACK TO capture_decision; RELEASE capture_decision'); throw error }
  }
  resolve(id: string, choiceId: string): DecisionResolution {
    let item = this.get(id)
    if (!item) throw new InboxError(404, 'Decision not found')
    if (item.status === 'stale') throw new InboxError(409, 'Decision is stale. Open the source conversation for current context.')
    const choice = item.choices.find(choice => choice.id === choiceId)
    if (!choice) throw new InboxError(400, 'Unknown decision choice')
    if (item.resolvedChoice && item.resolvedChoice !== choiceId) throw new InboxError(409, 'Decision already resolved with another choice')
    if (item.status !== 'resolved' || item.resolutionBasis !== 'submitted' || item.resolvedChoice !== choiceId) throw new InboxError(409, 'Linked native submission required. Stage the choice and bind its native requestId; drafting alone cannot resolve a decision.')
    return { resolved: true, choiceId, execution: 'not_executed', draft: { ...(item.sessionId ? { sessionId: item.sessionId } : {}), text: item.draftResponse ?? choice.prompt ?? choice.label }, item }
  }
}

/** List completed human task threads without invoking a model; tool/internal continuations do not create new asks. */
export function captureAdvisorTask(inbox: DecisionInbox, sessionId: string, events: readonly SessionEvent[]): void {
  const endIndex = events.findLastIndex(event => event.type === 'turn/end')
  const end = events[endIndex]
  if (end?.type !== 'turn/end' || end.data.reason.kind !== 'completed') return
  if (events.some(event => event.seq > end.seq && (event.type === 'turn/start' || event.type === 'user/message' && event.data.source.kind === 'user'))) return
  const before = events.slice(0, endIndex)
  const previous = before.findLast(event => event.type === 'turn/end')
  const human = before.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
  if (human?.type !== 'user/message' || previous && human.seq <= previous.seq) return
  const request = human.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n').split('Current runtime context.')[0]!.trim()
  if (request.length < 8 || /diagnostic only|reply exactly|^(?:ping|pong)\b/i.test(request)) return
  const assistant = before.findLast(event => event.type === 'assistant/message' && event.data.turn === end.data.turn)
  if (assistant?.type !== 'assistant/message' || assistant.data.interrupted) return
  const text = assistant.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim()
  if (text.length < 20) return
  inbox.ensureAdvisor({ sessionId, sourceMessageId: assistant.data.message.id, sourceTurn: end.data.turn, sourceSeq: assistant.seq,
    key: String(end.seq), question: decisionQuestion(text) ?? 'Choose the next step for this thread', context: text,
    title: request.replace(/\s+/g, ' ').slice(0, 120), createdAt: end.time })
}

/** Read complete persisted history, never only the currently mounted page or a queued native echo. */
export async function durableDecisionEvents(ctx: Context, sessionId: string): Promise<SessionEvent[]> {
  await ctx.sessionPersistence.flush()
  await using handle = await ctx.sessionPersistence.open(sessionId as SessionId, 'read')
  const events: SessionEvent[] = []
  for (let offset = 0; ; ) {
    const page = await handle.read(offset, 512)
    if (!page.events.length) break
    events.push(...page.events); offset += page.events.length
  }
  return events
}
/** Use server-owned durable history, never a browser-supplied checkpoint or parent snapshot. */
export async function restartDecision(ctx: Context, inbox: DecisionInbox, id: string, request: RestartDecisionRequest): Promise<DecisionRestartResult> {
  const parent = inbox.get(id)
  if (!parent) throw new InboxError(404, 'Decision not found')
  if (!parent.sessionId || parent.sessionId !== request.sessionId) throw new InboxError(409, 'Decision does not belong to this session')
  if (parent.status !== 'resolved') throw new InboxError(409, 'Only a recorded decision can be restarted')
  return { item: inbox.startNewDecision(id, await durableDecisionEvents(ctx, parent.sessionId)), execution: 'not_executed' }
}
/** Revalidate the durable source before accepting a new staged selection. */
export async function stageDecision(ctx: Context, inbox: DecisionInbox, id: string, request: StageDecisionRequest): Promise<DecisionStagingResult> {
  const item = inbox.get(id)
  if (!item) throw new InboxError(404, 'Decision not found')
  if (item.status !== 'pending' || item.invalidation) throw new InboxError(409, 'Decision is stale or closed; no staging is allowed')
  if (!item.sessionId || !item.sourceMessageId || item.sourceSeq === undefined) throw new InboxError(409, 'A current native source identity and sequence are required for linked submission')
  const events = await durableDecisionEvents(ctx, item.sessionId)
  if (!events.some(event => event.type === 'assistant/message' && event.seq === item.sourceSeq && event.data.message.id === item.sourceMessageId)) throw new InboxError(409, 'The complete durable source history is unavailable or does not match this decision')
  if (item.restartAfterSeq !== undefined && !events.some(event => event.seq === item.restartAfterSeq)) throw new InboxError(409, 'Complete restart checkpoint history is unavailable')
  const end = events.findLast(event => event.type === 'turn/end')
  const current = end?.type === 'turn/end' ? events.findLast(event => event.type === 'assistant/message' && event.data.turn === end.data.turn) : undefined
  if (end?.type !== 'turn/end' || end.data.reason.kind !== 'completed' || current?.type !== 'assistant/message' || current.data.interrupted
    || (item.restartAfterSeq === undefined && (current.data.message.id !== item.sourceMessageId || current.seq !== item.sourceSeq))
    || events.some(event => event.seq > end.seq && event.type === 'turn/start')
    || (item.restartAfterSeq !== undefined && events.some(event => event.seq > item.restartAfterSeq! && (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'user/message' && event.data.source.kind === 'user')))) throw new InboxError(409, 'Decision source changed or is no longer the current completed assistant response')
  inbox.capture(item.sessionId, events)
  return inbox.stage(id, request)
}
/** Persist explicit native intent before I/O; confirm only against complete durable history. */
export async function submitDecision(ctx: Context, inbox: DecisionInbox, id: string, request: BindDecisionSubmission): Promise<DecisionStagingResult> {
  const item = inbox.get(id)
  if (!item) throw new InboxError(404, 'Decision not found')
  if (!item.sessionId) throw new InboxError(409, 'Native source session is required')
  const linked = inbox.linkSubmission(id, request)
  if (linked.item.status === 'resolved') return linked
  return inbox.bindSubmission(id, request, await durableDecisionEvents(ctx, item.sessionId))
}

/** Installed independently of chat mounts and setup state; also recovers missed turns from durable histories. */
export function registerDecisionCapture(ctx: Context, inbox: () => DecisionInbox): { ready: Promise<void>; dispose: () => void } {
  let disposed = false
  const dispose = ctx.on('session/event', async (session, event) => {
    if (event.type === 'turn/end' || (event.type === 'user/message' && event.data.source.kind === 'user')) {
      try {
        const events = await durableDecisionEvents(ctx, session.id)
        if (disposed) return
        inbox().capture(session.id, events)
        if (session.header?.origin !== 'subagent' && !(session.header?.delegationDepth ?? 0)) captureAdvisorTask(inbox(), session.id, events)
      }
      catch (error) { if (!disposed) ctx.logger.error('Decision inbox capture failed: %s', String(error)) }
    }
  })
  const ready = (async () => {
    await ctx.sessionPersistence.flush()
    for (const snapshot of await ctx.sessionPersistence.list()) {
      if (disposed) return
      try {
        const events = await durableDecisionEvents(ctx, snapshot.header.id)
        if (!disposed) {
          inbox().capture(snapshot.header.id, events)
          if (snapshot.header.origin !== 'subagent' && !(snapshot.header.delegationDepth ?? 0)) captureAdvisorTask(inbox(), snapshot.header.id, events)
        }
      } catch (error) { ctx.logger.warn('Decision inbox recovery skipped %s: %s', snapshot.header.id, String(error)) }
    }
  })().catch(error => { ctx.logger.error('Decision inbox recovery failed: %s', String(error)) })
  return { ready, dispose: () => { disposed = true; dispose() } }
}
