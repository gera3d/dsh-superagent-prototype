/**
 * Composio failure handling at the host boundary: a real DSH ToolRuntime runs mocked `mcp__composio__*` tools through its
 * actual execute pipeline with the listener this plugin installs, and the plugin's own Session decoration is checked for
 * installing it. No network, account or connection is used.
 */
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assessComposioResult, composioFeedback, installComposioBoundary, isComposioTool, retryAfterSeconds, sanitizeDiagnostic } from '../src/app/composio-boundary.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const MULTI = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL'
const SINGLE = 'mcp__composio__GITHUB_CREATE_ISSUE'
type Outcome = { value?: unknown; throws?: Error }

/** A ToolRuntime with the Composio listener, and the named tools answering from `outcomes` as an MCP client would. */
async function runtimeWith(outcomes: Record<string, Outcome>) {
  const ctx = new Context()
  ctx.reflect.provide('systemPrompt', { section: () => () => {}, tools: () => () => {} })
  ctx.plugin(ToolRuntime as never, {} as never)
  await new Promise(resolve => setTimeout(resolve, 10))
  const tools = (ctx as unknown as { tools: ToolRuntime }).tools
  const calls: string[] = []
  for (const name of Object.keys(outcomes)) {
    tools.register({ name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: true },
      output: { schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => (value as { content?: unknown[] }).content ?? [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async () => { calls.push(name); const outcome = outcomes[name]!; if (outcome.throws) throw outcome.throws; return outcome.value } } as never)
  }
  installComposioBoundary({ ctx })
  const run = (name: string) => tools.execute({ callId: `call-${calls.length}`, name, arguments: {}, signal: new AbortController().signal } as never)
  return { run, calls }
}
const mcp = (payload: unknown, extra: Record<string, unknown> = {}) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false, ...extra })
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map(block => block.text ?? '').join('\n')
const failure = (result: { content: { type: string; text?: string }[] }) => JSON.parse(textOf(result).split('\n').slice(1).join('\n')).composio_failure

const read = { index: 0, tool_slug: 'GMAIL_FETCH_EMAILS', response: { successful: true, data: { messages: [{ id: 'm1', subject: 'unauthorized access report' }] } } }
const write = (error: unknown, index = 1) => ({ index, tool_slug: 'GITHUB_CREATE_ISSUE', response: { successful: false, data: null, error } })
const batch = (...results: unknown[]) => ({ successful: true, data: { results, total_count: results.length,
  success_count: results.filter(item => (item as { response: { successful: boolean } }).response.successful).length,
  error_count: results.filter(item => !(item as { response: { successful: boolean } }).response.successful).length } })

