import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { agentEvents, installModelSelection, type Agent, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { installRoutingGuard, defaultRoute, DEEPSEEK_FALLBACK_ROUTE, escalationChain, escalationStep, fallbackNote, isFallbackOnlyRoute, qualityEscalation, initializeRoleModel, isModelUnavailable, roleDefaults, sameRoute, selectRoleModel, starredRoutes, unavailableFallbackStep }
  from '../src/app/role-models.ts'
import { SettingsSchema } from '../src/policy.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
async function fixture() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(SystemPrompt)
  const resolve = vi.fn(async value => value)
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const agent = { ctx, session } as Agent
  const host: ModelSelectionRef = { get current() { return session.requestHeader()?.config ?? { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') } }, assembled: undefined }
  installModelSelection(ctx, host)
  const request = () => agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'seed', model: 'seed' }))
  const record = (selection: ModelSelection) => { const event = session.append('request/header', { header: { config: selection }, reason: 'initial' }); ctx.emit('session/event', session, event) }
  return { ctx, agent, host, resolve, flush, request, record }
}
it('keeps prompt variables and initial routing on the role model without saving the host default', async () => {
  const { ctx, agent, request, record, flush } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker-provider', model: 'worker-model' })
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'worker-provider', model: 'worker-model' })
  const selected = await request()
  expect(selected).toEqual({ provider: 'worker-provider', model: 'worker-model' })
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(true)
  expect(flush).toHaveBeenCalledOnce()
  record(selected)
  // A retry of the same assembled step keeps the same model even after the header is persisted.
  expect(await request()).toEqual(selected)
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(selected)
})
it('lets a later explicit selection win without changing the in-flight assembled step', async () => {
  const { ctx, agent, host, request } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  await ctx.systemPrompt.assemble()
  const manual = { provider: 'manual', model: 'two', reasoningEffort: ReasoningEffortId('low') }
  Object.defineProperty(host, 'current', { value: manual, configurable: true })
  const event = agent.session.append('model/selection', manual); ctx.emit('session/event', agent.session, event)
  expect(await request()).toEqual({ provider: 'worker', model: 'one' })
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(manual)
})
it.each(['header', 'selection'])('preserves a resumed Session with existing %s', async kind => {
  const { ctx, agent, resolve } = await fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else agent.session.append('model/selection', existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).not.toHaveBeenCalled()
})
it('inherits the host when unset and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve, request } = await fixture()
  await initializeRoleModel(ctx, agent, null)
  await ctx.systemPrompt.assemble()
  expect(await request()).toMatchObject({ provider: 'host', model: 'default' })
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
})

