import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { captureAdvisorTask, DecisionInbox } from '../src/app/decision-inbox.ts'
import { apply } from '../../dsh-next-steps/src/index.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const dbs: DatabaseSync[] = []
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(dispose => dispose()); dbs.splice(0).forEach(db => db.close()) })
const history = (id = 'm1', text = 'If you want, I can add focused regression tests next.') => [
  { type: 'user/message', seq: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement the parser' }] } },
  { type: 'request/header', seq: 1, data: { header: { config: { provider: 'mock', model: 'advisor' } } } },
  { type: 'turn/start', seq: 2, data: { turn: 1 } },
  { type: 'assistant/message', seq: 3, data: { turn: 1, message: { id, role: 'assistant', content: [{ type: 'text', text }] } } },
  { type: 'turn/end', seq: 4, time: 100, data: { turn: 1, reason: { kind: 'completed' } } },
]
const answer = { recommended: 0, options: [
  { label: 'Add regression tests', prompt: 'Add focused regression tests for the parser, then run them and report any failures.', why: 'Verify the completed parser against edge cases.' },
  { label: 'Review the patch', prompt: 'Review the parser patch for correctness before making any further changes.', why: 'Inspect implementation risks first.' },
] }
/** Slim host fixture: one finished turn per session and a mocked advisor route; no startup generation or shared inbox. */
function fixture(count = 1, text?: string) {
  const histories = new Map(Array.from({ length: count }, (_, i) => [`s${i}`, history(`m${i}`, text)]))
  let handler: any
  const prepare = vi.fn(async () => ({ config: {}, async *stream() {
    await Promise.resolve(); yield { type: 'text-delta', text: JSON.stringify(answer) }; yield { type: 'finish', reason: { kind: 'completed' } }
  } }))
  const ctx = {
    sessionPersistence: { flush: async () => {},
      open: async (id: string) => ({ read: async () => ({ events: histories.get(id)! }), close: async () => {} }) },
    llm: { prepareCall: prepare }, logger: () => ({ info: () => {}, warn: () => {} }),
    effect: (effect: () => (() => void)) => { cleanups.push(effect()) },
    webServer: { host: '127.0.0.1', port: 3082, register: (route: any) => { handler = route.handler; return () => {} } },
  }
  apply(ctx as any)
  const request = async (sessionId: string, force = false, headers: Record<string, string> = { 'x-next-steps-request': '1' }) => {
    let status = 0; let body: any
    await handler({ method: 'POST', url: '/next-steps/api/suggest', headers,
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId, force })) } },
    { writeHead: (code: number) => { status = code }, end: (text: string) => { body = JSON.parse(text) } })
    return { status, body }
  }
  return { histories, prepare, request }
}

it('lists all cold completed human tasks without any model calls, and skips internal follow-on turns', () => {
  const db = new DatabaseSync(':memory:'); dbs.push(db)
  const inbox = new DecisionInbox(db)
  for (let index = 0; index < 7; index++) {
    const events = history(`complete-${index}`, 'Implementation is complete and the focused checks passed.') as unknown as SessionEvent[]
    inbox.capture(`task-${index}`, events)
    captureAdvisorTask(inbox, `task-${index}`, events)
    captureAdvisorTask(inbox, `task-${index}`, events)
  }
  expect(inbox.list()).toHaveLength(7)
  expect(inbox.list().every(item => item.advisor?.status === 'pending' && item.choices.length === 0 && !item.recommendation.recommendedValue)).toBe(true)
  const internal = history('internal', 'Automatic background continuation is finished.')
  internal.splice(3, 0, { type: 'turn/end', seq: 2.5, time: 99, data: { turn: 0, reason: { kind: 'completed' } } } as any)
  captureAdvisorTask(inbox, 'internal', internal as unknown as SessionEvent[])
  expect(inbox.list()).toHaveLength(7)
})