describe('host boundary with a real ToolRuntime', () => {
  it('turns a nested successful:false of a single action into an error that names the recovery', async () => {
    const { run } = await runtimeWith({ [SINGLE]: { value: mcp({ successful: false, data: null, error: 'Validation failed: title is required' }) } })
    const result = await run(SINGLE)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Composio call failed: the action reported a failure')
    expect(failure(result)).toMatchObject({ classification: 'action_failed', completion: 'failed', failed: [{ error: 'Validation failed: title is required' }] })
  })

  it('keeps the successful entries of a mixed batch and marks the batch partially failed', async () => {
    const { run } = await runtimeWith({ [MULTI]: { value: mcp(batch(read, write('Validation failed: title is required'))) } })
    const result = await run(MULTI)
    expect(result.isError).toBe(true)
    const found = failure(result)
    expect(found).toMatchObject({ classification: 'action_failed', completion: 'partial', counts: { total: 2, succeeded: 1, failed: 1, unreported: 0 } })
    expect(found.succeeded).toEqual([read])
    expect(found.failed).toEqual([{ index: 1, tool_slug: 'GITHUB_CREATE_ISSUE', kind: 'action_failed', error: 'Validation failed: title is required' }])
    expect(found.recovery.join(' ')).toContain('never repeat them')
  })

  it('reads a batch from structuredContent too', async () => {
    const { run } = await runtimeWith({ [MULTI]: { value: { content: [{ type: 'text', text: 'done' }], structuredContent: batch(read, write('Validation failed')) } } })
    expect(failure(await run(MULTI))).toMatchObject({ completion: 'partial', succeeded: [read] })
  })

  it('classifies a rate limit with its Retry-After and says to retry only the failed entries once', async () => {
    const limited = { index: 1, tool_slug: 'SLACK_SEND_MESSAGE', response: { successful: false, error: { message: 'Rate limit exceeded', retry_after: 30 } } }
    const { run, calls } = await runtimeWith({ [MULTI]: { value: mcp(batch(read, limited)) } })
    const found = failure(await run(MULTI))
    expect(found).toMatchObject({ classification: 'rate_limited', completion: 'partial', retry_after_seconds: 30, succeeded: [read] })
    expect(found.recovery.join(' ')).toContain('at least 30 seconds')
    expect(calls).toEqual([MULTI])
  })

  it('reads Retry-After from the message and from headers, in seconds or milliseconds, and keeps the longest', () => {
    expect(retryAfterSeconds('Too many requests. Retry-After: 12')).toBe(12)
    expect(retryAfterSeconds({ headers: { 'Retry-After': '7' } })).toBe(7)
    expect(retryAfterSeconds({ retryAfterMs: 1500 })).toBe(2)
    expect(retryAfterSeconds({ retry_after: 5 }, 'try again in 20 seconds')).toBe(20)
    expect(retryAfterSeconds('no hint here')).toBeUndefined()
  })

  it('routes an auth or connection failure to a no-retry, no-self-reconnect instruction', async () => {
    const { run } = await runtimeWith({ [MULTI]: { value: mcp(batch(read, write('No active connection found for toolkit github'))) } })
    const result = await run(MULTI)
    const found = failure(result)
    expect(found).toMatchObject({ classification: 'connection_required', completion: 'partial', succeeded: [read] })
    expect(found.recovery[0]).toMatch(/Do not retry and do not reconnect or re-authorize yourself/)
    expect(textOf(result)).toContain('a connection or authorization is missing or expired')
  })

  it('treats a thrown MCP timeout as an unknown outcome and forbids resending the action', async () => {
    const { run, calls } = await runtimeWith({ [SINGLE]: { throws: new Error('MCP error -32001: Request timed out') } })
    const result = await run(SINGLE)
    expect(result.isError).toBe(true)
    expect(failure(result)).toMatchObject({ classification: 'uncertain_completion', completion: 'unknown' })
    expect(failure(result).recovery[0]).toMatch(/do NOT resend it/)
    expect(calls).toEqual([SINGLE])
  })

  it('treats a timed-out entry in a batch as unknown, ahead of other kinds, while keeping what succeeded', async () => {
    const { run } = await runtimeWith({ [MULTI]: { value: mcp(batch(read, write('Validation failed', 1), write('Upstream gateway timeout (504); no response received', 2))) } })
    const found = failure(await run(MULTI))
    expect(found).toMatchObject({ classification: 'uncertain_completion', completion: 'partial', counts: { succeeded: 1, failed: 2 }, succeeded: [read] })
    expect(found.recovery.join(' ')).toContain('do NOT resend it')
  })

  it('counts entries the service never reported as unknown', async () => {
    const payload = { successful: true, data: { results: [read], total_count: 3, success_count: 1, error_count: 0 } }
    const { run } = await runtimeWith({ [MULTI]: { value: mcp(payload) } })
    const found = failure(await run(MULTI))
    expect(found).toMatchObject({ classification: 'uncertain_completion', completion: 'partial', counts: { total: 3, succeeded: 1, failed: 0, unreported: 2 } })
  })

  it('keeps a transport failure the MCP client itself marked as an error, with sanitized diagnostics', async () => {
    const raw = 'Composio MCP returned 500 for https://user:hunter2@backend.composio.dev/v3 Authorization: Bearer abcdef0123456789abcdef api_key=sk-live-aaaaaaaaaaaaaaaaaaaaaaaa'
    const { run } = await runtimeWith({ [SINGLE]: { value: { content: [{ type: 'text', text: raw }], isError: true } } })
    const result = await run(SINGLE)
    expect(result.isError).toBe(true) // An MCP error envelope returned as a tool value keeps its error flag.
    expect(textOf(result)).not.toMatch(/hunter2|abcdef0123456789|sk-live/)
    const flagged = await runtimeWith({ [SINGLE]: { throws: new Error(raw) } })
    const failed = await flagged.run(SINGLE)
    expect(failed.isError).toBe(true)
    const text = textOf(failed)
    expect(text).not.toMatch(/hunter2|abcdef0123456789|sk-live/)
    expect(text).toContain('[redacted]')
    expect(failure(failed)).toMatchObject({ completion: 'unknown' })
  })

  it('does not take business data for a failure: a successful payload with failure-like words, or with an error field and no envelope', async () => {
    const success = mcp({ successful: true, data: { note: 'The user was unauthorized; authentication failed on the old host', error: 'none of the above' } })
    const { run } = await runtimeWith({ [SINGLE]: { value: success }, [MULTI]: { value: mcp(batch(read)) } })
    const single = await run(SINGLE)
    expect(single.isError).toBe(false)
    expect(textOf(single)).toContain('authentication failed on the old host')
    const multi = await run(MULTI)
    expect(multi.isError).toBe(false)
    expect(JSON.parse(textOf(multi))).toEqual(batch(read))
    // Business data lives under `data`; an `error` inside it, a null/empty root error, or an explicit success is not a failure report.
    for (const payload of [
      { data: { error: 'invalid token in the document body' } },
      { successful: true, data: { error: 'invalid token in the document body' } },
      { successful: true, error: 'a note the service attached to a success', data: {} },
      { successful: true, data: { id: 'x' }, error: null },
      { data: { id: 'x' }, error: '' },
      { data: { id: 'x' }, error: false },
    ]) {
      const bare = await runtimeWith({ [SINGLE]: { value: mcp(payload) } })
      expect((await bare.run(SINGLE)).isError, JSON.stringify(payload)).toBe(false)
    }
  })

  it('takes a root error without the successful flag for the service\'s own failure report, in the content and in structuredContent', async () => {
    const message = 'Validation failed: title is required'
    for (const value of [
      mcp({ data: {}, error: message }),
      mcp({ error: { message, code: 'VALIDATION' } }),
      mcp({ response: { error: message } }),
      { content: [{ type: 'text', text: 'see structured content' }], structuredContent: { data: null, error: message }, isError: false },
    ]) {
      const { run } = await runtimeWith({ [SINGLE]: { value } })
      const result = await run(SINGLE)
      expect(result.isError, JSON.stringify(value)).toBe(true)
      expect(failure(result)).toMatchObject({ classification: 'action_failed', completion: 'failed', failed: [{ error: expect.stringContaining('Validation failed') }] })
    }
    // Its connection and rate-limit wording still classify it.
    const auth = await runtimeWith({ [SINGLE]: { value: mcp({ error: 'No active connection found for github' }) } })
    expect(failure(await auth.run(SINGLE))).toMatchObject({ classification: 'connection_required' })
    const limited = await runtimeWith({ [SINGLE]: { value: mcp({ error: '429 rate limit exceeded, retry after 12 seconds' }) } })
    expect(failure(await limited.run(SINGLE))).toMatchObject({ classification: 'rate_limited', retry_after_seconds: 12 })
  })

  it('keeps the prior successes of a Session intact when a later Composio call fails, and keeps a batch\'s own successes', async () => {
    const { run, calls } = await runtimeWith({ [SINGLE]: { value: mcp({ successful: true, data: { id: 'issue_1' } }) }, [MULTI]: { value: mcp({ data: { results: [read, write('Validation failed')], total_count: 2 }, error: 'one entry failed' }) } })
    const first = await run(SINGLE)
    expect(first.isError).toBe(false)
    const failed = await run(MULTI)
    expect(failed.isError).toBe(true)
    expect(failure(failed)).toMatchObject({ completion: 'partial', counts: { succeeded: 1, failed: 1 } })
    expect(failure(failed).succeeded).toEqual([read])
    // The earlier success was not re-run, rewritten or reclassified by the later failure.
    expect(JSON.parse(textOf(first))).toEqual({ successful: true, data: { id: 'issue_1' } })
    expect(calls).toEqual([SINGLE, MULTI])
    expect((await run(SINGLE)).isError).toBe(false)
  })

  it('leaves an unrecognised payload, plain text and non-Composio tools untouched', async () => {
    const { run } = await runtimeWith({ [SINGLE]: { value: mcp('plain words, timeout, unauthorized') }, 'mcp__chrome__navigate': { value: mcp({ successful: false, error: 'blocked' }) },
      bash: { value: mcp({ successful: false, error: 'No active connection' }) } })
    expect((await run(SINGLE)).isError).toBe(false)
    const chrome = await run('mcp__chrome__navigate')
    expect(chrome.isError).toBe(false)
    expect(JSON.parse(textOf(chrome))).toEqual({ successful: false, error: 'blocked' })
    expect((await run('bash')).isError).toBe(false)
  })

  it('classifies a failed tool call that threw, by its own message', async () => {
    const { run } = await runtimeWith({ [SINGLE]: { throws: new Error('boom') } })
    const result = await run(SINGLE)
    expect(result.isError).toBe(true)
    expect(failure(result)).toMatchObject({ completion: 'unknown' })
  })
})

