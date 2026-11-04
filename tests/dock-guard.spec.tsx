// @vitest-environment jsdom
/** The dock must never take the composer's place when there is no decision to show. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { InlineDecision, type InlineDecisionProps } from '../src/client/inline-decision.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let node: HTMLDivElement | undefined
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = undefined; node?.remove(); node = undefined
  vi.useRealTimers(); vi.unstubAllGlobals()
})

it('renders nothing for a blank conversation with no decision and no creation in flight', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path.endsWith('/decisions/inbox')) return Response.json({ items: [] })
    throw new Error(`Unexpected request: ${path}`)
  }))
  const chat = { legacy: { nodes: [] }, timeline: { turns: new Map() } }
  const snapshot = { views: new Map([['chat', chat]]) }
  const props = {
    session: { sessionId: 'session-empty', running: false, removed: false, openState: 'open', pendingSubmissions: [] },
    input: { phase: 'plain', draft: '' },
    inputActions: { captureInsertion: vi.fn(), insertText: vi.fn(), persistDraft: vi.fn(), send: vi.fn(), submit: vi.fn() },
    useConversation: (selector: (value: typeof snapshot) => unknown) => selector(snapshot),
  } as unknown as InlineDecisionProps
  node = document.createElement('div'); document.body.append(node)
  root = createRoot(node)
  await act(async () => { root!.render(<InlineDecision {...props} />) })
  await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
  expect(node.innerHTML).toBe('')
  expect(props.inputActions.insertText).not.toHaveBeenCalled()
  expect(props.inputActions.submit).not.toHaveBeenCalled()
})