it('returns the advisor full prompts through the suggest route and shares one in-flight call', async () => {
  const view = fixture()
  const [one, concurrent] = await Promise.all([view.request('s0'), view.request('s0')])
  expect(one.status).toBe(200)
  expect(one.body).toMatchObject({ status: 'ready', key: '4', model: 'mock/advisor' })
  expect(one.body.options).toEqual(answer.options.map((option, index) => ({ ...option, recommended: index === 0 })))
  expect(concurrent.body).toEqual(one.body)
  expect(view.prepare).toHaveBeenCalledTimes(1)
  expect(view.prepare).toHaveBeenCalledWith({ provider: 'mock', model: 'advisor', maxTokens: 1200 }, expect.any(AbortSignal))
})

it('rejects a cross-origin suggest request without asking the advisor', async () => {
  const view = fixture()
  const rejected = await view.request('s0', false, {})
  expect(rejected.status).toBe(403)
  expect(rejected.body).toEqual({ error: 'same-origin request required' })
  expect(view.prepare).not.toHaveBeenCalled()
})

it('serves a cached digest and only re-asks the advisor on an explicit force refresh', async () => {
  const view = fixture()
  const first = await view.request('s0')
  const cached = await view.request('s0')
  expect(cached.body).toEqual(first.body)
  expect(view.prepare).toHaveBeenCalledTimes(1)
  view.prepare.mockImplementationOnce(async () => ({ config: {}, async *stream() {
    yield { type: 'text-delta', text: JSON.stringify({ recommended: 0, options: [
      { label: 'Commit the fix', prompt: 'Commit the parser fix and open the pull request.', why: 'Ship the verified change.' },
    ] }) }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } }))
  const forced = await view.request('s0', true)
  expect(view.prepare).toHaveBeenCalledTimes(2)
  expect(forced.body).toEqual({ status: 'ready', key: '4', model: 'mock/advisor', options: [
    { label: 'Commit the fix', prompt: 'Commit the parser fix and open the pull request.', why: 'Ship the verified change.', recommended: true },
  ] })
})

it('does not generate options at startup; the active slot asks for them on demand', async () => {
  const view = fixture(6)
  for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve))
  expect(view.prepare).not.toHaveBeenCalled()
  const result = await view.request('s3')
  expect(result.status).toBe(200)
  expect(result.body).toMatchObject({ status: 'ready', key: '4', model: 'mock/advisor' })
  expect(view.prepare).toHaveBeenCalledTimes(1)
})

it('places the model recommendation first and marks exactly one option recommended', async () => {
  const view = fixture()
  view.prepare.mockImplementationOnce(async () => ({ config: {}, async *stream() {
    yield { type: 'text-delta', text: JSON.stringify({ recommended: 1, options: [
      { label: 'Review the patch', prompt: 'Review the parser patch before changing anything.', why: 'Find risks first.' },
      { label: 'Add regression tests', prompt: 'Add focused regression tests for the parser and report failures.', why: 'Verify edge cases.' },
    ] }) }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } }))
  const result = await view.request('s0')
  expect(result.body.options.map((option: any) => option.label)).toEqual(['Add regression tests', 'Review the patch'])
  expect(result.body.options.map((option: any) => option.recommended)).toEqual([true, false])
})

it('reports not-ready without a model call while the latest turn is still running', async () => {
  const view = fixture()
  view.histories.set('s0', [...history(), { type: 'turn/start', seq: 5, data: { turn: 2 } }])
  const result = await view.request('s0')
  expect(result.status).toBe(200)
  expect(result.body).toEqual({ status: 'not-ready', reason: 'turn-running' })
  expect(view.prepare).not.toHaveBeenCalled()
})

it('reports an advisor failure without caching and retries the next request', async () => {
  const view = fixture()
  view.prepare.mockRejectedValueOnce(new Error('Provider unavailable'))
  const failed = await view.request('s0')
  expect(failed.status).toBe(500)
  expect(failed.body).toEqual({ error: 'Provider unavailable' })
  const retried = await view.request('s0')
  expect(retried.status).toBe(200)
  expect(retried.body).toMatchObject({ status: 'ready', key: '4', model: 'mock/advisor' })
  expect(view.prepare).toHaveBeenCalledTimes(2)
})