describe('classification details', () => {
  it('matches Composio tools by provenance only', () => {
    expect(isComposioTool('mcp__composio__COMPOSIO_SEARCH_TOOLS')).toBe(true)
    for (const name of ['mcp__rube-composio__X', 'mcp__notcomposio__x', 'mcp__composio', 'bash', 'mcp__chrome__navigate', 'composio_search', 'mcp__github__create_issue']) expect(isComposioTool(name)).toBe(false)
  })

  it('returns nothing for successes and for other tools', () => {
    expect(assessComposioResult(SINGLE, { content: [{ type: 'text', text: JSON.stringify({ successful: true, data: {} }) }] })).toBeUndefined()
    expect(assessComposioResult('bash', { content: [{ type: 'text', text: JSON.stringify({ successful: false }) }] })).toBeUndefined()
  })

  it('redacts credentials, headers, tokens and URL userinfo but keeps the diagnostic readable', () => {
    const clean = sanitizeDiagnostic('POST /v3/execute failed: 401 Unauthorized. Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123 client_secret=s3cr3tvalue {"access_token":"tok_abcdef123456"} cookie: sid=abc123')
    expect(clean).toContain('POST /v3/execute failed: 401 Unauthorized')
    expect(clean).not.toMatch(/ghp_abc|s3cr3tvalue|tok_abcdef|sid=abc123/)
  })

  it('keeps every entry accounted for: explicit successes, explicit failures, and entries of unknown outcome', () => {
    const run = (payload: unknown) => assessComposioResult(MULTI, { content: [{ type: 'text', text: JSON.stringify(payload) }] })
    const good = { index: 0, response: { successful: true, data: { id: 'kept' } } }
    expect(run({ successful: false, data: { results: [good, { index: 1, response: { successful: false, error: 'bad input' } }] } })?.succeeded).toEqual([good])
    const empty = run({ successful: false, data: { total_count: 2, results: [{ index: 0, tool_slug: 'GITHUB_CREATE_ISSUE', response: {} }, { index: 1, response: { successful: false, error: 'bad input' } }] } })!
    expect(empty.succeeded).toEqual([])
    expect(empty.kinds).toContain('uncertain_completion')
    expect(empty.counts.unreported).toBe(1)
    const malformed = run({ successful: false, data: { total_count: 2, results: [null, { index: 1, response: { successful: false, error: 'bad input' } }] } })!
    expect(malformed.counts.unreported).toBe(1)
    expect(malformed.unconfirmed).toEqual([{ index: 0, reason: 'malformed' }])
    expect(malformed.kinds).toContain('uncertain_completion')
    // A counted-but-missing entry and a malformed one are both unknown, and neither is dropped from the accounting.
    expect(run({ successful: false, data: { total_count: 3, results: [null, good] } })!.counts).toMatchObject({ succeeded: 1, unreported: 2 })
    // The service's own top-level failure is not lost behind unconfirmed entries.
    expect(run({ successful: false, error: 'Validation failed', data: { results: [{ index: 0, response: {} }] } })!.failed[0]).toMatchObject({ kind: 'action_failed' })
  })

  it('does not hold search or listing results, which are not execution batches, to the success flag', () => {
    const search = { successful: true, data: { results: [{ primary_tool_slugs: ['GMAIL_FETCH_EMAILS'], toolkits: ['gmail'] }, 'free text'] } }
    expect(assessComposioResult('mcp__composio__COMPOSIO_SEARCH_TOOLS', { content: [{ type: 'text', text: JSON.stringify(search) }] })).toBeUndefined()
  })

  it('lets a timeout or lost acknowledgement outrank a rate-limit word, and keeps Retry-After only as a wait floor', () => {
    const lost = assessComposioResult(MULTI, { content: [{ type: 'text', text: JSON.stringify({ successful: false, error: '429 upstream rate limit; request timed out after sending; acknowledgement lost; Retry-After: 20' }) }] })!
    expect(lost).toMatchObject({ kind: 'uncertain_completion', completion: 'unknown', retryAfterSeconds: 20 })
    const feedback = composioFeedback(lost)
    expect(feedback).not.toMatch(/did not run|rejected it/)
    expect(feedback).toContain('not before 20 seconds')
    const plain = assessComposioResult(MULTI, { content: [{ type: 'text', text: JSON.stringify({ successful: false, error: '429 upstream rate limit; Retry-After: 20' }) }] })!
    expect(plain).toMatchObject({ kind: 'rate_limited', completion: 'failed', retryAfterSeconds: 20 })
  })

  it('states the classification, completion and one recovery per kind in the feedback', () => {
    const assessment = assessComposioResult(MULTI, { content: [{ type: 'text', text: JSON.stringify(batch(read, write('No active connection'))) }] })!
    const text = composioFeedback(assessment)
    expect(text.split('\n')[0]).toBe('Composio batch partially failed: 1 succeeded, 1 failed; a connection or authorization is missing or expired.')
    expect(JSON.parse(text.split('\n')[1]!).composio_failure.recovery).toHaveLength(2)
  })
})

