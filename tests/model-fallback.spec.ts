import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { latestAssignment, waitsForPerson, type Ticket } from '../src/core/index.ts'
import { DEEPSEEK_FALLBACK_ROUTE, fallbackNote, isModelUnavailable, unavailableFallbackStep, classifyModelError, executeWithFallback, ToolExecutionLedger } from '../src/app/role-models.ts'
import { KV } from '../src/kv.ts'
import { ModelRoutingConfigSchema } from '../src/policy.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

describe('Models Fallback Rules (DeepSeek flash fallback vs Escalation ladder)', () => {
  const gemini = { provider: 'antigravity', model: 'gemini-3.8-flash', starred: true }
  const sol = { provider: 'openai-codex', model: 'gpt-6.1-sol', starred: true }
  const sonnet = { provider: 'anthropic', model: 'claude-sonnet-5-5', starred: true }

  it('simulates an unavailable model and shows the fallback firing to DeepSeek cheap flash with a note on the ticket', async () => {
    await h.runtime.settings.save('models', { hierarchy: [gemini, sol, sonnet], maxEscalations: 2 },
      h.runtime.store.blockRevision('models'), 'panel')

    const one = await h.acceptedTicket(feishu('fallback-1', '@bot Fix quota outage'))
    const agent = h.agents.get(one.sessionId)!

    // Simulate quota cooldown on Antigravity / Gemini
    const cooldownError = new Error('All Antigravity accounts are unavailable: no account can serve google right now (1 in cooldown)')
    h.ctx.emit('agent/error', { agent, error: cooldownError } as never)
    await h.runtime.idle()

    // 1st fallback tries next in ladder (Sol)
    const session = (agent as unknown as { session: { append: ReturnType<typeof vi.fn> } }).session
    const selections = () => session.append.mock.calls.filter(([event]) => event === 'model/selection').map(([, value]) => value)
    expect(selections().at(-1)).toMatchObject({ provider: 'openai-codex', model: 'gpt-6.1-sol' })

    // Simulate Sol also unavailable (rate limited / quota cooldown)
    const solError = new Error('OpenAI 429 rate limit exceeded')
    h.ctx.emit('agent/error', { agent, error: solError } as never)
    await h.runtime.idle()

    // 2nd fallback tries next in ladder (Sonnet)
    expect(selections().at(-1)).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' })

    // Simulate Sonnet also unavailable (outage / 503)
    const sonnetError = new Error('Anthropic 503 Service Unavailable: overloaded')
    h.ctx.emit('agent/error', { agent, error: sonnetError } as never)
    await h.runtime.idle()

    // None of Gemini, GPT and Claude can serve it: falls back to DeepSeek's cheap flash model!
    expect(selections().at(-1)).toMatchObject({
      provider: DEEPSEEK_FALLBACK_ROUTE.provider,
      model: DEEPSEEK_FALLBACK_ROUTE.model,
    })
    expect(DEEPSEEK_FALLBACK_ROUTE).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })

    // Verify a plain-language one short line note is recorded on the ticket warning quality may be lower
    const ticket = h.runtime.store.tickets.get(one.ticket.id)!
    const notes = ticket.inputs.filter(input => input.kind === 'note')
    expect(notes.length).toBeGreaterThan(0)
    const deepseekNote = notes.find(n => n.text.includes('deepseek-official/deepseek-flash'))
    expect(deepseekNote).toBeDefined()
    expect(deepseekNote!.text).toContain('Fell back to DeepSeek cheap flash model (deepseek-official/deepseek-flash)')
    expect(deepseekNote!.text).toContain('Quality may be lower')

    // DeepSeek flash was NOT added as an escalation rung on the ticket
    expect(ticket.escalations ?? []).toHaveLength(0)
  })

  it('shows a hard task gets one quality escalation, then waits for a person, and never lands on DeepSeek flash', async () => {
    await h.runtime.settings.save('models', { hierarchy: [gemini, sol, sonnet], maxEscalations: 2 },
      h.runtime.store.blockRevision('models'), 'panel')

    const one = await h.acceptedTicket(feishu('hard-task-1', '@bot Complex refactoring'))
    const agent = h.agents.get(one.sessionId)!
    const session = (agent as unknown as { session: { append: ReturnType<typeof vi.fn> } }).session
    const selections = () => session.append.mock.calls.filter(([event]) => event === 'model/selection').map(([, value]) => value)

    // The one quality attempt: a concrete failed report escalates up the ladder.
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'failed', summary: 'task too hard for flash' })
    await h.runtime.idle()

    const ticket1 = h.runtime.store.tickets.get(one.ticket.id)!
    expect(ticket1.escalations).toHaveLength(1)
    expect(ticket1.escalations![0]!).toMatchObject({
      from: { provider: 'antigravity', model: 'gemini-3.8-flash' },
      to: { provider: 'openai-codex', model: 'gpt-6.1-sol' },
    })
    expect(selections().at(-1)).toMatchObject({ provider: 'openai-codex', model: 'gpt-6.1-sol' })

    // Even with maxEscalations 2, a second failure returns to a person instead of repeating or climbing further.
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'failed', summary: 'still too hard' })
    await h.runtime.idle()

    const capped = h.runtime.store.tickets.get(one.ticket.id)!
    expect(capped.escalations).toHaveLength(1)
    expect(waitsForPerson(capped)).toBe(true)
    expect(selections().some(s => s.provider === 'deepseek-official' && s.model === 'deepseek-flash')).toBe(false)
  })

  describe('bounded Sonnet quality escalation with subscription priority', () => {
    const particle = { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' }
    const live = (extra: Record<string, unknown> = {}) => h.runtime.settings.save('models', {
      hierarchy: [gemini, { ...sol, starred: false }, sonnet, { ...particle, starred: false }], maxEscalations: 1, economyRoute: particle,
      subscriptions: [{ provider: 'openai-codex', status: 'conserved' }], ...extra }, h.runtime.store.blockRevision('models'), 'panel')
    const start = async (id: string) => {
      const one = await h.acceptedTicket(feishu(id, '@bot Difficult change'))
      const agent = h.agents.get(one.sessionId)!
      const session = (agent as unknown as { session: { append: ReturnType<typeof vi.fn> } }).session
      return { one, agent, selections: () => session.append.mock.calls.filter(([event]) => event === 'model/selection').map(([, value]) => value) }
    }
    const fail = async (sessionId: string, summary: string) => {
      await h.runTool(sessionId, 'orchestrator_report', { state: 'failed', summary }); await h.runtime.idle()
    }

    it('escalates a concrete failure from Flash to Sonnet exactly once, skipping conserved OpenAI, then waits for a person', async () => {
      await live()
      const { one, selections } = await start('bounded-1')
      await fail(one.sessionId, 'tests still fail after two attempts: 3 failing')
      const escalated = h.runtime.store.tickets.get(one.ticket.id)!
      expect(escalated.escalations).toEqual([expect.objectContaining({ from: { provider: 'antigravity', model: 'gemini-3.8-flash' }, to: { provider: 'anthropic', model: 'claude-sonnet-5-5' } })])
      expect(selections().at(-1)).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' })
      await fail(one.sessionId, 'sonnet could not finish either')
      const after = h.runtime.store.tickets.get(one.ticket.id)!
      expect(after.escalations).toHaveLength(1)
      expect(waitsForPerson(after)).toBe(true)
      const used = selections().map(item => `${item.provider}/${item.model}`)
      expect(used).not.toContain('openai-codex/gpt-6.1-sol')
      expect(used).not.toContain('openrouter/deepseek/deepseek-v4.1-flash')
    })

    it('does not escalate when quality escalation is off (maxEscalations 0)', async () => {
      await live({ maxEscalations: 0 })
      const off = await start('bounded-off')
      await fail(off.one.sessionId, 'could not finish')
      expect(h.runtime.store.tickets.get(off.one.ticket.id)!.escalations ?? []).toHaveLength(0)
      expect(waitsForPerson(h.runtime.store.tickets.get(off.one.ticket.id)!)).toBe(true)
    })

    it('keeps availability fallback separate: quota moves Flash to Sonnet to the pinned DeepSeek route without spending the quality attempt', async () => {
      await live()
      const { one, agent, selections } = await start('bounded-quota')
      h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new Error('Quota exceeded for gemini-3.8-flash') } as never)
      await h.runtime.idle()
      expect(selections().at(-1)).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' })
      h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new Error('Anthropic 503 Service Unavailable: overloaded') } as never)
      await h.runtime.idle()
      expect(selections().at(-1)).toMatchObject(particle)
      const ticket = h.runtime.store.tickets.get(one.ticket.id)!
      expect(ticket.escalations ?? []).toHaveLength(0)
      // On the cheaper availability route a task failure is not a quality upgrade: it goes to a person.
      await fail(one.sessionId, 'the change is still wrong')
      expect(h.runtime.store.tickets.get(one.ticket.id)!.escalations ?? []).toHaveLength(0)
      expect(waitsForPerson(h.runtime.store.tickets.get(one.ticket.id)!)).toBe(true)
    })

    it('does not re-escalate a worker that quota already moved onto Sonnet', async () => {
      await live()
      const { one, agent, selections } = await start('bounded-already')
      h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new Error('Quota exceeded for gemini-3.8-flash') } as never)
      await h.runtime.idle()
      expect(selections().at(-1)).toMatchObject({ provider: 'anthropic' })
      await fail(one.sessionId, 'wrong result on sonnet')
      expect(h.runtime.store.tickets.get(one.ticket.id)!.escalations ?? []).toHaveLength(0)
      expect(waitsForPerson(h.runtime.store.tickets.get(one.ticket.id)!)).toBe(true)
    })

    it('does not reset the quality attempt when quota fallback follows it, and ends at the pinned DeepSeek route when all providers are unavailable', async () => {
      await live()
      const { one, agent, selections } = await start('bounded-after')
      await fail(one.sessionId, 'needs a stronger model: 5 tests fail')
      expect(h.runtime.store.tickets.get(one.ticket.id)!.escalations).toHaveLength(1)
      h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new Error('Anthropic 503 Service Unavailable: overloaded') } as never)
      await h.runtime.idle()
      expect(selections().at(-1)).toMatchObject(particle)
      const ticket = h.runtime.store.tickets.get(one.ticket.id)!
      expect(ticket.escalations).toHaveLength(1)
      // The attempt stays spent: a later task failure goes to a person rather than back up the ladder.
      await fail(one.sessionId, 'still wrong on the fallback route')
      const after = h.runtime.store.tickets.get(one.ticket.id)!
      expect(after.escalations).toHaveLength(1)
      expect(waitsForPerson(after)).toBe(true)
      expect(selections().some(item => item.provider === 'openai-codex' || item.provider === 'deepseek-official')).toBe(false)
    })

    it('fails closed to a person, without OpenAI or direct DeepSeek, once every eligible provider and the pinned route are unavailable', async () => {
      await live()
      const { one, agent, selections } = await start('bounded-all-down')
      for (const message of ['Quota exceeded for gemini', 'Anthropic quota exceeded', 'Quota exceeded for the pinned OpenRouter route', 'Quota exceeded again']) {
        h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new Error(message) } as never)
        await h.runtime.idle()
      }
      const ticket = h.runtime.store.tickets.get(one.ticket.id)!
      expect(ticket.escalations ?? []).toHaveLength(0)
      expect(latestAssignment(ticket)?.report).toMatchObject({ state: 'failed' })
      expect(waitsForPerson(ticket)).toBe(true)
      expect(selections().map(item => item.provider)).not.toContain('openai-codex')
      expect(selections().map(item => item.provider)).not.toContain('deepseek-official')
    })
  })

  /** A ticket on the configured hierarchy, with the route selections its worker Session recorded. */
  const routable = async () => {
    await h.runtime.settings.save('models', { hierarchy: [gemini, sol, sonnet], maxEscalations: 2 },
      h.runtime.store.blockRevision('models'), 'panel')
    const one = await h.acceptedTicket(feishu('route-1', '@bot Fix provider routing'))
    const agent = h.agents.get(one.sessionId)!
    const session = (agent as unknown as { session: { append: ReturnType<typeof vi.fn> } }).session
    return {
      one,
      agent,
      selections: () => session.append.mock.calls.filter(([event]) => event === 'model/selection').map(([, value]) => value),
      retried: () => h.deliveries.mock.calls.some(([call]) => call.sessionId === one.sessionId && call.text.includes('passing reason')),
    }
  }

  it('switches route at once for an HTTP 429 instead of retrying the same route', async () => {
    const { agent, selections, retried } = await routable()
    h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: Object.assign(new Error('Too many requests'), { status: 429 }) } as never)
    await h.runtime.idle()
    expect(selections().at(-1)).toMatchObject({ provider: 'openai-codex', model: 'gpt-6.1-sol' })
    expect(retried()).toBe(false)
  })

  it.each([
    ['a quota message', Object.assign(new Error('Quota exceeded for gemini-3.8-flash'), { status: 503 })],
    ['a cooldown message', Object.assign(new Error('The account is in cooldown'), { status: 503 })],
    ['a budget code', Object.assign(new Error('Provider refused the request'), { status: 500, code: 'BUDGET_EXCEEDED' })],
    ['an account message', Object.assign(new Error('No account can serve this route'), { status: 502 })],
  ])('switches route at once for a numeric status with %s', async (_case, error) => {
    const { agent, selections, retried } = await routable()
    h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error } as never)
    await h.runtime.idle()
    expect(selections().at(-1)).toMatchObject({ provider: 'openai-codex', model: 'gpt-6.1-sol' })
    expect(retried()).toBe(false)
  })

  it('retries a generic 503 on the same route before any route switch', async () => {
    const { agent, selections, retried } = await routable()
    const before = selections().length
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: Object.assign(new Error('Service Unavailable'), { status: 503 }) } as never)
      await vi.advanceTimersByTimeAsync(15_000)
    } finally { vi.useRealTimers() }
    expect(selections()).toHaveLength(before)
    expect(retried()).toBe(true)
  })

  it('fails closed on auth or safety errors without model substitution in runtime', async () => {
    await h.runtime.settings.save('models', { hierarchy: [gemini, sol, sonnet], maxEscalations: 2 },
      h.runtime.store.blockRevision('models'), 'panel')
    const one = await h.acceptedTicket(feishu('auth-fail-1', '@bot Secret audit'))
    const agent = h.agents.get(one.sessionId)!
    const session = (agent as unknown as { session: { append: ReturnType<typeof vi.fn> } }).session
    const initialSelections = session.append.mock.calls.filter(([event]) => event === 'model/selection').length

    // 401 Unauthorized
    h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: Object.assign(new Error('Invalid API Key'), { status: 401 }) } as never)
    await h.runtime.idle()

    // No fallback selection event occurred
    const afterSelections = session.append.mock.calls.filter(([event]) => event === 'model/selection').length
    expect(afterSelections).toBe(initialSelections)

    // Ticket marked failed
    const ticket = h.runtime.store.tickets.get(one.ticket.id)!
    expect(latestAssignment(ticket)?.report?.state).toBe('failed')
  })

  it('blocks automatic continuation when uncertain tool outcome exists in DshExecutor ledger', async () => {
    await h.runtime.settings.save('models', { hierarchy: [gemini, sol, sonnet], maxEscalations: 2 },
      h.runtime.store.blockRevision('models'), 'panel')
    const one = await h.acceptedTicket(feishu('uncertain-tool-1', '@bot Critical deploy'))
    const agent = h.agents.get(one.sessionId)!

    // Mark an uncertain tool outcome in the executor ledger
    h.runtime.executor.toolLedger(one.ticket.id).recordStart('deploy-call', 'deploy')
    h.runtime.executor.toolLedger(one.ticket.id).recordUncertain('deploy-call')

    // Simulate quota error on active route
    h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: Object.assign(new Error('Rate limited'), { status: 429 }) } as never)
    await h.runtime.idle()

    // Automatic fallback was blocked
    const ticket = h.runtime.store.tickets.get(one.ticket.id)!
    const notes = ticket.inputs.filter(input => input.kind === 'note')
    const uncertainNote = notes.find(n => n.text.includes('Uncertain tool outcome blocks automatic continuation'))
    expect(uncertainNote).toBeDefined()
    expect(latestAssignment(ticket)?.report?.state).toBe('failed')
  })

  it('real runtime honors total one-attempt limit even when another fallback is eligible', async () => {
    await h.runtime.settings.save('models', {
      hierarchy: [gemini, sonnet],
      maxEscalations: 1,
      routing: ModelRoutingConfigSchema.parse({
        primary: { provider: gemini.provider, model: gemini.model },
        fallbacks: [{ provider: sonnet.provider, model: sonnet.model }],
        max_total_attempts: 1,
        max_attempts_per_model: 1,
      }),
    }, h.runtime.store.blockRevision('models'), 'panel')

    const one = await h.acceptedTicket(feishu('review-no-substitution', '@bot Fix isolated audit fixture'))
    const agent = h.agents.get(one.sessionId)!
    const session = (agent as unknown as { session: { append: ReturnType<typeof vi.fn> } }).session
    const before = session.append.mock.calls.filter(([e]) => e === 'model/selection').length

    h.ctx.emit('agent/error', { agent, error: Object.assign(new Error('Google quota exhausted'), { status: 429 }) } as never)
    await h.runtime.idle()
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setImmediate(resolve))
      await h.runtime.idle()
    }

    const later = session.append.mock.calls.filter(([e]) => e === 'model/selection').slice(before).map(([, v]) => v)
    expect(later).toHaveLength(0)
  })
})

