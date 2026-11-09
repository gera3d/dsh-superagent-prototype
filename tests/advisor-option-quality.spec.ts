import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DecisionInbox, captureAdvisorTask } from '../src/app/decision-inbox.ts'
import { FindingStore } from '../src/app/finding.ts'
import { DeliveryStore } from '../src/app/feature-delivery.ts'
import { reconcileInboxCurrency } from '../src/app/delivery-runtime.ts'
import { enforceDecisionQuality, evaluateDecisionWithFallback } from '../src/app/decision-ranker.ts'
import { evaluateWithCharacter } from '../src/app/character-evaluator.ts'
import { DEFAULT_SENIOR_DEVELOPER_CHARACTER } from '../src/core/character.ts'
import {
  auditOptionSet,
  deriveOptionQualityContext,
  evaluateOptionQuality,
  filterQualityOptions,
  type OptionQualityContext,
} from '../src/app/option-quality.ts'
import type { DecisionChoice, DecisionEvaluationRequest, DecisionEvaluationResult } from '../src/core/decision.ts'

const dbs: DatabaseSync[] = []
afterEach(() => dbs.splice(0).forEach(db => db.close()))

function createEnvironment() {
  const db = new DatabaseSync(':memory:')
  dbs.push(db)
  const inbox = new DecisionInbox(db)
  const findings = new FindingStore(db)
  const deliveries = new DeliveryStore(db)
  return { db, inbox, findings, deliveries }
}