const gemini = { provider: 'antigravity', model: 'gemini-3.8-flash' }
const sol = { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' }
const sonnet = { provider: 'anthropic', model: 'claude-sonnet-5-5' }
const hierarchy = (...entries: { provider: string; model: string; reasoningEffort?: string; starred?: boolean }[]) =>
  entries.map(entry => ({ ...entry, starred: entry.starred ?? true }))
const configured = (overrides: Record<string, unknown> = {}) => SettingsSchema.parse({
  models: { hierarchy: hierarchy(gemini, sol, sonnet), maxEscalations: 2 }, ...overrides })

it('starts a job type on its configured model, else the first starred route, else the first hierarchy route', () => {
  const base = configured()
  expect(defaultRoute(base, 'eval')).toEqual(gemini)
  expect(defaultRoute(base, 'executor')).toEqual(gemini)
  expect(defaultRoute(configured({ eval: { model: sol }, executor: { model: sonnet } }), 'eval')).toEqual(sol)
  expect(defaultRoute(configured({ eval: { model: sol }, executor: { model: sonnet } }), 'executor')).toEqual(sonnet)
  // An unstarred first route is not a default while another route is starred.
  expect(defaultRoute(configured({ models: { hierarchy: hierarchy({ ...gemini, starred: false }, sol, sonnet), maxEscalations: 2 } }),
    'executor')).toEqual(sol)
  expect(defaultRoute(SettingsSchema.parse({ models: { hierarchy: hierarchy({ ...gemini, starred: false }), maxEscalations: 0 } }),
    'executor')).toEqual(gemini)
  expect(defaultRoute(SettingsSchema.parse({}), 'executor')).toBeNull()
})

it('walks the hierarchy from the job type\'s route for exactly one quality escalation', () => {
  const settings = configured()
  expect(starredRoutes(settings)).toEqual([gemini, sol, sonnet])
  expect(escalationChain(settings, 'executor')).toEqual([sol, sonnet])
  expect(escalationStep(settings, 'executor')).toEqual({ from: gemini, to: sol })
  // One attempt per job: a recorded escalation ends quality escalation even though maxEscalations allows two.
  expect(escalationStep(settings, 'executor', sol, 1)).toBeUndefined()
  expect(escalationStep(settings, 'executor', sol, 2)).toBeUndefined()
  // At the end of the hierarchy nothing escalates either.
  expect(escalationStep(settings, 'executor', sonnet, 0)).toBeUndefined()
  expect(escalationStep(settings, 'executor', sonnet, 1)).toBeUndefined()
  expect(escalationStep(configured({ executor: { model: sol } }), 'executor')).toEqual({ from: sol, to: sonnet })
  expect(escalationStep(configured({ models: { hierarchy: hierarchy(gemini, sol, sonnet), maxEscalations: 0 } }), 'executor')).toBeUndefined()
})

it('treats a job route outside the hierarchy as starting before it and compares routes including effort', () => {
  const outside = { provider: 'local', model: 'tiny' }
  const settings = configured({ executor: { model: outside } })
  expect(escalationStep(settings, 'executor')).toEqual({ from: outside, to: gemini })
  expect(sameRoute(sol, { ...sol })).toBe(true)
  expect(sameRoute(sol, { ...sol, reasoningEffort: 'low' })).toBe(false)
  expect(escalationStep(configured({ models: { hierarchy: hierarchy(gemini, { ...gemini, reasoningEffort: 'low' }), maxEscalations: 2 } }),
    'executor')).toEqual({ from: gemini, to: { ...gemini, reasoningEffort: 'low' } })
  expect(roleDefaults(settings)).toEqual({ orchestrator: gemini, worker: outside })
})

it('selects a route for the next request of an existing Session without changing the global default', async () => {
  const { ctx, agent, request, record, flush } = await fixture()
  record({ provider: 'weak', model: 'small' })
  await selectRoleModel(ctx, agent, { provider: 'strong', model: 'big' })
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual({ provider: 'strong', model: 'big' })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
  expect(flush).toHaveBeenCalledOnce()
})

it('identifies availability failures and distinguishes them from ordinary task errors', () => {
  expect(isModelUnavailable(new Error('All Antigravity accounts are unavailable: no account can serve google right now (1 in cooldown)'))).toBe(true)
  expect(isModelUnavailable(new Error('Quota exceeded for model gemini-3.8-flash'))).toBe(true)
  expect(isModelUnavailable(new Error('Budget has been exceeded'))).toBe(true)
  expect(isModelUnavailable({ status: 429, message: 'rate limit' })).toBe(true)
  expect(isModelUnavailable({ status: 503, message: 'Service Unavailable' })).toBe(true)
  expect(isModelUnavailable({ code: 'RESOURCE_EXHAUSTED' })).toBe(true)
  expect(isModelUnavailable(new Error('ECONNRESET'))).toBe(true)
  // Ordinary task failures, logic errors, or bad outputs must NOT trigger availability fallback
  expect(isModelUnavailable(new Error('SyntaxError: Unexpected token'))).toBe(false)
  expect(isModelUnavailable(new Error('AssertionError: expected true to be false'))).toBe(false)
  expect(isModelUnavailable(new Error('Command failed with exit code 1'))).toBe(false)
  expect(isModelUnavailable(null)).toBe(false)
})

it('falls back through the ladder on availability failure, and lands on DeepSeek flash when all ladder models are unavailable', () => {
  const settings = configured()
  // When Gemini fails for availability reasons, next in ladder is GPT-6.1 Sol
  const step1 = unavailableFallbackStep(settings, gemini, [gemini])
  expect(step1).toEqual({ from: gemini, to: sol, isDeepSeekFlash: false })

  // When Sol also fails for availability reasons, next in ladder is Claude Sonnet
  const step2 = unavailableFallbackStep(settings, sol, [gemini, sol])
  expect(step2).toEqual({ from: sol, to: sonnet, isDeepSeekFlash: false })

  // When all models in the ladder (Gemini, Sol, Sonnet) are unavailable, fall back to DeepSeek cheap flash!
  const step3 = unavailableFallbackStep(settings, sonnet, [gemini, sol, sonnet])
  expect(step3).toEqual({ from: sonnet, to: DEEPSEEK_FALLBACK_ROUTE, isDeepSeekFlash: true })
  expect(DEEPSEEK_FALLBACK_ROUTE).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })

  // When DeepSeek flash is also tried/unavailable, no further fallback exists
  expect(unavailableFallbackStep(settings, DEEPSEEK_FALLBACK_ROUTE, [gemini, sol, sonnet, DEEPSEEK_FALLBACK_ROUTE])).toBeUndefined()
})

