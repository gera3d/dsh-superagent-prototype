import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { captureAdvisorTask, DecisionInbox, InboxError } from '../src/app/decision-inbox.ts'
import { apply } from '../../dsh-next-steps/src/index.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const dbs: DatabaseSync[] = []
const cleanups: (() => void)[] = []
const unexpectedFetches: string[] = []
const base = 'http://hermetic.invalid:1'
const helperPath = '/orchestrator/api/helper/suggest'
const rankerPath = '/orchestrator/api/decisions/evaluate'
function unexpectedFetch(input: unknown): never {
  const message = `Unexpected network request: ${String(input)}`
  unexpectedFetches.push(message)
  throw new Error(message)
}
beforeEach(() => {
  unexpectedFetches.length = 0
  // Never delegate to the original fetch, including when generation catches errors.
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => unexpectedFetch(input)))
})
afterEach(() => {
  cleanups.splice(0).reverse().forEach(dispose => dispose())
  dbs.splice(0).forEach(db => db.close())
  vi.unstubAllGlobals()
  expect(unexpectedFetches).toEqual([])
})
const history = (id = 'm1', text = 'If you want, I can add focused regression tests next.') => [
  { type: 'user/message', seq: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement the parser' }] } },
  { type: 'request/header', seq: 1, data: { header: { config: { provider: 'mock', model: 'advisor' } } } },
  { type: 'turn/start', seq: 2, data: { turn: 1 } },
  { type: 'assistant/message', seq: 3, time: 99, data: { turn: 1, message: { id, role: 'assistant', content: [{ type: 'text', text }] } } },
  { type: 'turn/end', seq: 4, time: 100, data: { turn: 1, reason: { kind: 'completed' } } },
]
const answer = { recommended: 0, options: [
  { label: 'Add regression tests', prompt: 'Add focused regression tests for the parser, then run them and report any failures.', why: 'Verify the completed parser against edge cases.' },
  { label: 'Review the patch', prompt: 'Review the parser patch for correctness before making any further changes.', why: 'Inspect implementation risks first.' },
] }
const helperAnswer = { options: answer.options.map((option, index) => ({ id: `choice-${index + 1}`, label: option.label, prompt: option.prompt, recommended: index === 0 })) }
const draftOptions = helperAnswer.options.map(option => ({ ...option, why: '' }))
const ranking = { recommendedValue: 'choice-2', provider: 'Hermetic ranker', distribution: [{ id: 'choice-1', probability: 0.2 }, { id: 'choice-2', probability: 0.8 }] }
// Independently assert the persisted turn-content identity, not the obsolete turn/end seq.
const keyFor = (events: ReturnType<typeof history>, sessionId = 's0') => {
  const messageId = events.findLast(event => event.type === 'assistant/message')!.data.message!.id
  const id = `chat-${createHash('sha256').update(`${sessionId}\0${messageId}`).digest('hex').slice(0, 32)}`
  return `${id}:${createHash('sha256').update(JSON.stringify(events.slice(2).filter(event => event.type !== 'turn/end'))).digest('hex')}`
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
/** In-process route fixture; every helper/ranker fetch and fallback LLM is mocked. */
function fixture(count = 1) {
  const histories = new Map(Array.from({ length: count }, (_, i) => [`s${i}`, history(`m${i}`)]))
  let handler: any
  const helper = vi.fn(async (_init?: RequestInit) => Response.json(helperAnswer))
  const ranker = vi.fn(async (_init?: RequestInit) => Response.json(ranking))
  const db = new DatabaseSync(':memory:'); dbs.push(db)
  const inbox = new DecisionInbox(db)
  const network = vi.mocked(fetch)
  network.mockImplementation(async (input, init) => {
    if (init?.method !== 'POST') return unexpectedFetch(input)
    if (input === `${base}${helperPath}`) return helper(init)
    if (input === `${base}${rankerPath}`) return ranker(init)
    const operation = String(input).startsWith(`${base}/orchestrator/api/decisions/canonical/`)
      ? String(input).slice(`${base}/orchestrator/api/decisions/canonical/`.length) : undefined
    if (operation && ['claim', 'publish', 'score', 'fail'].includes(operation)) {
      const body = JSON.parse(String(init.body))
      const durable = histories.get(body.sessionId) as unknown as SessionEvent[]
      try {
        const result = operation === 'claim' ? inbox.claimCanonical(body, durable)
          : operation === 'publish' ? inbox.publishCanonical(body, durable)
          : operation === 'score' ? inbox.scoreCanonical(body, durable) : inbox.failCanonical(body, durable)
        return Response.json(result)
      } catch (error) {
        if (!(error instanceof InboxError)) throw error
        return Response.json({ error: error.message }, { status: error.status })
      }
    }
    return unexpectedFetch(input)
  })
  const prepare = vi.fn(async () => ({ config: {}, async *stream() {
    yield { type: 'text-delta', text: JSON.stringify(answer) }; yield { type: 'finish', reason: { kind: 'completed' } }
  } }))
  const services = {
    sessionPersistence: { flush: async () => {},
      open: async (id: string) => ({ read: async () => ({ events: histories.get(id)! }), close: async () => {} }) },
    llm: { prepareCall: prepare },
    webServer: { host: 'hermetic.invalid', port: 1, register: (route: any) => { handler = route.handler; return () => {} } },
  }
  const ctx = {
    get: (name: string) => services[name as keyof typeof services],
    effect: (effect: () => (() => void)) => { cleanups.push(effect()) },
  }
  apply(ctx as any, { provider: 'ignored-legacy-provider', model: 'ignored-legacy-model' })
  const request = async (sessionId: string, force = false, headers: Record<string, string> = { 'x-next-steps-request': '1' }, operation = 'suggest', key?: string) => {
    let status = 0; let body: any
    await handler({ method: 'POST', url: `/next-steps/api/${operation}`, headers,
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId, force, key })) } },
    { writeHead: (code: number) => { status = code }, end: (text: string) => { body = JSON.parse(text) } })
    return { status, body }
  }
  const score = (key: string, sessionId = 's0') => request(sessionId, false, undefined, 'score', key)
  return { histories, inbox, prepare, helper, ranker, network, request, score }
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

