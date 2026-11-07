import { afterEach, expect, it, vi } from 'vitest'
import { SettingsSchema } from '../src/policy.ts'
import { DEFAULT_SENIOR_DEVELOPER_CHARACTER } from '../src/core/character.ts'
import { HelperDigestSchema, HelperSuggestionsSchema, helperSystemPrompt, suggestHelper } from '../src/app/routes/helper.ts'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const digest = { summary: 'Patched a regression.', latestTurn: 'Implemented a fix but tests have not run.' }
const options = [{ id: 'verify', label: 'Run tests', prompt: 'Run tests and inspect diffs before shipping.', recommended: true },
  { id: 'inspect', label: 'Review edge cases', prompt: 'Inspect edge cases and error handling.', recommended: false }]
const ladder = [{ provider: 'first', model: 'flash' }, { provider: 'second', model: 'sol', reasoningEffort: 'high' },
  { provider: 'third', model: 'sonnet' }]
function harness(replies: Array<string | Error> = [JSON.stringify({ options })]) {
  const calls: Record<string, unknown>[] = []
  const resolveCallConfig = vi.fn(async (route: unknown) => route)
  const get = vi.fn(() => ({ currentSelection: () => ({ provider: 'default', model: 'default' }) }))
  const logger = { warn: vi.fn() }
  const ctx = { get, logger, llm: { resolveCallConfig, async *stream(request: Record<string, unknown>) {
    calls.push(request)
    const reply = replies.shift() ?? JSON.stringify({ options })
    if (reply instanceof Error) throw reply
    yield { type: 'text-delta', text: reply }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  return { ctx: ctx as never, calls, resolveCallConfig, get, logger }
}

it('defaults helper to null, accepts a role route and rejects inline credentials', () => {
  expect(SettingsSchema.parse({}).models.helper).toBeNull()
  const helper = { provider: 'test', model: 'fast', reasoningEffort: 'high' }
  expect(SettingsSchema.parse({ models: { helper } }).models.helper).toEqual(helper)
  expect(SettingsSchema.safeParse({ models: { helper: { ...helper, apiKey: 'not-allowed' } } }).success).toBe(false)
  expect(SettingsSchema.safeParse({ models: { helper: { ...helper, apiKeyEnv: 'OPENAI_API_KEY' } } }).success).toBe(false)
})

it('only accepts the bounded compact digest and never accepts raw event fields', () => {
  expect(HelperDigestSchema.parse({ summary: '', latestTurn: 'done' })).toEqual({ summary: '', latestTurn: 'done' })
  for (const invalid of [{ ...digest, summary: 'x'.repeat(1500) }, { ...digest, latestTurn: 'x'.repeat(12001) },
    { ...digest, events: [] }, { ...digest, latestTurn: [{ type: 'text' }] }, { ...digest, latestTurn: '' }]) {
    expect(HelperDigestSchema.safeParse(invalid).success).toBe(false)
  }
})

it('generates drafts using the existing Senior Developer standards with no ranking or tools', async () => {
  const h = harness()
  expect(await suggestHelper(h.ctx, digest, SettingsSchema.parse({ models: { hierarchy: ladder } }))).toEqual({ options })
  expect(h.calls).toHaveLength(1)
  expect(h.calls[0]).toMatchObject({ provider: 'first', model: 'flash', tools: [], maxTokens: 4096,
    messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(digest) }] }] })
  const system = String(h.calls[0]!.system)
  for (const standard of DEFAULT_SENIOR_DEVELOPER_CHARACTER.standards) expect(system).toContain(standard)
  expect(system).toContain('Permission to disagree: YES')
  expect(system).toContain('untrusted data')
  expect(system).toContain('recommend running automated tests/typecheck or inspecting diffs before shipping')
  expect(h.get).not.toHaveBeenCalled()
})

it('uses a configured Senior Developer, never a different default character', async () => {
  const h = harness()
  const senior = { ...DEFAULT_SENIOR_DEVELOPER_CHARACTER, brief: 'Configured senior brief' }
  const settings = SettingsSchema.parse({ characters: { defaultCharacterId: 'other', characters: [
    { ...senior, id: 'other', brief: 'Wrong persona' }, senior,
  ] } })
  await suggestHelper(h.ctx, digest, settings)
  expect(h.calls[0]!.system).toContain('Configured senior brief')
  expect(h.calls[0]!.system).not.toContain('Wrong persona')
  expect(helperSystemPrompt(senior)).toContain('human confirmation')
})