describe('Session wiring', () => {
  let h: Host
  beforeEach(async () => { h = await startRuntime() })
  afterEach(async () => { await h.stop() })
  const decide = (sessionId: string, name: string, payload: unknown) => ((h.agents.get(sessionId) as unknown as { ctx: { waterfall: (...args: unknown[]) => Promise<unknown> } }).ctx).waterfall('tools/post-execute',
    { name, callId: 'c1', arguments: {} }, { isError: false, value: mcp(payload), content: mcp(payload).content }, async () => ({ kind: 'accept' }))

  it('classifies a Composio failure nested in a success for a worker and for the main Session, and ignores other tools', async () => {
    const { sessionId } = await h.acceptedTicket((await import('./fixtures/host.ts')).feishu('1', '@bot 修一下回归'))
    for (const id of [sessionId, h.runtime.masterId]) {
      expect(await decide(id, MULTI, batch(read, write('Validation failed')))).toMatchObject({ kind: 'block', feedback: [{ type: 'text', text: expect.stringContaining('partially failed') }] })
      expect(await decide(id, MULTI, batch(read))).toEqual({ kind: 'accept' })
      expect(await decide(id, 'bash', { successful: false, error: 'x' })).toEqual({ kind: 'accept' })
    }
  })

  it('does not widen the worker or main tool allowlists', async () => {
    const { sessionId } = await h.acceptedTicket((await import('./fixtures/host.ts')).feishu('1', '@bot 修一下回归'))
    const registered = [...h.tools.get(sessionId)!.keys(), ...h.tools.get(h.runtime.masterId)!.keys()]
    expect(registered.filter(name => /^mcp__/i.test(name) || /composio/i.test(name))).toEqual([])
  })
})

