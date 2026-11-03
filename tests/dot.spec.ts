import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { registerDot } from '../src/app/dot.ts'

// Mocked unit tests only: invoke the registered HTTP handler directly. No HTTP
// server, provider connection, real model inference, or recommendation evaluation.
type Handler = (req: IncomingMessage, res: ServerResponse) => unknown
const routes = [
  { provider: 'deepseek-official', model: 'deepseek-flash' },
  { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  { provider: 'openai-codex', model: 'gpt-6.1-sol' },
]
const projects = [{ id: 'project-web', title: 'Web', path: '/workspace/web' }]
const threads = [{ id: 'thread-tests', title: 'Tests', projectId: 'project-web', running: false, waiting: 1, updatedAt: 1_700_000_000_000 }]
const planRequest = { utterance: 'Plan the work', projects, threads }
const jevRequest = {
  question: 'Which approach?', context: 'A worker is choosing an implementation.',
  choices: [{ id: 'first', label: 'Rewrite everything' }, { id: 'second', label: 'Make a small patch', description: 'Reversible change' }],
}
const planReply = {
  reply: 'I can start the work and review the tests.',
  actions: [
    { type: 'start_thread', projectId: 'project-web', prompt: '  Implement the feature  ', why: 'New work' },
    { type: 'message_thread', sessionId: 'thread-tests', prompt: '  Add regression coverage  ', why: 'Existing context' },
    { type: 'open_thread', sessionId: 'thread-tests', why: 'Review progress' },
  ],
  jev_pick: -1, confidence: 0.91,
}
const jevReply = { pick: 'Make a small patch', confidence: 0.88, rationale: 'Prefer a reversible change.' }
const jevModelReply = { pick_id: 'second', confidence: jevReply.confidence, rationale: jevReply.rationale }

/** Actual provider-neutral chunk shapes, not a mocked complete()/plan() result. */
function textFixture(value: unknown, finish: Extract<StreamChunk, { type: 'finish' }> = { type: 'finish', reason: { kind: 'stop' } }): StreamChunk[] {
  return rawTextFixture(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, finish)
}

function rawTextFixture(text: string, finish: Extract<StreamChunk, { type: 'finish' }> = { type: 'finish', reason: { kind: 'stop' } }): StreamChunk[] {
  const middle = Math.floor(text.length / 2)
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: text.slice(0, middle) },
    { type: 'text-delta', index: 0, text: text.slice(middle) },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    finish,
  ]
}

function serve(chunks: StreamChunk[] = textFixture(planReply), unavailable = false, subsequent: StreamChunk[][] = []) {
  let handler: Handler | undefined
  const dispose = vi.fn()
  let streamIndex = 0
  const responses = [chunks, ...subsequent]
  const stream = vi.fn(async function* (_options: unknown) {
    yield* responses[Math.min(streamIndex++, responses.length - 1)]!
  })
  const prepareCall = vi.fn(async (_config: unknown, _signal: AbortSignal) => {
    if (unavailable) throw new Error('Mock route unavailable')
    return { config: { temperature: (_config as { temperature?: number }).temperature ?? 0 }, stream }
  })
  const register = vi.fn((route: { kind: string; path: string; handler: Handler }) => {
    handler = route.handler
    return dispose
  })
  const returnedDisposer = registerDot({ webServer: { port: 3082, register }, llm: { prepareCall } } as never)
  async function request(method: string, path: string, body?: unknown, headers: Record<string, string | undefined> = {}) {
    let status = 0, text = ''
    let responseHeaders: unknown
    const req = {
      method, url: `/dot/api/${path}`,
      headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1', origin: 'http://127.0.0.1:3082', ...headers },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
    }
    const res = {
      writeHead(code: number, sent: unknown) { status = code; responseHeaders = sent },
      end(data: string) { text = data },
    }
    if (!handler) throw new Error('Dot handler was not registered')
    await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
    return { status, body: JSON.parse(text) as Record<string, unknown>, headers: responseHeaders }
  }
  return { request, prepareCall, stream, register, dispose, returnedDisposer }
}

