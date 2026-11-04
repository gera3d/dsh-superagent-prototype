// @vitest-environment jsdom
/** Component integration only: synthetic Session snapshots and a mocked shared HTTP inbox; no live model claims. */
import { act, StrictMode } from 'react'
import { readFileSync } from 'node:fs'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InlineDecision, type InlineDecisionProps } from '../src/client/inline-decision.tsx'
import { apply as applyNextSteps } from '../../dsh-next-steps/src/client/index.tsx'
import type { PendingDecisionItem } from '../src/core/decision.ts'
import { DecisionsPage } from '../src/client/decisions.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import type { T } from '../src/client/text.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const alternatives = 'Which approach should we choose?\nA. Inspect the implementation\nB. Run the existing tests'
const recommendation = { recommendedValue: 'option-b', confidence: 0.6, rationale: 'Synthetic evaluator response for component tests.', distribution: [{ id: 'option-a', probability: 0.4 }, { id: 'option-b', probability: 0.6 }], provider: 'Mock model', latencyMs: 7 }
function item(sessionId = 'session-one'): PendingDecisionItem {
  return { id: `inline:${sessionId}:message-one`, sessionId, sourceMessageId: 'message-one', ticketTitle: 'Conversation decision', trigger: 'Explicit alternatives', status: 'pending', urgency: 'low', createdAt: 1, context: alternatives, question: 'Which approach should we choose?', choices: [{ id: 'option-a', label: 'Inspect the implementation' }, { id: 'option-b', label: 'Run the existing tests' }], recommendation }
}
let inbox: PendingDecisionItem[]
let requests: { path: string; method: string; body: any }[]
let roots: Root[]
let inboxFailure: boolean
let evaluationFailure: boolean
let resolutionFailure: boolean
let restartFailure: boolean
beforeEach(() => {
  inbox = []; requests = []; roots = []; inboxFailure = false; evaluationFailure = false; resolutionFailure = false; restartFailure = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://localhost').pathname.replace('/orchestrator/api/', '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, method, body })
    if (path === '/next-steps/api/suggest') {
      const target = inbox.find(item => item.sessionId === body.sessionId)!
      target.choices = item().choices; target.recommendation = recommendation
      return Response.json({ status: 'ready', decisionId: target.id })
    }
    if (path === 'state') return Response.json({ load: { running: 0 } })
    if (path === 'decisions/inbox' && method === 'GET') return inboxFailure ? Response.json({ error: 'Inbox offline' }, { status: 503 }) : Response.json({ items: inbox })
    if (path === 'decisions/evaluate') return evaluationFailure ? Response.json({ error: 'Evaluator unavailable' }, { status: 503 }) : Response.json(recommendation)
    if (path === 'decisions/inbox' && method === 'POST') {
      const existing = inbox.find(item => item.id === body.id || (item.sessionId === body.sessionId && item.sourceMessageId === body.sourceMessageId))
      if (existing?.status === 'pending' && !existing.recommendation.recommendedValue) existing.recommendation = body.recommendation
      else if (!existing) inbox.push(body)
      return Response.json({ ok: true, id: existing?.id ?? body.id })
    }
    if (path.endsWith('/restart')) {
      if (restartFailure) return Response.json({ error: 'Restart unavailable; previous choice preserved.' }, { status: 503 })
      const parentId = decodeURIComponent(path.slice('decisions/'.length, -'/restart'.length))
      const parent = inbox.find(entry => entry.id === parentId)!
      let child = inbox.find(entry => entry.parentDecisionId === parentId)
      if (!child) {
        child = { ...parent, id: `restart-${parentId}`, parentDecisionId: parentId, restartAfterSeq: 10,
          createdAt: parent.createdAt + 1, status: 'pending', staging: undefined, invalidation: undefined,
          resolvedChoice: undefined, resolvedAt: undefined, resolutionBasis: undefined,
          submittedSeq: undefined, submittedMessageId: undefined, submissionId: undefined }
        inbox.push(child)
      }
      return Response.json({ item: child, execution: 'not_executed' })
    }
    if (path.endsWith('/resolve')) return Response.json({ error: 'Linked native submission required' }, { status: 409 })
    throw new Error(`Unexpected API call: ${method} ${path}`)
  }))
})
afterEach(() => {
  act(() => { roots.forEach(root => root.unmount()) })
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const mutations = () => requests.filter(request => request.method === 'POST')
async function flush() { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() }) }
async function pollInbox() { await act(async () => { await vi.advanceTimersByTimeAsync(30000) }); await flush() }
function fixture() {
  const node = { kind: 'assistant', seq: 2, turn: 'turn-one', messageId: 'message-one', interrupted: false, blocks: [{ kind: 'text', text: alternatives }] }
  const chat = { legacy: { nodes: [node] }, timeline: { turns: new Map([['turn-one', { status: 'closed' }]]) } }
  const snapshot = { views: new Map([['chat', chat]]) }
  const span = { revision: 1 }
  const inputActions = { captureInsertion: vi.fn(() => span), insertText: vi.fn((_text: string, _span: unknown) => true), persistDraft: vi.fn(), send: vi.fn(), submit: vi.fn() }
  const session = { sessionId: 'session-one', running: false, removed: false, openState: 'open', pendingSubmissions: [] as unknown[] }
  const input = { phase: 'plain', draft: '' }
  const submissionBridge = { watch: vi.fn(() => vi.fn()), discard: vi.fn(async () => ({ item: inbox[0] })), stage: vi.fn(async (request: any) => {
    if (resolutionFailure) throw new Error('Staging unavailable; the existing draft was preserved.')
    const guard = inputActions.captureInsertion()
    if (!inputActions.insertText(`${input.draft ? '\n\n' : ''}${request.prompt}`, guard)) throw new Error('The draft changed or is locked. Try again.')
    inputActions.persistDraft()
    const target = inbox.find(entry => entry.id === request.decisionId)!
    target.staging = { attemptId: 'stage-attempt', choiceId: request.choiceId, draftFingerprint: 'sha256:mock', choiceFingerprint: 'sha256:choice', stagedAt: 1 } as NonNullable<PendingDecisionItem['staging']>
    return { item: target, staging: target.staging, execution: 'not_executed' as const }
  }) }
  const props = { session, input, inputActions, submissionBridge, useConversation: (selector: (value: typeof snapshot) => unknown) => selector(snapshot) } as unknown as InlineDecisionProps
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  const render = async (strict = false) => { await act(async () => { root.render(strict ? <StrictMode><InlineDecision {...props} /></StrictMode> : <InlineDecision {...props} />) }); await flush() }
  const choose = async () => { const button = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Run the existing tests'))!; expect(button).toBeTruthy(); await act(async () => { button.click() }); await flush() }
  return { node, chat, snapshot, span, session, input, inputActions, submissionBridge, props, container, render, choose }
}

it('creates one shared inbox record from a closed assistant turn under StrictMode, without sending', async () => {
  const view = fixture(); await view.render(true)
  expect(mutations().map(request => request.path)).toEqual(['decisions/evaluate', 'decisions/inbox'])
  expect(inbox).toHaveLength(1)
  expect(inbox[0]).toMatchObject({ id: 'inline:session-one:message-one', sessionId: 'session-one', sourceMessageId: 'message-one', status: 'pending', recommendation })
  expect(requests.find(request => request.path === 'decisions/evaluate')?.body).toMatchObject({ context: alternatives, sessionId: 'session-one', choices: item().choices })
  expect(view.container.textContent).toContain('Agent-Mini · Choose a direction')
  expect(view.container.textContent).toContain('Shared decision queue · 1 pending')
  expect(view.container.textContent).toContain('Run the existing tests')
  expect(view.container.textContent).toContain('· Suggested')
  expect(view.inputActions.insertText).not.toHaveBeenCalled()
  expect(view.inputActions.send).not.toHaveBeenCalled()
  expect(view.inputActions.submit).not.toHaveBeenCalled()
  await view.render(true)
  expect(mutations()).toHaveLength(2)
})

it('evaluates a captured canonical question and keeps that single recommendation on fresh mount', async () => {
  const captured = { ...item(), id: 'chat-canonical', recommendation: { ...recommendation, recommendedValue: '', rationale: 'Not evaluated', provider: 'Not evaluated' } }
  inbox = [captured]
  const view = fixture(); await view.render(true)
  expect(inbox).toHaveLength(1)
  expect(inbox[0]!.id).toBe('chat-canonical')
  expect(view.container.querySelectorAll('article')).toHaveLength(1)
  expect(view.container.textContent).toContain('Run the existing tests')
  expect(view.container.textContent).toContain('· Suggested')
  expect(view.container.textContent).not.toContain('Not evaluated')
  const before = mutations().length
  const fresh = fixture(); await fresh.render(true)
  expect(mutations()).toHaveLength(before)
  expect(fresh.container.textContent).toContain('Mock model')
  expect(fresh.inputActions.submit).not.toHaveBeenCalled()
})

it('constrains the dock to composer tokens and scopes compact responsive styles outside the main panel', async () => {
  inbox = [item()]
  const view = fixture(); await view.render()
  const dock = view.container.querySelector<HTMLElement>('[aria-label="Conversation decisions"]')!
  expect(dock.className).toBe('dsa-decisions')
  expect(dock.querySelector('style')).toBeTruthy()
  // Vitest disables CSS imports; inspect the raw stylesheet bundled by tsdown.
  const css = readFileSync('src/client/inline-decision.css', 'utf8')
  expect(css).toContain('var(--dsh-composer-side-clearance, 24px)')
  expect(css).toContain('max-width: var(--dsh-composer-card-max-width, 840px)')
  expect(css).toContain('margin: 0 auto 8px')
  expect(css).toContain('overflow-wrap: anywhere')
  expect(css).toContain('38dvh')
  expect(css).not.toContain('currentColor')
  expect(dock.querySelectorAll('.dsa-decisions__choice')).toHaveLength(2)
  expect(dock.querySelectorAll('.dsa-decisions__choice--suggested')).toHaveLength(1)
  expect(dock.querySelector('details')).toBeNull()
  expect(dock.querySelector('.dsa-decisions__details')!.textContent).toContain('Mock model')
  expect(view.inputActions.submit).not.toHaveBeenCalled()
})

it('reuses the shared queue and stages only its source choice while both decisions remain pending', async () => {
  inbox = [item(), item('other-session')]
  const view = fixture(); view.input.draft = 'My existing draft'; await view.render()
  expect(mutations()).toEqual([])
  expect(view.container.querySelectorAll('article')).toHaveLength(1)
  expect(view.container.textContent).toContain('2 pending')
  await view.choose()
  expect(view.inputActions.captureInsertion).toHaveBeenCalledOnce()
  expect(view.inputActions.insertText).toHaveBeenCalledExactlyOnceWith('\n\nFor the decision “Which approach should we choose?”, choose: Run the existing tests', view.span)
  expect(view.inputActions.persistDraft).toHaveBeenCalledOnce()
  expect(mutations()).toEqual([])
  expect(view.submissionBridge.stage).toHaveBeenCalledWith(expect.objectContaining({ decisionId: item().id, choiceId: 'option-b', sessionId: 'session-one' }))
  expect(inbox.map(entry => entry.status)).toEqual(['pending', 'pending'])
  expect(view.container.textContent).toContain('awaiting confirmed Send')
  expect(view.container.textContent).toContain('Nothing has been sent')
  expect(view.inputActions.send).not.toHaveBeenCalled()
  expect(view.inputActions.submit).not.toHaveBeenCalled()
})

it('replaces the staged notice with confirmed submission status after the server resolves the same decision', async () => {
  vi.useFakeTimers(); inbox = [item()]
  const view = fixture(); view.input.draft = 'Draft for the staged response'
  await view.render(); await view.choose()
  expect(view.container.textContent).toContain('Nothing has been sent')
  inbox[0] = { ...inbox[0]!, status: 'resolved', resolvedChoice: 'option-b', resolutionBasis: 'submitted', submissionId: 'native-send', submittedSeq: 3 }
  await pollInbox()
  expect(view.container.querySelector('[role="status"]')?.textContent).toContain('Linked response confirmed submitted')
  expect(view.container.textContent).not.toContain('Nothing has been sent')
  expect(view.container.textContent).not.toContain('Choice staged')
  expect(view.container.textContent).not.toContain('awaiting confirmed Send')
  expect(view.container.querySelectorAll('.dsa-decisions__choice:disabled')).toHaveLength(0)
})

it.each([undefined, 'legacy_staged'] as const)('does not certify historical resolved choices with resolution basis %s', async resolutionBasis => {
  vi.useFakeTimers(); inbox = [item()]
  const view = fixture(); view.input.draft = 'Draft for the staged response'
  await view.render(); await view.choose()
  inbox[0] = { ...inbox[0]!, status: 'resolved', resolvedChoice: 'option-b', resolutionBasis }
  await pollInbox()
  expect(view.container.textContent).toContain('Native submission is not confirmed for this historical record')
  expect(view.container.textContent).not.toContain('Linked response confirmed submitted')
  expect(view.container.textContent).not.toContain('Nothing has been sent')
  expect(view.container.textContent).not.toContain('Choice staged')
})

it('does not leak the staged notice onto an older resolved comparison after its decision becomes stale', async () => {
  vi.useFakeTimers(); inbox = [item(), { ...item(), id: 'older-recorded', sourceMessageId: 'older-source', createdAt: 0, status: 'resolved', resolvedChoice: 'option-a' }]
  const view = fixture(); view.input.draft = 'Draft for the staged response'
  await view.render(); await view.choose()
  inbox[0] = { ...inbox[0]!, status: 'stale', invalidation: { at: 2, reason: 'A newer message replaced the source.' } }
  await pollInbox()
  expect(view.container.textContent).toContain('Recorded choice: Inspect the implementation')
  expect(view.container.textContent).not.toContain('Choice staged')
  expect(view.container.textContent).not.toContain('Nothing has been sent')
  expect(view.container.textContent).not.toContain('awaiting confirmed Send')
})

it('scopes the local staging notice to its own decision even if a replacement decision is staged', async () => {
  vi.useFakeTimers(); inbox = [item()]
  const view = fixture(); view.input.draft = 'Draft for the staged response'
  await view.render(); await view.choose()
  const staging = inbox[0]!.staging
  inbox[0] = { ...inbox[0]!, status: 'stale' }
  inbox.push({ ...item(), id: 'replacement', sourceMessageId: 'replacement-source', question: 'A new decision', createdAt: 2, staging })
  await pollInbox()
  expect(view.container.textContent).toContain('A new decision')
  expect(view.container.textContent).toContain('Choice staged · awaiting confirmed Send')
  expect(view.container.querySelector('.dsa-decisions__item [role="status"]')).toBeNull()
  expect(view.container.textContent).not.toContain('Nothing has been sent')
})

it('removes the local staging notice when the staging link is discarded', async () => {
  inbox = [item()]
  const view = fixture(); view.input.draft = 'Draft for the staged response'
  view.submissionBridge.discard.mockImplementation(async () => { delete inbox[0]!.staging; return { item: inbox[0] } })
  await view.render(); await view.choose()
  expect(view.container.textContent).toContain('Nothing has been sent')
  const discard = [...view.container.querySelectorAll('button')].find(button => button.textContent === 'Discard staged link')!
  await act(async () => { discard.click() }); await flush()
  expect(view.container.textContent).not.toContain('Choice staged')
  expect(view.container.textContent).not.toContain('Nothing has been sent')
  expect(view.container.querySelectorAll('.dsa-decisions__choice:disabled')).toHaveLength(0)
  expect(view.input.draft).toBe('Draft for the staged response')
})

it.each(['running', 'pending-submission', 'cleared-composer', 'adjudicating', 'bound-submission', 'admitted-candidate'] as const)('does not claim nothing was sent while %s indicates submission may be in flight', async mode => {
  vi.useFakeTimers(); inbox = [item()]
  const view = fixture(); view.input.draft = 'Draft for the staged response'
  await view.render(); await view.choose()
  expect(view.container.textContent).toContain('Nothing has been sent')
  if (mode === 'running') view.session.running = true
  if (mode === 'pending-submission') view.session.pendingSubmissions.push({ requestId: 'native-send' })
  if (mode === 'cleared-composer') view.input.draft = ''
  if (mode === 'adjudicating') view.input.phase = 'adjudicating'
  if (mode === 'bound-submission') inbox[0]!.staging!.submissionId = 'native-send'
  if (mode === 'admitted-candidate') inbox[0]!.staging!.candidateSubmission = { submissionId: 'native-send', messageId: 'admitted', seq: 3, acceptedAt: 2 }
  await view.render(); await pollInbox()
  expect(view.container.textContent).not.toContain('Nothing has been sent')
  expect(view.container.textContent).toContain('Awaiting confirmation of the linked submission')
  expect(view.container.textContent).not.toContain('Linked response confirmed submitted')
})

it('renders an inline-created decision in the real shared Decisions inbox page', async () => {
  const view = fixture(); await view.render()
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  await act(async () => { root.render(<PanelProvider t={((key: string) => key) as T}><DecisionsPage /></PanelProvider>) })
  await flush()
  expect(container.textContent).toContain('Pending (1)')
  expect(container.textContent).toContain(inbox[0]!.question)
  expect(container.textContent).toContain(recommendation.rationale)
  expect(mutations().map(request => request.path)).toEqual(['decisions/evaluate', 'decisions/inbox'])
  expect(view.inputActions.insertText).not.toHaveBeenCalled()
  expect(view.inputActions.send).not.toHaveBeenCalled()
})

it('does not resolve or persist if guarded insertion rejects a changed or locked draft', async () => {
  inbox = [item()]; const view = fixture(); view.inputActions.insertText.mockReturnValue(false)
  await view.render(); await view.choose()
  expect(view.container.textContent).toContain('draft changed or is locked')
  expect(view.inputActions.persistDraft).not.toHaveBeenCalled()
  expect(mutations()).toEqual([])
  expect(inbox[0]!.status).toBe('pending')
})

it('disables choices while the composer is not in plain mode', async () => {
  inbox = [item()]; const view = fixture(); view.input.phase = 'editing'; await view.render(); await view.choose()
  expect(view.container.querySelectorAll('button:disabled')).toHaveLength(2)
  expect(view.inputActions.captureInsertion).not.toHaveBeenCalled()
  expect(mutations()).toEqual([])
})

it.each(['running', 'removed', 'closed-session', 'pending-submission', 'open-turn', 'interrupted', 'latest-user', 'ordinary-list', 'no-chat'] as const)('does not evaluate or insert for %s', async mode => {
  const view = fixture()
  if (mode === 'running') view.session.running = true
  if (mode === 'removed') view.session.removed = true
  if (mode === 'closed-session') view.session.openState = 'closed'
  if (mode === 'pending-submission') view.session.pendingSubmissions.push({})
  if (mode === 'open-turn') view.chat.timeline.turns.set('turn-one', { status: 'open' })
  if (mode === 'interrupted') view.node.interrupted = true
  if (mode === 'latest-user') view.chat.legacy.nodes.push({ ...view.node, kind: 'user', seq: 3 })
  if (mode === 'ordinary-list') view.node.blocks[0]!.text = 'Next steps:\n1. Inspect implementation\n2. Run tests'
  if (mode === 'no-chat') view.snapshot.views.clear()
  await view.render()
  expect(mutations()).toEqual([])
  // With no saved decision the dock renders nothing in every mode, so it can never displace the composer.
  expect(view.container.textContent).toBe('')
  expect(view.inputActions.insertText).not.toHaveBeenCalled()
})

it('keeps saved decisions visible but disabled while a turn is running', async () => {
  inbox = [item()]
  const view = fixture(); view.session.running = true
  await view.render(); await view.choose()
  expect(view.container.textContent).toContain('Conversation is running')
  expect(view.container.textContent).toContain(recommendation.rationale)
  expect(view.container.querySelectorAll('button:disabled')).toHaveLength(2)
  expect(mutations()).toEqual([])
  expect(view.inputActions.insertText).not.toHaveBeenCalled()
})

it('reports a failed staging operation without claiming success or sending', async () => {
  inbox = [item()]; resolutionFailure = true; const view = fixture(); await view.render(); await view.choose()
  expect(view.inputActions.persistDraft).not.toHaveBeenCalled()
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Staging unavailable')
  expect(inbox[0]!.status).toBe('pending')
  expect(view.inputActions.send).not.toHaveBeenCalled()
})

it('offers an explicit retry after evaluation fails without enqueueing a fabricated recommendation', async () => {
  evaluationFailure = true; const view = fixture(); await view.render()
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Evaluator unavailable')
  expect(inbox).toEqual([])
  evaluationFailure = false
  const retry = [...view.container.querySelectorAll('button')].find(button => button.textContent === 'Retry')!
  await act(async () => { retry.click() }); await flush()
  expect(inbox).toHaveLength(1)
  expect(requests.filter(request => request.path === 'decisions/evaluate')).toHaveLength(2)
})

it('keeps resolved alternatives selectable and starts a linked decision only on an explicit click', async () => {
  const parent: PendingDecisionItem = { ...item(), status: 'resolved', resolvedChoice: 'option-a', resolvedAt: 5,
    invalidation: { at: 6, reason: 'A later conversation continued.' },
    staging: { attemptId: 'historical', choiceId: 'option-a', draftFingerprint: 'old', choiceFingerprint: 'old', stagedAt: 1 } }
  inbox = [parent]
  const saved = structuredClone(parent), view = fixture()
  view.input.draft = 'Keep my existing notes'
  await view.render(true)
  expect(mutations()).toEqual([])
  expect(view.container.textContent).toContain('Recorded choice: Inspect the implementation')
  expect(view.container.textContent).toContain('Choose any option again to start a new decision')
  expect(view.container.querySelectorAll('button:disabled')).toHaveLength(0)
  expect(view.inputActions.insertText).not.toHaveBeenCalled()
  await view.choose()
  expect(mutations()).toHaveLength(1)
  expect(mutations()[0]).toMatchObject({ path: expect.stringContaining('/restart'), body: { sessionId: 'session-one' } })
  expect(inbox).toHaveLength(2)
  expect(parent).toEqual(saved)
  const child = inbox.find(entry => entry.parentDecisionId === parent.id)!
  expect(child).toMatchObject({ status: 'pending', parentDecisionId: parent.id, restartAfterSeq: 10, staging: { choiceId: 'option-b' } })
  expect(view.submissionBridge.stage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ decisionId: child.id, choiceId: 'option-b', sessionId: 'session-one' }))
  expect(view.inputActions.insertText).toHaveBeenCalledWith(expect.stringContaining('Run the existing tests'), view.span)
  expect(view.container.textContent).toContain('previous recorded choice is preserved')
  expect(view.container.textContent).toContain('awaiting confirmed Send')
  expect(view.input.draft).toBe('Keep my existing notes')
  expect(view.inputActions.send).not.toHaveBeenCalled()
  expect(view.inputActions.submit).not.toHaveBeenCalled()
})