it('uses helper override, starred ladder route or host default without mutating settings', async () => {
  for (const [models, expected] of [
    [{ hierarchy: ladder, helper: { provider: 'override', model: 'tiny' } }, { provider: 'override', model: 'tiny' }],
    [{ hierarchy: ladder.map((route, i) => ({ ...route, starred: i === 1 })) }, ladder[1]],
    [{}, { provider: 'default', model: 'default' }],
  ] as const) {
    const h = harness(), settings = SettingsSchema.parse({ models }), before = structuredClone(settings)
    await suggestHelper(h.ctx, digest, settings)
    expect(h.resolveCallConfig.mock.calls[0]![0]).toEqual(expected)
    expect(settings).toEqual(before)
  }
})

it('falls back through the existing model ladder only on availability errors and respects the escalation cap', async () => {
  const h = harness([new Error('quota exhausted'), new Error('rate limit'), JSON.stringify({ options })])
  await expect(suggestHelper(h.ctx, digest, SettingsSchema.parse({ models: { hierarchy: ladder } }))).resolves.toEqual({ options })
  expect(h.calls.map(call => call.provider)).toEqual(['first', 'second', 'third'])
  expect(h.calls[1]!.signal).toBe(h.calls[0]!.signal)
  const capped = harness([new Error('quota exhausted'), new Error('quota exhausted')])
  await expect(suggestHelper(capped.ctx, digest, SettingsSchema.parse({ models: { hierarchy: ladder, maxEscalations: 1 } })))
    .rejects.toThrow('Helper suggestion unavailable')
  expect(capped.calls).toHaveLength(2)
  const disabled = harness([new Error('quota exhausted')])
  await expect(suggestHelper(disabled.ctx, digest, SettingsSchema.parse({ models: { hierarchy: ladder, maxEscalations: 0 } })))
    .rejects.toThrow('Helper suggestion unavailable')
  expect(disabled.calls).toHaveLength(1)
})

it('falls back on in-band provider availability failures, but not aborted or malformed streams', async () => {
  for (const failure of [{ code: 'QUOTA', message: 'Quota exhausted' },
    { code: 'UNKNOWN', message: 'Account cooldown' }, { code: 'UNKNOWN', message: 'Provider failure', status: 503 }]) {
    const routes: string[] = []
    const ctx = { llm: { resolveCallConfig: async (route: unknown) => route,
      async *stream(request: { provider: string }) {
        routes.push(request.provider)
        if (routes.length === 1) { yield { type: 'finish', reason: { kind: 'error', failure } }; return }
        yield { type: 'text-delta', text: JSON.stringify({ options }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } } }
    await expect(suggestHelper(ctx as never, digest, SettingsSchema.parse({ models: { hierarchy: ladder } }))).resolves.toEqual({ options })
    expect(routes).toEqual(['first', 'second'])
  }
  const resolve = vi.fn(async (route: unknown) => route)
  const ctx = { llm: { resolveCallConfig: resolve, async *stream() {
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'QUOTA', message: 'Quota exhausted' } } }
  } } }
  await expect(suggestHelper(ctx as never, digest, SettingsSchema.parse({ models: { hierarchy: ladder } })))
    .rejects.toThrow('Helper suggestion unavailable')
  expect(resolve).toHaveBeenCalledTimes(1)
})

it('retains existing DeepSeek availability fallback when the ladder is exhausted', async () => {
  const h = harness([new Error('unavailable')])
  await suggestHelper(h.ctx, digest, SettingsSchema.parse({ models: { hierarchy: [ladder[0]] } }))
  expect(h.calls.map(call => call.provider)).toEqual(['first', 'deepseek-official'])
})

it('rejects malformed drafts without escalating or leaking provider errors', async () => {
  for (const bad of ['not json', JSON.stringify({ options: [options[0]] }), JSON.stringify({ options: [options[0], options[0]] }),
    JSON.stringify({ options: options.map(option => ({ ...option, recommended: false })) }), 'x'.repeat(12001),
    new Error('internal credential-like detail')]) {
    const h = harness([bad])
    await expect(suggestHelper(h.ctx, digest, SettingsSchema.parse({ models: { hierarchy: ladder } })))
      .rejects.toThrow(/^Helper suggestion unavailable$/)
    expect(h.calls).toHaveLength(1)
  }
  expect(HelperSuggestionsSchema.safeParse({ options: [...options, ...options, options[0]] }).success).toBe(false)
})