it('ensures hard task escalation only climbs the ladder once and NEVER escalates to DeepSeek flash', () => {
  const settings = configured()
  expect(escalationStep(settings, 'executor')).toEqual({ from: gemini, to: sol })
  // The one attempt is spent: no second rung, and never DeepSeek flash.
  expect(escalationStep(settings, 'executor', sol, 1)).toBeUndefined()
  // Even with a higher maxEscalations (e.g. 5), one attempt is the most a job gets.
  const uncapped = configured({ models: { hierarchy: hierarchy(gemini, sol, sonnet), maxEscalations: 5 } })
  expect(escalationStep(uncapped, 'executor', sonnet, 1)).toBeUndefined()
  expect(escalationStep(uncapped, 'executor', sol, 1)).toBeUndefined()
})

it('formats a plain-language fallback note for the ticket warning quality may be lower', () => {
  const deepseekNote = fallbackNote(DEEPSEEK_FALLBACK_ROUTE, 'All Antigravity accounts are unavailable (1 in cooldown)')
  expect(deepseekNote).toBe('Fell back to DeepSeek cheap flash model (deepseek-official/deepseek-flash): All Antigravity accounts are unavailable (1 in cooldown). Quality may be lower.')

  const ladderNote = fallbackNote(sol, 'Antigravity quota cooldown')
  expect(ladderNote).toBe('Fell back to available ladder model (openai-codex/gpt-6.1-sol): Antigravity quota cooldown.')
})

it('overrides an already selected premium session on the next managed request and restores it when conservation ends', async () => {
  const { ctx, agent, request } = await fixture()
  const premium = { provider: 'premium', model: 'strong' }
  const cheap = { provider: 'economy', model: 'cheap' }
  await initializeRoleModel(ctx, agent, premium)
  await ctx.systemPrompt.assemble()
  let settings = SettingsSchema.parse({ models: { conserve: true, economyRoute: cheap } })
  let dispose = installRoutingGuard(ctx, agent, () => settings)
  expect(await request()).toEqual(cheap)
  settings = SettingsSchema.parse({ models: { subscriptions: [{ provider: 'premium', status: 'exhausted' }], hierarchy: [cheap] } })
  expect(await request()).toEqual(cheap)
  settings.models.hierarchy = []
  await expect(request()).rejects.toThrow('No eligible')
  settings = SettingsSchema.parse({})
  expect(await request()).toEqual(premium)
  dispose()
  await selectRoleModel(ctx, agent, premium)
  settings = SettingsSchema.parse({ models: { conserve: true, economyRoute: cheap } })
  dispose = installRoutingGuard(ctx, agent, () => settings)
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(cheap)
  dispose()
})