it('leaves the resolved record and draft unchanged when restart fails', async () => {
  inbox = [{ ...item(), status: 'resolved', resolvedChoice: 'option-a' }]; restartFailure = true
  const saved = structuredClone(inbox), view = fixture()
  await view.render(); await view.choose()
  expect(inbox).toEqual(saved)
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Restart unavailable')
  expect(view.submissionBridge.stage).not.toHaveBeenCalled()
  expect(view.inputActions.insertText).not.toHaveBeenCalled()
  expect(view.container.querySelectorAll('.dsa-decisions__choice:disabled')).toHaveLength(0)
})

it('shows the new pending child for retry if staging fails after restart', async () => {
  inbox = [{ ...item(), status: 'resolved', resolvedChoice: 'option-a' }]; resolutionFailure = true
  const view = fixture(); await view.render(); await view.choose()
  expect(inbox).toHaveLength(2)
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Staging unavailable')
  resolutionFailure = false
  await view.choose()
  expect(mutations().filter(request => request.path.endsWith('/restart'))).toHaveLength(1)
  expect(inbox.find(entry => entry.parentDecisionId)?.staging?.choiceId).toBe('option-b')
  expect(view.inputActions.submit).not.toHaveBeenCalled()
})

it('deduplicates repeated clicks while restarting a resolved decision', async () => {
  inbox = [{ ...item(), status: 'resolved', resolvedChoice: 'option-a' }]
  const view = fixture(); await view.render()
  await act(async () => {
    const control = [...view.container.querySelectorAll('button')].find(button => button.textContent?.includes('Run the existing tests'))!
    control.click(); control.click()
  }); await flush()
  expect(mutations().filter(request => request.path.endsWith('/restart'))).toHaveLength(1)
  expect(view.submissionBridge.stage).toHaveBeenCalledOnce()
})