describe('registerDot HTTP handler (mocked LLM unit tests)', () => {
  it('plans valid project and thread actions from streamed text-delta JSON', async () => {
    const unit = serve()
    const result = await unit.request('POST', 'plan', planRequest)
    expect(result.status).toBe(200)
    expect(result.body).toEqual({
      reply: planReply.reply,
      actions: [
        { ...planReply.actions[0], prompt: 'Implement the feature' },
        { ...planReply.actions[1], prompt: 'Add regression coverage' },
        planReply.actions[2],
      ],
      jevPick: -1, confidence: 0.91, route: 'deepseek-official/deepseek-flash',
    })
    expect(unit.prepareCall).toHaveBeenCalledExactlyOnceWith({ ...routes[0], maxTokens: 2500 }, expect.any(AbortSignal))
    expect(unit.stream).toHaveBeenCalledOnce()
    expect(unit.stream.mock.calls[0]![0]).toMatchObject({
      temperature: 0, system: expect.stringContaining('Never invent project ids or thread ids'),
      messages: [expect.objectContaining({ content: [expect.objectContaining({ type: 'text', text: expect.stringContaining('project-web') })] })],
    })
  })

  it('rejects invented project/thread IDs rather than exposing actionable targets', async () => {
    const unit = serve(textFixture({ ...planReply, actions: [
      { type: 'start_thread', projectId: 'invented-project', prompt: 'Do work', why: '' },
      { type: 'message_thread', sessionId: 'invented-thread', prompt: 'Do work', why: '' },
      { type: 'open_thread', sessionId: 'invented-thread', why: '' },
    ], jev_pick: 0 }))
    expect(await unit.request('POST', 'plan', planRequest)).toMatchObject({ status: 200, body: { actions: [], jevPick: -1 } })
  })

  it('Jev resolves a stable ID to the canonical second label with no extra retry', async () => {
    const unit = serve(textFixture(jevModelReply))
    expect(await unit.request('POST', 'jev', jevRequest)).toEqual({
      status: 200, body: { ...jevReply, route: 'deepseek-official/deepseek-flash' },
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
    expect(unit.prepareCall).toHaveBeenCalledExactlyOnceWith({ ...routes[0], maxTokens: 1200, temperature: 0.2 }, expect.any(AbortSignal))
    expect(unit.stream).toHaveBeenCalledOnce()
    expect(unit.stream.mock.calls[0]![0]).toMatchObject({ temperature: 0.2, system: expect.stringContaining('pick_id') })
    const options = unit.stream.mock.calls[0]![0] as { messages: { content: { text: string }[] }[] }
    const input = options.messages.flatMap(message => message.content.map(block => block.text)).join('\n')
    // Choices must remain JSON records, not label-plus-description bullet strings.
    expect(JSON.parse(input)).toMatchObject({
      question: jevRequest.question, context: jevRequest.context, choices: jevRequest.choices,
    })
  })

  it.each(['Make a small patch', 'mAkE a SmAlL pAtCh'])('accepts a legacy exact label %s and returns its canonical spelling', async pick => {
    const unit = serve(textFixture({ ...jevReply, pick }))
    expect(await unit.request('POST', 'jev', jevRequest)).toMatchObject({ status: 200, body: jevReply })
    expect(unit.prepareCall).toHaveBeenCalledOnce()
  })

  it('corrects malformed JSON once with error detail and a schema reminder', async () => {
    const unit = serve(rawTextFixture('{"pick_id":'), false, [textFixture(jevModelReply)])
    expect(await unit.request('POST', 'jev', jevRequest)).toMatchObject({ status: 200, body: jevReply })
    expect(unit.prepareCall.mock.calls.map(([config]) => config)).toEqual([
      { ...routes[0], maxTokens: 1200, temperature: 0.2 }, { ...routes[0], maxTokens: 2000, temperature: 0.2 },
    ])
    expect(unit.stream).toHaveBeenCalledTimes(2)
    const retry = unit.stream.mock.calls[1]![0] as { system: string; messages: { content: { text: string }[] }[] }
    const retryInput = retry.messages.flatMap(message => message.content.map(block => block.text)).join('\n')
    const first = unit.stream.mock.calls[0]![0] as typeof retry
    const firstText = [first.system, ...first.messages.flatMap(message => message.content.map(block => block.text))].join('\n')
    const retryText = [retry.system, retryInput].join('\n')
    expect(retryText).not.toBe(firstText)
    expect(retryText).toMatch(/JSON/)
    expect(retryText).toMatch(/pick_id/)
    expect(retryText).toMatch(/confidence/)
    expect(retryText).toMatch(/rationale/)
    expect(retryText).toMatch(/error|invalid|failed|unexpected|unterminated|expected/i)
    expect(unit.stream.mock.calls[1]![0]).toMatchObject({ temperature: 0.2 })
  })

  const invalidReplies = [
    { name: 'missing JSON', chunks: rawTextFixture('I recommend a small patch.') },
    { name: 'empty stopped response', chunks: rawTextFixture('') },
    { name: 'blank stopped response', chunks: rawTextFixture('  \n  ') },
    { name: 'nonexistent ID', chunks: textFixture({ ...jevModelReply, pick_id: 'invented' }) },
    { name: 'nonexistent ID with a valid legacy label', chunks: textFixture({ ...jevModelReply, pick_id: 'invented', pick: jevReply.pick }) },
    { name: 'non-string ID', chunks: textFixture({ ...jevModelReply, pick_id: 2 }) },
    { name: 'label used as ID', chunks: textFixture({ ...jevModelReply, pick_id: jevReply.pick }) },
    { name: 'nonexistent legacy label', chunks: textFixture({ ...jevReply, pick: 'Invented option' }) },
    { name: 'label plus description', chunks: textFixture({ ...jevReply, pick: 'Make a small patch: Reversible change' }) },
    { name: 'missing pick', chunks: textFixture({ confidence: 0.8, rationale: 'Safe.' }) },
    { name: 'nonfinite confidence', chunks: rawTextFixture('{"pick_id":"second","confidence":1e309,"rationale":"Safe."}') },
    ...[-0.01, 1.01, '0.88', null, undefined].map(confidence => ({ name: `bad confidence ${String(confidence)}`, chunks: textFixture({ ...jevModelReply, confidence }) })),
    ...['', '   ', null, 123, undefined].map(rationale => ({ name: `bad rationale ${String(rationale)}`, chunks: textFixture({ ...jevModelReply, rationale }) })),
  ]

  it.each(invalidReplies)('retries $name output and accepts a corrected stable ID', async ({ chunks }) => {
    const unit = serve(chunks, false, [textFixture(jevModelReply)])
    expect(await unit.request('POST', 'jev', jevRequest)).toMatchObject({ status: 200, body: jevReply })
    expect(unit.prepareCall).toHaveBeenCalledTimes(2)
    expect(unit.stream).toHaveBeenCalledTimes(2)
  })

  it.each(invalidReplies)('returns 502 without a pick after exactly two $name outputs', async ({ chunks }) => {
    const unit = serve(chunks)
    const result = await unit.request('POST', 'jev', jevRequest)
    expect(result.status).toBe(502)
    expect(result.body.error).toEqual(expect.any(String))
    expect(result.body).not.toHaveProperty('pick')
    expect(unit.prepareCall.mock.calls.map(([config]) => config)).toEqual([
      { ...routes[0], maxTokens: 1200, temperature: 0.2 }, { ...routes[0], maxTokens: 2000, temperature: 0.2 },
    ])
    expect(unit.stream).toHaveBeenCalledTimes(2)
  })

  it.each([0, 1])('accepts confidence at the inclusive boundary %s', async confidence => {
    const unit = serve(textFixture({ ...jevModelReply, confidence }))
    expect(await unit.request('POST', 'jev', jevRequest)).toMatchObject({ status: 200, body: { ...jevReply, confidence } })
    expect(unit.prepareCall).toHaveBeenCalledOnce()
  })

  it.each([
    undefined, null, {}, [],
    [{ label: 'Missing ID' }], [{ id: '', label: 'Empty ID' }], [{ id: ' ', label: 'Blank ID' }],
    [{ id: 1, label: 'Numeric ID' }], [null], ['not a choice'],
    [{ id: 'only' }], [{ id: 'only', label: '' }], [{ id: 'only', label: 2 }],
    [{ id: 'same', label: 'One' }, { id: 'same', label: 'Two' }],
    [{ id: 'one', label: 'Same' }, { id: 'two', label: 'Same' }],
    [{ id: 'one', label: 'Same' }, { id: 'two', label: 'sAmE' }],
  ].map(choices => ({ choices })))('rejects malformed or ambiguous choice input without any LLM calls: $choices', async ({ choices }) => {
    const unit = serve(textFixture(jevModelReply))
    const result = await unit.request('POST', 'jev', { ...jevRequest, choices })
    expect(result.status).toBe(400)
    expect(result.body.error).toEqual(expect.any(String))
    expect(result.body).not.toHaveProperty('pick')
    expect(unit.prepareCall).not.toHaveBeenCalled()
    expect(unit.stream).not.toHaveBeenCalled()
  })

  it('retries a length terminal even when its JSON is parseable', async () => {
    const unit = serve(textFixture(jevModelReply, { type: 'finish', reason: { kind: 'max-tokens' } }), false, [textFixture(jevModelReply)])
    expect(await unit.request('POST', 'jev', jevRequest)).toMatchObject({ status: 200, body: jevReply })
    expect(unit.prepareCall.mock.calls.map(([config]) => config)).toEqual([
      { ...routes[0], maxTokens: 1200, temperature: 0.2 }, { ...routes[0], maxTokens: 2000, temperature: 0.2 },
    ])
    expect(unit.stream).toHaveBeenCalledTimes(2)
  })

  it('retains route fallback within each Jev semantic attempt', async () => {
    const unit = serve(rawTextFixture('not JSON'), false, [textFixture(jevModelReply)])
    unit.prepareCall.mockRejectedValueOnce(new Error('First route unavailable'))
    expect(await unit.request('POST', 'jev', jevRequest)).toMatchObject({
      status: 200, body: { ...jevReply, route: 'deepseek-official/deepseek-flash' },
    })
    expect(unit.prepareCall.mock.calls.map(([config]) => config)).toEqual([
      { ...routes[0], maxTokens: 1200, temperature: 0.2 }, { ...routes[1], maxTokens: 1200, temperature: 0.2 },
      { ...routes[0], maxTokens: 2000, temperature: 0.2 },
    ])
    expect(unit.stream).toHaveBeenCalledTimes(2)
  })

  it('retains plan route fallback and its 2500-token budget', async () => {
    const unit = serve()
    unit.prepareCall.mockRejectedValueOnce(new Error('First route unavailable'))
    expect(await unit.request('POST', 'plan', planRequest)).toMatchObject({
      status: 200, body: { reply: planReply.reply, route: 'anthropic/claude-sonnet-5-5' },
    })
    expect(unit.prepareCall.mock.calls.map(([config]) => config)).toEqual([
      { ...routes[0], maxTokens: 2500 }, { ...routes[1], maxTokens: 2500 },
    ])
    expect(unit.stream).toHaveBeenCalledOnce()
  })

  it('rejects two length terminals without exposing even a parseable pick', async () => {
    const unit = serve(textFixture(jevModelReply, { type: 'finish', reason: { kind: 'max-tokens' } }))
    const result = await unit.request('POST', 'jev', jevRequest)
    expect(result.status).toBe(502)
    expect(result.body).not.toHaveProperty('pick')
    expect(unit.prepareCall).toHaveBeenCalledTimes(2)
    expect(unit.stream).toHaveBeenCalledTimes(2)
  })

  it.each(['plan', 'jev'])('never substitutes a heuristic when every %s model route is unavailable', async endpoint => {
    const unit = serve([], true)
    const result = await unit.request('POST', endpoint, endpoint === 'plan' ? planRequest : jevRequest)
    expect(result.status).toBe(502)
    expect(result.body).toEqual({ error: expect.stringContaining('No model route answered') })
    expect(unit.prepareCall.mock.calls.map(([config]) => config)).toEqual(endpoint === 'plan'
      ? routes.map(route => ({ ...route, maxTokens: 2500 }))
      : [1200, 2000].flatMap(maxTokens => routes.map(route => ({ ...route, maxTokens, temperature: 0.2 }))))
    for (const route of routes) expect(result.body.error).toContain(`${route.provider}/${route.model}`)
    expect(unit.stream).not.toHaveBeenCalled()
  })

  for (const endpoint of ['plan', 'jev']) {
    it.each(['error', 'aborted'] as const)(`rejects ${endpoint} JSON emitted before a failed %s terminal`, async kind => {
      // Even parseable JSON is only partial/uncommitted output until the stream
      // succeeds. A finish failure must invalidate it and try the other routes.
      const finish: Extract<StreamChunk, { type: 'finish' }> = {
        type: 'finish', reason: { kind, failure: { code: 'MOCK_STREAM_FAILURE', message: 'Mock failure after JSON' } },
      }
      const unit = serve(textFixture(endpoint === 'plan' ? planReply : jevModelReply, finish))
      const result = await unit.request('POST', endpoint, endpoint === 'plan' ? planRequest : jevRequest)
      expect(result.status).toBe(502)
      expect(result.body).toEqual({ error: expect.stringContaining('No model route answered') })
      expect(unit.prepareCall).toHaveBeenCalledTimes(routes.length * (endpoint === 'jev' ? 2 : 1))
      expect(unit.stream).toHaveBeenCalledTimes(routes.length * (endpoint === 'jev' ? 2 : 1))
    })
  }

  it.each([
    { origin: 'https://evil.example' },
    { host: 'evil.example:3082' },
    { host: '127.0.0.1:9999' },
    { 'x-orchestrator-request': undefined },
  ])('denies a non-same-origin request before invoking the model: %j', async headers => {
    const unit = serve()
    const result = await unit.request('POST', 'plan', planRequest, headers)
    expect(result).toMatchObject({ status: 403, body: { error: 'Same-origin request required' } })
    expect(unit.prepareCall).not.toHaveBeenCalled()
  })

  it('reports health and configured routes without preparing an LLM call', async () => {
    const unit = serve([], true)
    expect(await unit.request('GET', 'health')).toEqual({
      status: 200, body: { ok: true, routes },
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
    expect(unit.prepareCall).not.toHaveBeenCalled()
  })

  it('mounts the Dot prefix and returns the web server registration disposer', () => {
    const unit = serve()
    expect(unit.register).toHaveBeenCalledExactlyOnceWith({ kind: 'prefix', path: '/dot', handler: expect.any(Function) })
    expect(unit.returnedDisposer).toBe(unit.dispose)
    unit.returnedDisposer()
    expect(unit.dispose).toHaveBeenCalledOnce()
  })
})
