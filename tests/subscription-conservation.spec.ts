import { expect, it } from 'vitest'
import { ECONOMY_ROUTE } from '../src/economy.ts'
import { SettingsSchema } from '../src/policy.ts'
import { conservationActive, defaultRoute, economyRoute, escalationChain, evaluatorRoute, helperRoute,
  providerState, roleDefaults, routingView, routeSkipReason, unavailableFallbackStep } from '../src/app/role-models.ts'

const gemini = { provider: 'antigravity', model: 'gemini-3.8-flash' }
const sol = { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' }
const sonnet = { provider: 'anthropic', model: 'claude-sonnet-5-5' }
const hierarchy = (...entries: ({ provider: string; model: string; reasoningEffort?: string } | undefined)[]) =>
  entries.filter(Boolean).map(entry => ({ ...entry!, starred: true }))

/** A pre-conservation settings block, as an older installation saved it. */
const legacy = () => SettingsSchema.parse({ models: { hierarchy: hierarchy(gemini, sol, sonnet), maxEscalations: 2 },
  eval: { model: sol }, executor: { model: sonnet } })
const conserved = (marks: { provider: string; status: 'available' | 'exhausted' | 'conserved'; resetAt?: string }[] = []) =>
  SettingsSchema.parse({ models: { hierarchy: hierarchy(gemini, sol, sonnet), maxEscalations: 2, conserve: true, subscriptions: marks },
    eval: { model: sol }, executor: { model: sonnet } })

it('keeps old settings on their saved priority order and conservation off until enabled', () => {
  const settings = legacy()
  expect(settings.models.conserve).toBe(false)
  expect(conservationActive(settings)).toBe(false)
  expect(defaultRoute(settings, 'eval')).toEqual(sol)
  expect(defaultRoute(settings, 'executor')).toEqual(sonnet)
  expect(escalationChain(settings, 'eval')).toEqual([sonnet])
  expect(roleDefaults(settings)).toEqual({ orchestrator: sol, worker: sonnet })
  expect(settings.models.economyRoute).toEqual(ECONOMY_ROUTE)
})

it('routes every managed role to the qualified economy route in conserve mode', () => {
  const settings = conserved()
  expect(conservationActive(settings)).toBe(true)
  expect(economyRoute(settings)).toEqual(ECONOMY_ROUTE)
  expect(defaultRoute(settings, 'eval')).toEqual(ECONOMY_ROUTE)
  expect(defaultRoute(settings, 'executor')).toEqual(ECONOMY_ROUTE)
  expect(helperRoute(settings)).toEqual(ECONOMY_ROUTE)
  expect(evaluatorRoute(settings, sol)).toEqual(ECONOMY_ROUTE)
  expect(routingView(settings).effective).toEqual({ orchestrator: ECONOMY_ROUTE, worker: ECONOMY_ROUTE,
    helper: ECONOMY_ROUTE, ranker: ECONOMY_ROUTE })
  // Conserve mode pins the economy route; it does not escalate into the parked subscriptions.
  expect(escalationChain(settings, 'executor')).toEqual([])
  expect(unavailableFallbackStep(settings, ECONOMY_ROUTE)).toBeUndefined()
})

it('skips exhausted and temporarily conserved providers for starting routes and escalation', () => {
  const exhausted = SettingsSchema.parse({ models: { hierarchy: hierarchy(gemini, sol, sonnet), maxEscalations: 2,
    subscriptions: [{ provider: 'openai-codex', status: 'exhausted', resetAt: '2026-11-20T00:00:00Z' }] },
  executor: { model: sol } })
  expect(providerState(exhausted, 'openai-codex')).toMatchObject({ status: 'exhausted' })
  expect(defaultRoute(exhausted, 'executor')).toEqual(gemini)
  expect(routeSkipReason(exhausted, sol)).toContain('exhausted')
  expect(escalationChain(exhausted, 'executor')).toEqual([sonnet])
  const fallback = unavailableFallbackStep(exhausted, gemini)
  expect(fallback?.to).toEqual(sonnet)

  const conservedAnthropic = SettingsSchema.parse({ models: { hierarchy: hierarchy(gemini, sol, sonnet),
    subscriptions: [{ provider: 'anthropic', status: 'conserved' }] } })
  expect(escalationChain(conservedAnthropic, 'executor')).toEqual([sol])
  expect(routeSkipReason(conservedAnthropic, sonnet)).toContain('conserved')
})

it('never falls back into a parked subscription provider', () => {
  const settings = SettingsSchema.parse({ models: { hierarchy: hierarchy(gemini, sol, sonnet),
    subscriptions: [{ provider: 'deepseek-official', status: 'exhausted' }] } })
  // The ladder ends at Sonnet; the last-resort DeepSeek fallback is parked, so the resolver reports no step once the
  // ladder routes were already tried. A parked provider is never used as the remaining untried route.
  expect(unavailableFallbackStep(settings, sonnet, [gemini, sol, sonnet])).toBeUndefined()
  expect(unavailableFallbackStep(settings, sonnet)?.to).toEqual(gemini)
  // A provider absent from the marks is available, so old settings keep the last-resort fallback.
  expect(unavailableFallbackStep(legacy(), sonnet, [gemini, sol, sonnet])?.to)
    .toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
})

it('restores the saved normal priority order when conservation is switched off and marks are cleared', () => {
  const before = legacy()
  const during = SettingsSchema.parse({ ...before, models: { ...before.models, conserve: true,
    subscriptions: [{ provider: 'anthropic', status: 'conserved' }] } })
  expect(defaultRoute(during, 'executor')).toEqual(ECONOMY_ROUTE)
  const after = SettingsSchema.parse({ ...during, models: { ...during.models, conserve: false, subscriptions: [] } })
  expect(defaultRoute(after, 'eval')).toEqual(sol)
  expect(defaultRoute(after, 'executor')).toEqual(sonnet)
  expect(escalationChain(after, 'eval')).toEqual([sonnet])
  // The hierarchy and both role routes were never rewritten by conservation.
  expect(after.models.hierarchy).toEqual(before.models.hierarchy)
  expect(after.eval.model).toEqual(before.eval.model)
  expect(after.executor.model).toEqual(before.executor.model)
})

it('keeps availability separate from capability and from saved connections', () => {
  const base = legacy()
  const marked = SettingsSchema.parse({ ...base, models: { ...base.models,
    subscriptions: [{ provider: 'openai-codex', status: 'exhausted' }] } })
  // An availability mark is not a route change: capability (the hierarchy and role routes) stays exactly as saved.
  expect(marked.models.hierarchy).toEqual(base.models.hierarchy)
  expect(marked.eval.model).toEqual(base.eval.model)
  expect(marked.executor.model).toEqual(base.executor.model)
  // Connections are untouched and no mark can carry a credential.
  expect(marked.sources).toEqual(base.sources)
  expect(() => SettingsSchema.parse({ models: { subscriptions: [{ provider: 'anthropic', status: 'available',
    apiKey: 'sk-live-secret' }] } })).toThrow()
  expect(() => SettingsSchema.parse({ models: { subscriptions: [{ provider: 'anthropic', status: 'paused' }] } })).toThrow()
})

it('reports effective routes and the reason a provider is skipped', () => {
  const view = routingView(SettingsSchema.parse({ models: { hierarchy: hierarchy(gemini, sol),
    subscriptions: [{ provider: 'openai-codex', status: 'conserved' }] } }))
  expect(view.conserve).toBe(false)
  expect(view.effective.worker).toEqual(gemini)
  expect(view.skipped).toHaveLength(1)
  expect(view.skipped[0]).toMatchObject({ provider: 'openai-codex', status: 'conserved' })
  expect(view.skipped[0]!.reason).toContain('conserved')
})

it('fails closed when every configured provider or the economy provider is parked', () => {
  const settings = SettingsSchema.parse({ models: { hierarchy: hierarchy(sol), helper: sol,
    subscriptions: [{ provider: sol.provider, status: 'exhausted' }] }, executor: { model: sol } })
  expect(() => defaultRoute(settings, 'executor')).toThrow('No eligible')
  expect(() => helperRoute(settings)).toThrow('No eligible')
  expect(() => evaluatorRoute(settings, sol)).toThrow('No eligible')
  expect(routingView(settings).errors).not.toHaveLength(0)
  const economyParked = conserved([{ provider: ECONOMY_ROUTE.provider, status: 'exhausted' }])
  expect(() => economyRoute(economyParked)).toThrow('Economy route unavailable')
})
it('skips a parked source ranker route and shows the same eligible role defaults in the preview', () => {
  const settings = SettingsSchema.parse({ models: { hierarchy: hierarchy(gemini, sol), helper: sol,
    subscriptions: [{ provider: sol.provider, status: 'conserved' }] }, eval: { model: sol }, executor: { model: sol } })
  expect(evaluatorRoute(settings, sol)).toEqual(gemini)
  expect(routingView(settings).effective).toMatchObject({ orchestrator: gemini, worker: gemini, helper: gemini })
})