it('does not stage a late restart response after switching sessions', async () => {
  inbox = [{ ...item(), status: 'resolved', resolvedChoice: 'option-a' }]
  const view = fixture(); await view.render()
  const original = fetch
  let release!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => url.endsWith('/restart')
    ? new Promise<Response>(resolve => { release = resolve }) : original(url, init)))
  const parent = structuredClone(inbox[0]!)
  await view.choose()
  view.session.sessionId = 'session-two'; await view.render()
  await act(async () => { release(Response.json({ item: { ...parent, id: 'child', status: 'pending', parentDecisionId: parent.id, restartAfterSeq: 10 }, execution: 'not_executed' })) }); await flush()
  expect(view.submissionBridge.stage).not.toHaveBeenCalled()
  expect(view.inputActions.insertText).not.toHaveBeenCalled()
})

it('prefers pending decisions over resolved comparisons and never displays another session history', async () => {
  inbox = [item(), { ...item(), id: 'older', status: 'resolved', question: 'Old recorded question' }, { ...item('other-session'), status: 'resolved', createdAt: 999 }]
  const view = fixture(); await view.render()
  expect(view.container.querySelectorAll('article')).toHaveLength(1)
  expect(view.container.textContent).not.toContain('Old recorded question')
  expect(view.container.querySelectorAll('button:disabled')).toHaveLength(0)
  expect(mutations()).toEqual([])
})

