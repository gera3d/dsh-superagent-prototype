/** Durable, server-wide capture of explicit end-of-turn questions. No choice executes or sends anything. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import type { AdvisorDecision, AuthoritativeUserSource, DecisionEvaluationResult, DecisionOptionSet, DecisionStaging, PendingDecisionItem } from '../core/decision.ts'
import { normalizeChoices } from '../core/options.ts'
import { ticketStage, latestReport, type Ticket } from '../core/index.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { isStallGuardStuck } from '../core/stall-guard.ts'
import { parseInlineAlternatives } from '../client/inline-alternatives.ts'
import { isConversationCloseoutEvents, CONVERSATION_CLOSED_REASON, CONVERSATION_CLOSED_MESSAGE } from './conversation-closeout.ts'
import { FindingStore } from './finding.ts'
import { DeliveryStore } from './feature-delivery.ts'
import { workerTicket } from './delivery-currency.ts'
import { auditOptionSet, deriveOptionQualityContext, type OptionQualityContext } from './option-quality.ts'

function tableExists(db: DatabaseSync, tableName: string): boolean {
  try {
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName)
    return Boolean(row)
  } catch {
    return false
  }
}

/** Same ticket projection for the regular runtime and independently loaded inbox provider. */
export function ticketDecisions(tickets: Ticket[]): PendingDecisionItem[] {
  return tickets.flatMap(ticket => {
    if (ticket.ended) return []
    const assignment = ticket.assignments.at(-1)
    const pr = ticket.follows?.filter(follow => !follow.closed && /^github:[1-9]\d*$/.test(follow.thread))
    const done = assignment?.report?.state === 'ready' && pr?.length === 1 && !!assignment.idleAt && assignment.idleAt >= assignment.report.at
      && (!assignment.deliveredAt || assignment.deliveredAt <= assignment.idleAt) && !ticket.attention && !ticket.delivery && !ticket.undelivered.length
    const stuck = isStallGuardStuck(ticket)
    if (assignment && (stuck || done)) {
      const kind = stuck ? 'stuck' : 'done'
      const prNumber = done ? Number(pr![0]!.thread.slice(7)) : undefined
      const checkpoint = stuck ? ticket.stallGuard!.stuckAt! : assignment.report!.at
      const issue = ticket.channels.find(channel => channel.source === 'github' && /^[1-9]\d*$/.test(channel.address.number ?? ''))?.address.number
      // A later idle episode gets a fresh identity; stale history is never resurrected in place.
      return [{ id: `life-${ticket.id}-${createHash('sha256').update(`${assignment.id}:${kind}:${checkpoint}:${prNumber ?? ''}:${assignment.idleAt ?? ''}`).digest('hex').slice(0, 16)}`,
        ticketId: ticket.id, sessionId: workerSessionId(ticket.id), ticketTitle: ticket.title,
        trigger: stuck ? 'Worker stayed idle after one recovery attempt.' : 'Ready report with a bound pull request.',
        status: 'pending' as const, urgency: 'low' as const, createdAt: Date.parse(checkpoint),
        context: stuck ? 'No new progress after recovery. Retry starts a fresh assignment with the original task.' : (assignment.report?.summary ?? 'Work is ready for review.'),
        question: stuck ? 'This ticket is stuck' : 'Ready to review', actionMode: 'ticket_lifecycle' as const,
        lifecycle: { kind, assignmentId: assignment.id, ...(prNumber ? { prNumber, docsOnly: false } : {}), ...(issue ? { issueNumber: Number(issue) } : {}) },
        choices: stuck ? [{ id: 'retry', label: 'Retry' }, { id: 'open_issue', label: 'Open issue' }]
          : [{ id: 'try_it', label: 'Try it' }, { id: 'changes_needed', label: 'Changes needed' }], recommendation }] as PendingDecisionItem[]
    }
    if (ticketStage(ticket).stage !== 'person') return []
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
export interface CanonicalSource { sessionId: string; sourceMessageId: string; sourceTurn: number; sourceSeq: number; draftRevision: string }
export interface CanonicalClaim extends CanonicalSource { owner: string; purpose?: 'score' }
export interface CanonicalWrite extends CanonicalSource { leaseToken: string }
export interface CanonicalPublish extends CanonicalWrite { model: string; options: AdvisorDecision['options'] }
export interface CanonicalScore extends CanonicalWrite { evaluation: DecisionEvaluationResult }
export interface CanonicalFailure extends CanonicalWrite { error: string }
export interface CanonicalResult { item: PendingDecisionItem; claimed?: boolean; leaseToken?: string; leaseExpiresAt?: number }
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

/** Derive authoritative user source proof from server session events bound to a specific turn. */
export function deriveTurnUserSource(events?: readonly SessionEvent[], sourceTurn?: number, sourceSeq?: number): AuthoritativeUserSource | undefined {
  if (!events || !events.length) return undefined
  const endIdx = sourceSeq !== undefined ? events.findIndex(e => e.seq === sourceSeq) : -1
  const searchSpace = endIdx >= 0 ? events.slice(0, endIdx) : events
  const prevEnd = sourceTurn !== undefined
    ? searchSpace.findLast(e => e.type === 'turn/end' && (e.data as any)?.turn !== undefined && (e.data as any).turn < sourceTurn)
    : searchSpace.findLast(e => e.type === 'turn/end')
  const minSeq = prevEnd ? prevEnd.seq : -1
  const human = searchSpace.findLast(e =>
    e.type === 'user/message'
    && e.seq > minSeq
    && (e.data as any)?.source?.kind === 'user'
    && Number.isFinite(e.time)
  )
  if (!human) return undefined
  return {
    kind: 'user',
    time: human.time,
    seq: human.seq,
    turn: sourceTurn,
    messageId: (human.data as any)?.message?.id ?? (human.data as any)?.id,
  }
}

/** SQLite-backed shared decisions with CAS staging, durable native submission proof and preserved resolution history. */
export class DecisionInbox {
  constructor(readonly db: DatabaseSync, private readonly changed?: (item: PendingDecisionItem) => void) {
    db.exec(`CREATE TABLE IF NOT EXISTS decision_inbox (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decision_inbox_cursor (session TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS decision_inbox_canonical_guard BEFORE UPDATE OF value ON decision_inbox
      WHEN json_type(OLD.value, '$.canonical') = 'object'
      BEGIN
        SELECT CASE WHEN json_extract(NEW.value, '$.canonical.draftRevision') IS NOT json_extract(OLD.value, '$.canonical.draftRevision')
          OR json_extract(NEW.value, '$.sessionId') IS NOT json_extract(OLD.value, '$.sessionId')
          OR json_extract(NEW.value, '$.sourceMessageId') IS NOT json_extract(OLD.value, '$.sourceMessageId')
          OR json_extract(NEW.value, '$.sourceTurn') IS NOT json_extract(OLD.value, '$.sourceTurn')
          OR json_extract(NEW.value, '$.sourceSeq') IS NOT json_extract(OLD.value, '$.sourceSeq')
          THEN RAISE(ABORT, 'Canonical source and revision are immutable') END;
        SELECT CASE WHEN json_extract(OLD.value, '$.canonical.phase') IN ('ready', 'scored')
          AND (json_extract(NEW.value, '$.choices') IS NOT json_extract(OLD.value, '$.choices')
            OR json_extract(NEW.value, '$.canonical.phase') NOT IN ('ready', 'scored'))
          THEN RAISE(ABORT, 'Published canonical choices are immutable') END;
        SELECT CASE WHEN json_type(OLD.value, '$.staging') = 'object'
          AND json_extract(NEW.value, '$.recommendation') IS NOT json_extract(OLD.value, '$.recommendation')
          THEN RAISE(ABORT, 'Staged canonical recommendation is immutable') END;
      END;
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
      if (!existing.parentDecisionId && !existing.canonical && !existing.staging && existing.status === 'pending' && !existing.recommendation.recommendedValue
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
    if (item.actionMode === 'finding_triage' || item.finding || item.id.startsWith('finding-')) throw new InboxError(400, 'Finding decisions are server-owned projections')
    if (item.actionMode === 'feature_delivery' || item.delivery || item.id.startsWith('delivery-')) throw new InboxError(400, 'Delivery decisions are server-owned projections')
    if (item.id.startsWith('life-') && item.actionMode !== 'ticket_lifecycle') throw new InboxError(400, 'Lifecycle decisions are server-owned')
    const saved = { ...item, actionMode: item.lifecycle ? 'ticket_lifecycle' as const : 'stage_response' as const }
    this.save(saved)
    return saved
  }
  /**
   * Record which specialist advised this SAME decision. Attribution only: choices, recommendation and staging are
   * untouched, and a staged, closed or invalidated record refuses it (CAS, like every other writer).
   */
  attributeCharacter(id: string, character: NonNullable<PendingDecisionItem['character']>): PendingDecisionItem {
    const item = this.get(id)
    if (!item) throw new InboxError(404, 'Decision not found')
    if (item.status !== 'pending' || item.staging || item.invalidation) throw new InboxError(409, 'Only an open, unstaged decision can be attributed')
    const next = { ...item, character: { ...character } }
    this.save(next, item)
    return next
  }
  findSource(source: { sessionId: string; sourceMessageId?: string; sourceTurn?: number }): PendingDecisionItem | undefined {
    // list() places newer descendants ahead of their parents (strictly increasing createdAt).
    return this.list().find(item => item.sessionId === source.sessionId && (
      !!source.sourceMessageId && item.sourceMessageId === source.sourceMessageId
      || source.sourceTurn !== undefined && item.sourceTurn === source.sourceTurn))
  }
  advisorState(id: string, advisor: NonNullable<PendingDecisionItem['advisor']>): void {
    const item = this.get(id)
    if (item?.status === 'pending' && !item.canonical && !item.staging) this.save({ ...item, advisor }, item)
  }
  /** Capture a user-visible completed task before advising it; empty choices explicitly mean not yet advised. */
  ensureAdvisor(input: Omit<AdvisorDecision, 'options' | 'model'> & { human?: boolean; userSource?: AuthoritativeUserSource }, events?: readonly SessionEvent[]): PendingDecisionItem {
    const existing = this.findSource(input)
    if (existing) return existing
    const id = `chat-${createHash('sha256').update(`${input.sessionId}\0${input.sourceMessageId ?? `turn:${input.sourceTurn ?? input.key}`}`).digest('hex').slice(0, 32)}`
    const choices: PendingDecisionItem['choices'] = [], hiddenOptions: PendingDecisionItem['choices'] = []
    const userSource = input.userSource ?? deriveTurnUserSource(events, input.sourceTurn, input.sourceSeq)
    const human = input.human ?? (userSource !== undefined ? true : undefined)
    const item: PendingDecisionItem = { id, sessionId: input.sessionId, sourceMessageId: input.sourceMessageId,
      sourceTurn: input.sourceTurn, sourceSeq: input.sourceSeq, question: input.question, context: input.context.slice(-30000),
      ticketTitle: input.title ?? 'Conversation next steps', trigger: 'Task-specific next steps', status: 'pending', urgency: 'low',
      createdAt: input.createdAt, actionMode: 'stage_response', choices, ...(hiddenOptions.length ? { hiddenOptions } : {}),
      recommendation, advisor: { status: 'pending', key: input.key },
      ...(human !== undefined ? { human } : {}),
      ...(userSource ? { userSource } : {}) }
    this.save(item)
    return item
  }
  /** Publish the real advisor output as a new option-set revision, never overwrite or revive a closed item. */
  publishAdvisor(input: AdvisorDecision, events?: readonly SessionEvent[]): PendingDecisionItem {
    const existing = this.findSource(input)
    if (existing && (existing.status !== 'pending' || existing.parentDecisionId || existing.canonical)) return existing
    try {
      if (tableExists(this.db, 'finding')) {
        const ticketId = input.sessionId.replace(/^worker-/, '')
        const findings = new FindingStore(this.db)
        const resolved = findings.list().find(f =>
          (f.state === 'resolved' || Boolean(f.resolution))
          && (f.id === ticketId || f.sessionId === input.sessionId || f.job?.ticketId === ticketId || f.priorJobs?.some(pj => pj.ticketId === ticketId))
        )
        if (resolved && !existing) {
          throw new InboxError(409, 'Finding is already resolved; pending advice cannot be published')
        }
      }
    } catch (e) {
      if (e instanceof InboxError) throw e
    }
    if (!input.options.length || input.options.some(option => !option.id || !option.label?.trim() || !option.prompt?.trim())
      || input.options.filter(option => option.recommended).length !== 1) throw new InboxError(400, 'Invalid advisor choices')
    const qualityContext = this.deriveAuthoritativeQualityContext(input.sessionId, undefined, input.title)
    const audit = auditOptionSet(input.options, qualityContext)
    if (!audit.valid) {
      throw new InboxError(400, `Invalid advisor choices: ${audit.issues.map(i => i.message).join('; ')}`)
    }
    const selected = input.options.find(option => option.recommended)!
    // Keep the recommendation visible: it is always first, whatever the caller's order.
    const ordered = [selected, ...input.options.filter(option => option !== selected)].map(option => ({ id: option.id,
      label: option.label, description: option.why, prompt: option.prompt, ...(option.added ? { added: true } : {}) }))
    const { choices, hiddenOptions } = normalizeChoices(ordered)
    const recommendation: DecisionEvaluationResult = { recommendedValue: selected.id, confidence: 0, rationale: selected.why, distribution: [], provider: input.model, latencyMs: 0 }
    const id = existing?.id ?? `chat-${createHash('sha256').update(`${input.sessionId}\0${input.sourceMessageId ?? `turn:${input.sourceTurn ?? input.key}`}`).digest('hex').slice(0, 32)}`
    const userSource = existing?.userSource ?? deriveTurnUserSource(events, input.sourceTurn, input.sourceSeq)
    const human = existing?.human ?? (userSource !== undefined ? true : undefined)
    const item: PendingDecisionItem = { ...(existing ?? {}), id, sessionId: input.sessionId,
      sourceMessageId: input.sourceMessageId, sourceTurn: input.sourceTurn, sourceSeq: input.sourceSeq,
      ticketTitle: existing?.ticketTitle ?? input.title ?? 'Conversation next steps', trigger: 'Task-specific next steps',
      question: existing?.question ?? input.question, context: existing?.context ?? input.context.slice(-30000),
      createdAt: existing?.createdAt ?? input.createdAt, urgency: existing?.urgency ?? 'low', status: 'pending', actionMode: 'stage_response',
      choices, ...(hiddenOptions.length ? { hiddenOptions } : {}),
      recommendation, advisor: { status: 'ready', model: input.model, key: input.key },
      ...(human !== undefined ? { human } : {}),
      ...(userSource ? { userSource } : {}) }
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
  /** Validate complete server-owned history before every producer mutation. */
  private canonicalSource(input: CanonicalSource, events: readonly SessionEvent[]): PendingDecisionItem | undefined {
    const end = events.findLast(event => event.type === 'turn/end')
    const message = events.findLast(event => event.type === 'assistant/message')
    if (end?.type !== 'turn/end' || end.data.reason.kind !== 'completed' || end.data.turn !== input.sourceTurn
      || message?.type !== 'assistant/message' || message.data.interrupted || message.data.turn !== input.sourceTurn
      || message.seq !== input.sourceSeq || message.data.message.id !== input.sourceMessageId || message.seq >= end.seq
      || events.some(event => event.seq > end.seq && (event.type === 'turn/start' || event.type === 'user/message' && event.data.source.kind === 'user')))
      throw new InboxError(409, 'Canonical source is not the current durable completed turn')
    const item = this.findSource(input)
    // A completed close-out is neither an error nor a new task: retire unstaged advice and refuse to open more.
    // Staged or submitted work keeps its own guards below.
    if (!item?.staging && isConversationCloseoutEvents(events, input.sourceTurn)) {
      this.retireClosedOut(input.sessionId, events)
      throw new InboxError(409, CONVERSATION_CLOSED_MESSAGE)
    }
    if (item && (item.status !== 'pending' || item.invalidation || item.parentDecisionId)) throw new InboxError(409, 'Canonical decision is staged, stale or closed')
    if (item && (item.sourceSeq !== input.sourceSeq || item.sourceTurn !== input.sourceTurn || item.sourceMessageId !== input.sourceMessageId)) throw new InboxError(409, 'Canonical source identity changed')
    if (item?.canonical && item.canonical.draftRevision !== input.draftRevision) throw new InboxError(409, 'Canonical draft revision changed')
    if (!item?.staging && this.isSourceScopeResolved(input.sessionId, events, input.sourceTurn, input.sourceSeq)) {
      throw new InboxError(409, 'Scope is completed and resolved; pending advice cannot be claimed or published')
    }
    return item
  }
  /** Explicit CAS correction only: preserve published choices in their original immutable row. */
  reviseCanonical(input: CanonicalSource & { expectedDecisionId: string; reason: string }, events: readonly SessionEvent[]): CanonicalResult {
    const previous = this.canonicalSource(input, events)
    if (!previous || previous.id !== input.expectedDecisionId || !previous.canonical || previous.staging
      || !['ready', 'scored'].includes(previous.canonical.phase) || previous.actionMode !== 'stage_response')
      throw new InboxError(409, 'Only the current unstaged published chat recommendation can be corrected')
    const id = `chat-${createHash('sha256').update(`${previous.id}:correction`).digest('hex').slice(0, 32)}`
    const item: PendingDecisionItem = { id, supersedesDecisionId: previous.id, sessionId: previous.sessionId,
      sourceMessageId: previous.sourceMessageId, sourceSeq: previous.sourceSeq, sourceTurn: previous.sourceTurn,
      ticketTitle: previous.ticketTitle, trigger: 'Corrected next steps', status: 'pending', urgency: previous.urgency,
      createdAt: Math.max(Date.now(), previous.createdAt + 1), actionMode: 'stage_response', question: previous.question,
      context: previous.context, choices: [], recommendation, advisor: { status: 'pending', key: input.draftRevision } }
    this.db.exec('SAVEPOINT revise_recommendation')
    try {
      this.invalidate(previous, `Recommendation superseded by ${id}: ${input.reason}`)
      this.save(item)
      this.db.exec('RELEASE revise_recommendation')
    } catch (error) { this.db.exec('ROLLBACK TO revise_recommendation; RELEASE revise_recommendation'); throw error }
    return { item }
  }
  claimCanonical(input: CanonicalClaim, events: readonly SessionEvent[], now = Date.now()): CanonicalResult {
    let item = this.canonicalSource(input, events)
    const userSource = item?.userSource ?? deriveTurnUserSource(events, input.sourceTurn, input.sourceSeq)
    const human = item?.human ?? (userSource !== undefined ? true : undefined)
    if (!item) {
      const source = events.find(event => event.seq === input.sourceSeq)!
      const text = source.type === 'assistant/message' ? source.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : ''
      item = this.ensureAdvisor({ ...input, key: input.draftRevision, question: decisionQuestion(text) ?? 'Choose the next step for this thread', context: text, createdAt: source.time, ...(human !== undefined ? { human } : {}), ...(userSource ? { userSource } : {}) }, events)
    }
    if (item.staging) return { item, claimed: false }
    const state = item.canonical
    if (state && (state.phase === 'scored' || state.phase === 'ready' && input.purpose !== 'score')) return { item, claimed: false }
    if (state && state.leaseExpiresAt > now) return state.owner === input.owner
      ? { item, claimed: true, leaseToken: state.leaseToken, leaseExpiresAt: state.leaseExpiresAt } : { item, claimed: false }
    const canonical: NonNullable<PendingDecisionItem['canonical']> = { draftRevision: input.draftRevision, phase: state?.phase ?? 'pending', owner: input.owner, leaseToken: randomUUID(), leaseExpiresAt: now + 120000 }
    const next = { ...item, ...(!state ? { choices: [], hiddenOptions: [], optionSets: optionHistory(item), recommendation } : {}), canonical, advisor: { ...item.advisor, status: canonical.phase === 'pending' ? 'generating' as const : 'ready' as const, key: input.draftRevision }, ...(human !== undefined ? { human } : {}), ...(userSource ? { userSource } : {}) }
    this.save(next, item)
    return { item: next, claimed: true, leaseToken: canonical.leaseToken, leaseExpiresAt: canonical.leaseExpiresAt }
  }
  private canonicalWriter(input: CanonicalWrite, events: readonly SessionEvent[]): PendingDecisionItem {
    const item = this.canonicalSource(input, events)
    if (item?.staging) throw new InboxError(409, 'Canonical decision is staged; publication is locked')
    if (!item?.canonical || item.canonical.leaseToken !== input.leaseToken) throw new InboxError(409, 'Canonical publication lease changed')
    if (item.canonical.leaseExpiresAt <= Date.now()) throw new InboxError(409, 'Canonical publication lease expired')
    return item
  }
  publishCanonical(input: CanonicalPublish, events: readonly SessionEvent[]): CanonicalResult {
    const item = this.canonicalWriter(input, events)
    if (!item?.staging && this.isSourceScopeResolved(input.sessionId, events, input.sourceTurn, input.sourceSeq)) {
      throw new InboxError(409, 'Scope is completed and resolved; pending advice cannot be claimed or published')
    }
    if (input.options.length < 2 || input.options.length > 4 || new Set(input.options.map(option => option.id)).size !== input.options.length
      || input.options.some(option => !option.id || !option.label.trim() || !option.prompt.trim()) || input.options.filter(option => option.recommended).length !== 1) throw new InboxError(400, 'Provide exactly 2–4 distinct helper choices and one recommendation')
    const qualityContext = this.deriveAuthoritativeQualityContext(input.sessionId, events)
    const audit = auditOptionSet(input.options, qualityContext)
    if (!audit.valid) {
      throw new InboxError(400, `Invalid canonical choices: ${audit.issues.map(i => i.message).join('; ')}`)
    }
    const choices = input.options.map(option => ({ id: option.id, label: option.label, prompt: option.prompt, description: option.why }))
    const selected = input.options.find(option => option.recommended)!
    if (item.canonical!.phase !== 'pending') {
      if (JSON.stringify(item.choices) !== JSON.stringify(choices)) throw new InboxError(409, 'Canonical choices were already published')
      return { item }
    }
    const evaluation = { ...recommendation, recommendedValue: selected.id, rationale: selected.why, provider: input.model }
    const userSource = item.userSource ?? deriveTurnUserSource(events, input.sourceTurn, input.sourceSeq)
    const human = item.human ?? (userSource !== undefined ? true : undefined)
    const history = optionHistory(item)
    const next: PendingDecisionItem = { ...item, choices, recommendation: evaluation, canonical: { ...item.canonical!, phase: 'ready' }, advisor: { status: 'ready', model: input.model, key: input.draftRevision },
      optionSets: [...history, { revision: Math.max(0, ...history.map(set => set.revision)) + 1, createdAt: Date.now(), key: input.draftRevision, model: input.model, choices: structuredClone(choices), recommendation: structuredClone(evaluation) }],
      ...(human !== undefined ? { human } : {}),
      ...(userSource ? { userSource } : {}) }
    delete next.hiddenOptions
    this.save(next, item)
    return { item: next }
  }
  scoreCanonical(input: CanonicalScore, events: readonly SessionEvent[]): CanonicalResult {
    const item = this.canonicalWriter(input, events), evaluation = input.evaluation
    if (item.canonical!.phase === 'pending') throw new InboxError(409, 'Publish choices before scoring')
    if (!item.choices.some(choice => choice.id === evaluation.recommendedValue) || evaluation.distribution.length !== item.choices.length
      || evaluation.distribution.some((score, index) => score.id !== item.choices[index]!.id || !Number.isFinite(score.probability) || score.probability < 0 || score.probability > 1)
      || Math.abs(evaluation.distribution.reduce((sum, score) => sum + score.probability, 0) - 1) > 0.01
      || !Number.isFinite(evaluation.confidence) || evaluation.confidence < 0 || evaluation.confidence > 1) throw new InboxError(400, 'Scores must reference published choices with exact choice IDs/order and valid probabilities')
    if (item.canonical!.phase === 'scored') {
      if (JSON.stringify(item.recommendation) !== JSON.stringify(evaluation)) throw new InboxError(409, 'Canonical scores were already published')
      return { item }
    }
    const next = { ...item, recommendation: evaluation, canonical: { ...item.canonical!, phase: 'scored' as const }, optionSets: item.optionSets?.map((set, index, sets) => index === sets.length - 1 ? { ...set, recommendation: structuredClone(evaluation) } : set) }
    delete next.canonical.error
    this.save(next, item); return { item: next }
  }
  failCanonical(input: CanonicalFailure, events: readonly SessionEvent[]): CanonicalResult {
    const item = this.canonicalWriter(input, events)
    if (item.canonical!.phase === 'scored') return { item }
    const next = { ...item, canonical: { ...item.canonical!, error: input.error, ...(item.canonical!.phase === 'pending' ? { leaseExpiresAt: 0 } : {}) },
      advisor: { ...item.advisor, status: item.canonical!.phase === 'pending' ? 'error' as const : 'ready' as const, error: input.error } }
    this.save(next, item); return { item: next }
  }
  /** Restore an earlier set by appending it as a new revision; no recorded set is erased. */
  restoreOptionSet(id: string, revision: number): PendingDecisionItem {
    const item = this.get(id)
    if (!item) throw new InboxError(404, 'Decision not found')
    if (item.status !== 'pending' || item.invalidation) throw new InboxError(409, 'Only a pending decision can restore an earlier option set')
    if (item.canonical) throw new InboxError(409, 'Canonical published choices are immutable; earlier option history remains available for inspection')
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
  syncTickets(items: PendingDecisionItem[], openTickets?: readonly { id: string; ended?: unknown }[]): void {
    const active = new Set(items.map(item => item.id))
    const openSet = openTickets ? new Set(openTickets.filter(t => !t.ended).map(t => t.id)) : undefined
    for (const item of this.list()) {
      if (item.actionMode === 'feature_delivery') continue // Durable aggregate, not worker-session lifetime.
      if (item.status === 'pending') {
        if (item.ticketId && !active.has(item.id)) {
          this.invalidate(item, 'Ticket no longer needs this input, or its question changed.')
        } else if (!(item.id.startsWith('chat-') && (item.staging || decisionQuestion(item.context) || decisionQuestion(item.question))) && item.sessionId?.startsWith('worker-')) {
          const workerTicketId = item.sessionId.slice(7)
          if (openSet ? !openSet.has(workerTicketId) : (items.length > 0 && !items.some(t => t.ticketId === workerTicketId || t.sessionId === item.sessionId))) {
            this.invalidate(item, 'The originating session has ended. This decision can no longer be answered.')
          }
        }
      }
    }
    for (const item of items) this.put(item)
  }
  /**
   * Retire still-unstaged chat advice for the latest completed turn when the durable history shows an explicit,
   * un-reopened close-out. Choices, scores and option history stay on the row; staged/submitted work keeps its guards.
   */
  retireClosedOut(sessionId: string, events: readonly SessionEvent[]): void {
    const end = events.findLast(event => event.type === 'turn/end')
    if (end?.type !== 'turn/end' || end.data.reason.kind !== 'completed' || !isConversationCloseoutEvents(events, end.data.turn)) return
    for (const item of this.list()) {
      if (item.sessionId !== sessionId || item.status !== 'pending' || item.invalidation || item.staging || item.lifecycle || item.parentDecisionId
        || item.actionMode && item.actionMode !== 'stage_response' || decisionSourceTurn(item, events) !== end.data.turn) continue
      this.invalidate(item, CONVERSATION_CLOSED_REASON, end.seq, end.time)
    }
  }
  invalidate(item: PendingDecisionItem, reason: string, sourceSeq?: number, at = Date.now()): void {
    if (item.status === 'stale' || item.invalidation) return
    this.save({ ...item, ...(item.status === 'pending' ? { status: 'stale' as const, staleReason: reason } : {}), invalidation: { at, reason, ...(sourceSeq === undefined ? {} : { sourceSeq }) } }, item)
  }
  stale(sessionId: string, reason: string): void {
    for (const item of this.list()) if (item.sessionId === sessionId) this.invalidate(item, reason)
  }
  stage(id: string, request: StageDecisionRequest): DecisionStagingResult {
    const item = this.get(id)
    if (!item) throw new InboxError(404, 'Decision not found')
    if (item.lifecycle) throw new InboxError(409, 'Use the explicit lifecycle action endpoint')
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
      if (initial.sessionId !== sessionId || initial.lifecycle) continue
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
    this.retireClosedOut(sessionId, events)
    const lastSeq = events.at(-1)?.seq ?? -1
    const cursor = Number(this.db.prepare('SELECT seq FROM decision_inbox_cursor WHERE session = ?').get(sessionId)?.seq ?? -1)
    if (lastSeq <= cursor) return
    this.db.exec('SAVEPOINT capture_decision')
    try {
      const fresh = events.filter(event => event.seq > cursor)
      for (const event of fresh) if (event.type === 'user/message' && event.data.source.kind === 'user') {
        for (const item of this.list()) if (!item.lifecycle && item.sessionId === sessionId && event.seq > decisionBoundary(item)
          && item.staging?.candidateSubmission?.seq !== event.seq && item.submittedSeq !== event.seq) this.invalidate(item, 'A newer human message continued this conversation.', event.seq, event.time)
      }
      // Only the newest completed turn can request input; tool-step commentary and interrupted prefixes are not asks.
      const end = events.findLast(event => event.type === 'turn/end')
      if (end?.type === 'turn/end' && end.seq > cursor) {
        for (const item of this.list()) if (!item.lifecycle && item.sessionId === sessionId && end.seq > decisionBoundary(item) && end.data.turn !== decisionSourceTurn(item, events)
          && !(item.status === 'pending' && item.staging?.candidateSubmission)) this.invalidate(item, 'A newer turn superseded this question.', end.seq, end.time)
        const message = events.findLast(event => event.type === 'assistant/message' && event.data.turn === end.data.turn)
        if (end.data.reason.kind === 'completed' && message?.type === 'assistant/message' && !message.data.interrupted) {
          const text = message.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
          const alternatives = parseInlineAlternatives(text)
          const question = alternatives?.question ?? decisionQuestion(text)
          const laterHuman = events.some(event => event.seq > end.seq && event.type === 'user/message' && event.data.source.kind === 'user')
          const closed = isConversationCloseoutEvents(events, end.data.turn)
          if (question && !laterHuman && !closed) {
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
  /** Confirm an answerable decision choice directly with submission proof when dispatched to its live session. */
  resolveWithSubmission(id: string, choiceId: string, submission: { submissionId: string; messageId: string; seq: number; text?: string }): DecisionResolution {
    let item = this.get(id)
    if (!item) throw new InboxError(404, 'Decision not found')
    if (item.status === 'stale') throw new InboxError(409, `Decision is stale: ${item.staleReason || 'Open the source conversation for current context.'}`)
    const choice = item.choices.find(choice => choice.id === choiceId)
    if (!choice) throw new InboxError(400, 'Unknown decision choice')
    if (item.status === 'resolved') {
      if (item.resolvedChoice !== choiceId) throw new InboxError(409, 'Decision already resolved with another choice')
      return { resolved: true, choiceId, execution: 'not_executed', draft: { ...(item.sessionId ? { sessionId: item.sessionId } : {}), text: item.draftResponse ?? choice.prompt ?? choice.label }, item }
    }
    let stagedItem = item
    if (!stagedItem.staging || stagedItem.staging.choiceId !== choiceId) {
      const attemptId = randomUUID()
      this.stage(id, { attemptId, choiceId, draftText: submission.text ?? choice.prompt ?? choice.label })
      stagedItem = this.get(id)!
    }
    const staging = stagedItem.staging!
    const ids = staging.submissionIds ?? (staging.submissionId ? [staging.submissionId] : [])
    if (!ids.includes(submission.submissionId)) {
      this.linkSubmission(id, { attemptId: staging.attemptId, submissionId: submission.submissionId })
      stagedItem = this.get(id)!
    }
    const resolvedAt = Date.now()
    const next: PendingDecisionItem = {
      ...stagedItem,
      status: 'resolved',
      resolvedChoice: choiceId,
      resolvedAt,
      resolutionBasis: 'submitted',
      submissionId: submission.submissionId,
      submittedMessageId: submission.messageId,
      submittedSeq: Math.max(submission.seq, (stagedItem.sourceSeq ?? 0) + 1),
      ...(stagedItem.resolutionRevision !== undefined ? { resolutionRevision: stagedItem.resolutionRevision + 1 } : {}),
    }
    this.save(next, stagedItem)
    const finalItem = this.get(id)!
    return { resolved: true, choiceId, execution: 'not_executed', draft: { ...(item.sessionId ? { sessionId: item.sessionId } : {}), text: item.draftResponse ?? choice.prompt ?? choice.label }, item: finalItem }
  }
  /** Authoritative completion check: completed findings with no newer user ask reject fresh advice. */
  isSourceScopeResolved(sessionId: string, events: readonly SessionEvent[], sourceTurn?: number, sourceSeq?: number): boolean {
    try {
      const ticketId = sessionId.replace(/^worker-/, '')
      if (tableExists(this.db, 'finding')) {
        const findings = new FindingStore(this.db)
        const resolved = findings.list().find(f =>
          (f.state === 'resolved' || Boolean(f.resolution))
          && (f.id === ticketId || f.sessionId === sessionId || f.job?.ticketId === ticketId || f.priorJobs?.some(pj => pj.ticketId === ticketId))
        )
        if (resolved) {
          const resolvedAt = Date.parse(resolved.resolution?.at ?? resolved.updatedAt ?? resolved.createdAt) || 0
          if (sourceTurn !== undefined || sourceSeq !== undefined) {
            const turnUserSource = deriveTurnUserSource(events, sourceTurn, sourceSeq)
            if (turnUserSource && Number.isFinite(turnUserSource.time) && turnUserSource.time > resolvedAt) {
              return false
            }
            return true
          }
          const hasNewerHumanRequest = events.some(e =>
            e.type === 'user/message'
            && (e.data as any)?.source?.kind === 'user'
            && Number.isFinite(e.time)
            && e.time > resolvedAt
          )
          if (!hasNewerHumanRequest) return true
        }
      }
    } catch {}
    return false
  }

  /** Authoritative option quality context derived from stored finding, delivery, and event lineage. */
  deriveAuthoritativeQualityContext(sessionId: string, events?: readonly SessionEvent[], fallbackTitle?: string): OptionQualityContext {
    const overrides: Partial<OptionQualityContext> = {}

    let latestHumanRequest: string | undefined
    if (events && events.length > 0) {
      const human = events.findLast(e => e.type === 'user/message' && (e.data as any)?.source?.kind === 'user')
      if (human && human.type === 'user/message' && Array.isArray((human.data as any)?.content)) {
        const text = (human.data as any).content
          .filter((part: any) => part.type === 'text')
          .map((part: any) => part.text)
          .join('\n')
          .split('Current runtime context.')[0]!
          .trim()
        if (text) latestHumanRequest = text
      }
    }

    if (tableExists(this.db, 'finding')) {
      try {
        const ticketId = sessionId.replace(/^worker-/, '')
        const findings = new FindingStore(this.db)
        const finding = findings.list().find(f =>
          f.id === ticketId || f.sessionId === sessionId || f.job?.ticketId === ticketId || f.priorJobs?.some(pj => pj.ticketId === ticketId)
        )
        if (finding) {
          overrides.findingId = finding.id
          overrides.taskTitle = finding.title
          overrides.taskScope = finding.scope
          overrides.findingState = finding.state
          overrides.findingBlocker = finding.blocker
          overrides.isFindingResolved = finding.state === 'resolved' || Boolean(finding.resolution)

          if (Array.isArray(finding.reports) && finding.reports.length > 0) {
            const reports = [...finding.reports]
            const hasTimestamps = reports.every((r: any) => r.at && Number.isFinite(Date.parse(r.at)))
            if (hasTimestamps) reports.sort((a: any, b: any) => Date.parse(a.at) - Date.parse(b.at))
            const latest = reports[reports.length - 1]
            if (latest && ['failed', 'waiting', 'blocked', 'pending'].includes(latest.state ?? '')) {
              overrides.hasNewerFailureOrPending = true
            }
            const lastReadyIndex = reports.findLastIndex((r: any) => r.state === 'ready' || r.state === 'verified')
            const lastFailedIndex = reports.findLastIndex((r: any) => ['failed', 'waiting', 'blocked', 'pending'].includes(r.state ?? ''))
            if (lastFailedIndex > lastReadyIndex) {
              overrides.hasNewerFailureOrPending = true
            }
            if (!finding.resolution && !overrides.hasNewerFailureOrPending && latest?.state === 'ready') {
              overrides.isReadyUnreviewed = true
            }
          }
        }
      } catch {}
    }

    if (tableExists(this.db, 'feature_delivery')) {
      try {
        const ticketId = sessionId.replace(/^worker-/, '')
        const deliveries = new DeliveryStore(this.db)
        const delivery = deliveries.list().find(d =>
          d.id === overrides.findingId || d.id === ticketId || d.workers?.includes(ticketId)
        )
        if (delivery) {
          overrides.deliveryId = delivery.id
          overrides.deliveryState = delivery.state
          if (delivery.scopeBinding) {
            overrides.deliveryScopeBound = false
            overrides.deliveryMissingBinding = delivery.scopeBinding.reason
          } else {
            overrides.deliveryScopeBound = true
          }
          const raw = delivery as any
          if (typeof raw.scopeBound === 'boolean') {
            overrides.deliveryScopeBound = raw.scopeBound
          }
          if (typeof raw.missingBinding === 'string') {
            overrides.deliveryMissingBinding = raw.missingBinding
          } else if (Array.isArray(raw.missingBinding)) {
            overrides.deliveryMissingBinding = raw.missingBinding.join(', ')
          }
          if (delivery.state === 'accepted' || Boolean(delivery.acceptance)) {
            overrides.isDeliveryAccepted = true
          }
        }
      } catch {}
    }

    if (events && (overrides.isFindingResolved || overrides.isDeliveryAccepted)) {
      let resolvedAt = 0
      if (overrides.findingId && tableExists(this.db, 'finding')) {
        try {
          const f = new FindingStore(this.db).get(overrides.findingId)
          if (f) resolvedAt = Date.parse(f.resolution?.at ?? f.updatedAt ?? f.createdAt) || 0
        } catch {}
      }
      const hasNewerHumanRequest = events.some(e =>
        e.type === 'user/message'
        && (e.data as any)?.source?.kind === 'user'
        && Number.isFinite(e.time)
        && e.time > resolvedAt
      )
      if (hasNewerHumanRequest) {
        overrides.isFindingResolved = false
        overrides.isDeliveryAccepted = false
        if (latestHumanRequest) {
          overrides.taskScope = latestHumanRequest
          overrides.taskTitle = latestHumanRequest.replace(/\s+/g, ' ').slice(0, 120)
        }
      }
    }

    if (!overrides.findingId && !overrides.deliveryId) {
      const conversationalObjective = latestHumanRequest || fallbackTitle
      if (conversationalObjective) {
        overrides.taskScope = conversationalObjective
        overrides.taskTitle = conversationalObjective.replace(/\s+/g, ' ').slice(0, 120)
      }
    }

    return deriveOptionQualityContext(undefined, overrides)
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
  if (isConversationCloseoutEvents(events, end.data.turn)) return inbox.retireClosedOut(sessionId, events)
  if (inbox.isSourceScopeResolved(sessionId, events, end.data.turn, assistant.seq)) return
  const userSource = deriveTurnUserSource(events, end.data.turn, assistant.seq)
  inbox.ensureAdvisor({ sessionId, sourceMessageId: assistant.data.message.id, sourceTurn: end.data.turn, sourceSeq: assistant.seq,
    key: String(end.seq), question: decisionQuestion(text) ?? 'Choose the next step for this thread', context: text,
    title: request.replace(/\s+/g, ' ').slice(0, 120), createdAt: end.time,
    ...(userSource ? { human: true, userSource } : {}) }, events)
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
