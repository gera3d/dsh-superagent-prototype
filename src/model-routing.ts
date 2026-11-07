/** Shared, browser-safe routing policy. No credentials or host services. */
import { ECONOMY_ROUTE } from './economy.ts'
import type { RoleModel, Settings, SubscriptionAvailability } from './policy.ts'

/** The two job types whose default model an existing settings block names: assessment (Eval) and execution (Executor). */
export type JobType = 'eval' | 'executor'
/** DeepSeek's cheap flash model: last-resort fallback when no model in the escalation ladder is available. */
export const DEEPSEEK_FALLBACK_ROUTE: RoleModel = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
}
/** Re-exported so routing callers and tests use the one qualified economy route definition. */
export { ECONOMY_ROUTE }
/** Operator marks one provider available, exhausted or temporarily conserved; only the mark, never the saved order. */
export type SubscriptionStatus = SubscriptionAvailability['status']
export interface ProviderState { status: SubscriptionStatus; resetAt?: string }
/** A provider the resolver skipped, with the operator-facing reason the settings panel and `models` resource show. */
export interface SkippedProvider extends ProviderState { provider: string; reason: string }
/**
 * Availability is a subscription fact, kept separate from capability (whether a route still resolves through DSH and
 * whether escalation is allowed). An absent mark means available, so old settings keep every provider in play.
 */
export function providerState(settings: Pick<Settings, 'models'>, provider: string): ProviderState {
  const mark = settings.models.subscriptions.find(entry => entry.provider === provider)
  return { status: mark?.status ?? 'available', ...(mark?.resetAt ? { resetAt: mark.resetAt } : {}) }
}
/** One-line reason a parked provider is skipped, or `undefined` while it is available. */
export function routeSkipReason(settings: Pick<Settings, 'models'>, route: RoleModel): string | undefined {
  const state = providerState(settings, route.provider)
  if (state.status === 'available') return undefined
  const until = state.resetAt ? `; reset reminder ${state.resetAt} (manual reactivation required)` : ''
  return state.status === 'exhausted'
    ? `${route.provider} is marked exhausted${until}; the saved route is kept but skipped.`
    : `${route.provider} is temporarily conserved${until}; the saved route is kept but skipped.`
}
/** Whether conserve/economy mode is explicitly enabled. It is off by default and never inferred from provider errors. */
export const conservationActive = (settings: Pick<Settings, 'models'>): boolean => settings.models.conserve === true
/** The economy route: the operator's override when set, else the qualified DeepSeek Flash 1017 Particle route. */
export function economyRoute(settings: Pick<Settings, 'models'>): RoleModel {
  const route = plainRoute(settings.models.economyRoute ?? ECONOMY_ROUTE)
  const reason = routeSkipReason(settings, route)
  if (reason) throw new Error(`Economy route unavailable: ${reason}`)
  return route
}
/** Every provider the resolver skips, in hierarchy order, with its reason; used by the panel and the `models` resource. */
export function skippedProviders(settings: Pick<Settings, 'models'>): SkippedProvider[] {
  const providers = [...new Set(settings.models.hierarchy.map(entry => entry.provider))]
  return providers.flatMap(provider => {
    const state = providerState(settings, provider)
    const reason = routeSkipReason(settings, { provider, model: '*' })
    return reason ? [{ provider, ...state, reason }] : []
  })
}

const UNAVAILABLE_PATTERNS = [
  'unavailable',
  'cooldown',
  'budget_exceeded',
  'budget has been exceeded',
  'over its model budget',
  'rate limit',
  'rate_limit',
  'quota',
  'resource_exhausted',
  'overloaded',
  'outage',
  'econnreset',
  'econnrefused',
  'etimedout',
  'eai_again',
  'enotfound',
  'socket hang up',
  'fetch failed',
  'network error',
]

/**
 * Identifies whether an error is due to model availability (quota cooldown, account unavailable, outage,
 * budget exceeded, rate limit). Does NOT match ordinary task failures, logic errors, or bad output.
 */
