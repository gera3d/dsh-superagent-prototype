/** Typed recommendation evaluation. Transport is provided by the host configured-model service. */
import type { PublicationSnapshot } from '../app/publication.ts'
import type { Delivery } from '../app/feature-delivery.ts'
import type { Finding } from '../app/finding.ts'

/** Structured privilege boundary: labels are never authorization. Unknown kinds fail closed in autonomous clients. */
export type DecisionActionKind = 'suggestion' | 'approve' | 'publish' | 'restart' | 'rollback' | 'merge' | 'lifecycle'
export interface DecisionChoice { id: string; label: string; actionKind?: DecisionActionKind; description?: string; /** Complete advisor continuation, never merely the button label. */ prompt?: string; /** True when added to satisfy the minimum option count, not proposed by the source or advisor. */ added?: boolean }
/** One append-only revision of a decision's option set. The latest revision is the shown set. */
export interface DecisionOptionSet {
  /** Monotonic, one-based revision within the decision. */
  revision: number
  /** Digest key of the turn that produced this set, when known. */
  key?: string
  /** Model label that produced this set; absent for capture fallbacks. */
  model?: string
  createdAt: number
  choices: DecisionChoice[]
  /** Options beyond the shown maximum, retained so no earlier option is lost. */
  hiddenOptions?: DecisionChoice[]
  recommendation: DecisionEvaluationResult
  /** Revision this set was restored from, when the user restored an earlier set. */
  restoredFrom?: number
}
export interface AdvisorDecision {
  sessionId: string; sourceMessageId?: string; sourceTurn?: number; sourceSeq?: number; key: string
  question: string; context: string; title?: string; createdAt: number; model: string
  options: { id: string; label: string; prompt: string; why: string; recommended: boolean; added?: boolean }[]
}
export interface DecisionEvaluationRequest {
  context: string
  sessionId?: string
  question: string
  choices: DecisionChoice[]
  provider?: 'auto' | 'typesafe-jev' | 'openai-luna' | 'deepseek'
}
export interface DecisionEvaluationResult {
  recommendedValue: string
  /** Model-reported score, not a calibrated probability of success. Zero when unavailable. */
  confidence: number
  rationale: string
  distribution: { id: string; probability: number }[]
  provider: string
  latencyMs: number
}
export interface AuthoritativeUserSource {
  kind: 'user'
  time: number
  seq: number
  turn?: number
  messageId?: string
}

export interface InvalidationBinding {
  kind: 'progress' | 'closeout' | 'human' | 'superseded' | 'sync'
  ticketId?: string
  revision?: number
  progressKind?: string
}

export interface DecisionStaging {
  attemptId: string
  choiceId: string
  /** SHA-256 of JSON.stringify(the entire native serialized plaintext), without normalization. */
  draftFingerprint: string
  choiceFingerprint: string
  stagedAt: number
  submissionId?: string
  /** Explicit native retry identities, bounded; old in-flight admissions remain eligible. */
  submissionIds?: string[]
  /** Unbound admission candidate is not resolution proof; explicit native request binding is still required. */
  candidateSubmission?: { submissionId: string; messageId: string; seq: number; acceptedAt: number }
}
export interface PendingDecisionItem {
  id: string
  /** Resolved record explicitly restarted by the user; history remains intact. */
  parentDecisionId?: string
  /** Explicit correction replaces an unstaged recommendation; original choices remain history. */
  supersedesDecisionId?: string
  /** Durable history through this sequence predates this new decision. */
  restartAfterSeq?: number
  /** Server-owned snapshot: historical request IDs must never arm a new Send binding. */
  restartExcludedSubmissionIds?: string[]
  ticketId?: string
  sessionId?: string
  sourceMessageId?: string
  /** Explicit human source confirmation. When true, proves this item originated from an authoritative human message. */
  human?: boolean
  /** Authoritative human source proof derived by the server from verified session events bound to this turn. */
  userSource?: AuthoritativeUserSource
  ticketTitle: string
  trigger: string
  status: 'pending' | 'resolved' | 'stale'
  /** Source event coordinates; choices only stage a draft, never execute work. */
  sourceTurn?: number
  sourceSeq?: number
  actionMode?: 'stage_response' | 'ticket_lifecycle' | 'feature_delivery' | 'finding_triage'
  /** Canonical pre-work triage; never staged as ordinary chat or autopilot. */
  finding?: Finding
  /** Canonical server-owned delivery snapshot. Never staged or resolved through native chat. */
  delivery?: Delivery
  /** Server-projected lifecycle state; never accepted as action authorization. */
  lifecycle?: { kind: 'stuck' | 'done'; assignmentId: string; prNumber?: number; docsOnly?: boolean; issueNumber?: number; issueUrl?: string; publication?: PublicationSnapshot; /** Recovery remains visible after the original ticket decision retires; only rollback may execute. */ recovery?: boolean; /** Exact approved own-merge fence remains current; server may offer safe refresh/resume. */ continuation?: boolean }
  /** Authoritative linked finding snapshot when projected for finding-owned work. */
  parentFinding?: { id: string; title: string; state: string; resolvedAt?: string }
  staleReason?: string
  /** Authoritative recorded workflow progress revision when this advice was generated. */
  progressRevision?: number
  draftResponse?: string
  staging?: DecisionStaging
  /** Opt-in enforcement marker for rows explicitly staged through the native submission bridge. */
  resolutionPolicy?: 'on_send'
  /** Internal CAS fence: legacy same-DB writers cannot overwrite native staging or proof metadata. */
  resolutionRevision?: number
  /** Historical staged resolutions are not confirmed native submissions. */
  resolutionBasis?: 'submitted' | 'legacy_staged'
  submittedMessageId?: string
  submittedSeq?: number
  submissionId?: string
  /** Obsolescence never erases a previously resolved choice or submission history. */
  invalidation?: { at: number; reason: string; sourceSeq?: number; binding?: InvalidationBinding }
  advisor?: { status: 'pending' | 'generating' | 'ready' | 'error'; model?: string; error?: string; key?: string }
  /** Canonical producer state; independent from human decision resolution. */
  canonical?: { draftRevision: string; phase: 'pending' | 'ready' | 'scored'; owner: string; leaseToken: string; leaseExpiresAt: number; error?: string; progressRevision?: number }
  urgency: 'high' | 'medium' | 'low'
  createdAt: number
  context: string
  question: string
  recommendation: DecisionEvaluationResult
  choices: DecisionChoice[]
  /** Options beyond the shown maximum; never pruned from the record. */
  hiddenOptions?: DecisionChoice[]
  /** Append-only option-set history; the latest revision is the shown set. */
  optionSets?: DecisionOptionSet[]
  /** Character attribution and correction details for this decision. */
  character?: DecisionCharacterAttribution
  resolvedChoice?: string
  resolvedAt?: number
}

