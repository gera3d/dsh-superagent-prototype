import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { agentEvents, installModelSelection, type Agent, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { defaultRoute, escalationChain, escalationStep, initializeRoleModel, roleDefaults, sameRoute, selectRoleModel, starredRoutes }
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

it('walks the hierarchy from the job type\'s route, one route per escalation and only up to the cap', () => {
  const settings = configured()
  expect(starredRoutes(settings)).toEqual([gemini, sol, sonnet])
  expect(escalationChain(settings, 'executor')).toEqual([sol, sonnet])
  expect(escalationStep(settings, 'executor')).toEqual({ from: gemini, to: sol })
  // The second escalation continues from the first one's route, not from the default again.
  expect(escalationStep(settings, 'executor', sol, 1)).toEqual({ from: sol, to: sonnet })
  // At the cap, and at the end of the hierarchy, nothing escalates.
  expect(escalationStep(settings, 'executor', sol, 2)).toBeUndefined()
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