export function isModelUnavailable(error: unknown): boolean {
  if (!error) return false
  const status = (error as { status?: unknown })?.status
  if (typeof status === 'number' && (status === 408 || status === 429 || status >= 500)) return true
  const code = (error as { code?: unknown })?.code
  if (typeof code === 'string' && /UNAVAILABLE|RESOURCE_EXHAUSTED|RATE_LIMIT|OVERLOADED|QUOTA|COOLDOWN|BUDGET/i.test(code)) return true
  const text = error instanceof Error ? `${error.name} ${error.message} ${String(code ?? '')}` : String(error)
  const lower = text.toLowerCase()
  return UNAVAILABLE_PATTERNS.some(pat => lower.includes(pat))
}

/** The route itself, without the hierarchy's presentation flags. */
const plainRoute = ({ provider, model, reasoningEffort }: RoleModel): RoleModel =>
  ({ provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) })
/** Whether two routes select the same provider, model and reasoning effort. */
export const sameRoute = (a: RoleModel, b: RoleModel): boolean => a.provider === b.provider && a.model === b.model
  && (a.reasoningEffort ?? '') === (b.reasoningEffort ?? '')
/** The starred routes, in hierarchy order: the models the deployment uses most. */
export const starredRoutes = (settings: Pick<Settings, 'models'>): RoleModel[] =>
  settings.models.hierarchy.filter(entry => entry.starred).map(plainRoute)
/**
 * The route a job type starts on: its own block's configured model, else the first starred route, else the first route of
 * the hierarchy. `null` leaves the DSH default in place.
 */
export function defaultRoute(settings: Pick<Settings, 'eval' | 'executor' | 'models'>, job: JobType): RoleModel | null {
  return constrainedRoute(settings, job === 'eval' ? settings.eval.model : settings.executor.model)
}
/** Re-evaluate an inherited/source/escalated route at each managed request boundary. */
export function constrainedRoute(settings: Pick<Settings, 'models'>, candidate?: RoleModel | null): RoleModel | null {
  if (conservationActive(settings)) return economyRoute(settings)
  if (candidate && !routeSkipReason(settings, candidate)) return plainRoute(candidate)
  const route = [...starredRoutes(settings), ...settings.models.hierarchy.map(plainRoute)]
    .find(entry => !routeSkipReason(settings, entry))
  if (route) return plainRoute(route)
  if (candidate || settings.models.subscriptions.some(entry => entry.status !== 'available'))
    throw new Error('No eligible managed model route; restore a provider or configure an available economy route')
  return null
}
/** Both job types' starting routes, as the settings panel and the `models` resource report them. */
export const roleDefaults = (settings: Pick<Settings, 'eval' | 'executor' | 'models'>): Record<'orchestrator' | 'worker', RoleModel | null> =>
  ({ orchestrator: defaultRoute(settings, 'eval'), worker: defaultRoute(settings, 'executor') })
/**
 * The helper role's route: the configured helper route, else the first starred route, else the first hierarchy route.
 * Conserve mode sends the helper to the economy route as well.
 */
export function helperRoute(settings: Pick<Settings, 'models'>): RoleModel | null {
  return constrainedRoute(settings, settings.models.helper)
}
/** The configured-model ranker/evaluator route: the economy route in conserve mode, else the supplied fallback. */
export function evaluatorRoute(settings: Pick<Settings, 'models'>, fallback?: RoleModel | null): RoleModel | null {
  return constrainedRoute(settings, fallback)
}
/** Effective routes and skipped providers for the settings panel and the `models` resource. */
export function routingView(settings: Pick<Settings, 'eval' | 'executor' | 'models'>) {
  const errors: string[] = []
  const safe = (resolve: () => RoleModel | null) => { try { return resolve() } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error)); return null
  } }
  return { conserve: conservationActive(settings), economy_route: safe(() => economyRoute(settings)),
    effective: { orchestrator: safe(() => defaultRoute(settings, 'eval')), worker: safe(() => defaultRoute(settings, 'executor')),
      helper: safe(() => helperRoute(settings)), ranker: conservationActive(settings) ? safe(() => economyRoute(settings)) : null },
    skipped: skippedProviders(settings), errors: [...new Set(errors)] }
}
/**
 * The routes a job type may still escalate to, in hierarchy order after its current route. `previous` is the last escalated
 * route and `used` how many escalations the ticket already recorded; the hierarchy's `maxEscalations` caps the latter.
 */
