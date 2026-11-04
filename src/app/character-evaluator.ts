/**
 * Character evaluator: evaluates candidate decisions through the lens of a domain character.
 * Pushes back on weak options, generates corrective counter-proposals, and enforces locked escalation bounds.
 */
import type { DecisionEvaluationRequest, DecisionEvaluationResult, DecisionModelCall } from '../core/decision.ts'
import {
  assessWeakProposals,
  detectLockedEscalation,
  type CharacterConfig,
  type CharacterEvaluationResult,
} from '../core/character.ts'

export interface CharacterEvaluatorOptions {
  rankerResult?: DecisionEvaluationResult
  modelCall?: DecisionModelCall
}

/**
 * Evaluates a decision request using the given character persona.
 *
 * Invariant order:
 * 1. Check locked escalation list (money, deletions, secrets, sending as person, undecided).
 *    If triggered, always escalate to human; auto-push is strictly disabled.
 * 2. If character has `permissionToDisagree`, assess whether candidate options are weak.
 *    If weak, disagree! Return critique, counter-proposal, and inclined tools.
 * 3. Otherwise, agree with the best option (aligned with character standards and ranker).
 */
export async function evaluateWithCharacter(
  character: CharacterConfig,
  request: DecisionEvaluationRequest,
  options: CharacterEvaluatorOptions = {},
): Promise<CharacterEvaluationResult> {
  const start = Date.now()

  // 1. Locked Escalation Guard (Strict Boundary)
  const escalation = detectLockedEscalation(
    request.context,
    request.question,
    request.choices,
    options.rankerResult,
  )

  if (escalation) {
    return {
      characterId: character.id,
      characterName: character.name,
      specialty: character.specialty,
      action: 'escalate',
      recommendedValue: '',
      critique: `Locked escalation boundary triggered (${escalation.category}): ${escalation.reason}. Character "${character.name}" cannot override locked escalations. Escalating to human operator.`,
      suggestedTools: [],
      mode: character.mode,
      canAutoPush: false, // Invariant: Escalations can NEVER be auto-pushed
      requiresHuman: true,
      escalation,
      latencyMs: Date.now() - start,
    }
  }

  // 2. Permission to Disagree & Weak Option Assessment
  if (character.permissionToDisagree) {
    const weakAssessment = assessWeakProposals(
      character,
      request.context,
      request.question,
      request.choices,
    )

    if (weakAssessment) {
      return {
        characterId: character.id,
        characterName: character.name,
        specialty: character.specialty,
        action: 'disagree',
        recommendedValue: weakAssessment.counterChoice.id,
        critique: `Disagreement by ${character.name}: ${weakAssessment.reason}`,
        counterProposal: weakAssessment.counterChoice,
        suggestedTools: character.inclinedTools,
        direction: weakAssessment.correctiveDirection,
        mode: character.mode,
        canAutoPush: character.mode === 'auto_push',
        requiresHuman: character.mode !== 'auto_push',
        latencyMs: Date.now() - start,
      }
    }
  }

  // 3. Agreement with Best Candidate
  // Use ranker's recommended value if present, or pick first non-weak option
  const recommendedValue = options.rankerResult?.recommendedValue
    || request.choices[0]?.id
    || ''

  const recommendedChoice = request.choices.find(c => c.id === recommendedValue)
  const choiceLabel = recommendedChoice?.label ?? recommendedValue

  return {
    characterId: character.id,
    characterName: character.name,
    specialty: character.specialty,
    action: 'agree',
    recommendedValue,
    critique: `${character.name} reviewed the proposed options and approved "${choiceLabel}". The proposed action meets character standards (${character.standards[0] ?? character.specialty}).`,
    suggestedTools: character.inclinedTools,
    mode: character.mode,
    canAutoPush: character.mode === 'auto_push',
    requiresHuman: character.mode !== 'auto_push',
    latencyMs: Date.now() - start,
  }
}