describe('ordinary Session binding', () => {
  let h: Host
  beforeEach(async () => { h = await startRuntime() })
  afterEach(async () => { await h.stop() })
  type Fake = { id: string; ctx: Context & { waterfall: (...args: unknown[]) => Promise<unknown>; tools: { restrict: ReturnType<typeof vi.fn>; guard: ReturnType<typeof vi.fn> }; systemPrompt: { section: ReturnType<typeof vi.fn> } }; session: { header?: object } }
  const created = (agent: Fake) => (h.runtime as unknown as { ctx: { parallel: (name: string, value: unknown) => Promise<void> } }).ctx.parallel('agent/created', { agent })
  const disposed = (agent: Fake) => (h.runtime as unknown as { ctx: { parallel: (name: string, value: unknown) => Promise<void> } }).ctx.parallel('agent/disposed', { agent })
  const post = (agent: Fake, payload: unknown) => agent.ctx.waterfall('tools/post-execute', { name: MULTI, callId: 'c1', arguments: {} },
    { isError: false, value: mcp(payload), content: mcp(payload).content }, async () => ({ kind: 'accept' }))
  async function ordinary(id = 'ordinary') {
    await (h.controller.create as (options: { sessionId: string }) => Promise<void>)({ sessionId: id })
    const agent = h.agents.get(id) as unknown as Fake
    agent.session.header = {}
    agent.ctx.systemPrompt.section = vi.fn(() => () => {})
    const events: string[] = []
    const on = agent.ctx.on.bind(agent.ctx)
    vi.spyOn(agent.ctx, 'on').mockImplementation(((name: string, ...rest: unknown[]) => { events.push(name); return (on as (...args: unknown[]) => () => void)(name, ...rest) }) as never)
    return { agent, events }
  }

  it('adds only the read-only post-execute listener to an ordinary Session: no prompt, routing, restriction or guard', async () => {
    const { agent, events } = await ordinary()
    await created(agent)
    expect(events).toEqual(['tools/post-execute'])
    expect(agent.ctx.systemPrompt.section).not.toHaveBeenCalled()
    expect(agent.ctx.tools.restrict).not.toHaveBeenCalled()
    expect(agent.ctx.tools.guard).not.toHaveBeenCalled()
    // Selecting a route installs the one request hook of the selection itself and, on a managed Session, a routing guard after it:
    // a person's own chat gets no guard (a managed worker, the control, gets both).
    await h.runtime.sessions.selectModel(agent as never, { provider: 'x', model: 'y' } as never)
    expect(events.filter(name => name === 'agent/request')).toHaveLength(1)
    const { sessionId } = await h.acceptedTicket((await import('./fixtures/host.ts')).feishu('1', '@bot 修一下回归'))
    const worker = h.agents.get(sessionId) as unknown as Fake, seen: string[] = []
    const on = worker.ctx.on.bind(worker.ctx)
    vi.spyOn(worker.ctx, 'on').mockImplementation(((name: string, ...rest: unknown[]) => { seen.push(name); return (on as (...args: unknown[]) => () => void)(name, ...rest) }) as never)
    await h.runtime.sessions.selectModel(worker as never, { provider: 'x', model: 'y' } as never)
    expect(seen.filter(name => name === 'agent/request')).toHaveLength(2)
    expect(await post(agent, batch(read, write('bad input')))).toMatchObject({ kind: 'block' })
  })

  it('is idempotent for repeated creation, and a second creation never rebinds an already bound Session', async () => {
    const { agent, events } = await ordinary()
    await created(agent); await created(agent); await created(agent)
    expect(events.filter(name => name === 'tools/post-execute')).toEqual(['tools/post-execute'])
    const { sessionId } = await h.acceptedTicket((await import('./fixtures/host.ts')).feishu('1', '@bot 修一下回归'))
    for (const id of [sessionId, h.runtime.masterId]) {
      const bound = h.agents.get(id) as unknown as Fake
      const seen: string[] = []
      const on = bound.ctx.on.bind(bound.ctx)
      vi.spyOn(bound.ctx, 'on').mockImplementation(((name: string, ...rest: unknown[]) => { seen.push(name); return (on as (...args: unknown[]) => () => void)(name, ...rest) }) as never)
      await created(bound)
      expect(seen, id).toEqual([])
    }
  })

  it('releases its listener when the agent is disposed, and a later disposal is harmless', async () => {
    const { agent } = await ordinary()
    await created(agent)
    expect(await post(agent, batch(read, write('bad input')))).toMatchObject({ kind: 'block' })
    await disposed(agent)
    expect(await post(agent, batch(read, write('bad input')))).toEqual({ kind: 'accept' })
    await disposed(agent)
    // A recreated Session of the same id is bound afresh.
    await created(agent)
    expect(await post(agent, batch(read, write('bad input')))).toMatchObject({ kind: 'block' })
  })
})