it('returns immediate unscored helper drafts and deduplicates concurrent generation without ranking or fallback', async () => {
  const view = fixture()
  const gate = deferred<Response>()
  view.helper.mockImplementationOnce(() => gate.promise)
  const pending = [view.request('s0'), view.request('s0')] as const
  await vi.waitFor(() => expect(view.helper).toHaveBeenCalledOnce())
  gate.resolve(Response.json(helperAnswer))
  const [one, concurrent] = await Promise.all(pending)
  expect(one.status).toBe(200)
  expect(one.body).toMatchObject({ status: 'ready', key: keyFor(view.histories.get('s0')!), decisionId: view.inbox.list()[0]!.id, model: 'Senior Developer', options: draftOptions, recommendedValue: 'choice-1', fallback: false, isScored: false })
  expect(view.inbox.list()[0]!.choices.map(({ id, label, prompt }) => ({ id, label, prompt }))).toEqual(draftOptions.map(({ id, label, prompt }) => ({ id, label, prompt })))
  expect(concurrent).toEqual(one)
  expect(view.ranker).not.toHaveBeenCalled()
  expect(view.prepare).not.toHaveBeenCalled()
  const init = view.helper.mock.calls[0]![0]!
  expect(init.headers).toMatchObject({ 'x-orchestrator-request': '1' })
  expect(JSON.parse(String(init.body))).toMatchObject({ summary: 'Implement the parser', latestTurn: expect.stringContaining('focused regression tests') })
})

it('rejects cross-origin suggest and score requests without any external calls', async () => {
  const view = fixture()
  for (const operation of ['suggest', 'score']) {
    const rejected = await view.request('s0', false, {}, operation)
    expect(rejected).toEqual({ status: 403, body: { error: 'same-origin request required' } })
  }
  expect(view.network).not.toHaveBeenCalled()
  expect(view.prepare).not.toHaveBeenCalled()
})

