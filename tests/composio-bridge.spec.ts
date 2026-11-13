/**
 * Composio failures through the installed MCP bridge. The tool definitions here are built by DSH's own `dsh-mcp-client`
 * (`createMcpToolDefinition`, the function its `syncTools` registers every `mcp__<server>__<tool>` with), so a raw MCP
 * `CallToolResult` takes the bridge's real path (an `isError` result is thrown, anything else becomes
 * `{ content, structuredContent? }`) into a real ToolRuntime carrying this plugin's listener. Only the remote `call` is a
 * mock: no network, account, connection or Composio action is used. Skipped when the host package is not installed.
 */
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installComposioBoundary } from '../src/app/composio-boundary.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const ENTRY = process.env.DSH_MCP_CLIENT_ENTRY
  ?? join(homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js')
const available = existsSync(ENTRY)
type Raw = { content: { type: 'text'; text: string }[]; isError?: boolean; structuredContent?: unknown }
type Definition = { name: string; execute: unknown }

const MULTI = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL'
const text = (value: unknown): Raw['content'] => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
const ok = (payload: unknown): Raw => ({ content: text(payload), isError: false })
const entry = (index: number, slug: string, response: Record<string, unknown>) => ({ index, tool_slug: slug, response })
const read = entry(0, 'GMAIL_FETCH_EMAILS', { successful: true, data: { messages: [{ id: 'm1' }] } })
const created = entry(2, 'GITHUB_CREATE_ISSUE', { successful: true, data: { number: 7 } })
const batch = (...results: ReturnType<typeof entry>[]) => ({ successful: true, data: { results, total_count: results.length,
  success_count: results.filter(item => item.response.successful === true).length, error_count: results.filter(item => item.response.successful !== true).length } })
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map(block => block.text ?? '').join('\n')
const failure = (result: { content: { type: string; text?: string }[] }) => JSON.parse(textOf(result).split('\n').slice(1).join('\n')).composio_failure

describe.skipIf(!available)('installed MCP bridge to the host boundary', () => {
  let createMcpToolDefinition: (ctx: unknown, options: Record<string, unknown>) => Definition
  beforeEach(async () => { ({ createMcpToolDefinition } = await import(/* @vite-ignore */ pathToFileURL(ENTRY).href)) })

  /** A ToolRuntime with this plugin's listener and bridge-built tools, each answering from `remote` like the MCP client's `callTool`. */
  async function bridge(remote: Record<string, () => Promise<Raw>>) {
    const ctx = new Context()
    ctx.reflect.provide('systemPrompt', { section: () => () => {}, tools: () => () => {} })
    ctx.plugin(ToolRuntime as never, {} as never)
    await new Promise(resolve => setTimeout(resolve, 10))
    const tools = (ctx as unknown as { tools: ToolRuntime }).tools
    const sent: string[] = []
    for (const [name, answer] of Object.entries(remote)) {
      const raw = name.split('__').slice(2).join('__')
      tools.register(createMcpToolDefinition(ctx, { name, rawName: raw, description: name, inputSchema: { type: 'object', properties: {}, additionalProperties: true },
        call: async () => { sent.push(name); return answer() } }) as never)
    }
    installComposioBoundary({ ctx })
    return { sent, run: (name: string) => tools.execute({ callId: `call-${sent.length}`, name, arguments: {}, signal: new AbortController().signal } as never) }
  }

  it('re-classifies a nested successful:false that the bridge returns as a success', async () => {
    const { run } = await bridge({ [MULTI]: async () => ok({ successful: false, error: 'Validation failed: title is required' }) })
    const result = await run(MULTI)
    expect(result.isError).toBe(true)
    expect(failure(result)).toMatchObject({ classification: 'action_failed', completion: 'failed' })
  })

  it('keeps the successful entries of a mixed batch the bridge returned as a success', async () => {
    const { run } = await bridge({ [MULTI]: async () => ok(batch(read, entry(1, 'SLACK_SEND_MESSAGE', { successful: false, error: 'channel_not_found' }), created)) })
    const found = failure(await run(MULTI))
    expect(found).toMatchObject({ classification: 'action_failed', completion: 'partial', counts: { total: 3, succeeded: 2, failed: 1 } })
    expect(found.succeeded).toEqual([read, created])
    expect(found.recovery.join(' ')).toContain('never repeat them')
  })

  it('keeps the successes when the bridge threw an MCP error that carried a partial batch', async () => {
    const body = { successful: false, data: { total_count: 2, error_count: 1, results: [read, entry(1, 'GITHUB_CREATE_ISSUE', { successful: false, error: 'timeout after sending' })] } }
    const { run } = await bridge({ [MULTI]: async () => ({ isError: true, content: text(body) }) })
    const result = await run(MULTI)
    expect(result.isError).toBe(true)
    const found = failure(result)
    expect(found).toMatchObject({ classification: 'uncertain_completion', completion: 'partial', counts: { succeeded: 1, failed: 1 } })
    expect(found.succeeded).toEqual([read])
    expect(found.recovery.join(' ')).not.toMatch(/retry entry 1/i)
  })

  it('classifies a rate-limit MCP error, with the service Retry-After and no blind resend', async () => {
    const { run, sent } = await bridge({ [MULTI]: async () => ({ isError: true, content: text('429 Too many requests; Retry-After: 60') }) })
    const result = await run(MULTI)
    expect(result.isError).toBe(true)
    expect(failure(result)).toMatchObject({ classification: 'rate_limited', retry_after_seconds: 60 })
    expect(failure(result).recovery.join(' ')).toContain('at least 60 seconds')
    expect(sent).toEqual([MULTI])
  })

  it('classifies an auth/connection MCP error as a person-owned action and never retries or reconnects', async () => {
    const { run, sent } = await bridge({ [MULTI]: async () => ({ isError: true, content: text({ successful: false, error: { code: 'NO_ACTIVE_CONNECTION', message: 'No active connection for toolkit gmail' } }) }) })
    const found = failure(await run(MULTI))
    expect(found).toMatchObject({ classification: 'connection_required', completion: 'failed' })
    expect(found.recovery.join(' ')).toMatch(/do not retry and do not reconnect/i)
    expect(sent).toEqual([MULTI])
  })

  it('treats a rejected MCP call (timeout, lost acknowledgement) as an unknown outcome and sends nothing again', async () => {
    const { run, sent } = await bridge({ [MULTI]: async () => { throw new Error('MCP error -32001: Request timed out') } })
    const result = await run(MULTI)
    expect(result.isError).toBe(true)
    expect(failure(result)).toMatchObject({ classification: 'uncertain_completion', completion: 'unknown' })
    expect(failure(result).recovery[0]).toContain('do NOT resend it')
    expect(sent).toEqual([MULTI])
  })

  it('guides a mixed batch without offering a succeeded or an uncertain entry for a retry', async () => {
    const limited = entry(1, 'SLACK_SEND_MESSAGE', { successful: false, error: { message: 'Rate limit exceeded', retry_after: 30 } })
    const timedOut = entry(3, 'GITHUB_CREATE_ISSUE', { successful: false, error: 'Gateway timeout (504); no response received' })
    const { run } = await bridge({ [MULTI]: async () => ok(batch(read, limited, created, timedOut)) })
    const found = failure(await run(MULTI))
    const advice = found.recovery.join(' ')
    expect(found).toMatchObject({ classification: 'uncertain_completion', completion: 'partial', retry_after_seconds: 30 })
    expect(found.succeeded).toEqual([read, created])
    expect(advice).toContain('then retry entry 1 once')
    expect(advice).toContain('outcome of entry 3 is unknown')
    expect(advice).not.toMatch(/retry (?:entry )?(?:0|2|3)\b|retry only the failed entries/i)
    expect(advice).toContain('never repeat them')
  })

  it('leaves a prior success untouched when a later call fails', async () => {
    let calls = 0
    const { run } = await bridge({ [MULTI]: async () => ++calls === 1 ? ok(batch(read)) : ok({ successful: false, error: 'Validation failed' }) })
    const first = await run(MULTI), second = await run(MULTI)
    expect(first.isError).toBe(false)
    expect(textOf(first)).toBe(JSON.stringify(batch(read)))
    expect(second.isError).toBe(true)
  })

  it('does not touch a success, business text with failure words, or another MCP server', async () => {
    const business = ok({ successful: true, data: { note: 'The user was unauthorized; authentication failed on the old host', error: 'none of the above' } })
    const other = ok({ successful: false, error: 'not a Composio tool' })
    const { run } = await bridge({ [MULTI]: async () => business, mcp__chrome__navigate: async () => other, mcp__notcomposio__x: async () => other })
    expect((await run(MULTI)).isError).toBe(false)
    expect((await run('mcp__chrome__navigate')).isError).toBe(false)
    expect((await run('mcp__notcomposio__x')).isError).toBe(false)
  })
})

describe('Session decoration', () => {
  let h: Host
  beforeEach(async () => { h = await startRuntime() })
  afterEach(async () => { await h.stop(); vi.restoreAllMocks() })
  const post = (agent: { ctx: { waterfall: (...args: unknown[]) => Promise<unknown> } }, name: string, payload: unknown) => agent.ctx.waterfall('tools/post-execute',
    { name, callId: 'c1', arguments: {} }, { isError: false, value: ok(payload), content: ok(payload).content }, async () => ({ kind: 'accept' }))

  it('classifies a Composio failure in an ordinary Session without registering, restricting or guarding any tool', async () => {
    await (h.controller.create as (options: { sessionId: string }) => Promise<void>)({ sessionId: 'ordinary' })
    const agent = h.agents.get('ordinary') as unknown as { ctx: { waterfall: (...args: unknown[]) => Promise<unknown>; tools: { restrict: ReturnType<typeof vi.fn>; guard: ReturnType<typeof vi.fn> } }; session: { header?: object } }
    agent.session.header = {}
    const restricted = vi.mocked(agent.ctx.tools.restrict), guarded = vi.mocked(agent.ctx.tools.guard)
    await (h.runtime as unknown as { ctx: { parallel: (name: string, value: unknown) => Promise<void> } }).ctx.parallel('agent/created', { agent })
    expect(await post(agent, MULTI, batch(read, entry(1, 'X', { successful: false, error: 'bad input' })))).toMatchObject({ kind: 'block' })
    expect(await post(agent, MULTI, batch(read))).toEqual({ kind: 'accept' })
    expect(await post(agent, 'bash', { successful: false, error: 'x' })).toEqual({ kind: 'accept' })
    expect([...h.tools.get('ordinary')!.keys()].filter(name => /mcp__|composio/i.test(name))).toEqual([])
    expect(restricted).not.toHaveBeenCalled()
    expect(guarded).not.toHaveBeenCalled()
  })
})