it('starts a fresh source identity after the dock switches Sessions without resolving another Session decision', async () => {
  inbox = [item()]
  const view = fixture(); await view.render()
  view.session.sessionId = 'session-two'
  await view.render()
  expect(inbox.map(entry => entry.id)).toEqual(['inline:session-one:message-one', 'inline:session-two:message-one'])
  expect(view.container.querySelectorAll('article')).toHaveLength(1)
  expect(requests.filter(request => request.path.endsWith('/resolve'))).toEqual([])
  expect(view.inputActions.send).not.toHaveBeenCalled()
})

it('surfaces initial inbox errors with a retry rather than silently hiding the dock', async () => {
  inboxFailure = true; const view = fixture(); await view.render()
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Inbox offline')
  expect(mutations()).toEqual([])
})

it('keeps Agent-Mini as the decision dock owner while the slim companion dock registers separately', async () => {
  const effects = vi.fn()
  const register = vi.fn(() => () => {})
  const inject = vi.fn((_name: string, factory: () => unknown) => factory())
  applyNextSteps({ effect: effects, slots: { inject, register } } as any)
  expect(effects).not.toHaveBeenCalled()
  expect(inject).toHaveBeenCalledOnce()
  expect(inject.mock.calls[0]?.[0]).toBe('conversation.input.dock')
  expect(register).toHaveBeenCalledWith({ name: 'conversation.input.dock', id: 'dsh-next-steps', order: 30 }, expect.any(Function))
  expect(document.documentElement.dataset.dshDecisionDockOwner).not.toBe('next-steps')
  inbox = [item()]
  const view = fixture(); await view.render(); await view.choose()
  expect(view.container.querySelectorAll('[aria-label="Conversation decisions"]')).toHaveLength(1)
  expect(view.container.textContent).toContain('Agent-Mini')
  expect(view.submissionBridge.stage).toHaveBeenCalledOnce()
  expect(view.inputActions.submit).not.toHaveBeenCalled()
})

