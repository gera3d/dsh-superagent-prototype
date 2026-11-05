/**
 * Character evaluator: evaluates candidate decisions through the lens of a domain character.
 * Invokes Gemini 3.8 Flash at high reasoning effort through the harness's model route,
 * pushes back on weak options, generates corrective counter-proposals, and enforces locked escalation bounds.
 */
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { DecisionChoice, DecisionEvaluationRequest, DecisionEvaluationResult, DecisionModelCall } from '../core/decision.ts'
import {
  assessWeakProposals,
  detectLockedEscalation,
  type CharacterConfig,
  type CharacterEvaluationResult,
  type CharacterReviewInput,
  type CharacterReviewModelCall,
  type CharacterReviewModelResponse,
} from '../core/character.ts'

export const CHARACTER_REVIEW_MODEL_ROUTE = {
  provider: 'antigravity',
  model: 'gemini-3.8-flash',
  reasoningEffort: 'high',
} as const

export const MAX_REVIEW_TOKENS_BUDGET = 30_000 // ~120,000 characters

export interface CharacterEvaluatorOptions {
  rankerResult?: DecisionEvaluationResult
  modelCall?: DecisionModelCall
  reviewCall?: CharacterReviewModelCall
  ctx?: Context
  diff?: string
  testOutput?: string
  ticketRequest?: string
  signal?: AbortSignal
}

/** Formats and budgets the review prompt up to ~30k tokens (~120,000 chars). */
export function formatReviewUserContent(
  input: CharacterReviewInput,
  maxChars = 120_000,
): string {
  const ticket = input.ticketRequest || input.context || input.question || 'No ticket description provided'
  const diff = input.diff || ''
  const testOutput = input.testOutput || ''
  const context = input.context || ''

  const choicesText = input.choices
    .map(c => `- ID "${c.id}": ${c.label}${c.description ? ` (${c.description})` : ''}`)
    .join('\n')

  const sections: string[] = []
  sections.push(`## Ticket Request\n${ticket.slice(0, 30_000)}`)

  if (diff) {
    sections.push(`## Git Diff\n${diff.slice(0, 50_000)}`)
  }

  if (testOutput) {
    sections.push(`## Test Output\n${testOutput.slice(0, 40_000)}`)
  }

  if (context && context !== ticket) {
    sections.push(`## Additional Context\n${context.slice(0, 20_000)}`)
  }

  sections.push(`## Decision Question\n${input.question}`)
  sections.push(`## Candidate Choices\n${choicesText}`)

  const assembled = sections.join('\n\n')
  return assembled.slice(0, maxChars)
}

/**
 * Calls Gemini 3.8 Flash at high reasoning effort through the harness's own authenticated model route (`ctx.llm`).
 */
export async function callHarnessCharacterReview(
  ctx: Context,
  character: CharacterConfig,
  input: CharacterReviewInput,
  signal?: AbortSignal,
): Promise<CharacterReviewModelResponse> {
  const timeoutSignal = signal ?? AbortSignal.timeout(60_000)
  const config = await ctx.llm.resolveCallConfig({
    provider: CHARACTER_REVIEW_MODEL_ROUTE.provider,
    model: CHARACTER_REVIEW_MODEL_ROUTE.model,
    reasoningEffort: ReasoningEffortId(CHARACTER_REVIEW_MODEL_ROUTE.reasoningEffort),
  }, timeoutSignal)

  const system = [
    `You are ${character.name}, a domain expert character specialized in ${character.specialty}.`,
    `Brief: ${character.brief}`,
    'Standards to uphold:',
    ...character.standards.map(s => `- ${s}`),
    `Permission to disagree: ${character.permissionToDisagree ? 'YES. You must push back on weak, hasty, or unverified proposals.' : 'NO.'}`,
    'Review the git diff, test output, and ticket request. Decide whether to approve, disagree, or escalate.',
    'Hard security rule: You can NEVER approve or relax locked boundaries (financial cost/spending, destructive deletions/rm -rf, secrets/credentials exposure, sending messages as the person, or genuinely undecided choices). Any match MUST be escalated.',
    'You MUST respond with valid JSON in this exact structure:',
    '{',
    '  "action": "approve" | "disagree" | "escalate",',
    '  "reason": "Concise critique explaining the architectural or verification rationale",',
    '  "redirect": "Concrete corrective next action or redirect when disagreeing, or empty if approving",',
    '  "recommendedChoiceId": "choice ID from candidate choices if approving or redirecting to an existing candidate",',
    '  "counterProposal": { "id": "string", "label": "string", "description": "string", "prompt": "string" }',
    '}',
  ].join('\n')

  const userContent = formatReviewUserContent(input, 120_000)

  let text = ''
  let finished = false
  for await (const chunk of ctx.llm.stream({
    ...config,
    signal: timeoutSignal,
    maxTokens: 4096,
    tools: [],
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: userContent }] }],
  })) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
      if (text.length > 64_000) throw new Error('Character review response exceeded size limit')
    }
    if (chunk.type === 'finish') {
      if (chunk.reason.kind !== 'stop') throw new Error(`Character review did not finish normally (${chunk.reason.kind})`)
      finished = true
    }
  }

  if (!finished || !text.trim()) {
    throw new Error('Model returned an empty review response')
  }

  const cleanJson = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed = JSON.parse(cleanJson)

  const action = parsed.action
  if (action !== 'approve' && action !== 'disagree' && action !== 'escalate') {
    throw new Error(`Invalid action returned by model: "${action}"`)
  }

  return {
    action,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    redirect: typeof parsed.redirect === 'string' ? parsed.redirect : undefined,
    recommendedChoiceId: typeof parsed.recommendedChoiceId === 'string' ? parsed.recommendedChoiceId : undefined,
    counterProposal: parsed.counterProposal && typeof parsed.counterProposal === 'object' ? parsed.counterProposal : undefined,
    modelRoute: `${config.provider} / ${config.model} (${CHARACTER_REVIEW_MODEL_ROUTE.reasoningEffort})`,
  }
}