it('rejects incomplete streams and missing model configuration', async () => {
  for (const finish of [undefined, { type: 'finish', reason: { kind: 'max-tokens' } }]) {
    const ctx = { llm: { resolveCallConfig: async (route: unknown) => route, async *stream() {
      yield { type: 'text-delta', text: JSON.stringify({ options }) }
      if (finish) yield finish
    } } }
    await expect(suggestHelper(ctx as never, digest, SettingsSchema.parse({ models: { hierarchy: ladder } })))
      .rejects.toThrow('Helper suggestion unavailable')
  }
  await expect(suggestHelper({ get: () => undefined } as never, digest, SettingsSchema.parse({})))
    .rejects.toThrow('Helper suggestion unavailable')
})

it('logs only safe failure categories and stages, never provider text or digest', async () => {
  for (const [reply, category] of [
    ['secret-response-not-json', 'response-parse'],
    [Object.assign(new Error('forbidden secret-api-key'), { status: 403 }), 'authentication'],
    [new Error('quota exhausted secret-token'), 'provider-unavailable'],
    ...['AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL'].map(code => [Object.assign(new Error('secret-provider-detail'), { code }), 'authentication'] as const),
    ...['NO_ADAPTER', 'UNSUPPORTED_REASONING_EFFORT', 'INVALID_ARGS'].map(code => [Object.assign(new Error('secret-provider-detail'), { code }), 'route'] as const),
  ] as const) {
    const h = harness([reply])
    await expect(suggestHelper(h.ctx, digest, SettingsSchema.parse({ models: { hierarchy: ladder, maxEscalations: 0 } })))
      .rejects.toThrow(/^Helper suggestion unavailable$/)
    const logged = h.logger.warn.mock.calls[0]
    expect(logged?.[0]).toBe('helper/suggest failure: %s')
    const facts = JSON.parse(logged![1])
    expect(facts).toMatchObject({ category, deadlineMs: 20000, attempt: 1 })
    expect(JSON.stringify(logged)).not.toMatch(/secret|regression|tests have not run/)
  }
})

it('permits a response after six seconds within the twenty-second budget (simulated)', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    setTimeout(() => controller.abort(), ms)
    return controller.signal
  })
  const h = harness()
  h.resolveCallConfig.mockImplementation(async (route: unknown) => {
    await new Promise(resolve => setTimeout(resolve, 7000))
    controller.signal.throwIfAborted()
    return route
  })
  const result = suggestHelper(h.ctx, digest, SettingsSchema.parse({ models: { hierarchy: ladder } }))
  await vi.advanceTimersByTimeAsync(7000)
  await expect(result).resolves.toEqual({ options })
})

it('does not retry after the shared twenty-second deadline', async () => {
  const controller = new AbortController()
  const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
  const h = harness()
  h.resolveCallConfig.mockImplementation(async () => {
    controller.abort()
    throw new Error('unavailable')
  })
  await expect(suggestHelper(h.ctx, digest, SettingsSchema.parse({ models: { hierarchy: ladder } })))
    .rejects.toThrow('Helper suggestion unavailable')
  expect(h.resolveCallConfig).toHaveBeenCalledTimes(1)
  expect(deadline).toHaveBeenCalledWith(20000)
  expect(JSON.parse(h.logger.warn.mock.calls[0]![1])).toMatchObject({ category: 'deadline', stage: 'configuration', attempt: 1 })
})

it('does not call the inherited host provider when every managed provider is parked', async () => {
  const h = harness()
  const settings = SettingsSchema.parse({ models: { subscriptions: [{ provider: 'default', status: 'exhausted' }] } })
  await expect(suggestHelper(h.ctx, digest, settings)).rejects.toThrow('No eligible')
  expect(h.calls).toHaveLength(0)
  expect(h.resolveCallConfig).not.toHaveBeenCalled()
})

it('server-owned unbound delivery state constrains the next reply to release preparation', async () => {
  const h = harness()
  await suggestHelper(h.ctx, digest, SettingsSchema.parse({ models: { hierarchy: ladder } }), 'Artifact ready; scope unbound.')
  const system = String(h.calls[0]!.system)
  expect(system).toContain('Shared workflow context:\nArtifact ready; scope unbound.')
  expect(system).toContain('Request live evidence only after a recorded deployment')
  expect(system).toContain('Optimize progress toward the overall goal')
})

it('failure diagnostics expose only stable categories and finish kinds, never provider details or digest text', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const h = harness([new Error('private-provider-detail')])
  await expect(suggestHelper(h.ctx, { summary: 'private-user-goal', latestTurn: 'private-user-text' }, SettingsSchema.parse({ models: { hierarchy: ladder } }))).rejects.toThrow('Helper suggestion unavailable')
  const logged = JSON.stringify(warn.mock.calls)
  expect(logged).toContain('provider-error')
  expect(logged).not.toMatch(/private-provider-detail|private-user-goal|private-user-text/)
})