it('hydrates captured empty choices through the canonical advisor without mounting the companion card', async () => {
  inbox = [{ ...item(), choices: [], recommendation: { ...recommendation, recommendedValue: '' } }]
  const view = fixture(); view.node.blocks[0]!.text = 'The work is complete.'
  await view.render(true)
  expect(requests.filter(request => request.path === '/next-steps/api/suggest')).toHaveLength(1)
  expect(view.container.textContent).toContain('Run the existing tests')
  expect(view.container.textContent).toContain('· Suggested')
  expect(view.container.querySelectorAll('article')).toHaveLength(1)
  expect(view.inputActions.submit).not.toHaveBeenCalled()
})

it('blocks invalidated pending decisions before calling the runtime bridge', async () => {
  inbox = [{ ...item(), invalidation: { at: 1, reason: 'Source changed' } }]
  const view = fixture(); await view.render(); await view.choose()
  expect(view.submissionBridge.stage).not.toHaveBeenCalled()
  expect(view.container.querySelectorAll('button:disabled')).toHaveLength(2)
})

it('yields to the preferred Next steps owner without rendering a second card or evaluating again', async () => {
  document.documentElement.dataset.dshDecisionDockOwner = 'next-steps'
  try {
    const view = fixture(); await view.render()
    expect(view.container.querySelector('[aria-label="Conversation decisions"]')).toBeNull()
    expect(requests).toEqual([])
    delete document.documentElement.dataset.dshDecisionDockOwner
    await act(async () => { window.dispatchEvent(new Event('dsh:decision-dock-owner')) }); await flush()
    expect(view.container.querySelector('[aria-label="Conversation decisions"]')).toBeTruthy()
  } finally { delete document.documentElement.dataset.dshDecisionDockOwner }
})