/**
 * Evaluates a decision request using the given character persona.
 *
 * Invariant order:
 * 1. Pre-model deterministic locked escalation check (money, deletions, secrets, sending as person, undecided).
 * 2. LLM review step calling Gemini 3.8 Flash (or injected reviewCall) with diff, test output, and ticket request.
 * 3. Post-model deterministic locked escalation check: model can never relax locked boundaries.
 * 4. Fallback to heuristics if model fails or times out; never auto-approve on model failure.
 * 5. Candidate alignment.
 */
export async function evaluateWithCharacter(
  character: CharacterConfig,
  request: DecisionEvaluationRequest & {
    characterId?: string
    diff?: string
    testOutput?: string
    ticketRequest?: string
  },
  options: CharacterEvaluatorOptions = {},
): Promise<CharacterEvaluationResult> {
  const start = Date.now()

  const diff = request.diff ?? options.diff ?? ''
  const testOutput = request.testOutput ?? options.testOutput ?? ''
  const ticketRequest = request.ticketRequest ?? options.ticketRequest ?? ''

  // 1. Pre-Model Locked Escalation Guard (Strict Deterministic Boundary)
  const initialCombinedText = [
    request.context,
    request.question,
    diff,
    testOutput,
    ticketRequest,
  ].filter(Boolean).join(' ')

  const earlyEscalation = detectLockedEscalation(
    initialCombinedText,
    request.question,
    request.choices,
    options.rankerResult,
  )

  if (earlyEscalation) {
    return {
      characterId: character.id,
      characterName: character.name,
      specialty: character.specialty,
      action: 'escalate',
      recommendedValue: '',
      critique: `Locked escalation boundary triggered (${earlyEscalation.category}): ${earlyEscalation.reason}. Character "${character.name}" cannot override locked escalations. Escalating to human operator.`,
      suggestedTools: [],
      mode: character.mode,
      canAutoPush: false, // Invariant: Escalations can NEVER be auto-pushed
      requiresHuman: true,
      escalation: earlyEscalation,
      latencyMs: Date.now() - start,
    }
  }

  // 2. Call LLM Review Step if caller provided reviewCall or ctx
  const reviewInput: CharacterReviewInput = {
    context: request.context,
    question: request.question,
    choices: request.choices,
    diff,
    testOutput,
    ticketRequest,
  }

  let modelReview: CharacterReviewModelResponse | undefined
  let modelFailed = false
  let fallbackReason = ''

  if (options.reviewCall || options.ctx) {
    try {
      if (options.reviewCall) {
        modelReview = await options.reviewCall(reviewInput, options.signal)
      } else if (options.ctx) {
        modelReview = await callHarnessCharacterReview(options.ctx, character, reviewInput, options.signal)
      }
    } catch (err) {
      modelFailed = true
      fallbackReason = `LLM review call failed (${err instanceof Error ? err.message : String(err)}). Falling back to heuristic evaluation.`
    }
  }

  // 3. If model reviewed successfully: run Post-Model Deterministic Guard
  if (modelReview) {
    const postModelText = [
      request.context,
      diff,
      testOutput,
      ticketRequest,
      modelReview.reason ?? '',
      modelReview.redirect ?? '',
      modelReview.counterProposal?.label ?? '',
      modelReview.counterProposal?.description ?? '',
      modelReview.counterProposal?.prompt ?? '',
      request.choices.find(c => c.id === modelReview?.recommendedChoiceId)?.label ?? '',
      request.choices.find(c => c.id === modelReview?.recommendedChoiceId)?.description ?? '',
    ].filter(Boolean).join(' ')

    const postEscalation = detectLockedEscalation(
      postModelText,
      request.question,
      request.choices,
      options.rankerResult,
    )

    // The model can NEVER relax locked escalations!
    if (postEscalation) {
      return {
        characterId: character.id,
        characterName: character.name,
        specialty: character.specialty,
        action: 'escalate',
        recommendedValue: '',
        critique: `Locked escalation boundary triggered (${postEscalation.category}): ${postEscalation.reason}. Model review returned or touched a locked category; the model can never relax locked boundaries. Escalating to human operator.`,
        suggestedTools: [],
        mode: character.mode,
        canAutoPush: false,
        requiresHuman: true,
        escalation: postEscalation,
        latencyMs: Date.now() - start,
        modelRoute: modelReview.modelRoute,
      }
    }

    if (modelReview.action === 'escalate') {
      return {
        characterId: character.id,
        characterName: character.name,
        specialty: character.specialty,
        action: 'escalate',
        recommendedValue: '',
        critique: `Escalated by ${character.name}: ${modelReview.reason}`,
        suggestedTools: character.inclinedTools,
        mode: character.mode,
        canAutoPush: false,
        requiresHuman: true,
        latencyMs: Date.now() - start,
        modelRoute: modelReview.modelRoute,
      }
    }

    if (modelReview.action === 'disagree') {
      const counterChoice: DecisionChoice = modelReview.counterProposal ?? {
        id: 'corrective_direction',
        label: modelReview.redirect ? modelReview.redirect.slice(0, 100) : 'Run tests and verify typecheck first',
        description: modelReview.redirect ?? 'Hold changes; execute automated tests and typecheck to verify regressions.',
        prompt: modelReview.redirect ?? 'Hold on. Before proceeding, run the test suite and verify typecheck.',
        added: true,
      }

      return {
        characterId: character.id,
        characterName: character.name,
        specialty: character.specialty,
        action: 'disagree',
        recommendedValue: counterChoice.id,
        critique: `Disagreement by ${character.name}: ${modelReview.reason}`,
        counterProposal: counterChoice,
        suggestedTools: character.inclinedTools,
        direction: modelReview.redirect ?? modelReview.reason,
        mode: character.mode,
        canAutoPush: character.mode === 'auto_push',
        requiresHuman: character.mode !== 'auto_push',
        latencyMs: Date.now() - start,
        modelRoute: modelReview.modelRoute,
      }
    }

    if (modelReview.action === 'approve') {
      const recommendedValue = modelReview.recommendedChoiceId
        || options.rankerResult?.recommendedValue
        || request.choices[0]?.id
        || ''
      const recommendedChoice = request.choices.find(c => c.id === recommendedValue)
      const choiceLabel = recommendedChoice?.label ?? recommendedValue

      return {
        characterId: character.id,
        characterName: character.name,
        specialty: character.specialty,
        action: 'approve',
        recommendedValue,
        critique: `${character.name} approved: ${modelReview.reason || `Approved "${choiceLabel}". The proposed changes satisfy verification standards.`}`,
        suggestedTools: character.inclinedTools,
        mode: character.mode,
        canAutoPush: character.mode === 'auto_push',
        requiresHuman: character.mode !== 'auto_push',
        latencyMs: Date.now() - start,
        modelRoute: modelReview.modelRoute,
      }
    }
  }

  // 4. Fallback Heuristics (when model call fails/times out or when no model review was configured)
  if (character.permissionToDisagree) {
    const weakAssessment = assessWeakProposals(
      character,
      request.context,
      request.question,
      request.choices,
    )

    if (weakAssessment) {
      const prefix = modelFailed ? `[Fallback: ${fallbackReason}] ` : ''
      return {
        characterId: character.id,
        characterName: character.name,
        specialty: character.specialty,
        action: 'disagree',
        recommendedValue: weakAssessment.counterChoice.id,
        critique: `${prefix}Disagreement by ${character.name}: ${weakAssessment.reason}`,
        counterProposal: weakAssessment.counterChoice,
        suggestedTools: character.inclinedTools,
        direction: weakAssessment.correctiveDirection,
        mode: character.mode,
        canAutoPush: modelFailed ? false : character.mode === 'auto_push',
        requiresHuman: modelFailed ? true : character.mode !== 'auto_push',
        latencyMs: Date.now() - start,
        fallback: modelFailed ? true : undefined,
        fallbackReason: modelFailed ? fallbackReason : undefined,
      }
    }
  }

  // 5. Agreement with Best Candidate Heuristic
  const recommendedValue = options.rankerResult?.recommendedValue
    || request.choices[0]?.id
    || ''
  const recommendedChoice = request.choices.find(c => c.id === recommendedValue)
  const choiceLabel = recommendedChoice?.label ?? recommendedValue

  const prefix = modelFailed ? `[Fallback: ${fallbackReason}] ` : ''
  const fallbackNotice = modelFailed ? ' Auto-approval is disabled due to model failure; human confirmation required.' : ''

  return {
    characterId: character.id,
    characterName: character.name,
    specialty: character.specialty,
    action: 'agree',
    recommendedValue,
    critique: `${prefix}${character.name} reviewed the proposed options and approved "${choiceLabel}". The proposed action meets character standards (${character.standards[0] ?? character.specialty}).${fallbackNotice}`,
    suggestedTools: character.inclinedTools,
    mode: character.mode,
    // INVARIANT: Never auto-approve on a model failure!
    canAutoPush: modelFailed ? false : character.mode === 'auto_push',
    requiresHuman: modelFailed ? true : character.mode !== 'auto_push',
    latencyMs: Date.now() - start,
    fallback: modelFailed ? true : undefined,
    fallbackReason: modelFailed ? fallbackReason : undefined,
  }
}