afterEach(() => { vi.restoreAllMocks() })

describe('batch and single envelopes follow one rule', () => {
  const note = (index: number, extra: Record<string, unknown>) => ({ index, tool_slug: 'GITHUB_CREATE_ISSUE', ...extra })
  const declared = (...results: unknown[]) => ({ successful: true, data: { results, total_count: results.length, success_count: results.length, error_count: 0 } })
  /** Entries that completed, each carrying an `error` note of a different shape; an explicit `successful: true` outranks the note. */
  const completed = [
    note(0, { response: { successful: true, data: { id: 'kept-0' }, error: 'deprecated field ignored' } }),
    note(1, { response: { successful: true, data: { id: 'kept-1' }, error: {} } }),
    note(2, { successful: true, data: { id: 'kept-2' }, error: { message: 'label was created instead of reused' } }),
    note(3, { successful: true, response: { data: { id: 'kept-3' }, error: 'a warning' } }),
  ]

  it('keeps an entry that explicitly succeeded although it carries an error note, in an all-successful batch and in a mixed one', async () => {
    const clean = await runtimeWith({ [MULTI]: { value: mcp(declared(...completed)) } })
    const ok = await clean.run(MULTI)
    expect(ok.isError).toBe(false)
    expect(JSON.parse(textOf(ok))).toEqual(declared(...completed))
    const mixed = await runtimeWith({ [MULTI]: { value: mcp({ successful: true, data: { results: [...completed, write('Validation failed', 4)], total_count: 5, success_count: 4, error_count: 1 } }) } })
    const found = failure(await mixed.run(MULTI))
    expect(found).toMatchObject({ classification: 'action_failed', completion: 'partial', counts: { total: 5, succeeded: 4, failed: 1, unreported: 0 } })
    expect(found.succeeded).toEqual(completed)
    expect(found.failed).toEqual([{ index: 4, tool_slug: 'GITHUB_CREATE_ISSUE', kind: 'action_failed', error: 'Validation failed' }])
    expect(found.recovery.join(' ')).not.toMatch(/entry 0|entry 1|entry 2|entry 3/)
  })

  it('treats the same envelope the same whether it is a single action or a batch entry', async () => {
    const shapes: [string, Record<string, unknown>, boolean][] = [
      ['success with an error note', { successful: true, data: { id: 'x' }, error: 'a note' }, false],
      ['success with an empty error object', { successful: true, data: { id: 'x' }, error: {} }, false],
      ['no flag and no error', { data: { id: 'x' } }, false],
      ['error only (string)', { data: {}, error: 'Validation failed: title is required' }, true],
      ['error only (object)', { error: { message: 'Validation failed', code: 'VALIDATION' } }, true],
      ['explicit failure', { successful: false, data: null, error: 'Validation failed' }, true],
    ]
    for (const [label, envelope, fails] of shapes) {
      const single = await runtimeWith({ [SINGLE]: { value: mcp(envelope) } })
      expect((await single.run(SINGLE)).isError, `single: ${label}`).toBe(fails)
      // As a batch entry, flat or under `response`; a good entry beside it is always kept.
      for (const entry of [note(1, envelope), note(1, { response: envelope })]) {
        const { run } = await runtimeWith({ [MULTI]: { value: mcp(declared(read, entry)) } })
        const result = await run(MULTI)
        if (fails) {
          const found = failure(result)
          expect(found, `batch: ${label}`).toMatchObject({ completion: 'partial', counts: { succeeded: 1, failed: 1 }, succeeded: [read] })
        } else if (label === 'no flag and no error') {
          // An execution batch entry that never says it completed is unknown, not a success and not lost.
          expect(failure(result), `batch: ${label}`).toMatchObject({ completion: 'partial', succeeded: [read], unconfirmed: [{ index: 1, reason: 'no_completion_evidence' }] })
        } else {
          expect(result.isError, `batch: ${label}`).toBe(false)
        }
      }
    }
  })

  it('does not call a business `error` inside an entry\'s data a failure', async () => {
    const entry = note(1, { response: { successful: true, data: { error: 'invalid token in the document body', note: 'unauthorized' } } })
    const { run } = await runtimeWith({ [MULTI]: { value: mcp(declared(read, entry)) } })
    expect((await run(MULTI)).isError).toBe(false)
  })

  it('keeps an entry whose success and failure flags contradict each other as unknown: not a success, not a retry candidate', async () => {
    for (const entry of [
      note(1, { successful: true, response: { successful: false, error: 'Validation failed' } }),
      note(1, { successful: false, response: { successful: true, data: { id: 'maybe' } } }),
    ]) {
      const { run, calls } = await runtimeWith({ [MULTI]: { value: mcp(declared(read, entry)) } })
      const found = failure(await run(MULTI))
      expect(found).toMatchObject({ classification: 'uncertain_completion', completion: 'partial', counts: { succeeded: 1, failed: 0, unreported: 1 },
        succeeded: [read], unconfirmed: [{ index: 1, tool_slug: 'GITHUB_CREATE_ISSUE', reason: 'contradictory_flags' }] })
      expect(found.recovery.join(' ')).toMatch(/do NOT resend it/)
      expect(found.recovery.join(' ')).not.toMatch(/then retry|retry entry|retry it once/i)
      expect(calls).toEqual([MULTI])
    }
    // The same contradiction in a single envelope: the action may have run.
    const single = await runtimeWith({ [SINGLE]: { value: mcp({ successful: true, response: { successful: false, error: 'Validation failed' } }) } })
    expect(failure(await single.run(SINGLE))).toMatchObject({ classification: 'uncertain_completion', completion: 'unknown' })
  })

  describe('contradictory flags stay unknown whatever the outer error flag says', () => {
    const limited = { successful: true, response: { successful: false, error: '429 rate limit exceeded; Retry-After: 30' } }
    const contradictory = [
      ['a thrown MCP error (the bridge throws a raw isError result)', () => ({ throws: new Error(`MCP error -32000: ${JSON.stringify(limited)}`) })],
      ['a returned value flagged isError:true', () => ({ value: { isError: true, content: [{ type: 'text', text: JSON.stringify(limited) }] } })],
      ['a successful MCP envelope', () => ({ value: mcp(limited) })],
    ] as const

    it.each(contradictory)('classifies %s as an unknown outcome: no retry, the Retry-After kept only as a wait floor', async (_label, outcome) => {
      const { run, calls } = await runtimeWith({ [SINGLE]: outcome() })
      const result = await run(SINGLE)
      expect(result.isError).toBe(true)
      const found = failure(result)
      expect(found).toMatchObject({ classification: 'uncertain_completion', completion: 'unknown', retry_after_seconds: 30 })
      const advice = found.recovery.join(' ')
      expect(advice).toContain('do NOT resend it')
      expect(advice).toContain('not before 30 seconds')
      expect(advice).not.toMatch(/retry (?:it|the call|entry \d+) once|did not run|rate-limited the call/i)
      expect(found.failed[0].error).toContain('429 rate limit exceeded')
      expect(calls).toEqual([SINGLE])
    })

    it('keeps the successes of a batch carried by an error-flagged result whose own envelope contradicts itself', async () => {
      const body = { ...limited, data: { total_count: 2, results: [read, { index: 1, tool_slug: 'GITHUB_CREATE_ISSUE', response: { successful: false, error: '429 rate limit; Retry-After: 30' } }] } }
      for (const outcome of [{ value: { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] } }, { throws: new Error(`MCP error -32000: ${JSON.stringify(body)}`) }, { value: mcp(body) }]) {
        const { run } = await runtimeWith({ [MULTI]: outcome })
        const found = failure(await run(MULTI))
        expect(found.succeeded, JSON.stringify(outcome)).toEqual([read])
        expect(found.completion).toBe('partial')
        expect(found.recovery.join(' ')).toContain('never repeat them')
      }
    })

    it('still offers one retry after the wait for a plain error-flagged rate limit with no contradiction', async () => {
      for (const body of [{ successful: false, error: '429 rate limit exceeded; Retry-After: 30' }, '429 rate limit exceeded; Retry-After: 30']) {
        const { run } = await runtimeWith({ [SINGLE]: { value: { isError: true, content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }] } } })
        const found = failure(await run(SINGLE))
        expect(found).toMatchObject({ classification: 'rate_limited', retry_after_seconds: 30 })
        expect(found.recovery.join(' ')).toContain('at least 30 seconds')
      }
    })

    it('judges the batch-level envelope by the same rule: a contradicting top level is unknown, a clean error count is not', () => {
      const entries = [read]
      const flagged = assessComposioResult(MULTI, { content: [{ type: 'text', text: JSON.stringify({ ...limited, data: { results: entries, total_count: 1, error_count: 1 } }) }] })!
      expect(flagged).toMatchObject({ kind: 'uncertain_completion', completion: 'partial', retryAfterSeconds: 30, succeeded: entries })
      const counted = assessComposioResult(MULTI, { content: [{ type: 'text', text: JSON.stringify({ successful: false, error: '429 rate limit; Retry-After: 30', data: { results: entries, total_count: 1, error_count: 1 } }) }] })!
      expect(counted).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 30 })
    })

    it('assesses the same contradiction identically without the runtime, for every outer flag', () => {
      for (const flag of [{}, { isError: true }, { value: { isError: true } }]) {
        const assessment = assessComposioResult(SINGLE, { content: [{ type: 'text', text: JSON.stringify(limited) }], ...flag } as never)!
        expect(assessment, JSON.stringify(flag)).toMatchObject({ kind: 'uncertain_completion', completion: 'unknown', retryAfterSeconds: 30 })
      }
    })
  })

  it('assesses the same entries identically without the runtime', () => {
    const run = (...results: unknown[]) => assessComposioResult(MULTI, { content: [{ type: 'text', text: JSON.stringify(declared(...results)) }] })
    expect(run(read, ...completed)).toBeUndefined()
    const warned = run(read, ...completed, write('bad input', 5))!
    expect(warned.succeeded).toEqual([read, ...completed])
    expect(warned.failed).toHaveLength(1)
    expect(run(read, note(1, { error: 'no flag' }))!.failed).toMatchObject([{ index: 1, kind: 'action_failed' }])
  })
})
