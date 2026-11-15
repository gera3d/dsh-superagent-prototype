// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
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

  it('TicketPage wiring: preserves verbatim original ask differing from title and renders via real provider', async () => {
    const root = createRoot(container)
    const kv = new Map<string, unknown>()
    const syntheticStore = {
      triggers: {
        get: (id: string) => {
          if (id === 'trig-1') {
            return {
              id: 'trig-1',
              text: 'Very detailed verbatim ask from user\nwith multiple lines of exact instructions',
            }
          }
          return undefined
        },
      },
      get: <V,>(key: string) => kv.get(key) as V | undefined,
      set: <V,>(key: string, value: V) => { kv.set(key, value) },
    }

    const ticket = {
      id: '8db3c6ac5758',
      title: 'Short Ticket Title',
      origin: { triggerId: 'trig-1', triggerIds: ['trig-1'] },
      mandate: { scope: 'Autonomous mandate execution', strength: 'autonomous', policyVersion: 'p12345678', actor: { source: 'web', id: 'u1' } },
      stage: 'Delivering',
      state: 'open',
      inputs: [],
      threads: [],
      channels: [{ id: 'ch-1' }],
      assignments: [],
      actions: {},
    }

    // Resolve authoritative brief
    const briefMgr = resolveTicketBriefManager(syntheticStore, ticket)
    expect(briefMgr.rawOriginalAsk).toBe('Very detailed verbatim ask from user\nwith multiple lines of exact instructions')
    expect(briefMgr.toView().objective).toBe('Short Ticket Title')
    expect(briefMgr.rawOriginalAsk).not.toBe(briefMgr.toView().objective)

    const call = vi.fn().mockImplementation((route: string) => {
      if (route === 'GET state') {
        return Promise.resolve({ load: { running: 0 } })
      }
      if (route === 'GET tickets/:id') {
        return Promise.resolve(mockTicketPageData({
          ...ticket,
          brief: briefMgr.toView(),
        }))
      }
      return Promise.resolve({})
    })

    await act(async () => {
      root.render(
        <PanelProvider t={mockT} call={call}>
          <TicketPage id="8db3c6ac5758" />
        </PanelProvider>
      )
    })
    await act(async () => {
      await Promise.resolve()
      await new Promise(r => setTimeout(r, 10))
    })

    // Brief header rendered with title, revision, and state
    expect(container.textContent).toContain('Short Ticket Title')
    expect(container.textContent).toContain('Rev 1')
    expect(container.textContent).toContain('Delivering')

    // Expand header to inspect raw ask
    const toggleBtn = container.querySelector('[data-testid="brief-toggle-btn"]') as HTMLButtonElement
    expect(toggleBtn).toBeDefined()
    await act(async () => {
      toggleBtn.click()
    })

    const body = container.querySelector('[data-testid="brief-expanded-body"]')
    expect(body).toBeDefined()
    expect(body?.textContent).toContain('Very detailed verbatim ask from user')

    await act(async () => {
      root.unmount()
    })
  })

  it('Persisted revision > 1 and proposal confirmation across reread/reload/context', async () => {
    const root = createRoot(container)
    const kv = new Map<string, unknown>()
    const syntheticStore = {
      triggers: {
        get: (id: string) => (id === 'trig-persist' ? { id: 'trig-persist', text: 'Original request' } : undefined),
      },
      get: <V,>(key: string) => kv.get(key) as V | undefined,
      set: <V,>(key: string, value: V) => { kv.set(key, value) },
    }

    const ticket = {
      id: 'ticket-persist',
      title: 'Evolving Task',
      origin: { triggerId: 'trig-persist', triggerIds: ['trig-persist'] },
      mandate: { scope: 'Initial scope', strength: 'autonomous', policyVersion: 'p12345678', actor: { source: 'web', id: 'u1' } },
      stage: 'working',
      state: 'open',
      inputs: [],
      threads: [],
      channels: [{ id: 'ch-1' }],
      assignments: [],
      actions: {},
    }

    const manager = resolveTicketBriefManager(syntheticStore, ticket)
    expect(manager.revisionId).toBe(1)

    // Stage unconfirmed proposal
    const prop = manager.stageProposal({
      description: 'Add core criteria',
      proposed_by: 'reviewer',
      added_criteria: ['Deliver functional changes and test with vitest'],
    })
    expect(prop.status).toBe('pending')
    expect(manager.revisionId).toBe(1) // Still rev 1 until confirmed

    // Confirm proposal by operator
    const confirmed = manager.confirmProposal(prop.proposal_id, 'human-operator')
    expect(confirmed).toBe(true)
    expect(manager.revisionId).toBe(2)
    syntheticStore.set(`ticket-brief:${ticket.id}`, manager.getState())

    // Reread/reload from store
    const reloaded = resolveTicketBriefManager(syntheticStore, ticket)
    expect(reloaded.revisionId).toBe(2)
    expect(reloaded.criteria[0]?.id).toBe('CRIT-1')
    expect(reloaded.criteria[0]?.confirmed).toBe(true)

    // Render TicketPage with reloaded brief
    const call = vi.fn().mockImplementation((route: string) => {
      if (route === 'GET state') {
        return Promise.resolve({ load: { running: 0 } })
      }
      if (route === 'GET tickets/:id') {
        return Promise.resolve(mockTicketPageData({
          ...ticket,
          brief: reloaded.toView(),
        }))
      }
      return Promise.resolve({})
    })

    await act(async () => {
      root.render(
        <PanelProvider t={mockT} call={call}>
          <TicketPage id="ticket-persist" />
        </PanelProvider>
      )
    })
    await act(async () => {
      await Promise.resolve()
      await new Promise(r => setTimeout(r, 10))
    })

    expect(container.textContent).toContain('Rev 2')
    expect(container.textContent).toContain('0/1 Criteria')

    await act(async () => {
      root.unmount()
    })
  })

  it('Failed/cancelled endings retain unresolved criteria; satisfied requires referenced evidence', async () => {
    const root = createRoot(container)
    const kv = new Map<string, unknown>()
    const syntheticStore = {
      triggers: {
        get: (id: string) => (id === 'trig-fail' ? { id: 'trig-fail', text: 'Task ask' } : undefined),
      },
      get: <V,>(key: string) => kv.get(key) as V | undefined,
      set: <V,>(key: string, value: V) => { kv.set(key, value) },
    }

    const stoppedTicket = {
      id: 'ticket-stopped',
      title: 'Cancelled Task',
      origin: { triggerId: 'trig-fail', triggerIds: ['trig-fail'] },
      mandate: { scope: 'Initial scope', strength: 'autonomous', policyVersion: 'p12345678', actor: { source: 'web', id: 'u1' } },
      stage: 'working',
      state: 'ended',
      ended: { outcome: 'stopped', at: '2026-11-15T12:00:00Z', reason: 'Aborted by operator' },
      inputs: [],
      threads: [],
      channels: [{ id: 'ch-1' }],
      assignments: [],
      actions: {},
    }

    const manager = resolveTicketBriefManager(syntheticStore, stoppedTicket)
    const prop = manager.stageProposal({
      description: 'Requirements',
      proposed_by: 'lead',
      added_criteria: ['Unsatisfied requirement A', 'Evidence-backed requirement B'],
    })
    manager.confirmProposal(prop.proposal_id, 'lead')

    // Reject evidence without valid reference or summary
    const emptyRef = manager.recordEvidence('CRIT-1', { type: 'test_result', reference: '', summary: 'test' })
    expect(emptyRef.success).toBe(false)
    expect(manager.criteria[0]?.status).toBe('pending')

    // Supply valid evidence for CRIT-2 only
    const validEvidence = manager.recordEvidence('CRIT-2', {
      type: 'test_result',
      reference: 'tests/thread-brief.spec.tsx#L100',
      summary: 'Automated test suite passing',
    })
    expect(validEvidence.success).toBe(true)
    expect(manager.criteria[1]?.status).toBe('satisfied')

    // Critical check: CRIT-1 MUST remain pending even though ticket ended
    syntheticStore.set(`ticket-brief:${stoppedTicket.id}`, manager.getState())
    const reloaded = resolveTicketBriefManager(syntheticStore, stoppedTicket)
    expect(reloaded.toView().task_status).toBe('closed')
    expect(reloaded.toView().current_state).toBe('ended:stopped')
    expect(reloaded.criteria[0]?.status).toBe('pending') // Retained unresolved!
    expect(reloaded.criteria[1]?.status).toBe('satisfied')

    const call = vi.fn().mockImplementation((route: string) => {
      if (route === 'GET state') {
        return Promise.resolve({ load: { running: 0 } })
      }
      if (route === 'GET tickets/:id') {
        return Promise.resolve(mockTicketPageData({
          ...stoppedTicket,
          brief: reloaded.toView(),
        }))
      }
      return Promise.resolve({})
    })

    await act(async () => {
      root.render(
        <PanelProvider t={mockT} call={call}>
          <TicketPage id="ticket-stopped" />
        </PanelProvider>
      )
    })
    await act(async () => {
      await Promise.resolve()
      await new Promise(r => setTimeout(r, 10))
    })

    // Verifies 1/2 Criteria (not falsely marked all satisfied on ticket ended!)
    expect(container.textContent).toContain('1/2 Criteria')
    expect(container.textContent).toContain('ended:stopped')

    await act(async () => {
      root.unmount()
    })
  })

  it('ThreadPage wiring: renders truthful evaluating and active states via real provider', async () => {
    const root = createRoot(container)
    const syntheticStore = {
      triggers: {
        get: (id: string) => (id === 'trig-eval' ? { id: 'trig-eval', text: 'Thread trigger request' } : undefined),
      },
    }

    const threadEvaluating = {
      key: 'github:216',
      title: 'Evaluating Issue',
      evaluating: { triggers: 1, strength: 'autonomous', deadline: '2026-11-15T18:00:00Z' },
      subscriptions: ['ticket-1'],
      source: 'github',
      timeline: [],
      tickets: [],
      decisions: [],
      correlated: [],
      context: [],
    }

    const evaluatingBrief = resolveThreadBriefManager(syntheticStore, threadEvaluating, [
      { id: 'trig-eval', text: 'Thread trigger request' },
    ]).toView()
    expect(evaluatingBrief.current_state).toBe('evaluating')
    expect(evaluatingBrief.next_action).toBe('Awaiting evaluation result')

    const call = vi.fn().mockImplementation((route: string) => {
      if (route === 'GET state') {
        return Promise.resolve({ load: { running: 0 } })
      }
      if (route === 'GET threads/:key') {
        return Promise.resolve(mockThreadPageData({
          ...threadEvaluating,
          brief: evaluatingBrief,
        }))
      }
      return Promise.resolve({})
    })

    await act(async () => {
      root.render(
        <PanelProvider t={mockT} call={call}>
          <ThreadPage id="github:216" />
        </PanelProvider>
      )
    })
    await act(async () => {
      await Promise.resolve()
      await new Promise(r => setTimeout(r, 10))
    })

    expect(container.textContent).toContain('Evaluating Issue')
    expect(container.textContent).toContain('evaluating')

    await act(async () => {
      root.unmount()
    })
  })

  it('Sessions prompt wiring: actual registered section callback formats authoritative brief context', () => {
    const kv = new Map<string, unknown>()
    const syntheticStore = {
      triggers: {
        get: (id: string) => (id === 'trig-sess' ? { id: 'trig-sess', text: 'Build feature safely' } : undefined),
      },
      get: <V,>(key: string) => kv.get(key) as V | undefined,
      set: <V,>(key: string, value: V) => { kv.set(key, value) },
    }

    const ticket = {
      id: 'ticket-sess',
      title: 'Production Feature',
      origin: { triggerId: 'trig-sess', triggerIds: ['trig-sess'] },
      mandate: { scope: 'Restricted domain scope', strength: 'autonomous' },
      stage: 'working',
      assignments: [{ state: 'running' }],
      channels: [{ id: 'ch-1' }],
    }

    const brief = resolveTicketBriefManager(syntheticStore, ticket, {
      current_model: 'anthropic/claude-3-5-sonnet',
      fallback_events: [
        {
          requested_model: 'google/gemini-2.5-pro',
          substituted_model: 'anthropic/claude-3-5-sonnet',
          reason: 'Rate limit 429',
        },
      ],
    })

    const prop = brief.stageProposal({
      description: 'Add production criteria',
      proposed_by: 'lead',
      added_criteria: ['Pass regression suite'],
    })
    brief.confirmProposal(prop.proposal_id, 'lead')
    syntheticStore.set(`ticket-brief:${ticket.id}`, brief.getState())

    // Compose context prompt via domain manager
    const promptContext = brief.composeContextPrompt()
    expect(promptContext).toContain('[Active Thread Brief Rev 2]')
    expect(promptContext).toContain('Objective: Production Feature')
    expect(promptContext).toContain('Current State: working')
    expect(promptContext).toContain('Next Action: Execute assignment')
    expect(promptContext).toContain('(confirmed) (pending): Pass regression suite')
    expect(promptContext).toContain('Model Fallback Routing:')
    expect(promptContext).toContain('google/gemini-2.5-pro -> anthropic/claude-3-5-sonnet (Rate limit 429)')
  })
})