export interface DecisionCharacterAttribution {
  characterId: string
  name: string
  specialty?: string
  brief?: string
  mode: 'suggest' | 'auto'
  correction?: string
  rationale?: string
  /** Declared specialist capabilities the native Harness did not expose when this advice was produced (bounded ids). */
  unavailable?: string[]
}

export interface DecisionModelReply { text: string; provider: string }
export type DecisionModelCall = (request: DecisionEvaluationRequest) => Promise<DecisionModelReply>

/** Returns why a decision request cannot be ranked, or `undefined` when its question, context and distinct choices are usable. */
export function decisionRequestProblem(request: DecisionEvaluationRequest): string | undefined {
  const { choices, question, context } = request
  if (!Array.isArray(choices) || choices.length < 2 || choices.length > 12
    || choices.some(c => !c || typeof c.id !== 'string' || !c.id || typeof c.label !== 'string')
    || new Set(choices.map(c => c.id)).size !== choices.length
    || typeof context !== 'string' || typeof question !== 'string') return 'Provide a question, context, and 2–12 distinct alternatives.'
  return undefined
}

export async function evaluateDecision(request: DecisionEvaluationRequest, call?: DecisionModelCall): Promise<DecisionEvaluationResult> {
  const start = Date.now()
  const unavailable = (rationale: string): DecisionEvaluationResult => ({
    recommendedValue: '', confidence: 0, rationale, distribution: [],
    provider: 'Recommendation unavailable', latencyMs: Date.now() - start,
  })
  const problem = decisionRequestProblem(request)
  if (problem) return unavailable(problem)
  if (request.provider && request.provider !== 'auto') return unavailable('Choose the existing configured model; vendor-specific decision endpoints are not implemented.')
  if (!call) return unavailable('The configured model service is unavailable. No evaluation was performed.')
  const { choices } = request
  try {
    const result = await call(request)
    const raw = result.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const parsed = JSON.parse(raw)
    const validScore = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
    const distribution: { id: string; probability: number }[] = parsed.distribution
    if (!choices.some(c => c.id === parsed.recommended_value) || !validScore(parsed.confidence)
      || typeof parsed.rationale !== 'string' || !parsed.rationale.trim()
      || !Array.isArray(distribution) || distribution.length !== choices.length
      || new Set(distribution.map(d => d.id)).size !== choices.length
      || distribution.some(d => !choices.some(c => c.id === d.id) || !validScore(d.probability))
      || Math.abs(distribution.reduce((sum, d) => sum + d.probability, 0) - 1) > 0.01) return unavailable('Model returned an invalid decision; no recommendation is available.')
    return { recommendedValue: parsed.recommended_value, confidence: parsed.confidence, rationale: parsed.rationale,
      distribution, provider: `${result.provider} (model-reported scores, not calibrated)`, latencyMs: Date.now() - start }
  } catch {
    return unavailable('Configured model request failed, timed out, or returned invalid JSON. Retry evaluation; no action was taken.')
  }
}