const particle = { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' }
const subscription = () => SettingsSchema.parse({
  models: { hierarchy: hierarchy(gemini, sol, sonnet, { ...particle, starred: false }), maxEscalations: 1, economyRoute: particle,
    subscriptions: [{ provider: sol.provider, status: 'conserved' }] } })
it('picks Sonnet as the one quality escalation, skipping conserved OpenAI and never a DeepSeek route', () => {
  const settings = subscription()
  expect(qualityEscalation(settings, {}, 'tests fail: 3 failing')).toEqual({ from: gemini, to: sonnet })
  expect(escalationChain(settings, 'executor')).toEqual([sonnet])
  expect(isFallbackOnlyRoute(settings, particle)).toBe(true)
  expect(isFallbackOnlyRoute(settings, DEEPSEEK_FALLBACK_ROUTE)).toBe(true)
  expect(isFallbackOnlyRoute(settings, sonnet)).toBe(false)
})
it('spends the quality attempt once across restarts and replays, whatever the settings cap says', () => {
  const settings = SettingsSchema.parse({ ...subscription(), models: { ...subscription().models, maxEscalations: 9 } })
  expect(qualityEscalation(settings, {}, 'failed')).toEqual({ from: gemini, to: sonnet })
  // The persisted escalation record alone decides, so a replayed or restarted evaluation finds the attempt spent.
  expect(qualityEscalation(settings, { escalations: [{ to: sonnet }] }, 'failed')).toBeUndefined()
  expect(qualityEscalation(settings, { escalations: [{ to: sonnet }] }, 'failed', particle)).toBeUndefined()
})
it('gives no quality escalation without evidence, when off, when already on Sonnet or a DeepSeek route, or when nothing is eligible', () => {
  const settings = subscription()
  expect(qualityEscalation(settings, {}, '   ')).toBeUndefined()
  expect(qualityEscalation(SettingsSchema.parse({ ...settings, models: { ...settings.models, maxEscalations: 0 } }), {}, 'failed')).toBeUndefined()
  expect(qualityEscalation(settings, {}, 'failed', sonnet)).toBeUndefined()
  // A route that differs only by reasoning effort is still Sonnet.
  expect(qualityEscalation(settings, {}, 'failed', { ...sonnet, reasoningEffort: 'high' })).toBeUndefined()
  expect(qualityEscalation(settings, {}, 'failed', particle)).toBeUndefined()
  const anthropicParked = SettingsSchema.parse({ ...settings, models: { ...settings.models,
    subscriptions: [...settings.models.subscriptions, { provider: sonnet.provider, status: 'exhausted' }] } })
  expect(qualityEscalation(anthropicParked, {}, 'failed')).toBeUndefined()
  // Conserve mode pins the economy route and never escalates.
  expect(qualityEscalation(SettingsSchema.parse({ ...settings, models: { ...settings.models, conserve: true } }), {}, 'failed')).toBeUndefined()
})
it('keeps availability fallback separate: eligible providers first, then the pinned economy DeepSeek route, with OpenAI excluded', () => {
  const settings = subscription()
  expect(unavailableFallbackStep(settings, gemini, [gemini])).toEqual({ from: gemini, to: sonnet, isDeepSeekFlash: false })
  expect(unavailableFallbackStep(settings, sonnet, [gemini, sonnet])).toEqual({ from: sonnet, to: particle, isDeepSeekFlash: false })
  // The pinned route is a ladder rung here; with the ladder spent there is no unqualified direct-DeepSeek substitution.
  expect(unavailableFallbackStep(settings, particle, [gemini, sonnet, particle])).toBeUndefined()
  const hierarchyOnly = SettingsSchema.parse({ models: { hierarchy: hierarchy(gemini, sonnet), economyRoute: particle,
    subscriptions: [{ provider: sol.provider, status: 'conserved' }] } })
  expect(unavailableFallbackStep(hierarchyOnly, sonnet, [gemini, sonnet])).toEqual({ from: sonnet, to: particle, isDeepSeekFlash: true })
  expect(fallbackNote(particle, 'quota')).toContain('Quality may be lower')
})
