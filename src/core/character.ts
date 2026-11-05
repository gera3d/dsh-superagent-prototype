/**
 * Stage 3: Autopilot Characters with domain standards, disagreement capabilities, and locked escalation boundaries.
 * Builds on Decision Engine Consolidation (docs/015) and replaces raw auto-run toggles with specialized personas.
 */
import type { DecisionChoice, DecisionEvaluationResult } from './decision.ts'

export type CharacterMode = 'suggest_only' | 'auto_push'
export type CharacterAction = 'agree' | 'approve' | 'disagree' | 'escalate'

export interface CharacterReviewInput {
  diff?: string
  testOutput?: string
  ticketRequest?: string
  context: string
  question: string
  choices: DecisionChoice[]
}

export interface CharacterReviewModelResponse {
  action: 'approve' | 'disagree' | 'escalate'
  reason: string
  redirect?: string
  recommendedChoiceId?: string
  counterProposal?: DecisionChoice
  modelRoute?: string
}

export type CharacterReviewModelCall = (
  input: CharacterReviewInput,
  signal?: AbortSignal,
) => Promise<CharacterReviewModelResponse>

/**
 * Hard rules: The character can never override the locked escalation list.
 * Any decision touching these domains must be handed to a human operator.
 */
export const LOCKED_ESCALATION_CATEGORIES = [
  'money',
  'deletions',
  'secrets',
  'sending_as_person',
  'undecided',
] as const

export type LockedEscalationCategory = (typeof LOCKED_ESCALATION_CATEGORIES)[number]

export interface LockedEscalation {
  category: LockedEscalationCategory
  reason: string
  matchedText?: string
}

export interface CharacterConfig {
  id: string
  name: string
  specialty: string
  brief: string
  standards: string[]
  permissionToDisagree: boolean
  inclinedTools: string[]
  mode: CharacterMode
  /** Name of the environment variable holding the key. Never store raw keys/secrets here. */
  apiKeyEnv: string
  enabled: boolean
}

export interface CharacterEvaluationResult {
  characterId: string
  characterName: string
  specialty: string
  action: CharacterAction
  recommendedValue: string
  critique: string
  counterProposal?: DecisionChoice
  suggestedTools: string[]
  direction?: string
  mode: CharacterMode
  canAutoPush: boolean
  requiresHuman: boolean
  escalation?: LockedEscalation
  latencyMs: number
  modelRoute?: string
  fallback?: boolean
  fallbackReason?: string
}

/** First character: Senior Developer */
export const DEFAULT_SENIOR_DEVELOPER_CHARACTER: CharacterConfig = {
  id: 'senior_developer',
  name: 'Senior Developer',
  specialty: 'Software Architecture, Code Quality & Test Verification',
  brief: 'Thinks critically about architectural soundness, test coverage, and regression risks. Rejects weak or hand-waving proposals, insists on verifying diffs with automated tests, and sends the worker back with precise corrective direction.',
  standards: [
    'Never deploy or merge without tests',
    'Verify diffs against project rules',
    'Reject hand-waving or incomplete fixes',
    'Check edge cases and error handling',
  ],
  permissionToDisagree: true,
  inclinedTools: [
    'run tests first',
    'typecheck',
    'verify git diff',
    'read test output',
  ],
  mode: 'suggest_only',
  apiKeyEnv: '',
  enabled: true,
}

// Regex patterns for locked escalation detection
const MONEY_PATTERN = /\b(billing|purchase|payment|credit\s*card|spend\s*money|buy\s*tokens|charge|subscription\s*upgrade|stripe\s*charge|invoice)\b/i
const DELETIONS_PATTERN = /\b(rm\s+-rf|drop\s+table|drop\s+database|delete\s+all|truncate\s+table|purge\s+database|git\s+push\s+--force|force\s+push|delete\s+branch|hard\s+reset|wipe\s+database)\b/i
const SECRETS_PATTERN = /\b(secret|private\s*key|api\s*key|password|credential|bearer\s*token|access\s*token|jwt\s*secret|id_rsa|env\s*secret|auth\s*token)\b/i
const SENDING_AS_PERSON_PATTERN = /\b(send\s+as\s+person|send\s+email\s+as|post\s+publicly\s+as|impersonat|speak\s+on\s+behalf|tweet\s+as|publish\s+as\s+user|email\s+customer)\b/i
const UNDECIDED_PATTERN = /\b(genuinely\s+undecided|undecided|need\s+human\s+decision|operator\s+must\s+decide|conflicting\s+requirements|ambiguous\s+intent|deadlock|tie\s+breaker)\b/i

/**
 * Checks context, question, and choices against the locked escalation list.
 * Returns a LockedEscalation if any locked boundary is triggered.
 */