it('keeps a durable submission receipt visible when a newer pending decision replaces the card', async () => {
  inbox = [item(), { ...item(), id: 'confirmed-earlier', sourceMessageId: 'older-message', status: 'resolved', resolvedChoice: 'option-a',
    resolutionBasis: 'submitted', submittedSeq: 3, submissionId: 'native-confirmed', resolvedAt: 10 }]
  const view = fixture(); await view.render()
  expect(view.container.querySelector('[data-decision-receipt="confirmed-earlier"]')?.textContent).toContain('Previous choice confirmed submitted: Inspect the implementation')
  expect(view.container.querySelectorAll('article')).toHaveLength(1)
  expect(view.container.textContent).not.toContain('Nothing has been sent')
})

it('treats 409 on an already-answered card by dropping quietly when choice was recorded', async () => {
  const target = item()
  inbox = [target]
  const view = fixture()
  view.submissionBridge.stage = vi.fn(async () => {
    target.status = 'resolved'
    target.resolvedChoice = 'option-b'
    const err = new Error('Decision service returned 409. No action confirmed.')
    ;(err as any).status = 409
    throw err
  })
  await view.render()
  await view.choose()
  // Quietly dropped; choice went through so no failure banner is rendered
  expect(view.container.querySelector('[role="alert"]')).toBeNull()
})

