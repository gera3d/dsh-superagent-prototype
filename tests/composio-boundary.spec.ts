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
    expect(result.isError).toBe(false) // A bare transport-flagged payload without a Composio envelope is left as the host reports it.
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
    const bare = await runtimeWith({ [SINGLE]: { value: mcp({ error: 'invalid token in the document body', data: {} }) } })
    expect((await bare.run(SINGLE)).isError).toBe(false)
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
    expect(isComposioTool('mcp__rube-composio__X')).toBe(true)
    for (const name of ['bash', 'mcp__chrome__navigate', 'composio_search', 'mcp__github__create_issue']) expect(isComposioTool(name)).toBe(false)
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

afterEach(() => { vi.restoreAllMocks() })