export function detectLockedEscalation(
  context: string,
  question: string,
  choices: DecisionChoice[],
  rankerResult?: DecisionEvaluationResult,
): LockedEscalation | undefined {
  const combined = [context, question, ...choices.map(c => `${c.label} ${c.description ?? ''} ${c.prompt ?? ''}`)].join(' ')

  if (MONEY_PATTERN.test(combined)) {
    const match = combined.match(MONEY_PATTERN)
    return { category: 'money', reason: `Involves financial cost or spending: "${match?.[0] ?? 'spending'}"`, matchedText: match?.[0] }
  }

  if (DELETIONS_PATTERN.test(combined)) {
    const match = combined.match(DELETIONS_PATTERN)
    return { category: 'deletions', reason: `Involves destructive data deletion or irreversible purge: "${match?.[0] ?? 'deletion'}"`, matchedText: match?.[0] }
  }

  if (SECRETS_PATTERN.test(combined)) {
    const match = combined.match(SECRETS_PATTERN)
    return { category: 'secrets', reason: `Involves secrets, credentials, or private key exposure: "${match?.[0] ?? 'secret'}"`, matchedText: match?.[0] }
  }

  if (SENDING_AS_PERSON_PATTERN.test(combined)) {
    const match = combined.match(SENDING_AS_PERSON_PATTERN)
    return { category: 'sending_as_person', reason: `Involves sending communications as the person or public posting without confirmation: "${match?.[0] ?? 'impersonation'}"`, matchedText: match?.[0] }
  }

  if (UNDECIDED_PATTERN.test(combined)) {
    const match = combined.match(UNDECIDED_PATTERN)
    return { category: 'undecided', reason: `Explicitly marked as undecided or ambiguous: "${match?.[0] ?? 'undecided'}"`, matchedText: match?.[0] }
  }

  if (rankerResult) {
    if (rankerResult.provider === 'unranked' || (rankerResult.confidence > 0 && rankerResult.confidence < 0.4)) {
      return { category: 'undecided', reason: `Ranker reported low confidence (${(rankerResult.confidence * 100).toFixed(0)}%) or unranked tie`, matchedText: rankerResult.provider }
    }
  }

  return undefined
}

// Patterns that indicate weak, hasty, or unverified proposals that a Senior Developer rejects
const WEAK_PROPOSAL_PATTERNS = [
  /\b(skip\s+tests?|without\s+tests?|untested|ignore\s+tests?|comment\s+out\s+tests?)\b/i,
  /\b(deploy\s+now\s+without|merge\s+without|bypass\s+typecheck|ignore\s+type\s*errors?)\b/i,
  /\b(suppress\s+errors?|ignore\s+the\s+failure|workaround\s+without\s+fix|force\s+through)\b/i,
  /\b(do\s+nothing|leave\s+broken|postpone\s+indefinitely)\b/i,
]

export interface WeakProposalAssessment {
  isWeak: boolean
  violatedStandard: string
  reason: string
  correctiveDirection: string
  counterChoice: DecisionChoice
}

/**
 * Assesses whether the candidate proposals are weak or violate character standards.
 * If weak proposals dominate or all options lack test rigor, returns an assessment to disagree.
 */
export function assessWeakProposals(
  character: CharacterConfig,
  context: string,
  question: string,
  choices: DecisionChoice[],
): WeakProposalAssessment | undefined {
  if (choices.length === 0) return undefined

  // Check if all or leading choices trigger weak patterns
  const weakChoices = choices.filter(c => {
    const text = `${c.label} ${c.description ?? ''} ${c.prompt ?? ''}`
    return WEAK_PROPOSAL_PATTERNS.some(p => p.test(text))
  })

  // Also check if context indicates test failure or unverified changes, but no choice offers running tests
  const contextMentionsChangesOrFailure = /\b(fail|error|fix|refactor|change|broken|bug|patch|implemented)\b/i.test(context + ' ' + question)
  const anyChoiceRunsTests = choices.some(c => /\b(test|typecheck|verify|spec|check)\b/i.test(`${c.label} ${c.description ?? ''}`))

  const isAllWeak = weakChoices.length === choices.length
  const isLackingVerification = contextMentionsChangesOrFailure && !anyChoiceRunsTests && weakChoices.length > 0

  if (isAllWeak || isLackingVerification) {
    const standard = character.standards.find(s => s.toLowerCase().includes('test')) ?? character.standards[0] ?? 'Verify diffs against project rules'
    return {
      isWeak: true,
      violatedStandard: standard,
      reason: `Proposals violate the standard: "${standard}". Options attempt to proceed without automated test verification or propose unverified shortcuts.`,
      correctiveDirection: 'Reject weak proposals. First run the test suite and verify typecheck, then inspect results before proceeding.',
      counterChoice: {
        id: 'corrective_verify_and_test',
        label: 'Run tests and verify typecheck first',
        description: 'Hold changes; execute automated tests and typecheck to verify regressions before proceeding.',
        prompt: 'Hold on. Before proceeding with this change, run the test suite and verify typecheck. Report the exact test output and diff status first.',
        added: true,
      },
    }
  }

  return undefined
}
