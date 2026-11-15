// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ThreadBriefManager,
  resolveTicketBriefManager,
  resolveThreadBriefManager,
  type ThreadBriefCriterion,
  type ThreadBriefState,
  type CriterionEvidence,
} from '../src/core/thread-brief.ts'
import {
  ThreadBriefHeader,
  type ThreadBriefView,
} from '../src/client/thread-brief-header.tsx'
import { TicketPage } from '../src/client/ticket.tsx'
import { ThreadPage } from '../src/client/thread.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import type { T } from '../src/client/text.ts'
import { Store } from '../src/app/store.ts'
import { threadDetail } from '../src/app/views/threads.ts'
import { Sessions, type SessionsHost } from '../src/app/sessions.ts'
import type { Ticket, Thread, Trigger, Mandate } from '../src/core/index.ts'

const defaultMandate = (scope = 'Test scope'): Mandate => ({
  strength: 'explicit',
  policyVersion: 'p12345678',
  actor: { source: 'web', id: 'u1' },
  scope,
  basis: { via: 'addressed', addressed: 'mention' },
})

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('ThreadBriefManager Domain & Context Adapter (Issue #216)', () => {
  it('AC-1: preserves verbatim raw original ask without trimming or stripping', () => {
    const rawWithWhitespace = '  \n\tDetailed user ask with leading and trailing whitespace\n\t  '
    const mgr = ThreadBriefManager.fromRequest({
      thread_id: 'thread-1',
      raw_request: rawWithWhitespace,
      inferred_criteria: ['Criterion A'],
    })

    expect(mgr.rawOriginalAsk).toBe(rawWithWhitespace)
    expect(mgr.getState().raw_original_ask).toBe(rawWithWhitespace)
    expect(mgr.toView().raw_original_ask).toBe(rawWithWhitespace)
  })

  it('AC-2 & AC-3: distinguishes objective, scope, and marks inferred items as unconfirmed', () => {
    const mgr = ThreadBriefManager.fromRequest({
      thread_id: 'thread-1',
      raw_request: 'Implement bounded feature',
      objective: 'Bounded Feature Implementation',
      inferred_scope: ['Do not edit sessions.ts', 'Synthetic fixtures only'],
      inferred_criteria: ['Pass focused vitest tests', 'Retain fallback coexistence'],
    })

    const state = mgr.getState()
    expect(state.objective).toBe('Bounded Feature Implementation')
    expect(state.scope.length).toBe(2)
    expect(state.scope[0]?.is_inferred).toBe(true)
    expect(state.scope[0]?.confirmed).toBe(false)

    expect(state.criteria.length).toBe(2)
    expect(state.criteria[0]?.id).toBe('CRIT-1')
    expect(state.criteria[0]?.is_inferred).toBe(true)
    expect(state.criteria[0]?.confirmed).toBe(false)
    expect(state.criteria[1]?.id).toBe('CRIT-2')
  })

  it('Counterexample regression fix: allocates unique monotonic IDs within a single multi-item proposal batch', () => {
    // Root counterexample from audit: fromRequest with no criteria, then stageProposal added_criteria ['first','second']
    const mgr = ThreadBriefManager.fromRequest({
      thread_id: 'thread-counterexample',
      raw_request: 'Task without initial criteria',
      inferred_criteria: [],
    })

    const proposal = mgr.stageProposal({
      description: 'Add multiple criteria at once',
      proposed_by: 'reviewer',
      added_criteria: ['first', 'second', 'third'],
    })

    expect(proposal.added_criteria).toBeDefined()
    const ids = proposal.added_criteria!.map(c => c.id)
    expect(ids).toEqual(['CRIT-1', 'CRIT-2', 'CRIT-3'])
    // Check uniqueness explicitly
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)
  })

  it('AC-2 & AC-14: monotonically allocates criterion IDs across active criteria, proposals, and history', () => {
    const mgr = ThreadBriefManager.fromRequest({
      thread_id: 'thread-1',
      raw_request: 'Task request',
      inferred_criteria: ['Initial crit 1', 'Initial crit 2'],
    })

    expect(mgr.allocateCriterionId()).toBe('CRIT-3')

    // Stage proposal with added criteria
    mgr.stageProposal({
      description: 'Add extra checks',
      proposed_by: 'operator-1',
      added_criteria: ['Proposed crit 3'],
    })

    // Next allocated ID must skip CRIT-3 because it is staged in proposal
    expect(mgr.allocateCriterionId()).toBe('CRIT-4')

    // Reject proposal; allocated ID must still avoid reusing CRIT-3
    const proposal2 = mgr.stageProposal({
      description: 'Will be rejected',
      proposed_by: 'operator-2',
      added_criteria: ['Proposed crit 4'],
    })
    mgr.rejectProposal(proposal2.proposal_id)
    expect(mgr.allocateCriterionId()).toBe('CRIT-5')
  })

  it('AC-4 & AC-19: stages unconfirmed proposals without mutating active brief or bumping revision', () => {
    const mgr = ThreadBriefManager.fromRequest({
      thread_id: 'thread-1',
      raw_request: 'Original ask',
      inferred_criteria: ['Baseline requirement'],
    })

    const initialRev = mgr.revisionId
    const proposal = mgr.stageProposal({
      description: 'Expand testing scope',
      proposed_by: 'reviewer-agent',
      added_scope: ['Extra edge case testing'],
      added_criteria: ['Edge case counterexample test passes'],
    })

    expect(mgr.revisionId).toBe(initialRev)
    expect(mgr.criteria.length).toBe(1) // Active criteria not mutated
    expect(mgr.pendingProposals.length).toBe(1)
    expect(mgr.pendingProposals[0]?.proposal_id).toBe(proposal.proposal_id)
    expect(mgr.pendingProposals[0]?.status).toBe('pending')
  })

  it('AC-20 & AC-21: operator confirmation audits revision, bumps revision_id, and records prior history', () => {
    const mgr = ThreadBriefManager.fromRequest({
      thread_id: 'thread-1',
      raw_request: 'Initial ask',
      inferred_criteria: ['Initial requirement'],
    })

    const proposal = mgr.stageProposal({
      description: 'Confirmed extension',
      proposed_by: 'operator',
      added_criteria: ['Extended requirement'],
    })

    const confirmed = mgr.confirmProposal(proposal.proposal_id, 'operator-human')
    expect(confirmed).toBe(true)

    const state = mgr.getState()
    expect(state.revision_id).toBe(2)
    expect(state.criteria.length).toBe(2)
    expect(state.criteria[1]?.confirmed).toBe(true) // Confirmed upon operator approval
    expect(state.revision_history.length).toBe(1)
    expect(state.revision_history[0]?.revision_id).toBe(1)
    expect(state.revision_history[0]?.confirmed_by).toBe('operator-human')
    expect(state.revision_history[0]?.criteria.length).toBe(1)
  })

  it('Getter boundary: read-only getter snapshots prevent external mutation of internal state', () => {
    const mgr = ThreadBriefManager.fromRequest({
      thread_id: 'thread-immutable',
      raw_request: 'Immutable test',
      inferred_criteria: ['Criteria 1'],
      inferred_scope: ['Scope 1'],
    })

    // Attempt direct mutation via getter arrays
    const externalCriteria = mgr.criteria
    const firstCrit = externalCriteria[0]
    if (firstCrit) firstCrit.status = 'satisfied'
    externalCriteria.push({
      id: 'CRIT-FAKE',
      description: 'Injected fake',
      status: 'satisfied',
      is_inferred: false,
      confirmed: true,
    })

    const externalScope = mgr.scope
    const firstScope = externalScope[0]
    if (firstScope) firstScope.confirmed = true

    // Internal state must remain untouched
    const freshState = mgr.getState()
    expect(freshState.criteria.length).toBe(1)
    expect(freshState.criteria[0]?.status).toBe('pending')
    expect(freshState.criteria.some(c => c.id === 'CRIT-FAKE')).toBe(false)
    expect(freshState.scope[0]?.confirmed).toBe(false)
  })

  it('Model context: represents unknown/unavailable when no genuine model context exists', () => {
    const mgr = ThreadBriefManager.fromRequest({
      thread_id: 'thread-no-model',
      raw_request: 'Task without model context',
      inferred_criteria: ['Criterion A'],
    })

    const state = mgr.getState()
    expect(state.model_context?.current_model).toBe('unknown')
    expect(mgr.toView().model_context.current_model).toBe('unknown')
  })

  it('AC-15 & AC-16: satisfied status strictly requires valid evidence and rejects missing/empty fields', () => {
    const mgr = ThreadBriefManager.fromRequest({
      thread_id: 'thread-1',
      raw_request: 'Implement tests',
      inferred_criteria: ['All tests pass'],
    })

    // Attempt without reference
    const failRef = mgr.recordEvidence('CRIT-1', {
      type: 'test_result',
      reference: '',
      summary: 'Passed suite',
    })
    expect(failRef.success).toBe(false)
    expect(mgr.criteria[0]?.status).toBe('pending')

    // Attempt without summary
    const failSummary = mgr.recordEvidence('CRIT-1', {
      type: 'test_result',
      reference: 'tests/thread-brief.spec.ts',
      summary: '   ',
    })
    expect(failSummary.success).toBe(false)
    expect(mgr.criteria[0]?.status).toBe('pending')

    // Valid evidence succeeds
    const success = mgr.recordEvidence('CRIT-1', {
      type: 'test_result',
      reference: 'tests/thread-brief.spec.ts#L10-L40',
      summary: '8/8 unit tests pass deterministically',
    })
    expect(success.success).toBe(true)
    expect(mgr.criteria[0]?.status).toBe('satisfied')
    expect(mgr.criteria[0]?.evidence?.reference).toBe('tests/thread-brief.spec.ts#L10-L40')
  })

  it('AC-18: rejects unverified agent claims and requires explicit audit for closure', () => {
    const mgr = ThreadBriefManager.fromRequest({
      thread_id: 'thread-1',
      raw_request: 'Complete task',
      inferred_criteria: ['Must deliver verified artifact'],
    })

    // Agent text claim is evaluated and rejected
    const claimResult = mgr.evaluateAgentClaim('CRIT-1', 'I have finished all criteria and verified everything.')
    expect(claimResult.accepted).toBe(false)
    expect(mgr.criteria[0]?.status).toBe('pending')

    // Task closure check
    const closeCheck = mgr.canCloseTask()
    expect(closeCheck.allowed).toBe(false)
    expect(closeCheck.pending).toContain('CRIT-1')
    expect(closeCheck.requires_audit).toBe(true)

    // After genuine evidence recorded:
    mgr.recordEvidence('CRIT-1', {
      type: 'artifact',
      reference: 'evidence/receipt.json',
      summary: 'Valid delivery artifact generated',
    })
    const afterEvidence = mgr.canCloseTask()
    expect(afterEvidence.allowed).toBe(true)
    expect(afterEvidence.requires_audit).toBe(true) // Still subject to coordinator/operator audit
  })

  it('AC-8, AC-9, AC-10: preserves brief revisions, criteria, and proposals across serialization reload', () => {
    const mgr = ThreadBriefManager.fromRequest({
      thread_id: 'thread-reload',
      ticket_id: 'ticket-reload-1',
      raw_request: 'Raw ask to be reloaded',
      objective: 'Reload Verification',
      inferred_criteria: ['Crit 1'],
    })

    mgr.stageProposal({
      description: 'Proposed update',
      proposed_by: 'operator',
      added_criteria: ['Crit 2'],
    })
    const firstProp = mgr.pendingProposals[0]
    expect(firstProp).toBeDefined()
    if (firstProp) mgr.confirmProposal(firstProp.proposal_id, 'human-operator')

    // Serialize
    const serialized = mgr.serialize()
    expect(typeof serialized).toBe('string')

    // Deserialize into fresh instance
    const restored = ThreadBriefManager.deserialize(serialized)
    expect(restored.revisionId).toBe(2)
    expect(restored.rawOriginalAsk).toBe('Raw ask to be reloaded')
    expect(restored.criteria.length).toBe(2)
    expect(restored.criteria[0]?.id).toBe('CRIT-1')
    expect(restored.criteria[1]?.id).toBe('CRIT-2')
    expect(restored.getState().revision_history.length).toBe(1)
  })

  it('AC-11, AC-12, AC-13 & AC-22, AC-23: composes context prompt with brief status and model fallback telemetry', () => {
    const mgr = ThreadBriefManager.fromRequest({
      thread_id: 'thread-1',
      raw_request: 'Execution ask',
      objective: 'Run safely with fallback',
      inferred_criteria: ['Execute safely'],
      model_context: {
        current_model: 'anthropic/claude-3-5-sonnet',
        fallback_events: [
          {
            requested_model: 'google/gemini-2.5-pro',
            substituted_model: 'anthropic/claude-3-5-sonnet',
            reason: 'Rate limit 429 quota exhaustion',
          },
        ],
      },
    })

    const prompt = mgr.composeContextPrompt()
    expect(prompt).toContain('[Active Thread Brief Rev 1]')
    expect(prompt).toContain('Objective: Run safely with fallback')
    expect(prompt).toContain('[CRIT-1] (inferred/unconfirmed) (pending): Execute safely')
    expect(prompt).toContain('Model Fallback Routing:')
    expect(prompt).toContain('google/gemini-2.5-pro -> anthropic/claude-3-5-sonnet (Rate limit 429 quota exhaustion)')
  })

  it('AC-3 & AC-11-13 authority distinction: distinguishes inferred/unconfirmed vs confirmed criteria in context prompt', () => {
    const mgr = ThreadBriefManager.fromRequest({
      thread_id: 'thread-authority-distinction',
      raw_request: 'Build feature',
      inferred_criteria: ['Identical criterion requirement'],
    })

    // Initially, criterion is inferred and visibly unconfirmed in prompt
    const initialPrompt = mgr.composeContextPrompt()
    expect(initialPrompt).toContain('[CRIT-1] (inferred/unconfirmed) (pending): Identical criterion requirement')
    expect(initialPrompt).not.toContain('[CRIT-1] (confirmed)')

    // Stage identical proposal and confirm it
    const proposal = mgr.stageProposal({
      description: 'Confirm identical requirement',
      proposed_by: 'operator',
      added_criteria: ['Identical criterion requirement'],
    })
    expect(proposal.proposal_id).toBeDefined()
    mgr.confirmProposal(proposal.proposal_id, 'human-operator')

    // After confirmation, the two otherwise identical criteria are clearly distinguished by authority tag
    const updatedPrompt = mgr.composeContextPrompt()
    expect(updatedPrompt).toContain('[CRIT-1] (inferred/unconfirmed) (pending): Identical criterion requirement')
    expect(updatedPrompt).toContain('[CRIT-2] (confirmed) (pending): Identical criterion requirement')
  })
})