it('treats 409 on a retired card with a small dismissible line and no retry button', async () => {
  const target = item()
  inbox = [target]
  const view = fixture()
  view.submissionBridge.stage = vi.fn(async () => {
    target.status = 'stale'
    const err = new Error('Decision is stale or closed; no staging is allowed')
    ;(err as any).status = 409
    throw err
  })
  await view.render()
  await view.choose()
  const alert = view.container.querySelector('[role="alert"]')
  expect(alert).not.toBeNull()
  expect(alert?.textContent).toContain('The option could not be sent because the decision is closed.')
  // Must NOT show a Retry button on 409
  expect(alert?.querySelector('button')?.textContent).toBe('Dismiss')
  // Clicking Dismiss removes the notice
  await act(async () => { (alert?.querySelector('button') as HTMLButtonElement)?.click() })
  await flush()
  expect(view.container.querySelector('[role="alert"]')).toBeNull()
})

it('retries a genuine 5xx transient error automatically once before succeeding', async () => {
  const target = item()
  inbox = [target]
  const view = fixture()
  let attempts = 0
  view.submissionBridge.stage = vi.fn(async request => {
    attempts++
    if (attempts === 1) {
      const err = new Error('Decision service error (500).')
      ;(err as any).status = 500
      throw err
    }
    const guard = view.inputActions.captureInsertion()
    view.inputActions.insertText(request.prompt, guard)
    view.inputActions.persistDraft()
    target.staging = { attemptId: 'auto-retry-attempt', choiceId: request.choiceId, draftFingerprint: 'sha256:test', choiceFingerprint: 'sha256:c', stagedAt: 1 } as NonNullable<PendingDecisionItem['staging']>
    return { item: target, staging: target.staging, execution: 'not_executed' as const }
  })
  await view.render()
  await view.choose()
  expect(view.submissionBridge.stage).toHaveBeenCalledTimes(2)
  expect(view.inputActions.persistDraft).toHaveBeenCalledOnce()
  expect(view.container.querySelector('[role="alert"]')).toBeNull()
})