export function escalationChain(settings: Pick<Settings, 'eval' | 'executor' | 'models'>, job: JobType, previous?: RoleModel,
  used = 0): RoleModel[] {
  // Conserve mode pins the economy route; escalating would spend the parked subscription allowances.
  if (conservationActive(settings)) return []
  if (used >= settings.models.maxEscalations) return []
  const current = previous ?? defaultRoute(settings, job)
  const hierarchy = settings.models.hierarchy
  // A current route outside the hierarchy leaves the whole hierarchy open; one inside it starts after its own place.
  const index = current ? hierarchy.findIndex(entry => sameRoute(entry, current)) : -1
  return hierarchy.slice(index + 1).filter(entry => !current || !sameRoute(entry, current))
    .filter(entry => !routeSkipReason(settings, entry)).map(plainRoute)
}
/**
 * The next escalation step for a job type: from its current route to the next hierarchy route, or `undefined` once the
 * hierarchy ends or the ticket reached `maxEscalations`.
 */
export function escalationStep(settings: Pick<Settings, 'eval' | 'executor' | 'models'>, job: JobType, previous?: RoleModel,
  used = 0): { from: RoleModel; to: RoleModel } | undefined {
  const from = previous ?? defaultRoute(settings, job)
  const to = escalationChain(settings, job, previous, used)[0]
  return from && to ? { from, to } : undefined
}

/**
 * When a model cannot serve a request due to availability reasons, determine the next fallback route:
 * 1. Try the next available model in the escalation ladder (hierarchy);
 * 2. When none of Gemini, GPT and Claude (the ladder) can serve it, fall back to DeepSeek's cheap flash model.
 * DeepSeek flash is NOT a rung of the escalation ladder and hard tasks never escalate to it.
 */
export function unavailableFallbackStep(
  settings: Pick<Settings, 'models'>,
  current?: RoleModel | null,
  triedRoutes: RoleModel[] = []
): { from?: RoleModel; to: RoleModel; isDeepSeekFlash: boolean } | undefined {
  // Conserve mode has one sanctioned route. If it fails, surface the failure instead of silently spending a parked
  // subscription, so availability never becomes implicit capability escalation.
  if (conservationActive(settings)) return undefined
  // Parked providers are excluded from every automatic fallback, not only from the ladder's top.
  const ladder = settings.models.hierarchy.map(plainRoute).filter(route => !routeSkipReason(settings, route))
  const hasTried = (route: RoleModel) => triedRoutes.some(item => sameRoute(item, route))

  // Find next route in the ladder after current that hasn't been tried
  if (current) {
    const currentIndex = ladder.findIndex(item => sameRoute(item, current))
    if (currentIndex >= 0) {
      for (let i = currentIndex + 1; i < ladder.length; i++) {
        if (!hasTried(ladder[i]!)) {
          return { from: current, to: ladder[i]!, isDeepSeekFlash: false }
        }
      }
    }
  }

  // If current was not in ladder or reached end of ladder, check any earlier untried ladder route
  for (const rung of ladder) {
    if ((!current || !sameRoute(current, rung)) && !hasTried(rung)) {
      return { from: current ?? undefined, to: rung, isDeepSeekFlash: false }
    }
  }

  // All ladder routes have been tried or are unavailable. Fall back to DeepSeek cheap flash!
  if (!routeSkipReason(settings, DEEPSEEK_FALLBACK_ROUTE) && !hasTried(DEEPSEEK_FALLBACK_ROUTE)
    && (!current || !sameRoute(current, DEEPSEEK_FALLBACK_ROUTE))) {
    return { from: current ?? undefined, to: DEEPSEEK_FALLBACK_ROUTE, isDeepSeekFlash: true }
  }

  return undefined
}

/** Plain-language one-line note for when a model fallback triggers. */
export function fallbackNote(to: RoleModel, reason: string): string {
  const modelName = `${to.provider}/${to.model}`
  const why = reason.replace(/\s+/g, ' ').slice(0, 150)
  if (to.provider === DEEPSEEK_FALLBACK_ROUTE.provider && to.model === DEEPSEEK_FALLBACK_ROUTE.model) {
    return `Fell back to DeepSeek cheap flash model (${modelName}): ${why}. Quality may be lower.`
  }
  return `Fell back to available ladder model (${modelName}): ${why}.`
}
