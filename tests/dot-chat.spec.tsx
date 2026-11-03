// @vitest-environment jsdom
/** Component integration with synthetic model responses only; no live models or Session mutations. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DotChat, type DotChatProps } from '../src/client/dot-chat.tsx'
import type { DotExecutionReceipt } from '../src/client/dot-execution.ts'
import type { DotPlan, JevResult } from '../src/app/dot.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const context = {
  projects: [{ id: 'project-one', title: 'Workbench', path: '/work/workbench' }],
  threads: [
    { id: 'thread-one', title: 'Implement search', projectId: 'project-one', running: true, waiting: 0, updatedAt: 1730000000000 },
    { id: 'thread-two', title: 'Review changes', running: false, waiting: 2, updatedAt: 1730000001000 },
  ],
}
const goal = 'Help me finish the search feature'
function plan(): DotPlan {
  return {
    reply: 'I can split the search work into safe next steps.',
    actions: [
      { type: 'start_thread', projectId: 'project-one', prompt: 'Implement search coverage in the Workbench project.', why: 'Add focused search tests' },
      { type: 'message_thread', sessionId: 'thread-one', prompt: 'Inspect search edge cases without publishing changes.', why: 'Continue the existing implementation' },
      { type: 'open_thread', sessionId: 'thread-two', why: 'Inspect the waiting review' },
    ],
    jevPick: 1,
    confidence: 0.84,
    route: 'mock/planner',
  }
}
const recommendation: JevResult = {
  pick: 'Continue the existing implementation', confidence: 0.91,
  rationale: 'Reusing the existing thread preserves its implementation context.', route: 'mock/jev-model',
}
type Request = { path: string; method: string; headers: Headers; body: Record<string, any> | undefined }
let requests: Request[]
let response: DotPlan
let planFailure: boolean
let jevFailure: boolean
let roots: Root[]

beforeEach(() => {
  requests = []; response = plan(); planFailure = false; jevFailure = false; roots = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, method, headers: new Headers(init?.headers), body })
    if (path === '/dot/api/plan' && method === 'POST') {
      return planFailure ? Response.json({ error: 'Planner is temporarily unavailable' }, { status: 502 }) : Response.json(response)
    }
    if (path === '/dot/api/jev' && method === 'POST') {
      return jevFailure ? Response.json({ error: 'Jev is temporarily unavailable' }, { status: 502 }) : Response.json(recommendation)
    }
    throw new Error(`Unexpected API call: ${method} ${path}`)
  }))
})
afterEach(() => {
  act(() => { roots.forEach(root => root.unmount()) })
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})
async function flush() { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() }) }
type ExecuteAction = NonNullable<DotChatProps['executeAction']>
function deferredReceipt() {
  let resolve!: (value: DotExecutionReceipt) => void
  const promise = new Promise<DotExecutionReceipt>(done => { resolve = done })
  return { promise, resolve }
}
function retainedClick(button: HTMLButtonElement): () => void {
  const propsKey = Object.keys(button).find(key => key.startsWith('__reactProps$'))!
  return (button as unknown as Record<string, { onClick: () => void }>)[propsKey]!.onClick
}
async function mount(props: Omit<DotChatProps, 'getContext'> = {}) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  const getContext = vi.fn(async () => structuredClone(context))
  await act(async () => { root.render(<DotChat getContext={getContext} {...props} />) })
  await flush()
  const textarea = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Goal for Dot"]')!
  const button = (label: string) => {
    const found = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === label)
    expect(found, `button ${label}`).toBeTruthy()
    return found!
  }
  const type = async (text: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), text)
      textarea().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const click = async (label: string) => { await act(async () => { button(label).click() }); await flush() }
  const submit = async (text = goal) => { await type(text); await click('Plan goal') }
  const selection = (number: number, scope: ParentNode = container) => {
    const input = scope.querySelector<HTMLInputElement>(`input[aria-label="Select action ${number}"]`)
    expect(input, `Select action ${number}`).toBeTruthy()
    return input!
  }
  const select = async (number: number, scope: ParentNode = container) => {
    await act(async () => { selection(number, scope).click() }); await flush()
  }
  const review = () => container.querySelector<HTMLElement>('[role="region"][aria-label="Approval review"]')
  return { container, getContext, textarea, button, type, click, submit, selection, select, review }
}

it('forwards the typed goal and complete current context to the planner with the request header', async () => {
  const view = await mount()
  expect(requests).toEqual([])
  await view.submit()
  expect(view.getContext).toHaveBeenCalledTimes(2) // Initial context preview and fresh submission snapshot.
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ path: '/dot/api/plan', method: 'POST', body: { utterance: goal, ...context, history: [] } })
  expect(requests[0]!.headers.get('x-orchestrator-request')).toBe('1')
  expect(requests[0]!.headers.get('content-type')).toContain('application/json')
})

it('renders the model reply and action prompts as approval-required cards, marking only the recommendation', async () => {
  const view = await mount(); await view.submit()
  expect(view.container.textContent).toContain(response.reply)
  for (const action of response.actions) {
    expect(view.container.textContent).toContain(action.why)
    if ('prompt' in action) expect(view.container.textContent).toContain(action.prompt)
  }
  const cards = [...view.container.querySelectorAll('.dot-chat-actions > li')]
  const selected = cards.filter(card => card.textContent?.includes('Jev’s pick'))
  expect(selected).toHaveLength(1)
  expect(selected[0]!.textContent).toContain('Continue the existing implementation')
  expect(selected[0]!.textContent).not.toContain('Implement search coverage in the Workbench project.')
  expect(view.container.textContent).toContain('Approval required')
  expect(view.container.textContent).toContain('Execution is disabled')
})

it('keeps execution disabled and never creates, messages, or opens Sessions while previewing', async () => {
  const view = await mount(); await view.submit()
  const execute = view.button('Execution disabled')
  expect(execute.disabled).toBe(true)
  await act(async () => { execute.click() }); await flush()
  expect(requests.map(request => `${request.method} ${request.path}`)).toEqual(['POST /dot/api/plan'])
  expect(view.container.textContent).toContain('Approval required')
  expect(view.container.textContent).toContain('Execution is disabled')
})

it('treats jevPick -1 as independent actions rather than selecting a card', async () => {
  response.jevPick = -1
  const view = await mount(); await view.submit()
  expect(view.container.textContent).not.toContain('Jev’s pick')
  expect(view.container.textContent).toMatch(/independent/i)
  for (const action of response.actions) expect(view.container.textContent).toContain(action.why)
  expect(requests.map(request => request.path)).toEqual(['/dot/api/plan'])
})

it('displays planning failures and preserves the draft for an explicit retry', async () => {
  planFailure = true
  const view = await mount(); await view.submit()
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Planner is temporarily unavailable')
  expect(view.textarea().value).toBe(goal)
  expect(view.container.textContent).not.toContain(response.reply)
  expect(requests.map(request => request.path)).toEqual(['/dot/api/plan'])
  planFailure = false
  await view.click('Plan goal')
  expect(requests).toHaveLength(2)
  expect(requests[1]!.body?.utterance).toBe(goal)
  expect(view.container.textContent).toContain(response.reply)
})

it('requests Jev only on click, forwarding proposed action choices and showing model rationale and score', async () => {
  const view = await mount(); await view.submit()
  expect(requests.map(request => request.path)).toEqual(['/dot/api/plan'])
  expect(view.container.textContent).not.toContain(recommendation.rationale)
  await view.click('Get Jev recommendation')
  expect(requests.map(request => request.path)).toEqual(['/dot/api/plan', '/dot/api/jev'])
  const request = requests[1]!
  expect(request.method).toBe('POST')
  expect(request.headers.get('x-orchestrator-request')).toBe('1')
  expect(request.body?.choices.map((choice: { label: string }) => choice.label)).toEqual(response.actions.map(action => action.why))
  expect(request.body?.question).toEqual(expect.any(String))
  expect(request.body?.question.length).toBeGreaterThan(0)
  expect(view.container.textContent).toContain(recommendation.rationale)
  expect(view.container.textContent).toContain('91%')
  expect(view.container.textContent).toContain(recommendation.route)
  expect(view.button('Execution disabled').disabled).toBe(true)
})

it('forwards prior successful conversation turns and obtains fresh context for a follow-up goal', async () => {
  const view = await mount(); await view.submit()
  const previousReply = response.reply
  const nextContext = { ...context, threads: context.threads.map(thread => ({ ...thread, running: false, waiting: 3 })) }
  view.getContext.mockResolvedValueOnce(nextContext)
  response = { ...plan(), reply: 'Here is the follow-up plan.' }
  await view.submit('Now focus on the review')
  expect(requests[1]!.body).toEqual({
    utterance: 'Now focus on the review', ...nextContext,
    history: [{ role: 'user', text: goal }, { role: 'assistant', text: previousReply }],
  })
  expect(view.container.querySelectorAll('article')).toHaveLength(2)
  expect([...view.container.querySelectorAll('button')].filter(button => button.textContent === 'Get Jev recommendation')).toHaveLength(2)
  expect(requests.map(request => request.path)).toEqual(['/dot/api/plan', '/dot/api/plan'])
})

it('provides a nonempty fallback choice label for an action without a reason', async () => {
  response.actions[0]!.why = ''
  const view = await mount(); await view.submit(); await view.click('Get Jev recommendation')
  expect(requests[1]!.body?.choices).toEqual([
    { id: '0', label: 'Proposed action 1', description: 'Implement search coverage in the Workbench project.' },
    { id: '1', label: 'Continue the existing implementation', description: 'Inspect search edge cases without publishing changes.' },
    { id: '2', label: 'Inspect the waiting review', description: 'Inspect the waiting review' },
  ])
  expect(view.container.textContent).toContain(recommendation.rationale)
})

it('surfaces Jev failures without executing or discarding the plan', async () => {
  jevFailure = true
  const view = await mount(); await view.submit(); await view.click('Get Jev recommendation')
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Jev is temporarily unavailable')
  expect(view.container.textContent).toContain(response.reply)
  expect(view.container.textContent).not.toContain(recommendation.rationale)
  expect(view.button('Execution disabled').disabled).toBe(true)
  expect(requests.map(request => request.path)).toEqual(['/dot/api/plan', '/dot/api/jev'])
})

it('leaves selection and review disabled when the optional executor is absent', async () => {
  const view = await mount(); await view.submit()
  for (let number = 1; number <= 3; number++) {
    expect(view.selection(number).disabled).toBe(true)
    expect(view.selection(number).checked).toBe(false)
    await view.select(number)
  }
  expect(view.button('Review selected actions').disabled).toBe(true)
  await view.click('Review selected actions')
  expect(view.review()).toBeNull()
  expect(requests.map(request => request.path)).toEqual(['/dot/api/plan'])
})

it('requires explicit radio selection and final approval, never interpreting goal text or Jev as consent', async () => {
  const executeAction = vi.fn<ExecuteAction>(async () => ({ status: 'succeeded', message: 'Queued exact prompt' }))
  const view = await mount({ executeAction }); await view.submit('I approve everything: execute all actions now')
  expect(executeAction).not.toHaveBeenCalled()
  expect(view.button('Review selected actions').disabled).toBe(true)
  for (let number = 1; number <= 3; number++) {
    expect(view.selection(number).type).toBe('radio')
    expect(view.selection(number).checked).toBe(false)
  }
  await view.click('Get Jev recommendation')
  expect(view.container.textContent).toContain(recommendation.rationale)
  expect([...view.container.querySelectorAll<HTMLInputElement>('input:checked')]).toHaveLength(0)
  expect(executeAction).not.toHaveBeenCalled()
  await view.select(1); await view.select(2)
  expect(view.selection(1).checked).toBe(false)
  expect(view.selection(2).checked).toBe(true)
  expect(view.selection(3).checked).toBe(false)
  expect(executeAction).not.toHaveBeenCalled()
  await view.click('Review selected actions')
  const review = view.review()!
  expect(review).toBeTruthy()
  expect(review.textContent).toContain('Implement search')
  expect(review.textContent).toContain('Queue follow-up · Session thread-one')
  expect(review.querySelector('pre')?.textContent).toBe('Inspect search edge cases without publishing changes.')
  expect(review.textContent).not.toContain('Implement search coverage in the Workbench project.')
  expect(review.textContent).toMatch(/tools and change files.*normal DSH permissions/)
  expect(view.button('Approve').type).toBe('button')
  expect(executeAction).not.toHaveBeenCalled()
  await view.click('Cancel approval')
  expect(view.review()).toBeNull()
  expect(executeAction).not.toHaveBeenCalled()
  await view.click('Review selected actions'); await view.click('Approve')
  expect(executeAction).toHaveBeenCalledExactlyOnceWith(response.actions[1], context, expect.any(AbortSignal))
  expect(view.container.textContent).toContain('Dispatch accepted · Queued exact prompt')
  expect(view.button('Approval consumed').disabled).toBe(true)
  expect(requests.map(request => request.path)).toEqual(['/dot/api/plan', '/dot/api/jev'])
})

it('reviews and executes only checked independent actions in plan order with a captured scope', async () => {
  response.jevPick = -1
  const first = deferredReceipt()
  const executeAction = vi.fn<ExecuteAction>().mockImplementationOnce(() => first.promise)
    .mockResolvedValue({ status: 'succeeded', message: 'Navigation accepted', sessionId: 'thread-two' })
  const view = await mount({ executeAction }); await view.submit()
  for (let number = 1; number <= 3; number++) {
    expect(view.selection(number).type).toBe('checkbox')
    expect(view.selection(number).checked).toBe(false)
  }
  await view.click('Get Jev recommendation')
  expect(view.container.querySelectorAll('input:checked')).toHaveLength(0)
  await view.select(3); await view.select(2); await view.select(1); await view.select(2)
  await view.click('Review selected actions')
  const scope = view.review()!
  expect(scope.querySelectorAll('li')).toHaveLength(2)
  expect(scope.textContent).toContain('Workbench')
  expect(scope.textContent).toContain('Review changes')
  expect(scope.textContent).toContain('Create thread · Project project-one · /work/workbench')
  expect(scope.textContent).toContain('Open thread · Session thread-two')
  expect(scope.querySelector('pre')?.textContent).toBe('Implement search coverage in the Workbench project.')
  expect(scope.textContent).not.toContain('Inspect search edge cases without publishing changes.')
  const expected = structuredClone(response.actions)
  await view.click('Approve')
  expect(executeAction).toHaveBeenCalledTimes(1)
  expect(executeAction.mock.calls[0]![0]).toEqual(expected[0])
  expect(executeAction.mock.calls[0]![0]).not.toBe(response.actions[0])
  expect(executeAction.mock.calls[0]![1]).toEqual(context)
  const planningSnapshot = await view.getContext.mock.results[1]!.value
  expect(executeAction.mock.calls[0]![1]).not.toBe(planningSnapshot)
  expect(executeAction.mock.calls[0]![1].projects[0]).not.toBe(planningSnapshot.projects[0])
  expect(executeAction.mock.calls[0]![1].threads[0]).not.toBe(planningSnapshot.threads[0])
  planningSnapshot.projects[0]!.path = '/changed-after-approval'
  planningSnapshot.threads[0]!.title = 'Changed after approval'
  expect(executeAction.mock.calls[0]![1]).toEqual(context)
  expect(view.selection(1).disabled).toBe(true)
  expect(view.selection(3).disabled).toBe(true)
  expect(executeAction.mock.calls[0]![2].aborted).toBe(false)
  await act(async () => { first.resolve({ status: 'succeeded', message: 'Feature queued' }) }); await flush()
  expect(executeAction).toHaveBeenCalledTimes(2)
  expect(executeAction.mock.calls[1]![0]).toEqual(expected[2])
  expect(executeAction.mock.calls[1]![1]).toBe(executeAction.mock.calls[0]![1])
  expect(executeAction.mock.calls[1]![2]).toBe(executeAction.mock.calls[0]![2])
  const cards = [...view.container.querySelectorAll('.dot-chat-actions > li')]
  expect(cards[0]!.textContent).toContain('Dispatch accepted · Feature queued')
  expect(cards[1]!.textContent).toContain('Not executed · awaiting approval')
  expect(cards[2]!.textContent).toContain('Dispatch accepted · Navigation accepted')
})

it('consumes approval synchronously against double clicks and even retained stale approval handlers', async () => {
  const pending = deferredReceipt()
  const executeAction = vi.fn<ExecuteAction>(() => pending.promise)
  const view = await mount({ executeAction }); await view.submit(); await view.select(1); await view.click('Review selected actions')
  const approve = view.button('Approve')
  // Retain the handler React attached before re-render; DOM disabled state alone is not sufficient protection.
  const staleApprove = retainedClick(approve)
  await act(async () => { approve.click(); approve.click(); staleApprove() }); await flush()
  expect(executeAction).toHaveBeenCalledTimes(1)
  await act(async () => { pending.resolve({ status: 'succeeded', message: 'Accepted once' }) }); await flush()
  await act(async () => { staleApprove(); staleApprove() }); await flush()
  expect(executeAction).toHaveBeenCalledTimes(1)
  expect(view.review()).toBeNull()
  expect(view.button('Approval consumed').disabled).toBe(true)
  expect(view.selection(1).disabled).toBe(true)
  expect([...view.container.querySelectorAll('button')].some(button => button.textContent === 'Review selected actions')).toBe(false)
})

it.each(['cancel', 'selection change'] as const)('synchronously revokes a reviewed approval on %s, including retained stale handlers', async revoke => {
  const executeAction = vi.fn<ExecuteAction>(async () => ({ status: 'succeeded', message: 'Fresh approval accepted' }))
  const view = await mount({ executeAction }); await view.submit(); await view.select(1); await view.click('Review selected actions')
  const staleApprove = retainedClick(view.button('Approve'))
  await act(async () => {
    if (revoke === 'cancel') view.button('Cancel approval').click()
    else view.selection(2).click()
    // Invoke before awaiting a React re-render: revocation must be synchronous, not just hide the button.
    staleApprove()
  }); await flush()
  expect(executeAction).not.toHaveBeenCalled()
  expect(view.review()).toBeNull()
  await act(async () => { staleApprove() }); await flush()
  expect(executeAction).not.toHaveBeenCalled()
  const selectedNumber = revoke === 'cancel' ? 1 : 2
  expect(view.selection(selectedNumber).checked).toBe(true)
  await view.click('Review selected actions')
  expect(view.review()?.querySelector('pre')?.textContent).toBe(
    selectedNumber === 1 ? 'Implement search coverage in the Workbench project.' : 'Inspect search edge cases without publishing changes.',
  )
  expect(executeAction).not.toHaveBeenCalled()
  await view.click('Approve')
  expect(executeAction).toHaveBeenCalledExactlyOnceWith(response.actions[selectedNumber - 1], context, expect.any(AbortSignal))
  expect(view.button('Approval consumed').disabled).toBe(true)
})

it('stops sequential dispatch at a failed receipt, marks partial results and never retries or reapproves', async () => {
  response.jevPick = -1
  const first = deferredReceipt(), second = deferredReceipt()
  const executeAction = vi.fn<ExecuteAction>().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
  const view = await mount({ executeAction }); await view.submit()
  await view.select(1); await view.select(2); await view.select(3); await view.click('Review selected actions'); await view.click('Approve')
  expect(executeAction).toHaveBeenCalledTimes(1)
  await act(async () => { first.resolve({ status: 'succeeded', sessionId: 'created-thread', message: 'Feature thread created' }) }); await flush()
  expect(executeAction).toHaveBeenCalledTimes(2)
  expect(executeAction.mock.calls.map(call => call[0])).toEqual(response.actions.slice(0, 2))
  await act(async () => { second.resolve({ status: 'failed', message: 'Prompt status uncertain; inspect existing thread' }) }); await flush()
  const cards = [...view.container.querySelectorAll('.dot-chat-actions > li')]
  expect(cards[0]!.textContent).toContain('Dispatch accepted · Feature thread created')
  expect(cards[1]!.textContent).toContain('Dispatch failed · Prompt status uncertain; inspect existing thread')
  expect(cards[2]!.textContent).toContain('Not dispatched. A prior failure or cancellation stopped this plan.')
  expect(view.container.textContent).not.toMatch(/nothing executed/i)
  expect(view.container.querySelector('[role="alert"]')).toBeNull()
  expect(view.button('Approval consumed').disabled).toBe(true)
  for (let number = 1; number <= 3; number++) expect(view.selection(number).disabled).toBe(true)
  await view.click('Approval consumed'); await flush()
  expect(executeAction).toHaveBeenCalledTimes(2)
})

it('requires fresh selection and final approval for every new plan, without inheriting consumed approval', async () => {
  const executeAction = vi.fn<ExecuteAction>(async () => ({ status: 'succeeded', message: 'Accepted' }))
  const view = await mount({ executeAction }); await view.submit(); await view.select(1)
  await view.click('Review selected actions'); await view.click('Approve')
  expect(executeAction).toHaveBeenCalledTimes(1)
  response = { ...plan(), reply: 'A distinct next plan.', jevPick: -1 }
  await view.submit('Continue; my earlier approval should cover this too')
  const articles = view.container.querySelectorAll('article'), next = articles[1]!
  expect(articles).toHaveLength(2)
  for (let number = 1; number <= 3; number++) {
    expect(view.selection(number, next).checked).toBe(false)
    expect(view.selection(number, next).disabled).toBe(false)
  }
  expect(view.button('Review selected actions').disabled).toBe(true)
  await view.click('Review selected actions')
  expect(view.review()).toBeNull()
  expect(executeAction).toHaveBeenCalledTimes(1)
  await view.select(2, next); await view.click('Review selected actions')
  expect(executeAction).toHaveBeenCalledTimes(1)
  await view.click('Approve')
  expect(executeAction).toHaveBeenCalledTimes(2)
  expect(executeAction.mock.calls[1]![0]).toEqual(response.actions[1])
  expect(view.container.querySelectorAll('input:disabled')).toHaveLength(6)
})

it('treats rejected dispatch as a consumed failure rather than retrying or claiming nothing executed', async () => {
  response.jevPick = -1
  const executeAction = vi.fn<ExecuteAction>().mockRejectedValue(new Error('Connection lost after submission'))
  const view = await mount({ executeAction }); await view.submit(); await view.select(1); await view.select(2)
  await view.click('Review selected actions'); await view.click('Approve')
  expect(executeAction).toHaveBeenCalledTimes(1)
  const cards = [...view.container.querySelectorAll('.dot-chat-actions > li')]
  expect(cards[0]!.textContent).toContain('Dispatch failed: Connection lost after submission')
  expect(cards[0]!.textContent).toContain('Check existing threads before planning a retry')
  expect(cards[1]!.textContent).toContain('Not dispatched.')
  expect(view.container.textContent).not.toMatch(/nothing executed/i)
  expect(view.button('Approval consumed').disabled).toBe(true)
  await flush()
  expect(executeAction).toHaveBeenCalledTimes(1)
})

it('does not navigate receipt sessions automatically and opens them only on a separate explicit click', async () => {
  const executeAction = vi.fn<ExecuteAction>(async () => ({ status: 'succeeded', sessionId: 'created-thread', message: 'Session created' }))
  const openSession = vi.fn(async (_id: string) => {})
  const view = await mount({ executeAction, openSession }); await view.submit(); await view.select(1)
  await view.click('Review selected actions')
  expect(openSession).not.toHaveBeenCalled()
  await view.click('Approve')
  expect(openSession).not.toHaveBeenCalled()
  expect(view.button('Open thread').type).toBe('button')
  await view.click('Open thread')
  expect(openSession).toHaveBeenCalledExactlyOnceWith('created-thread')
  expect(executeAction).toHaveBeenCalledTimes(1)
})
