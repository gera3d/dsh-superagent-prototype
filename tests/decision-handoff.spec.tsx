// @vitest-environment jsdom
/** Component tests with synthetic inbox and native bridge; not a real model/native Send run. */
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DecisionHandoffDock, DECISION_HANDOFF_KEY, DECISION_HANDOFF_EVENT } from '../src/client/decision-handoff.tsx'
import { DecisionsPage } from '../src/client/decisions.tsx'
import { PanelProvider } from '../src/client/provider.tsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let roots: Root[] = []
afterEach(() => { act(() => roots.forEach(root => root.unmount())); roots = []; document.body.replaceChildren(); sessionStorage.clear(); vi.unstubAllGlobals() })
function mount(view: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  return { container, async render(next = view) { await act(async () => root.render(next)) } }
}
const handoff = { decisionId: 'canonical', choiceId: 'recover', sessionId: 'session-one', prompt: 'Verify the complete recovery procedure.\nDo not change the backup.' }
const input = { phase: 'plain', draft: 'Keep existing text' }
const session = { sessionId: handoff.sessionId, running: false }

it('stages the exact selected full prompt through the native bridge without sending, including StrictMode replay', async () => {
  sessionStorage.setItem(DECISION_HANDOFF_KEY, JSON.stringify(handoff))
  const bridge = { stage: vi.fn(async (_request: any) => ({})), watch: vi.fn(() => () => {}) }
  const inputActions = { send: vi.fn(), submit: vi.fn() }
  const view = mount(<StrictMode><DecisionHandoffDock {...{ session, input, inputActions, bridge } as any} /></StrictMode>)
  await view.render()
  expect(bridge.stage).toHaveBeenCalledTimes(1)
  expect(bridge.stage.mock.calls[0]![0]).toMatchObject(handoff)
  expect(inputActions.send).not.toHaveBeenCalled(); expect(inputActions.submit).not.toHaveBeenCalled()
  expect(sessionStorage.getItem(DECISION_HANDOFF_KEY)).toBeNull()
  expect(view.container.textContent).toContain('press Send to record your decision')
})

it('consumes a new selection in an already-mounted dock and does not cancel for composer object rerenders', async () => {
  let finish!: () => void
  const bridge = { stage: vi.fn(async (_request: any) => new Promise<void>(resolve => { finish = resolve })), watch: vi.fn(() => () => {}) }
  const props: any = { session, input, inputActions: {}, bridge }
  const view = mount(<DecisionHandoffDock {...props} />)
  await view.render()
  expect(bridge.stage).not.toHaveBeenCalled()
  await act(async () => {
    sessionStorage.setItem(DECISION_HANDOFF_KEY, JSON.stringify(handoff))
    window.dispatchEvent(new Event(DECISION_HANDOFF_EVENT))
  })
  expect(bridge.stage).toHaveBeenCalledTimes(1)
  const signal = bridge.stage.mock.calls[0]![0].signal as AbortSignal
  await view.render(<DecisionHandoffDock {...props} input={{ ...input }} inputActions={{}} />)
  expect(signal.aborted).toBe(false)
  expect(bridge.stage).toHaveBeenCalledTimes(1)
  await act(async () => finish())
  const next = { ...handoff, decisionId: 'new-source', choiceId: 'scope', prompt: 'Clarify backup scope.' }
  await act(async () => {
    sessionStorage.setItem(DECISION_HANDOFF_KEY, JSON.stringify(next))
    window.dispatchEvent(new Event(DECISION_HANDOFF_EVENT))
  })
  expect(bridge.stage).toHaveBeenCalledTimes(2)
  expect(bridge.stage.mock.calls[1]![0]).toMatchObject(next)
  await act(async () => finish())
})

it('preserves the draft and displays the missing bridge limitation', async () => {
  sessionStorage.setItem(DECISION_HANDOFF_KEY, JSON.stringify(handoff))
  const view = mount(<DecisionHandoffDock {...{ session, input, inputActions: {} } as any} />)
  await view.render()
  expect(view.container.textContent).toContain('Linked submission service unavailable')
  expect(input.draft).toBe('Keep existing text')
  expect(sessionStorage.getItem(DECISION_HANDOFF_KEY)).toBe(JSON.stringify(handoff))
})

it('prepares from Decisions with exact canonical identities and prompts, without resolving or falsely recording', async () => {
  const item = { id: handoff.decisionId, sessionId: handoff.sessionId, status: 'pending', question: 'Next steps?', context: '', trigger: 'Tailored choices', ticketTitle: 'Backups', urgency: 'low', choices: [{ id: handoff.choiceId, label: 'Check recovery', prompt: handoff.prompt }, { id: 'scope', label: 'Clarify scope', prompt: 'Clarify backup scope.' }], canonical: { phase: 'ready', draftRevision: 'hash' }, recommendation: { recommendedValue: handoff.choiceId, confidence: 0, rationale: 'Verify recovery.', provider: 'Senior Developer', distribution: [] } }
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(url)
    return Response.json(url.endsWith('/state') ? { load: { running: 0 } } : { items: [item] })
  }))
  const openSession = vi.fn(async () => {})
  const view = mount(<PanelProvider t={((key: string) => key) as any} openSession={openSession}><DecisionsPage /></PanelProvider>)
  await view.render()
  const choices = [...view.container.querySelectorAll('button')].filter(button => button.textContent === 'Prepare reply')
  expect(choices).toHaveLength(2)
  await act(async () => choices[0]!.click())
  expect(openSession).toHaveBeenCalledExactlyOnceWith(handoff.sessionId)
  expect(JSON.parse(sessionStorage.getItem(DECISION_HANDOFF_KEY)!)).toEqual(handoff)
  expect(requests.every(url => !url.endsWith('/resolve'))).toBe(true)
  expect(view.container.textContent).not.toContain('Choice recorded:')
  expect(view.container.textContent).toContain('Only confirmed native Send records')
})


it('rereads a queued selection when the mounted composer switches source sessions', async () => {
  const bridge = { stage: vi.fn(async (_request: any) => ({})), watch: vi.fn(() => () => {}) }
  const props: any = { session: { sessionId: 'other', running: false }, input, inputActions: {}, bridge }
  const view = mount(<DecisionHandoffDock {...props} />)
  await view.render()
  await act(async () => {
    sessionStorage.setItem(DECISION_HANDOFF_KEY, JSON.stringify(handoff))
    window.dispatchEvent(new Event(DECISION_HANDOFF_EVENT))
  })
  expect(bridge.stage).not.toHaveBeenCalled()
  await view.render(<DecisionHandoffDock {...props} session={session} />)
  expect(bridge.stage).toHaveBeenCalledTimes(1)
  expect(bridge.stage.mock.calls[0]![0]).toMatchObject(handoff)
})