describe('Senior Developer Option Quality & Lifecycle Invariants', () => {
  describe('Independent Review Reproduction Blockers', () => {
    it('Blocker 1: Explicitly authorized native-tool gap issue is valid (taskScope honored)', () => {
      const issue = evaluateOptionQuality(
        {
          id: 'x',
          label: 'Create the new issue',
          prompt: 'Create the new issue for the native-tool gap as the user requested.',
        },
        { taskScope: 'User explicitly requested a new native-tool gap issue.' },
      )
      expect(issue).toBeNull()
    })

    it('Blocker 2: Safe prohibition / negation on resolved finding is valid (not stale-completed-work)', () => {
      const issue = evaluateOptionQuality(
        {
          id: 'x',
          label: 'Preserve completion',
          prompt: 'Do not repeat the verification or reopen the finding.',
        },
        { isFindingResolved: true },
      )
      expect(issue).toBeNull()
    })

    it('Blocker 3: Truthful denial of automatic dispatch API is valid (not fictional-dispatch)', () => {
      const issue = evaluateOptionQuality(
        {
          id: 'x',
          label: 'Explain the missing API',
          prompt: 'There is no automatic dispatch API to Codex; explain the manual handoff.',
        },
        {},
      )
      expect(issue).toBeNull()
    })

    it('Blocker 3b: filterQualityOptions in ordinary conversation clarifies next step, does not invent tests', () => {
      const filtered = filterQualityOptions(
        [
          {
            id: 'bad-tool-gap',
            label: 'Open native tool gap finding',
            prompt: 'Open a separate finding for the native tool gap.',
            why: 'Unsolicited detour',
            recommended: true,
          },
        ],
        {}, // ordinary conversation
      )
      expect(filtered.length).toBeGreaterThanOrEqual(1)
      expect(filtered[0]!.prompt).not.toContain('vitest')
      expect(filtered[0]!.prompt).not.toContain('tsc --noEmit')
      expect(filtered[0]!.label).toContain('Clarify next step')
    })
  })

  describe('Evaluation of all 17 options across the 6 actual cards', () => {
    // Card 1: chat-6557f8abbb8003c73cfefec683a5c4cd (Gemini r5 closure)
    const card6557Context: OptionQualityContext = {
      isFindingResolved: true,
      findingId: '06fd14af-5535-411d-936c-477bf2bd2cfa',
      taskScope: 'Verify reporting route with orchestrator_report',
    }
    const card6557Options = [
      {
        id: 'next-1',
        label: 'Confirm completion, no further work',
        prompt: 'The finding 06fd14af-5535-411d-936c-477bf2bd2cfa is recorded as verified and resolved (r5, local-operator). No further implementation, tests or review are needed for this scope. Stop here and take no new action unless given a new instruction.',
        why: 'Work finished',
        recommended: true,
      },
      {
        id: 'next-2',
        label: 'Inspect recorded resolution evidence',
        prompt: 'Read-only: review the recorded evidence for finding 06fd14af (r1 blocked, r3 fallback ready, r5 Gemini ready, verified reference reporting-real-gemini-verified.json) and summarize the history in a few lines. Do not re-run the CLI, tests or any verification, and do not reopen the finding.',
        why: 'Review evidence',
        recommended: false,
      },
    ]

    it('Card chat-6557f8ab: both options are valid (safe completion & read-only evidence)', () => {
      expect(evaluateOptionQuality(card6557Options[0]!, card6557Context)).toBeNull()
      expect(evaluateOptionQuality(card6557Options[1]!, card6557Context)).toBeNull()
      const audit = auditOptionSet(card6557Options, card6557Context)
      expect(audit.valid).toBe(true)
      expect(audit.validChoices).toHaveLength(2)
      expect(audit.invalidChoices).toHaveLength(0)
    })

    // Card 2: chat-7d80df3b084ddfc8ba5f6bea9c655c7f (fallback r3 closure)
    const card7d80Context: OptionQualityContext = {
      isFindingResolved: true,
      findingId: '06fd14af-5535-411d-936c-477bf2bd2cfa',
      taskScope: 'Verify reporting route fallback',
    }
    const card7d80Options = [
      {
        id: 'next-1',
        label: 'State completion; no further action',
        prompt: 'The finding 06fd14af-5535-411d-936c-477bf2bd2cfa is recorded as verified and resolved (revision 7, local-operator, job r5). The r3 fallback report (claude-sonnet-5-5, not Gemini) and the failed r1 attempt stay in history only. Do not repeat the verification, rerun tests, or reopen without a new user instruction. Confirm in one sentence that this scope is closed.',
        why: 'Work finished',
        recommended: true,
      },
      {
        id: 'next-2',
        label: 'Inspect recorded resolution evidence',
        prompt: 'Read-only: using records.read, summarize the recorded resolution of finding 06fd14af-5535-411d-936c-477bf2bd2cfa. Cover the verified r5 report (ticket dba40835765de9fc076788032474e7de, assignment fcc0f8a8d0ae474cd94d5a0db26fcc72) and the evidence file reporting-real-gemini-verified.json. Note that r3 ran on a fallback model and r1 was blocked. Do not run new checks, claim new verification, or take any action. If a record is unavailable, say so.',
        why: 'Summarize resolution',
        recommended: false,
      },
      {
        id: 'next-3',
        label: 'Note r3 vs r5 provenance for the record',
        prompt: 'Read-only: write a short provenance note distinguishing r1 (blocked), r3 (ready, fallback claude-sonnet-5-5 after Antigravity cooldown, so not a Gemini proof) and r5 (real Gemini, verified, resolved). Cite only recorded references. Do not propose acceptance, a rerun, or a new action, and do not invent verification results.',
        why: 'Provenance note',
        recommended: false,
      },
    ]

    it('Card chat-7d80df3b: all three options are valid (safe completion, read-only summary, provenance)', () => {
      expect(evaluateOptionQuality(card7d80Options[0]!, card7d80Context)).toBeNull()
      expect(evaluateOptionQuality(card7d80Options[1]!, card7d80Context)).toBeNull()
      expect(evaluateOptionQuality(card7d80Options[2]!, card7d80Context)).toBeNull()
      const audit = auditOptionSet(card7d80Options, card7d80Context)
      expect(audit.valid).toBe(true)
      expect(audit.validChoices).toHaveLength(3)
    })

    // Card 3: chat-f96fc47a6722410ddcb1c105e3a7fcf3 (reporting r31 closure)
    const cardF96fContext: OptionQualityContext = {
      isFindingResolved: true,
      findingId: '51f309ca-d396-4983-a55d-ef4432a8572f',
      taskScope: 'Implement missing report file transport for availability fallback',
    }
    const cardF96fOptions = [
      {
        id: 'next-1',
        label: 'Confirm resolution, stop here',
        prompt: 'The finding is recorded as verified and resolved (r31, evidence: reporting-real-gemini-verified.json). No further implementation, tests, or dispatch are needed for this scope. Please state completion plainly and take no further action unless I give a new instruction.',
        why: 'Stop here',
        recommended: true,
      },
      {
        id: 'next-2',
        label: 'Inspect recorded resolution evidence',
        prompt: 'Read-only: open the recorded verified evidence (docs/evidence/reporting-real-gemini-verified.json) and summarize what it shows about ready reports on the antigravity/Gemini route. Do not re-run tests, reopen the finding, or dispatch work. Flag only if the evidence appears to contradict the resolution.',
        why: 'Open evidence',
        recommended: false,
      },
      {
        id: 'next-3',
        label: 'Log the native-tool gap separately',
        prompt: 'The Gemini route still lacks a native orchestrator_report tool and relies on the file-based transport from PR #74. Draft a short description for a new, separate finding covering that gap. Do not reopen 51f309ca or start implementation; I will decide whether to file it.',
        why: 'Log tool gap',
        recommended: false,
      },
    ]

    it('Card chat-f96fc47a: options 1 & 2 valid; option 3 rejected as unrelated-task-detour', () => {
      expect(evaluateOptionQuality(cardF96fOptions[0]!, cardF96fContext)).toBeNull()
      expect(evaluateOptionQuality(cardF96fOptions[1]!, cardF96fContext)).toBeNull()
      const badChoiceIssue = evaluateOptionQuality(cardF96fOptions[2]!, cardF96fContext)
      expect(badChoiceIssue?.code).toBe('unrelated-task-detour')

      const audit = auditOptionSet(cardF96fOptions, cardF96fContext)
      expect(audit.valid).toBe(false)
      expect(audit.validChoices).toHaveLength(2)
      expect(audit.invalidChoices).toHaveLength(1)
      expect(audit.invalidChoices[0]!.id).toBe('next-3')

      const filtered = filterQualityOptions(cardF96fOptions, cardF96fContext)
      expect(filtered).toHaveLength(2)
      expect(filtered.map(o => o.id)).toEqual(['next-1', 'next-2'])
    })

    // Card 4: chat-94e77e2dc7bf4b94736ee247267c7e02 (failed r1 closure)
    const card94e7Context: OptionQualityContext = {
      isFindingResolved: true,
      findingId: '06fd14af-5535-411d-936c-477bf2bd2cfa',
      taskScope: 'Verify reporting route with orchestrator_report',
    }
    const card94e7Options = [
      {
        id: 'next-1',
        label: 'Confirm closure from recorded resolution',
        prompt: 'Finding 06fd14af-5535-411d-936c-477bf2bd2cfa is already recorded as verified and resolved (r5, local-operator, 2026-11-09T02:22:30Z). Using records.read only, summarize the recorded history: r1 blocked (closed ticket, Antigravity cooldown), r3 ready (fallback), r5 ready on Gemini, then verified. State that no further work is needed. Do not rerun the CLI check, reopen the finding, or claim any new verification.',
        why: 'Confirm closure',
        recommended: true,
      },
      {
        id: 'next-2',
        label: 'Mark r1 ticket as superseded history',
        prompt: 'The r1 worker\'s suggestion to open a new authorized ticket for this finding is stale. r5 (ticket dba40835765de9fc076788032474e7de, assignment fcc0f8a8d0ae474cd94d5a0db26fcc72) was later verified and resolved. Write a short note that r1 (ticket 92582a0a1a1bcff6cfa69a1b868d95dc) is superseded, preserved only as history, and that no reauthorization or retry is required.',
        why: 'Superseded note',
        recommended: false,
      },
      {
        id: 'next-3',
        label: 'List blocked deliveries needing operator scope',
        prompt: 'Using records.read only, list the recorded deliveries blocked on missing operator-confirmed scope, target and acceptance requirements: auto-1aa9568a, auto-71dc2590 and auto-d65f3131. For each, state exactly which input a person must supply. Do not start work, guess scope, or propose acceptance. This is separate from the resolved Gemini verification finding.',
        why: 'Triage blocked deliveries',
        recommended: false,
      },
    ]

    it('Card chat-94e77e2d: options 1 & 2 valid; option 3 rejected as unrelated-task-detour', () => {
      expect(evaluateOptionQuality(card94e7Options[0]!, card94e7Context)).toBeNull()
      expect(evaluateOptionQuality(card94e7Options[1]!, card94e7Context)).toBeNull()
      const badChoiceIssue = evaluateOptionQuality(card94e7Options[2]!, card94e7Context)
      expect(badChoiceIssue?.code).toBe('unrelated-task-detour')

      const audit = auditOptionSet(card94e7Options, card94e7Context)
      expect(audit.valid).toBe(false)
      expect(audit.validChoices).toHaveLength(2)
      expect(audit.invalidChoices).toHaveLength(1)
      expect(audit.invalidChoices[0]!.id).toBe('next-3')

      const filtered = filterQualityOptions(card94e7Options, card94e7Context)
      expect(filtered).toHaveLength(2)
      expect(filtered.map(o => o.id)).toEqual(['next-1', 'next-2'])
    })

    // Card 5: chat-a71ba8a1a0abcfc469fd1bcb06174d0f (advisor r12 candidate ready)
    const cardA71bContext: OptionQualityContext = {
      isReadyUnreviewed: true,
      findingId: '12779824-b82e-484d-9502-d2150ba58aa1',
      taskScope: 'Shared advisor context correction for canonical finding-owned implementation jobs and native fallback',
    }
    const cardA71bOptions = [
      {
        id: 'next-1',
        label: 'Hand off to Codex coordinator review',
        prompt: 'Operator: explicitly dispatch the isolated candidate to the Codex reviewer and release coordinator (root operator); no automated Codex notification route exists, so this handoff is manual. Review workspace finding-task-7c017292cef5, candidate commit 303d531, checkpoint/NOTES.md and checkpoint/01-backend-canonical-finding-advice.patch (the ticket report is ff2c549eeef9c883fa8064c997f3c225). Verify the exact head matches 303d531, inspect the diff in src/app/advice-context.ts against scope, and check the saved logs for the claimed 98 tests, typecheck and build. Rerun only checks that are missing or unverifiable. The worker\'s pass claims are unverified until the coordinator confirms them. Accept or reject under existing authorization.',
        why: 'Dispatch to coordinator',
        recommended: true,
      },
      {
        id: 'next-2',
        label: 'Audit saved evidence before review',
        prompt: 'Before coordinator review, inspect the saved logs and artifacts in checkpoint/ for candidate 303d531. Confirm they show the 11 suites and 98 tests, typecheck and build results, and that they were run on this exact head. Also confirm tests/root-advisor-evidence.audit.spec.ts and the new negative fixtures in tests/advice-context.spec.ts are included. Report any gaps as targeted missing checks, not a blanket full rerun. Do not merge or accept.',
        why: 'Inspect saved logs',
        recommended: false,
      },
      {
        id: 'next-3',
        label: 'Targeted diff scope check',
        prompt: 'Read-only: review the diff of candidate 303d531 against the finding scope. Confirm it touches only advice-context derivation and its tests, and adds no Codex dispatch bridge, permissions, auto-send or publication path. Check the edge cases: newer failure or pending evidence superseding older ready evidence, equal timestamps, missing timestamps, and ended tickets with no report. List any gaps for the coordinator. Do not modify code.',
        why: 'Diff scope check',
        recommended: false,
      },
    ]

    it('Card chat-a71ba8a1: all three options are valid (manual handoff, audit saved evidence, diff check)', () => {
      expect(evaluateOptionQuality(cardA71bOptions[0]!, cardA71bContext)).toBeNull()
      expect(evaluateOptionQuality(cardA71bOptions[1]!, cardA71bContext)).toBeNull()
      expect(evaluateOptionQuality(cardA71bOptions[2]!, cardA71bContext)).toBeNull()
      const audit = auditOptionSet(cardA71bOptions, cardA71bContext)
      expect(audit.valid).toBe(true)
      expect(audit.validChoices).toHaveLength(3)
    })

    // Card 6: chat-eb937970f942747759f30c87b8476336 (advisor r6 candidate)
    const cardEb93Context: OptionQualityContext = {
      isReadyUnreviewed: true,
      hasNestedProviderEvidence: true,
      findingId: '12779824-b82e-484d-9502-d2150ba58aa1',
      taskScope: 'Shared advisor context correction for canonical finding-owned jobs',
    }
    const cardEb93Options = [
      {
        id: 'next-1',
        label: 'Re-run checks, report real output',
        prompt: 'Your final message says typecheck was only launched and is still pending, yet it also says typecheck, build and 89 tests passed. This turn made 0 tool calls. In the isolated repo at candidate b4d9ad3, run tsc --noEmit, the build and the full test suite. Report the exact commands, exit codes and pass/fail counts. Do not claim a pass you did not observe. Stop at the scope boundary.',
        why: 'Re-run full suite',
        recommended: true,
      },
      {
        id: 'next-2',
        label: 'Audit diff against narrow scope',
        prompt: 'Before handoff, inspect the diff of 01-backend-canonical-finding-advice.patch against the stated scope: a shared advisor context correction for finding-owned implementation jobs and native fallback. List each changed file and hunk. Flag anything that is not needed for that correction, such as the CharactersConfigSchema factory change, persona override propagation and alias matching. For each, say whether it is required or should be split out. Do not modify anything yet.',
        why: 'Audit diff',
        recommended: false,
      },
      {
        id: 'next-3',
        label: 'Verify tests cover the handoff behavior',
        prompt: 'Check whether the candidate has tests that exercise the actual finding: a completed finding-owned job (finding:...:r6) yields a review handoff recommendation, and the native fallback path does the same. Name the test files and cases that cover each, plus the edge cases: a missing finding record, an unknown specialist id, and hyphen versus underscore ids. If coverage is missing, propose the specific tests to add in the isolated repo. Do not publish or merge.',
        why: 'Verify coverage',
        recommended: false,
      },
    ]

    it('Card chat-eb937970: option 1 rejected as blanket-rerun; options 2 & 3 valid', () => {
      const badIssue = evaluateOptionQuality(cardEb93Options[0]!, cardEb93Context)
      expect(badIssue?.code).toBe('blanket-rerun')
      expect(evaluateOptionQuality(cardEb93Options[1]!, cardEb93Context)).toBeNull()
      expect(evaluateOptionQuality(cardEb93Options[2]!, cardEb93Context)).toBeNull()

      const audit = auditOptionSet(cardEb93Options, cardEb93Context)
      expect(audit.valid).toBe(false)
      expect(audit.validChoices).toHaveLength(2)
      expect(audit.invalidChoices).toHaveLength(1)
      expect(audit.invalidChoices[0]!.id).toBe('next-1')

      const filtered = filterQualityOptions(cardEb93Options, cardEb93Context)
      expect(filtered).toHaveLength(2)
      expect(filtered[0]!.id).toBe('next-2')
      expect(filtered[0]!.recommended).toBe(true) // Reassigned recommendation to clean top choice
    })
  })

  describe('Additional Security & Boundary Guards', () => {
    it('Rejects worker self-review / self-acceptance', () => {
      const issue = evaluateOptionQuality(
        {
          id: 'self-1',
          label: 'Self review and merge',
          prompt: 'As the worker, review and accept your own patch and merge to main.',
        },
        { isReadyUnreviewed: true },
      )
      expect(issue?.code).toBe('worker-self-review')
    })

    it('Rejects fictional dispatch API invocation', () => {
      const issue = evaluateOptionQuality(
        {
          id: 'disp-1',
          label: 'Call notification API',
          prompt: 'Call the notification API to automatically dispatch candidate to Codex.',
        },
        { isReadyUnreviewed: true },
      )
      expect(issue?.code).toBe('fictional-dispatch')
    })

    it('Rejects premature publish on unbound delivery, but accepts gathering missing inputs', () => {
      const bypassIssue = evaluateOptionQuality(
        {
          id: 'unbound-1',
          label: 'Publish candidate',
          prompt: 'Publish and accept the candidate delivery immediately without waiting for scope binding.',
        },
        { deliveryScopeBound: false },
      )
      expect(bypassIssue?.code).toBe('unbound-delivery-bypass')

      const validGather = evaluateOptionQuality(
        {
          id: 'unbound-2',
          label: 'Identify missing inputs',
          prompt: 'Read-only: identify the exact missing scope binding inputs (target repository and base SHA) and which responsible human owner can provide them.',
        },
        { deliveryScopeBound: false },
      )
      expect(validGather).toBeNull()
    })

    it('Rejects actual repeat commands on resolved findings', () => {
      const repeatIssue = evaluateOptionQuality(
        {
          id: 'repeat-1',
          label: 'Retry verification',
          prompt: 'Re-run the full verification tests on the resolved finding.',
        },
        { isFindingResolved: true },
      )
      expect(repeatIssue?.code).toBe('stale-completed-work')
    })
  })

  describe('Lifecycle Currency & Non-Recreation Invariants', () => {
    it('Resolved finding with no newer user request does not capture a new pending advisor card', () => {
      const { inbox, findings } = createEnvironment()

      let finding = findings.observe({
        dedupKey: 'test-finding',
        title: 'Fix issue',
        problem: 'Bug',
        scope: 'Fix bug',
        owner: 'local-operator',
        kind: 'fix',
        requirements: ['Check 1'],
        repository: 'gera3d/superagent-sandbox',
        occurrence: { id: 'occ-1', reference: 'ref-1', evidence: 'Log' },
      })
      findings.confirm(finding.id, { revision: finding.revision, choiceId: 'fix_now' })
      finding = findings.markDispatched(finding.id, 'ticket-123', 'assignment-123')
      ;(findings as any).atomic(() => {
        const rec = (findings as any).require(finding.id)
        rec.reports.push({
          state: 'ready',
          jobId: rec.job!.id,
          at: new Date().toISOString(),
          reference: 'evidence.json',
          evidence: 'All tests pass',
          nextDecision: 'Ready for review',
        })
        rec.state = 'blocked'
        rec.blocker = 'Review / verification required'
        return (findings as any).save(rec)
      })
      findings.resolve(finding.id, 'evidence.json', ['Check 1'])
      const resolvedRec = findings.get(finding.id)!
      const resolvedAt = Date.parse(resolvedRec.resolution!.at)

      // Assistant finishes completion turn before/at resolution time
      const events: SessionEvent[] = [
        { type: 'user/message', seq: 0, time: resolvedAt - 500, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please resolve' }] } },
        { type: 'turn/start', seq: 1, time: resolvedAt - 400, data: { turn: 1 } },
        { type: 'assistant/message', seq: 2, time: resolvedAt - 100, data: { turn: 1, message: { id: 'msg-1', content: [{ type: 'text', text: 'All fixes complete and verified.' }] } } },
        { type: 'turn/end', seq: 3, time: resolvedAt, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as any

      captureAdvisorTask(inbox, 'worker-ticket-123', events)
      expect(inbox.list()).toHaveLength(0) // No pending choice captured
    })

    it('Explicit new human request after resolution is captured and preserved', () => {
      const { inbox, findings } = createEnvironment()

      let finding = findings.observe({
        dedupKey: 'test-finding-2',
        title: 'Fix issue 2',
        problem: 'Bug',
        scope: 'Fix bug',
        owner: 'local-operator',
        kind: 'fix',
        requirements: ['Check 1'],
        repository: 'gera3d/superagent-sandbox',
        occurrence: { id: 'occ-1', reference: 'ref-1', evidence: 'Log' },
      })
      findings.confirm(finding.id, { revision: finding.revision, choiceId: 'fix_now' })
      finding = findings.markDispatched(finding.id, 'ticket-456', 'assignment-456')
      ;(findings as any).atomic(() => {
        const rec = (findings as any).require(finding.id)
        rec.reports.push({
          state: 'ready',
          jobId: rec.job!.id,
          at: new Date().toISOString(),
          reference: 'evidence.json',
          evidence: 'All tests pass',
          nextDecision: 'Ready for review',
        })
        rec.state = 'blocked'
        rec.blocker = 'Review / verification required'
        return (findings as any).save(rec)
      })
      findings.resolve(finding.id, 'evidence.json', ['Check 1'])
      const resolvedRec = findings.get(finding.id)!
      const resolvedAt = Date.parse(resolvedRec.resolution!.at)

      // User sends a NEW explicit request AFTER resolution time
      const events: SessionEvent[] = [
        { type: 'user/message', seq: 0, time: resolvedAt + 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Can we add an extra test for performance?' }] } },
        { type: 'turn/start', seq: 1, time: resolvedAt + 1500, data: { turn: 2 } },
        { type: 'assistant/message', seq: 2, time: resolvedAt + 2000, data: { turn: 2, message: { id: 'msg-2', content: [{ type: 'text', text: 'I can prepare performance benchmarks for the extra test.' }] } } },
        { type: 'turn/end', seq: 3, time: resolvedAt + 2500, data: { turn: 2, reason: { kind: 'completed' } } },
      ] as any

      captureAdvisorTask(inbox, 'worker-ticket-456', events)
      const items = inbox.list()
      expect(items).toHaveLength(1)
      expect(items[0]!.sessionId).toBe('worker-ticket-456')
      expect(items[0]!.status).toBe('pending')
    })

    it('Existing pending historical rows are preserved without bulk retirement', () => {
      const { inbox, deliveries, findings } = createEnvironment()
      // Manually publish an item to history
      const item = inbox.publishAdvisor({
        sessionId: 'worker-ticket-old',
        sourceMessageId: 'msg-old',
        sourceTurn: 1,
        sourceSeq: 10,
        key: 'msg-old',
        createdAt: 1000,
        question: 'Choose next step',
        context: 'Some context',
        title: 'Old task',
        model: 'Senior Developer',
        options: [
          { id: 'opt-1', label: 'Action 1', prompt: 'Prompt 1', why: 'Why 1', recommended: true },
          { id: 'opt-2', label: 'Action 2', prompt: 'Prompt 2', why: 'Why 2', recommended: false },
        ],
      })
      expect(item.status).toBe('pending')

      // Run reconcile currency
      reconcileInboxCurrency(inbox, deliveries, undefined, findings)

      // Item must remain untouched as pending (no historical bulk retirement)
      const after = inbox.get(item.id)!
      expect(after.status).toBe('pending')
      expect(after.choices.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('Decision Ranker & Character Evaluator Integration', () => {
    it('Ranker filters invalid choices from evaluation set and appends quality notice', () => {
      const request: DecisionEvaluationRequest = {
        context: 'Task context for report verification.\nFACTS below are bounded recorded data: {"finding":{"id":"51f309ca","state":"resolved"}}',
        question: 'Choose next action',
        choices: [
          { id: 'next-1', label: 'Confirm resolution, stop here', prompt: 'Work is resolved, stop here.' },
          { id: 'next-2', label: 'Inspect recorded resolution evidence', prompt: 'Read-only: review the recorded evidence.' },
          { id: 'next-3', label: 'Log the native-tool gap separately', prompt: 'Draft a separate finding for the native-tool gap.' },
        ],
      }

      const qualityContext = deriveOptionQualityContext(request.context)
      const audit = auditOptionSet(request.choices, qualityContext)

      const rawResult: DecisionEvaluationResult = {
        recommendedValue: 'next-3', // Model initially picked the invalid detour
        confidence: 0.8,
        distribution: [
          { id: 'next-1', probability: 0.15 },
          { id: 'next-2', probability: 0.05 },
          { id: 'next-3', probability: 0.8 },
        ],
        rationale: 'Pick tool gap',
        provider: 'test-model',
        latencyMs: 10,
      }

      const result = enforceDecisionQuality(rawResult, request, audit)

      // The ranker must reject next-3 and reassign to next-1 with normalized probability
      expect(result.recommendedValue).toBe('next-1')
      expect(result.confidence).toBe(0.75) // normalized relative to remaining valid choices (0.15 / 0.20)
      expect(result.distribution).toHaveLength(2)
      expect(result.distribution[0]!.id).toBe('next-1')
      expect(result.rationale).toContain('rejected by quality guard')
      expect(result.rationale).toContain('Scores only rank choices, never certify usefulness')
    })

    it('Character Evaluator disagrees with invalid choices and supplies context-appropriate counter proposal', async () => {
      const request: DecisionEvaluationRequest = {
        context: 'Delivery context without scope binding.\nFACTS below are bounded recorded data: {"delivery":{"id":"del-1","state":"ready","scopeBinding":{"bound":false,"missing":["target repository","base SHA"]}}}',
        question: 'Choose next action',
        choices: [
          { id: 'opt-bypass', label: 'Publish delivery', prompt: 'Publish and accept delivery immediately.' },
        ],
      }

      const result = await evaluateWithCharacter(DEFAULT_SENIOR_DEVELOPER_CHARACTER, request, {
        rankerResult: {
          recommendedValue: 'opt-bypass',
          confidence: 0.9,
          distribution: [{ id: 'opt-bypass', probability: 0.9 }],
          rationale: 'Publish now',
          provider: 'ranker',
          latencyMs: 5,
        },
      })

      expect(result.action).toBe('disagree')
      expect(result.critique).toContain('violates option quality standards')
      expect(result.counterProposal?.id).toBe('gather_scope_binding_inputs')
      expect(result.counterProposal?.label).toBe('Identify missing scope binding inputs')
      expect(result.counterProposal?.prompt).toContain('target repository, base SHA')
    })
  })
})
