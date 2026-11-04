/** @vitest-environment jsdom */
/** Opt-in deployment check: exercise the actual UI bridge against a CLOSED record, so nothing can be staged or sent. */
import { expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { createDecisionSubmission } from '../src/client/decision-submission.ts'

it.skipIf(process.env.DSH_DECISION_LIVE_SMOKE !== '1')('Agent-Mini action reaches the live runtime and preserves the draft on a closed source', async () => {
  const nativeFetch = globalThis.fetch
  const base = 'http://127.0.0.1:3082'
  const response = await nativeFetch(`${base}/orchestrator/api/decisions/inbox`, { headers: { 'x-orchestrator-request': '1' } })
  expect(response.status).toBe(200)
  const { items } = await response.json()
  const closed = items.find((item: any) => item.sessionId && item.status !== 'pending')
  expect(closed, 'A closed record is required for a non-mutating action probe').toBeTruthy()
  const state = { draft: 'Preserved smoke-test draft', draftRev: 1, phase: 'plain', occurrences: [], attachmentIds: [], queue: [] }
  const session = { getSnapshot: () => ({ pendingSubmissions: [], running: false }), subscribe: () => () => {} }
  const binding = { ctx: {}, session }
  const statuses: number[] = []
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const result = await nativeFetch(new URL(url, base), init)
    statuses.push(result.status)
    return result
  })
  const bridge = createDecisionSubmission({
    sessions: { retain: () => ({ ready: Promise.resolve(binding), binding, release: () => {} }) },
    conversation: { input: { for: () => ({ state: { getSnapshot: () => state, subscribe: () => () => {} }, observeSubmissions: () => () => {}, notify: () => {} }) } },
  } as any)
  const insertText = vi.fn(), persistDraft = vi.fn()
  try {
    expect(bridge.dockOwner).toBe('agent-mini')
    await expect(bridge.stage({ decisionId: closed.id, sessionId: closed.sessionId, choiceId: closed.choices[0]?.id || 'closed-choice',
      prompt: 'Non-mutating deployment check.', input: state as any,
      inputActions: { captureInsertion: () => ({ draftRev: 1 }), insertText, persistDraft } as any,
    })).rejects.toThrow(/stale|closed/i)
    expect(statuses).toContain(409)
    expect(statuses).not.toContain(404)
    expect(insertText).not.toHaveBeenCalled()
    expect(persistDraft).not.toHaveBeenCalled()
    expect(state.draft).toBe('Preserved smoke-test draft')
  } finally {
    bridge.dispose(); vi.unstubAllGlobals()
  }
})
