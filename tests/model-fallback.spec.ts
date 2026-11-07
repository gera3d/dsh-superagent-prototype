import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { latestAssignment, waitsForPerson, type Ticket } from '../src/core/index.ts'
import { DEEPSEEK_FALLBACK_ROUTE, fallbackNote, isModelUnavailable, unavailableFallbackStep } from '../src/app/role-models.ts'
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
})