describe('Bounded Model Routing and Tool Execution Guard', () => {
  it('CRIT-1: rejects duplicate model entries across primary and fallbacks', () => {
    expect(() => ModelRoutingConfigSchema.parse({
      primary: 'model-a',
      fallbacks: ['model-b', 'model-a'],
    })).toThrow(/Duplicate model entries/)
  })

  it('CRIT-2: rejects nonpositive/noninteger routing limits', () => {
    expect(() => ModelRoutingConfigSchema.parse({
      primary: 'model-a',
      max_attempts_per_model: 0,
    })).toThrow()
    expect(() => ModelRoutingConfigSchema.parse({
      primary: 'model-a',
      max_total_attempts: -1,
    })).toThrow()
    expect(() => ModelRoutingConfigSchema.parse({
      primary: 'model-a',
      total_timeout_ms: 1.5,
    })).toThrow()
  })

  it('CRIT-4: empty fallbacks prevent substitution', () => {
    const settings = {
      models: {
        hierarchy: [{ provider: 'antigravity', model: 'gemini-3.8-flash', starred: true }],
        maxEscalations: 2,
        helper: null,
        conserve: false,
        economyRoute: { provider: 'deepseek-official', model: 'deepseek-flash' },
        subscriptions: [],
        routing: {
          primary: 'antigravity/gemini-3.8-flash',
          fallbacks: [],
          max_attempts_per_model: 2,
          max_total_attempts: 4,
          total_timeout_ms: 30000,
          backoff_base_ms: 500,
          backoff_ceiling_ms: 5000,
          required_capabilities: [],
        },
      },
    }
    const current = { provider: 'antigravity', model: 'gemini-3.8-flash' }
    const step = unavailableFallbackStep(settings, current, [current])
    expect(step).toBeUndefined()
  })

  it('CRIT-5: selection follows configured primary-then-fallback order', () => {
    const settings = {
      models: {
        hierarchy: [],
        maxEscalations: 2,
        helper: null,
        conserve: false,
        economyRoute: { provider: 'deepseek-official', model: 'deepseek-flash' },
        subscriptions: [],
        routing: {
          primary: 'antigravity/gemini-3.8-flash',
          fallbacks: ['openai-codex/gpt-6.1-sol', 'anthropic/claude-sonnet-5-5'],
          max_attempts_per_model: 2,
          max_total_attempts: 4,
          total_timeout_ms: 30000,
          backoff_base_ms: 500,
          backoff_ceiling_ms: 5000,
          required_capabilities: [],
        },
      },
    }
    const primary = { provider: 'antigravity', model: 'gemini-3.8-flash' }
    const step1 = unavailableFallbackStep(settings, primary, [primary])
    expect(step1).toBeDefined()
    expect(step1!.to).toEqual({ provider: 'openai-codex', model: 'gpt-6.1-sol' })

    const step2 = unavailableFallbackStep(settings, step1!.to, [primary, step1!.to])
    expect(step2).toBeDefined()
    expect(step2!.to).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' })

    const step3 = unavailableFallbackStep(settings, step2!.to, [primary, step1!.to, step2!.to])
    expect(step3).toBeUndefined()
  })

  it('CRIT-7 & CRIT-8: bounds requests per candidate and total attempts', async () => {
    const routing = ModelRoutingConfigSchema.parse({
      primary: 'candidate-1',
      fallbacks: ['candidate-2'],
      max_attempts_per_model: 2,
      max_total_attempts: 3,
      total_timeout_ms: 5000,
    })
    const callCounts: Record<string, number> = {}
    await expect(executeWithFallback({
      routing,
      executeCandidate: async (model) => {
        callCounts[model] = (callCounts[model] ?? 0) + 1
        throw Object.assign(new Error('503 Service Unavailable'), { status: 503 })
      },
    })).rejects.toThrow(/Total attempt bound exceeded \(3\)/)

    expect(callCounts['candidate-1']).toBe(2)
    expect(callCounts['candidate-2']).toBe(1)
  })

  it('CRIT-10 & CRIT-11: cancels in-flight candidate upon deadline expiry', async () => {
    const routing = ModelRoutingConfigSchema.parse({
      primary: 'slow-candidate',
      fallbacks: ['backup-candidate'],
      max_attempts_per_model: 1,
      max_total_attempts: 2,
      total_timeout_ms: 30,
    })
    let signalAborted = false
    await expect(executeWithFallback({
      routing,
      executeCandidate: async (_model, signal) => {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            signalAborted = true
            reject(new Error('aborted by signal'))
          })
          setTimeout(resolve, 200)
        })
      },
    })).rejects.toThrow(/Routing deadline exceeded/)

    expect(signalAborted).toBe(true)
  })

  it('CRIT-12: parameterizes error classification for auth, safety, and availability', () => {
    expect(classifyModelError(Object.assign(new Error('Unauthorized'), { status: 401 }))).toMatchObject({
      kind: 'auth', action: 'stop', retryable: false,
    })
    expect(classifyModelError(new Error('Prompt flagged by safety filter'))).toMatchObject({
      kind: 'safety', action: 'stop', retryable: false,
    })
    expect(classifyModelError(Object.assign(new Error('Rate limit exceeded'), { status: 429 }))).toMatchObject({
      kind: 'availability', action: 'advance', retryable: true,
    })
    expect(classifyModelError(Object.assign(new Error('Service overloaded'), { status: 503 }))).toMatchObject({
      kind: 'availability', action: 'retry', retryable: true,
    })
  })

  it('CRIT-14: logs structured fallback events when switching candidates', async () => {
    const routing = ModelRoutingConfigSchema.parse({
      primary: 'model-a',
      fallbacks: ['model-b'],
      max_attempts_per_model: 1,
      max_total_attempts: 2,
      total_timeout_ms: 5000,
    })
    const events: any[] = []
    const outcome = await executeWithFallback({
      routing,
      onFallback: (e) => events.push(e),
      executeCandidate: async (model) => {
        if (model === 'model-a') throw Object.assign(new Error('Rate limited'), { status: 429 })
        return 'success-from-b'
      },
    })
    expect(outcome.result).toBe('success-from-b')
    expect(outcome.activeModel).toBe('model-b')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      requested_model: 'model-a',
      substituted_model: 'model-b',
      attempt_count: 1,
    })
  })

  it('CRIT-21 & CRIT-22: blocks replay of completed tools in execution ledger', () => {
    const ledger = new ToolExecutionLedger()
    ledger.recordStart('call-1', 'bash')
    ledger.recordCompletion('call-1', true)

    expect(() => ledger.recordStart('call-1', 'bash')).toThrow(/already completed/)
    expect(() => ledger.guard('call-1')).toThrow(/already completed/)
    expect(ledger.completedCount()).toBe(1)
  })

  it('prevents a second start while identical tool outcome remains in flight', () => {
    const ledger = new ToolExecutionLedger()
    ledger.recordStart('effect-1', 'write')
    expect(() => ledger.recordStart('effect-1', 'write')).toThrow(/already in-flight/)
  })

  it('CRIT-24 & Audit Point 3: blocks execution on uncertain outcome until valid terminal reconciliation', () => {
    const ledger = new ToolExecutionLedger()
    ledger.recordStart('call-uncertain', 'git_push')
    ledger.recordUncertain('call-uncertain')

    expect(() => ledger.guard('call-2')).toThrow(/Uncertain tool outcome blocks execution/)

    // Arbitrary status must be rejected
    expect(() => ledger.reconcile('call-uncertain', 'banana' as any)).toThrow(/Invalid reconciliation status/)

    // Valid reconciliation clears the lock
    ledger.reconcile('call-uncertain', 'reconciled_success')
    expect(ledger.hasUncertain()).toBe(false)
    expect(() => ledger.guard('call-2')).not.toThrow()
  })

  it('CRIT-10 & CRIT-11: noncooperative transport ignoring signal settles at deadline and rejects late success', async () => {
    const routing = ModelRoutingConfigSchema.parse({
      primary: 'noncooperative-model',
      fallbacks: [],
      max_attempts_per_model: 1,
      max_total_attempts: 1,
      total_timeout_ms: 25,
    })
    const start = Date.now()
    await expect(executeWithFallback({
      routing,
      executeCandidate: async () => {
        // Ignores signal completely and resolves late after 150ms
        await new Promise(r => setTimeout(r, 150))
        return 'late-illegal-success'
      },
    })).rejects.toThrow(/Routing deadline exceeded/)
    const elapsed = Date.now() - start
    // Finite settlement: settled promptly around deadline (~25-80ms), not waiting 150ms
    expect(elapsed).toBeLessThan(120)
  })

  it('Sessions.registerTool & ToolRuntime: non-abort network/lost-ack records uncertain outcome and hasUncertain is true', async () => {
    const ticket = await h.acceptedTicket(feishu('lost-ack-1', '@bot Fix lost ack fixture'))
    const agent = h.agents.get(ticket.sessionId)!
    const ledger = h.runtime.executor.toolLedger(ticket.ticket.id)

    let invoked = false
    const register = (h.runtime.sessions as any).registerTool(agent, { disposers: [] })
    register(
      'synthetic_write_effect',
      'synthetic tool',
      z.object({ path: z.string() }),
      async () => {
        invoked = true
        throw new Error('network timeout: connection reset by peer before ack')
      }
    )

    const tool = h.tools.get(ticket.sessionId)!.get('synthetic_write_effect')!
    await expect(tool.execute({ path: 'a.txt' }, { callId: 'call-lost-ack-1', signal: new AbortController().signal } as never)).rejects.toThrow(/network timeout/)

    expect(invoked).toBe(true)
    expect(ledger.hasUncertain()).toBe(true)
    expect(ledger.record('call-lost-ack-1')?.status).toBe('uncertain')
  })

  it('Sessions.registerTool & ToolRuntime: known pre-effect rejection does not record uncertain', async () => {
    const ticket = await h.acceptedTicket(feishu('pre-effect-1', '@bot Fix pre-effect fixture'))
    const agent = h.agents.get(ticket.sessionId)!
    const ledger = h.runtime.executor.toolLedger(ticket.ticket.id)

    const register = (h.runtime.sessions as any).registerTool(agent, { disposers: [] })
    register(
      'synthetic_guarded_write',
      'synthetic tool with pre-effect failure',
      z.object({}),
      async () => {
        const err = new Error('Permission denied before effect')
        ;(err as any).beforeEffect = true
        throw err
      }
    )

    const tool = h.tools.get(ticket.sessionId)!.get('synthetic_guarded_write')!
    await expect(tool.execute({}, { callId: 'call-pre-effect-1', signal: new AbortController().signal } as never)).rejects.toThrow(/Permission denied/)

    expect(ledger.hasUncertain()).toBe(false)
    expect(ledger.record('call-pre-effect-1')?.status).toBe('failed')
  })

  it('Sessions.registerTool & ToolRuntime: successful completion records completed and prevents replay of same callId', async () => {
    const ticket = await h.acceptedTicket(feishu('success-1', '@bot Fix success fixture'))
    const agent = h.agents.get(ticket.sessionId)!
    const ledger = h.runtime.executor.toolLedger(ticket.ticket.id)

    const register = (h.runtime.sessions as any).registerTool(agent, { disposers: [] })
    register(
      'synthetic_success_write',
      'synthetic tool succeeding',
      z.object({ val: z.string() }),
      async () => ({ ok: true })
    )

    const tool = h.tools.get(ticket.sessionId)!.get('synthetic_success_write')!
    const res = await tool.execute({ val: 'test' }, { callId: 'call-success-1', signal: new AbortController().signal } as never)
    expect(res).toMatchObject({ ok: true })
    expect(ledger.completedCount()).toBe(1)
    expect(ledger.record('call-success-1')?.status).toBe('completed')

    // Replay of same callId is rejected
    await expect(tool.execute({ val: 'test' }, { callId: 'call-success-1', signal: new AbortController().signal } as never)).rejects.toThrow(/already completed; replay prevented/)
  })

  it('distinct canonical callIds with identical arguments succeed without collision', async () => {
    const ticket = await h.acceptedTicket(feishu('distinct-1', '@bot Fix distinct IDs fixture'))
    const agent = h.agents.get(ticket.sessionId)!
    const ledger = h.runtime.executor.toolLedger(ticket.ticket.id)

    const register = (h.runtime.sessions as any).registerTool(agent, { disposers: [] })
    register(
      'synthetic_append',
      'synthetic tool called multiple times',
      z.object({ line: z.string() }),
      async () => ({ written: true })
    )

    const tool = h.tools.get(ticket.sessionId)!.get('synthetic_append')!

    // Missing callId fails closed
    await expect(tool.execute({ line: 'no-call-id' }, { signal: new AbortController().signal } as never)).rejects.toThrow(/Canonical callId required/)

    // Turn 1
    const r1 = await tool.execute({ line: 'repeated argument' }, { callId: 'model-turn-1-call-1', signal: new AbortController().signal } as never)
    expect(r1).toMatchObject({ written: true })

    // Turn 2: identical arguments, distinct canonical callId
    const r2 = await tool.execute({ line: 'repeated argument' }, { callId: 'model-turn-2-call-2', signal: new AbortController().signal } as never)
    expect(r2).toMatchObject({ written: true })
    expect(ledger.completedCount()).toBe(2)
  })

  it('persists tool uncertainty and restores across recovery to block replay', async () => {
    const ticket = await h.acceptedTicket(feishu('persist-1', '@bot Fix persist fixture'))
    const ledger = h.runtime.executor.toolLedger(ticket.ticket.id)

    ledger.recordStart('call-restart-1', 'write')
    expect(ledger.record('call-restart-1')?.status).toBe('in_flight')

    // Simulate restart reconciliation
    h.runtime.executor.resume()

    // Host restart marks in-flight tool as uncertain
    expect(ledger.hasUncertain()).toBe(true)
    expect(ledger.record('call-restart-1')?.status).toBe('uncertain')

    // Clean new ledger restored from store retains uncertain state
    const cleanLedger = new ToolExecutionLedger()
    const stored = h.runtime.store.get(KV.sessions.toolLedgers(ticket.ticket.id))
    expect(stored).toBeDefined()
    cleanLedger.restore(stored as never)
    expect(cleanLedger.hasUncertain()).toBe(true)
    expect(() => cleanLedger.guard('call-next')).toThrow(/Uncertain tool outcome blocks execution/)
  })

  it('ToolRuntime pre-effect persistence failure: fail closed before dispatch, zero side-effect, and reverts in-memory record', async () => {
    const ticket = await h.acceptedTicket(feishu('pre-persist-1', '@bot Fix pre-persist fixture'))
    const agent = h.agents.get(ticket.sessionId)!
    const ledger = h.runtime.executor.toolLedger(ticket.ticket.id)

    let effectCount = 0
    const register = (h.runtime.sessions as any).registerTool(agent, { disposers: [] })
    register(
      'synthetic_effectful_pre_fail',
      'tool with pre-effect persistence failure',
      z.object({ cmd: z.string() }),
      async () => {
        effectCount++
        return { success: true }
      }
    )

    // Force store.set to throw synthetic persistence error
    const originalSet = h.runtime.store.set
    vi.spyOn(h.runtime.store, 'set').mockImplementation((key: any, val: any) => {
      if (typeof key === 'string' && key.includes('ticket-tool-ledger')) {
        throw new Error('synthetic persistence error: disk full or database locked')
      }
      return originalSet.call(h.runtime.store, key, val)
    })

    const tool = h.tools.get(ticket.sessionId)!.get('synthetic_effectful_pre_fail')!
    await expect(tool.execute({ cmd: 'write' }, { callId: 'call-pre-fail-1', signal: new AbortController().signal } as never)).rejects.toThrow(/synthetic persistence error/)

    // Invariant: Effect was NEVER dispatched
    expect(effectCount).toBe(0)
    // Invariant: Ledger record is reverted (deleted), not lingering in-flight or completed
    expect(ledger.record('call-pre-fail-1')).toBeUndefined()
    vi.restoreAllMocks()
  })

  it('ToolRuntime post-effect persistence failure: marks uncertain in-memory and blocks subsequent execution', async () => {
    const ticket = await h.acceptedTicket(feishu('post-persist-1', '@bot Fix post-persist fixture'))
    const agent = h.agents.get(ticket.sessionId)!
    const ledger = h.runtime.executor.toolLedger(ticket.ticket.id)

    let effectCount = 0
    const register = (h.runtime.sessions as any).registerTool(agent, { disposers: [] })
    register(
      'synthetic_effectful_post_fail',
      'tool with post-effect persistence failure',
      z.object({ cmd: z.string() }),
      async () => {
        effectCount++
        return { success: true }
      }
    )

    // Let recordStart persist successfully, then fail on recordCompletion
    let setCalls = 0
    const originalSet = h.runtime.store.set
    vi.spyOn(h.runtime.store, 'set').mockImplementation((key: any, val: any) => {
      if (typeof key === 'string' && key.includes('ticket-tool-ledger')) {
        setCalls++
        if (setCalls > 1) {
          throw new Error('synthetic post-effect persistence failure: power cut during write')
        }
      }
      return originalSet.call(h.runtime.store, key, val)
    })

    const tool = h.tools.get(ticket.sessionId)!.get('synthetic_effectful_post_fail')!
    await expect(tool.execute({ cmd: 'write' }, { callId: 'call-post-fail-1', signal: new AbortController().signal } as never)).rejects.toThrow(/synthetic post-effect persistence failure/)

    // Side effect happened once
    expect(effectCount).toBe(1)
    // Outcome marked uncertain honestly
    expect(ledger.record('call-post-fail-1')?.status).toBe('uncertain')
    expect(ledger.hasUncertain()).toBe(true)

    // Subsequent tool execution is strictly blocked
    await expect(tool.execute({ cmd: 'write-2' }, { callId: 'call-post-fail-2', signal: new AbortController().signal } as never)).rejects.toThrow(/Uncertain tool outcome blocks execution/)

    // Recovery test: on restart / resume, restored in-flight state marks uncertain
    h.runtime.executor.resume()
    const cleanLedger = new ToolExecutionLedger()
    const stored = h.runtime.store.get(KV.sessions.toolLedgers(ticket.ticket.id))
    expect(stored).toBeDefined()
    cleanLedger.restore(stored as never)
    cleanLedger.markInFlightUncertain()
    expect(cleanLedger.hasUncertain()).toBe(true)
    expect(() => cleanLedger.guard('call-any')).toThrow(/Uncertain tool outcome blocks execution/)
    vi.restoreAllMocks()
  })
})