describe('ThreadBriefHeader React Component (Issue #216 UI)', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  it('AC-6 & AC-7: renders compact top bar and expands on toggle to show criteria & verbatim ask', async () => {
    const root = createRoot(container)
    const rawAsk = 'Verbatim multi-line\nuser ask test'

    const briefView: ThreadBriefView = {
      thread_id: 'thread-100',
      ticket_id: 'ticket-100',
      raw_original_ask: rawAsk,
      revision_id: 1,
      objective: 'Test Brief Header Component',
      current_state: 'Active',
      next_action: 'Run component tests',
      task_status: 'open',
      criteria: [
        {
          id: 'CRIT-1',
          description: 'Compact display works',
          status: 'satisfied',
          is_inferred: false,
          confirmed: true,
          evidence: {
            type: 'test_result',
            reference: 'tests/thread-brief.spec.tsx',
            summary: 'UI test passed',
          },
        },
        {
          id: 'CRIT-2',
          description: 'Expandable body renders',
          status: 'pending',
          is_inferred: true,
          confirmed: false,
        },
      ],
      scope: [{ text: 'Scoped to client only', is_inferred: false, confirmed: true }],
      pending_proposals: [],
      model_context: {
        current_model: 'unknown',
        fallback_events: [],
      },
    }

    await act(async () => {
      root.render(<ThreadBriefHeader brief={briefView} />)
    })

    // Compact mode checks:
    expect(container.textContent).toContain('Rev 1')
    expect(container.textContent).toContain('Test Brief Header Component')
    expect(container.textContent).toContain('1/2 Criteria')
    expect(container.textContent).toContain('model: unavailable') // Unknown model represented without fabricating deepseek
    expect(container.querySelector('[data-testid="brief-expanded-body"]')).toBeNull()

    // Click View Details to expand
    const toggleBtn = container.querySelector('[data-testid="brief-toggle-btn"]') as HTMLButtonElement
    expect(toggleBtn).not.toBeNull()

    await act(async () => {
      toggleBtn.click()
    })

    // Expanded mode checks:
    const body = container.querySelector('[data-testid="brief-expanded-body"]')
    expect(body).not.toBeNull()

    // Verbatim original ask displayed
    const askPre = container.querySelector('[data-testid="verbatim-original-ask"]')
    expect(askPre?.textContent).toBe(rawAsk)

    // Criteria display
    const crit1 = container.querySelector('[data-testid="criterion-CRIT-1"]')
    expect(crit1?.textContent).toContain('Compact display works')
    expect(crit1?.textContent).toContain('satisfied')

    const ev1 = container.querySelector('[data-testid="evidence-CRIT-1"]')
    expect(ev1?.textContent).toContain('UI test passed')

    const crit2 = container.querySelector('[data-testid="criterion-CRIT-2"]')
    expect(crit2?.textContent).toContain('Inferred (Unconfirmed)')

    await act(async () => {
      root.unmount()
    })
  })

  it('AC-22 & AC-23: renders model fallback telemetry and triggers proposal confirmation callback', async () => {
    const root = createRoot(container)
    const onConfirm = vi.fn()

    const briefView: ThreadBriefView = {
      thread_id: 'thread-200',
      raw_original_ask: 'Fallback ask',
      revision_id: 2,
      objective: 'Fallback Coexistence Test',
      current_state: 'Evaluating',
      next_action: 'Confirm proposals',
      task_status: 'open',
      criteria: [
        {
          id: 'CRIT-1',
          description: 'Basic crit',
          status: 'pending',
          is_inferred: false,
          confirmed: true,
        },
      ],
      scope: [],
      pending_proposals: [
        {
          proposal_id: 'PROP-999',
          description: 'Proposed extra scope',
          proposed_by: 'agent-bob',
          timestamp: '2026-11-14T20:00:00Z',
          status: 'pending',
        },
      ],
      model_context: {
        current_model: 'anthropic/claude-3-5-sonnet',
        fallback_events: [
          {
            requested_model: 'deepseek/deepseek-chat',
            substituted_model: 'anthropic/claude-3-5-sonnet',
            reason: 'Rate limit 429',
          },
        ],
      },
    }

    await act(async () => {
      root.render(
        <ThreadBriefHeader
          brief={briefView}
          onConfirmProposal={onConfirm}
        />
      )
    })

    // Expand to see proposal and telemetry
    const toggleBtn = container.querySelector('[data-testid="brief-toggle-btn"]') as HTMLButtonElement
    await act(async () => {
      toggleBtn.click()
    })

    expect(container.textContent).toContain('anthropic/claude-3-5-sonnet')
    expect(container.textContent).toContain('Rate limit 429')

    // Confirm proposal button
    const confirmBtn = container.querySelector('[data-testid="confirm-proposal-PROP-999"]') as HTMLButtonElement
    expect(confirmBtn).not.toBeNull()

    await act(async () => {
      confirmBtn.click()
    })

    expect(onConfirm).toHaveBeenCalledWith('PROP-999')

    await act(async () => {
      root.unmount()
    })
  })

  it('Component regression: does not claim provider healthy when model context is unavailable or unobserved', async () => {
    const root = createRoot(container)
    const mgr = ThreadBriefManager.fromRequest({
      thread_id: 'thread-unobserved-health',
      raw_request: 'User ask without model routing info',
      inferred_criteria: ['Check criteria'],
    })

    const view = mgr.toView()
    await act(async () => {
      root.render(<ThreadBriefHeader brief={view} />)
    })

    const toggleBtn = container.querySelector('[data-testid="brief-toggle-btn"]') as HTMLButtonElement
    await act(async () => {
      toggleBtn.click()
    })

    expect(container.textContent).toContain('model: unavailable')
    expect(container.textContent).not.toContain('Primary model healthy')
    const telemetryMsg = container.querySelector('[data-testid="fallback-telemetry-empty"]')
    expect(telemetryMsg?.textContent).toBe('Model context unavailable; no fallback telemetry recorded.')

    await act(async () => {
      root.unmount()
    })
  })
})

