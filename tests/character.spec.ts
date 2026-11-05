import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_SENIOR_DEVELOPER_CHARACTER,
  assessWeakProposals,
  detectLockedEscalation,
  type CharacterConfig,
  type LockedEscalationCategory,
} from '../src/core/character.ts'
import { evaluateWithCharacter } from '../src/app/character-evaluator.ts'
import { CharacterConfigSchema, CharactersConfigSchema, SettingsSchema } from '../src/policy.ts'
import type { DecisionChoice, DecisionEvaluationRequest, DecisionEvaluationResult } from '../src/core/decision.ts'

describe('Stage 3: Autopilot Characters (Senior Developer)', () => {
  const sampleChoices: DecisionChoice[] = [
    { id: 'skip_tests', label: 'Skip tests and deploy now', description: 'Bypass test verification to move fast.' },
    { id: 'ignore_failures', label: 'Ignore test failures and merge', description: 'Proceed despite broken assertions.' },
  ]

  const strongChoices: DecisionChoice[] = [
    { id: 'run_tests', label: 'Run vitest suite and typecheck', description: 'Execute automated regression tests before merge.' },
    { id: 'inspect_diff', label: 'Review git diff with reviewer', description: 'Carefully verify diff against requirements.' },
  ]

  const baseRequest: DecisionEvaluationRequest = {
    context: 'Worker implemented bug fix in src/auth.ts. 2 files modified.',
    question: 'How should the worker proceed to complete the task?',
    choices: sampleChoices,
  }

  describe('Character Configuration & Defaults', () => {
    it('initializes Senior Developer with strict verification standards and inclined tools', () => {
      const dev = DEFAULT_SENIOR_DEVELOPER_CHARACTER
      expect(dev.id).toBe('senior_developer')
      expect(dev.name).toBe('Senior Developer')
      expect(dev.specialty).toContain('Architecture, Code Quality')
      expect(dev.brief).toContain('Thinks critically')
      expect(dev.permissionToDisagree).toBe(true)
      expect(dev.standards).toEqual(expect.arrayContaining([
        expect.stringContaining('Never deploy or merge without tests'),
        expect.stringContaining('Verify diffs against project rules'),
      ]))
      expect(dev.inclinedTools).toEqual(expect.arrayContaining([
        'run tests first',
        'typecheck',
        'verify git diff',
      ]))
      expect(dev.mode).toBe('suggest_only')
      expect(dev.apiKeyEnv).toBe('')
      expect(dev.enabled).toBe(true)
    })
  })

  describe('Permission to Disagree (Correcting Weak Options)', () => {
    it('disagrees with weak proposals and generates a corrective counter-proposal instead of picking the least bad option', async () => {
      const result = await evaluateWithCharacter(DEFAULT_SENIOR_DEVELOPER_CHARACTER, baseRequest)

      expect(result.action).toBe('disagree')
      expect(result.critique).toContain('Disagreement by Senior Developer')
      expect(result.critique).toContain('Never deploy or merge without tests')
      expect(result.counterProposal).toBeDefined()
      expect(result.counterProposal?.id).toBe('corrective_verify_and_test')
      expect(result.counterProposal?.label).toContain('Run tests and verify typecheck first')
      expect(result.counterProposal?.prompt).toContain('run the test suite and verify typecheck')
      expect(result.direction).toContain('Reject weak proposals')
      expect(result.suggestedTools).toEqual(DEFAULT_SENIOR_DEVELOPER_CHARACTER.inclinedTools)
      expect(result.recommendedValue).toBe('corrective_verify_and_test')
      expect(result.canAutoPush).toBe(false) // suggest_only mode
      expect(result.requiresHuman).toBe(true)
    })

    it('respects permissionToDisagree: false by not disagreeing and falling back to candidate choices', async () => {
      const compliantChar: CharacterConfig = {
        ...DEFAULT_SENIOR_DEVELOPER_CHARACTER,
        permissionToDisagree: false,
      }

      const result = await evaluateWithCharacter(compliantChar, baseRequest)
      expect(result.action).toBe('agree')
      expect(result.counterProposal).toBeUndefined()
      expect(result.recommendedValue).toBe('skip_tests')
    })

    it('approves strong proposals that satisfy verification standards without disagreement', async () => {
      const strongRequest: DecisionEvaluationRequest = {
        context: 'Changes made in src/api.ts. Ready for verification.',
        question: 'Which verification step should be executed next?',
        choices: strongChoices,
      }

      const rankerResult: DecisionEvaluationResult = {
        recommendedValue: 'run_tests',
        confidence: 0.88,
        rationale: 'Running tests catches regression early.',
        distribution: [{ id: 'run_tests', probability: 0.88 }, { id: 'inspect_diff', probability: 0.12 }],
        provider: 'OpenAI Decisions API / gpt-6-luna',
        latencyMs: 15,
      }

      const result = await evaluateWithCharacter(DEFAULT_SENIOR_DEVELOPER_CHARACTER, strongRequest, { rankerResult })

      expect(result.action).toBe('agree')
      expect(result.recommendedValue).toBe('run_tests')
      expect(result.critique).toContain('approved "Run vitest suite and typecheck"')
      expect(result.counterProposal).toBeUndefined()
    })

    it('allows auto_push when mode is auto_push and no locked escalations are present', async () => {
      const autoDev: CharacterConfig = {
        ...DEFAULT_SENIOR_DEVELOPER_CHARACTER,
        mode: 'auto_push',
      }

      const strongRequest: DecisionEvaluationRequest = {
        context: 'Changes ready.',
        question: 'Next step?',
        choices: strongChoices,
      }

      const result = await evaluateWithCharacter(autoDev, strongRequest)
      expect(result.action).toBe('agree')
      expect(result.mode).toBe('auto_push')
      expect(result.canAutoPush).toBe(true)
      expect(result.requiresHuman).toBe(false)
    })
  })

  describe('Hard Rule: Locked Escalation List (Security Boundaries)', () => {
    const lockedScenarios: Array<{
      category: LockedEscalationCategory
      name: string
      request: DecisionEvaluationRequest
      rankerResult?: DecisionEvaluationResult
    }> = [
      {
        category: 'money',
        name: 'Spending money and subscription upgrades',
        request: {
          context: 'API token limit reached on third-party provider.',
          question: 'Should we upgrade the paid billing plan or purchase additional token credit?',
          choices: [
            { id: 'upgrade_billing', label: 'Purchase subscription upgrade on Stripe' },
            { id: 'stop_work', label: 'Pause pipeline' },
          ],
        },
      },
      {
        category: 'deletions',
        name: 'Destructive deletions or database purging',
        request: {
          context: 'Old test data accumulated in production database.',
          question: 'Execute cleanup script now?',
          choices: [
            { id: 'drop_tables', label: 'Run drop database and purge database records' },
            { id: 'archive', label: 'Archive records to cold storage' },
          ],
        },
      },
      {
        category: 'deletions',
        name: 'Force pushing or deleting branches',
        request: {
          context: 'Merge conflict detected on main branch.',
          question: 'How to resolve?',
          choices: [
            { id: 'force_push', label: 'Execute git push --force to overwrite upstream' },
            { id: 'rebase', label: 'Rebase cleanly' },
          ],
        },
      },
      {
        category: 'secrets',
        name: 'Accessing or exposing secrets and private keys',
        request: {
          context: 'Need authentication to connect to staging cluster.',
          question: 'Where to retrieve credentials?',
          choices: [
            { id: 'read_secret', label: 'Extract private key and auth token from vault' },
            { id: 'mock_auth', label: 'Use local mock credentials' },
          ],
        },
      },
      {
        category: 'sending_as_person',
        name: 'External communications or impersonating the person',
        request: {
          context: 'Customer inquiry received on support thread.',
          question: 'How to reply?',
          choices: [
            { id: 'email_as_user', label: 'Send email as person directly to client' },
            { id: 'draft_reply', label: 'Draft internal notes only' },
          ],
        },
      },
      {
        category: 'undecided',
        name: 'Genuinely undecided choice or ambiguous user mandate',
        request: {
          context: 'Conflicting product requirements detected between specs.',
          question: 'This is a genuinely undecided choice requiring human architectural guidance.',
          choices: [
            { id: 'direction_a', label: 'Implement architecture A' },
            { id: 'direction_b', label: 'Implement architecture B' },
          ],
        },
      },
      {
        category: 'undecided',
        name: 'Ranker reported low confidence or unranked deadlock',
        request: {
          context: 'Two options with conflicting tradeoffs.',
          question: 'Select pathway',
          choices: [
            { id: 'path_a', label: 'Path A' },
            { id: 'path_b', label: 'Path B' },
          ],
        },
        rankerResult: {
          recommendedValue: '',
          confidence: 0.25,
          rationale: 'Low confidence deadlock.',
          distribution: [{ id: 'path_a', probability: 0.5 }, { id: 'path_b', probability: 0.5 }],
          provider: 'unranked',
          latencyMs: 10,
        },
      },
    ]

    for (const scenario of lockedScenarios) {
      it(`escalates locked item: ${scenario.name} (${scenario.category})`, async () => {
        const escalation = detectLockedEscalation(
          scenario.request.context,
          scenario.request.question,
          scenario.request.choices,
          scenario.rankerResult,
        )
        expect(escalation).toBeDefined()
        expect(escalation?.category).toBe(scenario.category)

        const result = await evaluateWithCharacter(
          DEFAULT_SENIOR_DEVELOPER_CHARACTER,
          scenario.request,
          { rankerResult: scenario.rankerResult },
        )

        expect(result.action).toBe('escalate')
        expect(result.escalation?.category).toBe(scenario.category)
        expect(result.requiresHuman).toBe(true)
        expect(result.canAutoPush).toBe(false)
        expect(result.critique).toContain('Locked escalation boundary triggered')
      })
    }

    it('proves that locked escalations can NEVER be overridden even when character mode is auto_push', async () => {
      const aggressiveCharacter: CharacterConfig = {
        ...DEFAULT_SENIOR_DEVELOPER_CHARACTER,
        mode: 'auto_push',
      }

      const destructiveRequest: DecisionEvaluationRequest = {
        context: 'Disk space warning on build server.',
        question: 'Clean build artifacts?',
        choices: [
          { id: 'wipe', label: 'Execute rm -rf /tmp/build-cache' },
          { id: 'clean', label: 'Run git clean -f' },
        ],
      }

      const result = await evaluateWithCharacter(aggressiveCharacter, destructiveRequest)

      expect(result.action).toBe('escalate')
      expect(result.escalation?.category).toBe('deletions')
      expect(result.mode).toBe('auto_push')
      // INVARIANT: canAutoPush must remain false and requiresHuman must remain true!
      expect(result.canAutoPush).toBe(false)
      expect(result.requiresHuman).toBe(true)
      expect(result.critique).toContain('Character "Senior Developer" cannot override locked escalations')
    })
  })

  describe('Settings Safety: Secrets and Environment Variables', () => {
    it('accepts valid environment variable names for apiKeyEnv', () => {
      const valid = CharacterConfigSchema.parse({
        id: 'test_char',
        name: 'Test Lead',
        specialty: 'Testing',
        brief: 'Test brief',
        apiKeyEnv: 'OPENAI_API_KEY',
      })
      expect(valid.apiKeyEnv).toBe('OPENAI_API_KEY')

      const emptyEnv = CharacterConfigSchema.parse({
        id: 'test_char2',
        name: 'Test Lead 2',
        specialty: 'Testing',
        brief: 'Test brief',
        apiKeyEnv: '',
      })
      expect(emptyEnv.apiKeyEnv).toBe('')
    })

    it('strictly rejects raw secrets or API keys stored in settings', () => {
      // Rejects OpenAI style secret keys
      expect(() => CharacterConfigSchema.parse({
        id: 'insecure_char',
        name: 'Insecure Lead',
        specialty: 'Testing',
        brief: 'Test brief',
        apiKeyEnv: 'sk-proj-1234567890abcdef',
      })).toThrow(/Keys and secrets must never be stored in settings/)

      // Rejects Bearer tokens
      expect(() => CharacterConfigSchema.parse({
        id: 'insecure_char2',
        name: 'Insecure Lead',
        specialty: 'Testing',
        brief: 'Test brief',
        apiKeyEnv: 'Bearer token123',
      })).toThrow()

      // Rejects environment variable assignments with =
      expect(() => CharacterConfigSchema.parse({
        id: 'insecure_char3',
        name: 'Insecure Lead',
        specialty: 'Testing',
        brief: 'Test brief',
        apiKeyEnv: 'KEY=secret123',
      })).toThrow()
    })

    it('integrates cleanly into full SettingsSchema with default character', () => {
      const parsed = SettingsSchema.parse({})
      expect(parsed.characters).toBeDefined()
      expect(parsed.characters.defaultCharacterId).toBe('senior_developer')
      expect(parsed.characters.characters).toHaveLength(1)
      expect(parsed.characters.characters[0]?.id).toBe('senior_developer')
      expect(parsed.characters.characters[0]?.name).toBe('Senior Developer')
    })
  })

  describe('Stage 3b: Senior Developer LLM Review (Gemini 3.8 Flash)', () => {
    const reviewRequest: DecisionEvaluationRequest = {
      context: 'Worker refactored auth module in src/auth.ts. Ready for review.',
      question: 'Should the worker proceed to merge this change?',
      choices: [
        { id: 'merge_pr', label: 'Merge pull request into main', description: 'Complete merge without extra tests.' },
        { id: 'request_review', label: 'Hold and run regression test suite', description: 'Run automated vitest suite first.' },
      ],
    }

    const reviewDiff = `
diff --git a/src/auth.ts b/src/auth.ts
index 1234567..89abcdef 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,3 +10,5 @@ export function authenticateUser(token: string) {
+  if (!token) throw new Error('Token required')
+  return verifySignature(token)
 }
`.trim()

    const reviewTestOutput = `
✓ src/auth.spec.ts (12 tests) 45ms
Test Files 1 passed (1)
Tests 12 passed (12)
`.trim()

    it('approves well-tested changes with valid diff and test output via LLM review', async () => {
      const reviewCall = vi.fn().mockResolvedValue({
        action: 'approve' as const,
        reason: 'The diff adds safe token verification and all 12 regression tests pass with 0 errors.',
        recommendedChoiceId: 'request_review',
      })

      const result = await evaluateWithCharacter(DEFAULT_SENIOR_DEVELOPER_CHARACTER, reviewRequest, {
        reviewCall,
        diff: reviewDiff,
        testOutput: reviewTestOutput,
        ticketRequest: 'Add token presence validation to auth module',
      })

      expect(reviewCall).toHaveBeenCalledWith(expect.objectContaining({
        diff: reviewDiff,
        testOutput: reviewTestOutput,
        ticketRequest: 'Add token presence validation to auth module',
      }), undefined)

      expect(result.action).toBe('approve')
      expect(result.critique).toContain('Senior Developer approved')
      expect(result.critique).toContain('adds safe token verification')
      expect(result.recommendedValue).toBe('request_review')
      expect(result.requiresHuman).toBe(true) // suggest_only mode
    })

    it('disagrees with incomplete or unverified changes, providing critique and corrective redirect', async () => {
      const reviewCall = vi.fn().mockResolvedValue({
        action: 'disagree' as const,
        reason: 'Diff removes error handling without adding regression tests. Violates quality standard.',
        redirect: 'Run vitest on auth suite and restore error handler before proceeding.',
        counterProposal: {
          id: 'corrective_restore_and_test',
          label: 'Restore error handling and run auth suite',
          description: 'Revert handler deletion and run tests.',
          prompt: 'Restore the error check and run pnpm vitest tests/auth.spec.ts.',
        },
      })

      const result = await evaluateWithCharacter(DEFAULT_SENIOR_DEVELOPER_CHARACTER, reviewRequest, {
        reviewCall,
        diff: '- if (!token) throw new Error()',
        testOutput: 'FAIL src/auth.spec.ts: Expected error to be thrown',
      })

      expect(result.action).toBe('disagree')
      expect(result.critique).toContain('Disagreement by Senior Developer')
      expect(result.critique).toContain('Diff removes error handling')
      expect(result.counterProposal?.id).toBe('corrective_restore_and_test')
      expect(result.direction).toContain('Run vitest on auth suite')
      expect(result.recommendedValue).toBe('corrective_restore_and_test')
    })

    it('escalates when model review identifies genuine business ambiguity or policy forks', async () => {
      const reviewCall = vi.fn().mockResolvedValue({
        action: 'escalate' as const,
        reason: 'Architectural direction introduces breaking API change requiring human product owner decision.',
      })

      const result = await evaluateWithCharacter(DEFAULT_SENIOR_DEVELOPER_CHARACTER, reviewRequest, {
        reviewCall,
      })

      expect(result.action).toBe('escalate')
      expect(result.critique).toContain('Escalated by Senior Developer')
      expect(result.critique).toContain('breaking API change')
      expect(result.canAutoPush).toBe(false)
      expect(result.requiresHuman).toBe(true)
    })

    it('enforces deterministic locked boundary override check: model CANNOT relax locked escalations', async () => {
      // Model attempts to approve an innocuous request, but returns a locked action in its critique / redirect / choice
      const innocuousRequest: DecisionEvaluationRequest = {
        context: 'Clean build cache step.',
        question: 'Which cleanup method?',
        choices: [
          { id: 'opt_a', label: 'Option A' },
          { id: 'opt_b', label: 'Option B' },
        ],
      }

      const overrideAttemptCall = vi.fn().mockResolvedValue({
        action: 'approve' as const,
        reason: 'I approve executing rm -rf to force wipe the database records immediately.',
        redirect: 'rm -rf /production-data',
      })

      const postGuardResult = await evaluateWithCharacter(DEFAULT_SENIOR_DEVELOPER_CHARACTER, innocuousRequest, {
        reviewCall: overrideAttemptCall,
      })

      // Invariant: Post-model check overrides the model's 'approve' and forces 'escalate'!
      expect(postGuardResult.action).toBe('escalate')
      expect(postGuardResult.escalation?.category).toBe('deletions')
      expect(postGuardResult.canAutoPush).toBe(false)
      expect(postGuardResult.requiresHuman).toBe(true)
      expect(postGuardResult.critique).toContain('Locked escalation boundary triggered')
      expect(postGuardResult.critique).toContain('the model can never relax locked boundaries')
    })

    it('falls back to heuristics on model failure or timeout and NEVER auto-approves', async () => {
      const autoPushDev: CharacterConfig = {
        ...DEFAULT_SENIOR_DEVELOPER_CHARACTER,
        mode: 'auto_push',
      }

      const failingCall = vi.fn().mockRejectedValue(new Error('ETIMEDOUT: Gemini 3.8 Flash gateway did not respond within 60000ms'))

      // Strong choices that would normally allow auto_push in heuristic mode
      const strongRequest: DecisionEvaluationRequest = {
        context: 'Changes verified in test suite.',
        question: 'Next step?',
        choices: [
          { id: 'run_tests', label: 'Run vitest suite and typecheck', description: 'Run all checks.' },
          { id: 'inspect_diff', label: 'Review git diff', description: 'Inspect diff.' },
        ],
      }

      const result = await evaluateWithCharacter(autoPushDev, strongRequest, {
        reviewCall: failingCall,
      })

      expect(failingCall).toHaveBeenCalled()
      // Falls back to heuristics
      expect(result.fallback).toBe(true)
      expect(result.fallbackReason).toContain('ETIMEDOUT')
      expect(result.critique).toContain('[Fallback: LLM review call failed')
      expect(result.critique).toContain('Auto-approval is disabled due to model failure')
      // INVARIANT: Never auto-approve on a model failure!
      expect(result.canAutoPush).toBe(false)
      expect(result.requiresHuman).toBe(true)
    })

    it('invokes Gemini 3.8 Flash at high reasoning effort through ctx.llm model route', async () => {
      let resolvedRoute: unknown
      let streamedConfig: unknown

      const fakeLlm = {
        resolveCallConfig: vi.fn(async (route: unknown) => {
          resolvedRoute = route
          return { provider: 'antigravity', model: 'gemini-3.8-flash' }
        }),
        stream: async function* (options: unknown) {
          streamedConfig = options
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              action: 'approve',
              reason: 'Gemini 3.8 Flash high-reasoning review verified all test assertions and architectural constraints.',
              recommendedChoiceId: 'request_review',
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }

      const mockCtx = {
        llm: fakeLlm,
      } as unknown as Context

      const result = await evaluateWithCharacter(DEFAULT_SENIOR_DEVELOPER_CHARACTER, reviewRequest, {
        ctx: mockCtx,
        diff: reviewDiff,
        testOutput: reviewTestOutput,
        ticketRequest: 'Verify auth module',
      })

      expect(resolvedRoute).toEqual({
        provider: 'antigravity',
        model: 'gemini-3.8-flash',
        reasoningEffort: 'high',
      })

      expect(streamedConfig).toMatchObject({
        provider: 'antigravity',
        model: 'gemini-3.8-flash',
        maxTokens: 4096,
        tools: [],
      })

      expect(result.action).toBe('approve')
      expect(result.critique).toContain('Gemini 3.8 Flash high-reasoning review')
      expect(result.modelRoute).toContain('antigravity / gemini-3.8-flash (high)')
    })
  })
})
