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
/** Score advice on the explicitly configured helper route; otherwise inherit the source. Conservation still wins. */
export function evaluatorRoute(settings: Pick<Settings, 'models'>, fallback?: RoleModel | null): RoleModel | null {
  return constrainedRoute(settings, settings.models.helper ?? fallback)
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
/** A job gets at most one quality escalation; `maxEscalations` 0 keeps it off, and larger values never buy a second attempt. */
export const QUALITY_ESCALATION_LIMIT = 1
/**
 * Whether a route exists for availability or cost, not for quality: the economy route (the operator's override or the
 * qualified default), the direct DeepSeek flash route, or any route on a DeepSeek model. These are never a quality upgrade.
 */
export function isFallbackOnlyRoute(settings: Pick<Settings, 'models'>, route: RoleModel): boolean {
  const economy = plainRoute(settings.models.economyRoute ?? ECONOMY_ROUTE)
  const same = (a: RoleModel, b: RoleModel) => a.provider === b.provider && a.model === b.model
  return same(route, economy) || same(route, DEEPSEEK_FALLBACK_ROUTE) || /deepseek/i.test(`${route.provider} ${route.model}`)
}
/**
 * The routes a job may still use for its one quality escalation: hierarchy routes after `previous` (the route the job
 * actually runs on, else the job type's default), without parked providers and without availability-only DeepSeek routes.
 * `used` counts the quality escalations the ticket already recorded; one is the most any job gets. A job that already runs
 * on an availability-only route has no quality base and returns to a person instead.
 */
export function escalationChain(settings: Pick<Settings, 'eval' | 'executor' | 'models'>, job: JobType, previous?: RoleModel,
  used = 0): RoleModel[] {
  // Conserve mode pins the economy route; escalating would spend the parked subscription allowances.
  if (conservationActive(settings)) return []
  if (used >= Math.min(settings.models.maxEscalations, QUALITY_ESCALATION_LIMIT)) return []
  const current = previous ?? defaultRoute(settings, job)
  if (current && isFallbackOnlyRoute(settings, current)) return []
  const hierarchy = settings.models.hierarchy
  // A current route outside the hierarchy leaves the whole hierarchy open; one inside it starts after its own place. A route
  // that differs only by reasoning effort (a Session header reports its own) still holds the place of its model.
  const exact = current ? hierarchy.findIndex(entry => sameRoute(entry, current)) : -1
  const index = exact >= 0 || !current ? exact : hierarchy.findIndex(entry => entry.provider === current.provider && entry.model === current.model)
  return hierarchy.slice(index + 1).filter(entry => !current || !sameRoute(entry, current))
    .filter(entry => !routeSkipReason(settings, entry) && !isFallbackOnlyRoute(settings, entry)).map(plainRoute)
}
/**
 * The quality escalation step for a job type: from its current route to the next eligible stronger hierarchy route, or
 * `undefined` once the job used its one attempt, is already on the last eligible route, or escalation is off.
 */
export function escalationStep(settings: Pick<Settings, 'eval' | 'executor' | 'models'>, job: JobType, previous?: RoleModel,
  used = 0): { from: RoleModel; to: RoleModel } | undefined {
  const from = previous ?? defaultRoute(settings, job)
  const to = escalationChain(settings, job, previous, used)[0]
  return from && to ? { from, to } : undefined
}
/**
 * Decision for a failed executor report. Concrete evidence is the report's own non-blank summary; the text is never parsed
 * and availability failures never reach this path (the Executor marks them non-escalatable). `running` is the route the
 * worker's Session actually uses, which differs from the default after an availability fallback. The attempt count is the
 * ticket's persisted escalations, so restarts, replays and quota fallback cannot reset it.
 */
export function qualityEscalation(settings: Pick<Settings, 'eval' | 'executor' | 'models'>, ticket: { escalations?: { to: RoleModel }[] },
  reason: string, running?: RoleModel | null): { from: RoleModel; to: RoleModel } | undefined {
  if (!reason.trim()) return undefined
  const used = ticket.escalations?.length ?? 0
  return escalationStep(settings, 'executor', running ?? ticket.escalations?.at(-1)?.to, used)
}

/**
 * When a model cannot serve a request due to availability reasons, determine the next fallback route:
 * 1. Try the next available model in the escalation ladder (hierarchy);
 * 2. When no eligible ladder route can serve it, fall back to the economy route: the operator's pinned, qualified DeepSeek
 *    route when set, else the portable direct DeepSeek flash default.
 * DeepSeek is availability and cost insurance only: hard tasks never escalate to it (see `escalationChain`).
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

  // All ladder routes have been tried or are unavailable: the economy route is the last resort, unless it is parked or tried.
  const economy = plainRoute(settings.models.economyRoute ?? ECONOMY_ROUTE)
  if (!routeSkipReason(settings, economy) && !hasTried(economy) && (!current || !sameRoute(current, economy))) {
    return { from: current ?? undefined, to: economy, isDeepSeekFlash: true }
  }

  return undefined
}

/** Plain-language one-line note for when a model fallback triggers. */
export function fallbackNote(to: RoleModel, reason: string): string {
  const modelName = `${to.provider}/${to.model}`
  const why = reason.replace(/\s+/g, ' ').slice(0, 150)
  if (/deepseek/i.test(`${to.provider} ${to.model}`)) {
    return `Fell back to DeepSeek cheap flash model (${modelName}): ${why}. Quality may be lower.`
  }
  return `Fell back to available ladder model (${modelName}): ${why}.`
}