describe('Thread Brief Integration (ThreadPage, TicketPage & Sessions wiring)', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  const mockT: T = ((key: string, values?: Record<string, unknown>) => {
    if (values) {
      return Object.entries(values).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key)
    }
    return key
  }) as T

  function mockTicketPageData(overrides: Record<string, unknown> = {}): any {
    return {
      id: 'ticket-1',
      title: 'Ticket title',
      stage: 'working',
      state: 'open',
      mandate: { strength: 'autonomous', policyVersion: 'p12345678', actor: { source: 'web', id: 'u1' } },
      basis: { legacy: false, facts: [], policyVersion: 'p1' },
      channels: [{ key: 'ch-1', title: 'Channel', label: 'Channel', url: 'https://example.com' }],
      assignments: [],
      inputs: [],
      threads: [],
      environment: [],
      ghCalls: { total: 0, commands: [] },
      actions: {},
      summary: '',
      updatedAt: '2026-11-15T10:00:00Z',
      ...overrides,
    }
  }

  function mockThreadPageData(overrides: Record<string, unknown> = {}): any {
    return {
      key: 'th-1',
      title: 'Thread title',
      source: 'github',
      createdAt: '2026-11-15T10:00:00Z',
      lastAt: '2026-11-15T10:00:00Z',
      subscriptions: [],
      tickets: [],
      decisions: [],
      correlated: [],
      context: [],
      timeline: [],
      ...overrides,
    }
  }

  it('1. ORIGINAL PROVENANCE: threadDetail retrieves earliest trigger outside visible page, missing origin is unavailable, empty origin is preserved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-brief-prov-'))
    const store = new Store(join(dir, 'orchestrator.sqlite'))
    try {
      const threadKey = 'github:owner/repo:issue:42'
      const thread: Thread = {
        key: threadKey,
        ref: { source: 'github', id: 'owner/repo:issue:42' },
        createdAt: '2026-11-15T01:00:00Z',
        subscriptions: [],
        correlated: [],
        pending: [],
        meta: { label: 'Issue 42: Production Regression' },
      }
      store.threads.save(thread)

      // Save two triggers: t1 is earlier (canonical origin), t2 is newer
      const t1: Trigger = {
        id: 'trig-orig-1',
        at: '2026-11-15T01:00:00Z',
        source: 'github',
        human: true,
        actor: { source: 'github', id: 'reporter' },
        threads: [thread.ref],
        text: 'Initial detailed report:\nLine 1: regression bug\nLine 2: reproduction steps',
        meta: {},
      }
      const t2: Trigger = {
        id: 'trig-orig-2',
        at: '2026-11-15T02:00:00Z',
        source: 'github',
        human: true,
        actor: { source: 'github', id: 'commenter' },
        threads: [thread.ref],
        text: 'Later comment on thread',
        meta: {},
      }
      store.triggers.save(t1)
      store.triggers.save(t2)

      // Paginate threadDetail with limit=1: shown triggers only contain t2, but brief MUST preserve t1
      const viewHost = {
        store,
        sources: { find: () => ({ terms: [], threads: [] }), kind: () => undefined } as any,
        links: { entries: () => [] } as any,
      }
      const detail = threadDetail(viewHost, threadKey, undefined, 1)
      expect(detail).toBeDefined()
      expect(detail?.timeline.length).toBe(1)
      expect(detail?.timeline[0]?.id).toBe('trig-orig-2') // Only newer trigger is shown on this page
      expect(detail?.brief?.raw_original_ask).toBe('Initial detailed report:\nLine 1: regression bug\nLine 2: reproduction steps') // Earliest trigger retained!

      // Missing origin: ticket with non-existent trigger ID has raw_original_ask explicitly 'unavailable', never title
      const ticketMissingOrigin: Ticket = {
        id: 'ticket-no-origin',
        title: 'Title of ticket without origin',
        decisionId: 'd1',
        mandate: defaultMandate('Missing origin scope'),
        channels: [],
        assignments: [],
        inputs: [],
        undelivered: [],
        createdAt: '2026-11-15T01:00:00Z',
        updatedAt: '2026-11-15T01:00:00Z',
        origin: { triggerId: 'non-existent-trigger-id', triggerIds: [] },
      }
      const briefNoOrigin = resolveTicketBriefManager(store, ticketMissingOrigin)
      expect(briefNoOrigin.rawOriginalAsk).toBe('unavailable')
      expect(briefNoOrigin.rawOriginalAsk).not.toBe(ticketMissingOrigin.title)
      expect(briefNoOrigin.toView().objective).toBe('Title of ticket without origin')

      // Empty origin: trigger with genuine empty string is preserved as '', NOT substituted by title
      const tEmpty: Trigger = {
        id: 'trig-empty',
        at: '2026-11-15T01:00:00Z',
        source: 'github',
        human: true,
        actor: { source: 'github', id: 'u' },
        threads: [thread.ref],
        text: '',
        meta: {},
      }
      store.triggers.save(tEmpty)
      const ticketEmptyOrigin: Ticket = {
        id: 'ticket-empty-origin',
        title: 'Title with empty origin trigger',
        decisionId: 'd2',
        mandate: defaultMandate('Empty origin scope'),
        channels: [],
        assignments: [],
        inputs: [],
        undelivered: [],
        createdAt: '2026-11-15T01:00:00Z',
        updatedAt: '2026-11-15T01:00:00Z',
        origin: { triggerId: 'trig-empty', triggerIds: ['trig-empty'] },
      }
      const briefEmptyOrigin = resolveTicketBriefManager(store, ticketEmptyOrigin)
      expect(briefEmptyOrigin.rawOriginalAsk).toBe('')
      expect(briefEmptyOrigin.rawOriginalAsk).not.toBe(ticketEmptyOrigin.title)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('2. REAL TYPES & STATE: classifies person, idle, working, and ended outcomes using core stage models', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-brief-stage-'))
    const store = new Store(join(dir, 'orchestrator.sqlite'))
    try {
      const baseTicket = (id: string): Ticket => ({
        id,
        title: `Task ${id}`,
        decisionId: 'd1',
        mandate: defaultMandate(`Mandate for ${id}`),
        channels: [],
        assignments: [],
        inputs: [],
        undelivered: [],
        createdAt: '2026-11-15T01:00:00Z',
        updatedAt: '2026-11-15T01:00:00Z',
        origin: { triggerId: 'trig-1', triggerIds: ['trig-1'] },
      })

      // Person: blocked
      const tBlocked = baseTicket('t-blocked')
      tBlocked.assignments = [{
        id: 'a1', state: 'running', createdAt: '2026-11-15T01:00:00Z',
        report: { state: 'blocked', summary: 'Missing environment secret INFISICAL_TOKEN', at: '2026-11-15T01:05:00Z' },
      }]
      const briefBlocked = resolveTicketBriefManager(store, tBlocked).toView()
      expect(briefBlocked.current_state).toBe('person:blocked')
      expect(briefBlocked.next_action).toBe('Missing environment secret INFISICAL_TOKEN')

      // Person: failed
      const tFailed = baseTicket('t-failed')
      tFailed.assignments = [{
        id: 'a2', state: 'running', createdAt: '2026-11-15T01:00:00Z',
        report: { state: 'failed', summary: 'Unit test execution crashed fatally', at: '2026-11-15T01:05:00Z' },
      }]
      const briefFailed = resolveTicketBriefManager(store, tFailed).toView()
      expect(briefFailed.current_state).toBe('person:failed')
      expect(briefFailed.next_action).toBe('Unit test execution crashed fatally')

      // Person: answer
      const tAnswer = baseTicket('t-answer')
      tAnswer.attention = { id: 'att-1', question: 'Should we deploy to staging or prod?' }
      const briefAnswer = resolveTicketBriefManager(store, tAnswer).toView()
      expect(briefAnswer.current_state).toBe('person:answer')
      expect(briefAnswer.next_action).toBe('Should we deploy to staging or prod?')

      // Person: delivery
      const tDelivery = baseTicket('t-delivery')
      tDelivery.delivery = { error: 'Webhook payload delivery timed out', at: '2026-11-15T01:05:00Z' }
      const briefDelivery = resolveTicketBriefManager(store, tDelivery).toView()
      expect(briefDelivery.current_state).toBe('person:delivery')
      expect(briefDelivery.next_action).toBe('Webhook payload delivery timed out')

      // Person: review (ready report)
      const tReview = baseTicket('t-review')
      tReview.assignments = [{
        id: 'a3', state: 'running', createdAt: '2026-11-15T01:00:00Z',
        report: { state: 'ready', summary: 'PR 126 ready for review', at: '2026-11-15T01:05:00Z' },
      }]
      const briefReview = resolveTicketBriefManager(store, tReview).toView()
      expect(briefReview.current_state).toBe('person:review')
      expect(briefReview.next_action).toBe('Review ready report')

      // Idle: waiting for trigger
      const tIdle = baseTicket('t-idle')
      tIdle.assignments = [{
        id: 'a4', state: 'running', createdAt: '2026-11-15T01:00:00Z',
        report: { state: 'waiting', summary: 'Awaiting CI check completion', at: '2026-11-15T01:05:00Z' },
      }]
      const briefIdle = resolveTicketBriefManager(store, tIdle).toView()
      expect(briefIdle.current_state).toBe('waiting')
      expect(briefIdle.next_action).toBe('Waiting for trigger')

      // Core Thread: dormant when all tickets ended
      const tEnded = baseTicket('t-ended')
      tEnded.ended = { at: '2026-11-15T02:00:00Z', by: 'executor', outcome: 'completed' }
      store.tickets.save(tEnded)
      const threadDormant: Thread = {
        key: 'github:owner/repo:issue:99',
        ref: { source: 'github', id: 'owner/repo:issue:99' },
        createdAt: '2026-11-15T01:00:00Z',
        subscriptions: ['t-ended'],
        correlated: [],
        pending: [],
        meta: { label: 'Issue 99' },
      }
      const briefDormant = resolveThreadBriefManager(store, threadDormant).toView()
      expect(briefDormant.task_status).toBe('closed')
      expect(briefDormant.current_state).toBe('dormant')
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('3. THREAD IDENTITY & SNAPSHOT PRESERVATION: multiple subscriptions [ended A, live B], evaluating/pending states, and existing thread snapshots are preserved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-brief-identity-'))
    const dbPath = join(dir, 'orchestrator.sqlite')
    let store = new Store(dbPath)

    try {
      const threadKey = 'github:owner/repo:issue:100'
      const threadTrigger: Trigger = {
        id: 'trig-thread-canonical',
        at: '2026-11-15T00:30:00Z',
        source: 'github',
        human: true,
        actor: { source: 'github', id: 'reporter' },
        threads: [{ source: 'github', id: 'owner/repo:issue:100' }],
        text: 'Thread-level canonical prompt text',
        meta: {},
      }
      store.triggers.save(threadTrigger)

      const tEnded: Ticket = {
        id: 't-ended-1',
        title: 'Old Finished Ticket',
        decisionId: 'd1',
        mandate: defaultMandate('Old task scope'),
        channels: [{ source: 'github', thread: threadKey, address: {} }],
        assignments: [{ id: 'a1', state: 'ended', createdAt: '2026-11-15T01:00:00Z' }],
        inputs: [],
        undelivered: [],
        createdAt: '2026-11-15T01:00:00Z',
        updatedAt: '2026-11-15T01:30:00Z',
        ended: { outcome: 'completed', at: '2026-11-15T01:30:00Z', by: 'executor' },
        origin: { triggerId: 'trig-ended', triggerIds: ['trig-ended'] },
      }
      store.tickets.save(tEnded)

      const tLive: Ticket = {
        id: 't-live-2',
        title: 'Active Followup Ticket',
        decisionId: 'd2',
        mandate: defaultMandate('Active task scope'),
        channels: [{ source: 'github', thread: threadKey, address: {} }],
        assignments: [{ id: 'a2', state: 'running', createdAt: '2026-11-15T02:00:00Z' }],
        inputs: [],
        undelivered: [],
        createdAt: '2026-11-15T02:00:00Z',
        updatedAt: '2026-11-15T02:00:00Z',
        origin: { triggerId: 'trig-live', triggerIds: ['trig-live'] },
      }
      store.tickets.save(tLive)

      // Thread with subscription ordering [ended A, live B]
      const threadMulti: Thread = {
        key: threadKey,
        ref: { source: 'github', id: 'owner/repo:issue:100' },
        createdAt: '2026-11-15T00:30:00Z',
        subscriptions: ['t-ended-1', 't-live-2'],
        correlated: [],
        pending: [],
        meta: { label: 'Issue 100: Multi-subscription' },
      }
      store.threads.save(threadMulti)

      // Thread brief MUST NOT become closed or take A's prompt; it preserves thread identity and active state
      const briefMulti = resolveThreadBriefManager(store, threadMulti).toView()
      expect(briefMulti.task_status).toBe('open')
      expect(briefMulti.current_state).toBe('active')
      expect(briefMulti.next_action).toBe('Execute thread tickets')
      expect(briefMulti.raw_original_ask).toBe('Thread-level canonical prompt text')

      // Evaluating thread with ended subscription remains 'evaluating', NOT closed
      const threadEvaluating: Thread = {
        ...threadMulti,
        evaluating: { triggers: 1, strength: 'explicit', deadline: '2026-11-15T03:00:00Z' } as any,
      }
      const briefEvaluating = resolveThreadBriefManager(store, threadEvaluating).toView()
      expect(briefEvaluating.current_state).toBe('evaluating')
      expect(briefEvaluating.task_status).toBe('open')

      // Existing snapshot preservation: advance thread brief to Rev 2, save, and ensure adding subscription retains Rev 2
      const threadMgr = resolveThreadBriefManager(store, threadMulti)
      const prop = threadMgr.stageProposal({
        description: 'Thread-level verified criteria',
        proposed_by: 'lead',
        added_criteria: ['Thread criterion 1'],
      })
      threadMgr.confirmProposal(prop.proposal_id, 'lead')
      expect(threadMgr.revisionId).toBe(2)
      threadMgr.save(store)

      // Reopening store and adding a new subscription does NOT overwrite the thread's stored snapshot
      store.close()
      store = new Store(dbPath)

      const threadWithMoreSubs: Thread = {
        ...threadMulti,
        subscriptions: ['t-ended-1', 't-live-2', 't-another-3'],
      }
      const reloadedThreadBrief = resolveThreadBriefManager(store, threadWithMoreSubs).toView()
      expect(reloadedThreadBrief.revision_id).toBe(2)
      expect(reloadedThreadBrief.criteria[0]?.id).toBe('CRIT-1')
      expect(reloadedThreadBrief.criteria[0]?.confirmed).toBe(true)
      expect(reloadedThreadBrief.raw_original_ask).toBe('Thread-level canonical prompt text')

      // Actual threadDetail server view retains preserved Rev 2 snapshot
      const viewHost = {
        store,
        sources: { find: () => ({ terms: [], threads: [] }), kind: () => undefined } as any,
        links: { entries: () => [] } as any,
      }
      const detail = threadDetail(viewHost, threadKey, undefined, 10)
      expect(detail?.brief?.revision_id).toBe(2)
      expect(detail?.brief?.raw_original_ask).toBe('Thread-level canonical prompt text')
    } finally {
      try { store.close() } catch {}
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('4. TRUTHFUL PERSISTENCE STATUS: surfaces non-durable and write-failed storage states through real resolver path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-brief-fail-'))
    const store = new Store(join(dir, 'orchestrator.sqlite'))

    try {
      const ticket: Ticket = {
        id: 'ticket-storage-check',
        title: 'Storage Check Task',
        decisionId: 'd1',
        mandate: defaultMandate('Storage check scope'),
        channels: [{ source: 'github', thread: 'github:owner/repo:issue:1', address: {} }],
        assignments: [],
        inputs: [],
        undelivered: [],
        createdAt: '2026-11-15T01:00:00Z',
        updatedAt: '2026-11-15T01:00:00Z',
        origin: { triggerId: 'trig-1', triggerIds: ['trig-1'] },
      }

      // Store without set operation: surfaces storage_state = 'non-durable'
      const storeWithoutSet = {
        triggers: { get: () => ({ id: 'trig-1', text: 'Prompt without set' }) },
        get: () => undefined,
      }
      const nonDurableBrief = resolveTicketBriefManager(storeWithoutSet as any, ticket).toView()
      expect(nonDurableBrief.storage_state).toBe('non-durable')

      // Store with failing set operation (closed database): surfaces storage_state = 'write_failed'
      store.close()
      const writeFailedBrief = resolveTicketBriefManager(store, ticket).toView()
      expect(writeFailedBrief.storage_state).toBe('write_failed')

      // Ensure write failure does not claim persisted reload/recovery
      const storeReopened = new Store(join(dir, 'orchestrator.sqlite'))
      try {
        expect(storeReopened.get(`ticket-brief:${ticket.id}`)).toBeUndefined()
      } finally {
        storeReopened.close()
      }
    } finally {
      try { store.close() } catch {}
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('5. ACTUAL SESSIONS WIRING: captures registered systemPrompt.section callback from Sessions.decorate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-brief-sessions-'))
    const store = new Store(join(dir, 'orchestrator.sqlite'))
    try {
      const ticket: Ticket = {
        id: 'ticket-sess-real',
        title: 'Production Feature Implementation',
        decisionId: 'd1',
        mandate: defaultMandate('Must not edit executor'),
        channels: [{ source: 'github', thread: 'github:owner/repo:issue:1', address: {} }],
        assignments: [{ id: 'a1', state: 'running', createdAt: '2026-11-15T01:00:00Z' }],
        inputs: [],
        undelivered: [],
        createdAt: '2026-11-15T01:00:00Z',
        updatedAt: '2026-11-15T01:00:00Z',
        origin: { triggerId: 'trig-sess', triggerIds: ['trig-sess'] },
      }
      store.tickets.save(ticket)
      store.triggers.save({
        id: 'trig-sess',
        at: '2026-11-15T01:00:00Z',
        source: 'github',
        human: true,
        actor: { source: 'github', id: 'user' },
        threads: [{ source: 'github', id: 'thread-1' }],
        text: 'Implement authoritative brief in Sessions callback',
        meta: {},
      })

      // Setup Sessions with mock host
      const mockEffects = {
        handle: vi.fn(),
        enqueue: vi.fn(),
        idle: vi.fn(),
        pending: vi.fn(),
      }
      const mockPrompts = {
        current: () => ({ revision: 1, config: { scope: 'test' } }),
        version: () => ({ revision: 1, config: { scope: 'test' } }),
        compose: (_config: any, role: string, _env: any) => `[Composed prompt for ${role}]`,
        skills: () => [],
      }
      const mockContext = {
        on: vi.fn(),
        inject: vi.fn().mockReturnValue(Promise.resolve()),
        agents: new Map(),
        logger: { warn: vi.fn() },
      } as any

      const sessionsHost: SessionsHost = {
        context: mockContext,
        store: store as any,
        prompts: mockPrompts as any,
        effects: mockEffects as any,
        health: { set: vi.fn() } as any,
        masterId: 'master-session',
        lifetime: new AbortController().signal,
        closing: () => false,
        environment: () => [],
        tools: () => [],
      }

      const sessions = new Sessions(sessionsHost)

      // Decorate worker agent for this ticket and capture registered systemPrompt section callback
      let registeredSection: any = null
      const workerAgent: any = {
        id: `worker-${ticket.id}`,
        status: 'idle',
        session: {
          id: `worker-${ticket.id}`,
          snapshotEvents: () => [],
          requestHeader: () => ({ config: { provider: 'anthropic', model: 'claude-3-5-sonnet' } }),
        },
        ctx: {
          on: vi.fn().mockReturnValue(() => {}),
          tools: {
            get: vi.fn().mockReturnValue(undefined),
            restrict: vi.fn().mockReturnValue(() => {}),
            guard: vi.fn().mockReturnValue(() => {}),
          },
          systemPrompt: {
            section: (spec: any) => {
              registeredSection = spec
              return () => {}
            },
          },
          inject: vi.fn().mockReturnValue(Promise.resolve({ dispose: () => Promise.resolve() })),
        },
      }

      await (sessions as any).decorate(workerAgent)
      expect(registeredSection).not.toBeNull()
      expect(registeredSection.name).toBe('dsh-superagent-policy')

      // Call the ACTUAL registered callback function from Sessions.decorate
      const promptOutput = registeredSection.text({ signal: undefined })
      expect(promptOutput).toContain('[Active Thread Brief Rev 1]')
      expect(promptOutput).toContain('Objective: Production Feature Implementation')
      expect(promptOutput).toContain('Current State: working')
      expect(promptOutput).toContain('Next Action: Execute assignment')
      expect(promptOutput).toContain('Scope:\n  - (inferred/unconfirmed) Must not edit executor')
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('6. REAL COMPONENT WIRING: renders TicketPage AND ThreadPage via real PanelProvider', async () => {
    const root = createRoot(container)
    const ticketMgr = ThreadBriefManager.fromRequest({
      thread_id: 'thread-comp-1',
      ticket_id: 'ticket-comp-1',
      raw_request: 'Verbatim original ticket prompt',
      objective: 'Ticket Component Display',
      inferred_scope: ['Ticket scope A'],
      inferred_criteria: ['Ticket criterion B'],
    })

    const threadMgr = ThreadBriefManager.fromRequest({
      thread_id: 'thread-comp-1',
      raw_request: 'Verbatim original thread prompt',
      objective: 'Thread Component Display',
      inferred_scope: ['Thread scope X'],
      inferred_criteria: ['Thread criterion Y'],
    })

    const call = vi.fn().mockImplementation((route: string) => {
      if (route === 'GET state') {
        return Promise.resolve({ load: { running: 0 } })
      }
      if (route === 'GET tickets/:id') {
        return Promise.resolve(mockTicketPageData({
          id: 'ticket-comp-1',
          title: 'Ticket Component Display',
          brief: ticketMgr.toView(),
        }))
      }
      if (route === 'GET threads/:key') {
        return Promise.resolve(mockThreadPageData({
          key: 'thread-comp-1',
          title: 'Thread Component Display',
          brief: threadMgr.toView(),
        }))
      }
      return Promise.resolve({})
    })

    // Test 1: Render TicketPage via real PanelProvider
    await act(async () => {
      root.render(
        <PanelProvider t={mockT} call={call}>
          <TicketPage id="ticket-comp-1" />
        </PanelProvider>
      )
    })
    await act(async () => {
      await Promise.resolve()
      await new Promise(r => setTimeout(r, 10))
    })

    expect(container.textContent).toContain('Ticket Component Display')
    expect(container.textContent).toContain('Rev 1')
    expect(container.textContent).toContain('0/1 Criteria')

    // Expand header to verify verbatim ask
    const ticketToggleBtn = container.querySelector('[data-testid="brief-toggle-btn"]') as HTMLButtonElement
    expect(ticketToggleBtn).not.toBeNull()
    await act(async () => {
      ticketToggleBtn.click()
    })
    expect(container.textContent).toContain('Verbatim original ticket prompt')
    expect(container.textContent).toContain('Ticket scope A')

    // Test 2: Render ThreadPage via real PanelProvider
    await act(async () => {
      root.render(
        <PanelProvider t={mockT} call={call}>
          <ThreadPage id="thread-comp-1" />
        </PanelProvider>
      )
    })
    await act(async () => {
      await Promise.resolve()
      await new Promise(r => setTimeout(r, 10))
    })

    expect(container.textContent).toContain('Thread Component Display')
    expect(container.textContent).toContain('Rev 1')

    const threadToggleBtn = container.querySelector('[data-testid="brief-toggle-btn"]') as HTMLButtonElement
    expect(threadToggleBtn).not.toBeNull()
    await act(async () => {
      threadToggleBtn.click()
    })
    expect(container.textContent).toContain('Verbatim original thread prompt')
    expect(container.textContent).toContain('Thread scope X')

    await act(async () => {
      root.unmount()
    })
  })
})