it('reuses durable canonical choices even on legacy force refresh without regeneration', async () => {
  const view = fixture()
  const first = await view.request('s0')
  expect(await view.request('s0')).toEqual(first)
  expect(view.helper).toHaveBeenCalledOnce()
  const fresh = { options: helperAnswer.options.map(option => ({ ...option, prompt: `Fresh: ${option.prompt}` })) }
  view.helper.mockResolvedValueOnce(Response.json(fresh))
  const forced = await view.request('s0', true)
  expect(forced).toEqual(first)
  expect(forced.body.options.map((option: any) => option.prompt)).toEqual(helperAnswer.options.map(option => option.prompt))
  expect(view.helper).toHaveBeenCalledOnce()
  expect(view.ranker).not.toHaveBeenCalled()
  expect(view.prepare).not.toHaveBeenCalled()
})

it('does not generate at startup and only asks for the requested session on demand', async () => {
  const view = fixture(6)
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(view.network).not.toHaveBeenCalled()
  expect(view.prepare).not.toHaveBeenCalled()
  expect((await view.request('s3')).body).toMatchObject({ status: 'ready', model: 'Senior Developer', isScored: false })
  expect(view.helper).toHaveBeenCalledOnce()
  expect(view.ranker).not.toHaveBeenCalled()
})

it('scores separately with concurrent deduplication and updates badges without reordering or rewriting prompts', async () => {
  const view = fixture()
  const draft = (await view.request('s0')).body
  const gate = deferred<Response>()
  view.ranker.mockImplementationOnce(() => gate.promise)
  const pending = [view.score(draft.key), view.score(draft.key)] as const
  await vi.waitFor(() => expect(view.ranker).toHaveBeenCalledOnce())
  gate.resolve(Response.json(ranking))
  const [one, concurrent] = await Promise.all(pending)
  expect(one.body).toMatchObject({ ...draft, isScored: true, provider: ranking.provider, distribution: ranking.distribution, recommendedValue: 'choice-2', options: draftOptions.map((option, index) => ({ ...option, percent: index === 0 ? 20 : 80, recommended: index === 1 })) })
  expect(concurrent).toEqual(one)
  expect(await view.score(draft.key)).toEqual(one)
  expect(await view.request('s0')).toEqual(one)
  const recorded = view.inbox.list()[0]!
  expect(recorded.canonical?.phase).toBe('scored')
  expect(recorded.recommendation.distribution).toEqual(one.body.distribution)
  expect(recorded.recommendation.recommendedValue).toBe(one.body.recommendedValue)
  expect(recorded.choices.map(({ id, label, prompt, description }) => ({ id, label, prompt, why: description }))).toEqual(one.body.options.map(({ id, label, prompt, why }: any) => ({ id, label, prompt, why })))
  expect(view.helper).toHaveBeenCalledOnce()
  expect(view.ranker).toHaveBeenCalledOnce()
  expect(view.prepare).not.toHaveBeenCalled()
  expect(JSON.parse(String(view.ranker.mock.calls[0]![0]!.body))).toMatchObject({ sessionId: 's0', choices: draftOptions.map(option => ({ id: option.id, label: option.label, description: '' })) })
})

it.each(['unavailable', 'invalid'] as const)('keeps draft options unscored when ranker is %s', async mode => {
  const view = fixture()
  const draft = (await view.request('s0')).body
  view.ranker.mockResolvedValueOnce(mode === 'unavailable' ? Response.json({ error: 'offline' }, { status: 503 }) : Response.json({ ...ranking, distribution: [{ id: 'wrong', probability: 1 }] }))
  const result = await view.score(draft.key)
  expect(result.status).toBe(200)
  expect(result.body).toMatchObject({ status: 'ready', options: draftOptions, isScored: false, fallback: false })
  expect(result.body.options.every((option: any) => option.percent === undefined)).toBe(true)
   expect(result.body.options.filter((option: any) => option.recommended).map((option: any) => option.id)).toEqual(['choice-1'])
  expect(view.prepare).not.toHaveBeenCalled()
})

it('reports not-ready without helper, ranker, or fallback while the latest turn is running', async () => {
  const view = fixture()
  // Keep a closing assistant message present so this exercises the running guard, not an empty digest.
  view.histories.set('s0', history().slice(0, -1))
  expect(await view.request('s0')).toEqual({ status: 200, body: { status: 'not-ready', reason: 'turn-running' } })
  expect(view.network).not.toHaveBeenCalled()
  expect(view.prepare).not.toHaveBeenCalled()
})

it.each(['unavailable', 'invalid'] as const)('uses only fixed Flash fallback when helper is %s and never ranks fallback output', async mode => {
  const view = fixture()
  view.helper.mockResolvedValueOnce(mode === 'unavailable' ? Response.json({ error: 'offline' }, { status: 503 }) : Response.json({ options: [helperAnswer.options[0]] }))
  const result = await view.request('s0')
  expect(result.body).toMatchObject({ status: 'ready', model: 'deepseek-official/deepseek-flash', fallback: true, isScored: false })
  expect(result.body.options).toEqual(answer.options.map((option, index) => ({ ...option, id: `opt-${index + 1}`, recommended: index === answer.recommended })))
  expect(view.prepare).toHaveBeenCalledExactlyOnceWith({ provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 1200 }, expect.any(AbortSignal))
  expect(await view.score(result.body.key)).toEqual(result)
  expect(view.ranker).not.toHaveBeenCalled()
})

it('returns generation-failed without caching fabricated options and retries after helper and fallback failure', async () => {
  const view = fixture()
  view.helper.mockRejectedValueOnce(new Error('Helper offline'))
  view.prepare.mockRejectedValueOnce(new Error('Provider unavailable'))
  expect(await view.request('s0')).toEqual({ status: 200, body: { status: 'not-ready', reason: 'generation-failed' } })
  const retried = await view.request('s0')
  expect(retried.body).toMatchObject({ status: 'ready', model: 'Senior Developer', fallback: false, isScored: false })
  expect(view.helper).toHaveBeenCalledTimes(2)
  expect(view.prepare).toHaveBeenCalledOnce()
  expect(view.ranker).not.toHaveBeenCalled()
})

it('rejects rewritten source-turn identity and scoring old keys without regenerating a competing set', async () => {
  const view = fixture()
  const first = await view.request('s0')
  view.histories.set('s0', history('revised', 'The parser is revised; add targeted coverage.'))
  expect(await view.score(first.body.key)).toEqual({ status: 200, body: { status: 'not-ready', reason: 'stale' } })
  const next = await view.request('s0')
  expect(next).toEqual({ status: 200, body: { status: 'not-ready', reason: 'stale' } })
  expect(view.inbox.list()).toHaveLength(1)
  expect(view.inbox.list()[0]!.choices.map(choice => choice.prompt)).toEqual(helperAnswer.options.map(option => option.prompt))
  expect(view.helper).toHaveBeenCalledOnce()
  expect(view.ranker).not.toHaveBeenCalled()
})

it('uses only mocked fetches and rejects unknown endpoints instead of reaching any network', async () => {
  const view = fixture()
  const draft = await view.request('s0')
  await view.score(draft.body.key)
  expect(view.network.mock.calls.map(([url]) => url)).toEqual([
    `${base}/orchestrator/api/decisions/canonical/claim`, `${base}${helperPath}`,
    `${base}/orchestrator/api/decisions/canonical/publish`, `${base}/orchestrator/api/decisions/canonical/claim`,
    `${base}${rankerPath}`, `${base}/orchestrator/api/decisions/canonical/score`,
  ])
  expect(view.prepare).not.toHaveBeenCalled()
  await expect(fetch('http://127.0.0.1:3082/unexpected')).rejects.toThrow('Unexpected network request')
  expect(unexpectedFetches.splice(0)).toEqual(['Unexpected network request: http://127.0.0.1:3082/unexpected'])
})
