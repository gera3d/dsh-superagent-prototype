/** Shared, browser-safe routing policy. No credentials or host services. */
import { ECONOMY_ROUTE } from './economy.ts'
import type { ModelCandidate, ModelRoutingConfig, RoleModel, Settings, SubscriptionAvailability } from './policy.ts'

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

export type ModelErrorAction = 'advance' | 'retry' | 'stop'

export interface ClassifiedError {
  kind: 'availability' | 'auth' | 'safety' | 'client' | 'unknown'
  action: ModelErrorAction
  retryable: boolean
  reason: string
}

const AUTH_PATTERNS = ['unauthorized', 'invalid_api_key', 'invalid api key', 'authentication', 'forbidden', 'access_denied']
const SAFETY_PATTERNS = ['safety', 'content_filter', 'content filter', 'moderation', 'harmful', 'policy violation', 'blocked']

export function classifyModelError(error: unknown): ClassifiedError {
  if (!error) return { kind: 'unknown', action: 'stop', retryable: false, reason: 'Empty error' }
  const status = (error as { status?: unknown })?.status
  const code = String((error as { code?: unknown })?.code ?? '')
  const message = error instanceof Error ? error.message : String(error)
  const text = `${error instanceof Error ? error.name : ''} ${message} ${code}`.toLowerCase()

  if (status === 401 || status === 403 || AUTH_PATTERNS.some(p => text.includes(p))) {
    return { kind: 'auth', action: 'stop', retryable: false, reason: message || 'Authentication failed' }
  }
  if (SAFETY_PATTERNS.some(p => text.includes(p))) {
    return { kind: 'safety', action: 'stop', retryable: false, reason: message || 'Safety or content policy rejection' }
  }
  if (status === 400 || text.includes('context_length_exceeded') || text.includes('bad_request')) {
    return { kind: 'client', action: 'stop', retryable: false, reason: message || 'Client error' }
  }
  if (isModelUnavailable(error)) {
    const immediateSwitch = typeof status === 'number' && status === 429
      || /quota|cooldown|budget/i.test(text)
    return {
      kind: 'availability',
      action: immediateSwitch ? 'advance' : 'retry',
      retryable: true,
      reason: message || 'Model unavailable',
    }
  }
  return { kind: 'unknown', action: 'stop', retryable: false, reason: message || 'Unknown error' }
}

export type ToolExecutionStatus =
  | 'in_flight'
  | 'completed'
  | 'uncertain'
  | 'failed'
  | 'reconciled_success'
  | 'reconciled_failed'
  | 'reconciled_abandoned'

export class ToolExecutionLedger {
  private records = new Map<string, { status: ToolExecutionStatus; toolName: string; timestamp: number }>()

  recordStart(toolCallId: string, toolName: string): void {
    const existing = this.records.get(toolCallId)
    if (existing && (existing.status === 'completed' || existing.status === 'reconciled_success')) {
      throw new Error(`Tool call ${toolCallId} already completed; replay prevented`)
    }
    this.records.set(toolCallId, { status: 'in_flight', toolName, timestamp: Date.now() })
  }

  recordCompletion(toolCallId: string, success: boolean): void {
    const rec = this.records.get(toolCallId)
    if (rec) rec.status = success ? 'completed' : 'failed'
  }

  recordUncertain(toolCallId: string): void {
    const rec = this.records.get(toolCallId)
    if (rec) rec.status = 'uncertain'
  }

  hasUncertain(): boolean {
    for (const rec of this.records.values()) {
      if (rec.status === 'uncertain') return true
    }
    return false
  }

  reconcile(toolCallId: string, finalStatus: 'reconciled_success' | 'reconciled_failed' | 'reconciled_abandoned'): void {
    const rec = this.records.get(toolCallId)
    if (!rec) throw new Error(`Unknown tool call: ${toolCallId}`)
    if (!['reconciled_success', 'reconciled_failed', 'reconciled_abandoned'].includes(finalStatus)) {
      throw new Error(`Invalid reconciliation status: ${finalStatus}`)
    }
    rec.status = finalStatus
  }

  guard(toolCallId: string): void {
    if (this.hasUncertain()) {
      throw new Error('Uncertain tool outcome blocks execution until operator reconciliation')
    }
    const rec = this.records.get(toolCallId)
    if (rec && (rec.status === 'completed' || rec.status === 'reconciled_success')) {
      throw new Error(`Tool call ${toolCallId} has already completed; replay is forbidden`)
    }
  }

  completedCount(): number {
    let count = 0
    for (const rec of this.records.values()) {
      if (rec.status === 'completed' || rec.status === 'reconciled_success') count++
    }
    return count
  }
}

export interface FallbackEvent {
  requested_model: string
  substituted_model: string
  reason: string
  attempt_count: number
  timestamp: number
}

export interface ExhaustionState {
  exhausted: boolean
  attempted_models: string[]
  per_model_reasons: Record<string, string>
  stopping_bound: string
  manual_recovery_action: string
}

export function candidateToRoute(settings: Pick<Settings, 'models'>, candidate: ModelCandidate): RoleModel {
  if (typeof candidate !== 'string') return plainRoute(candidate)
  if (candidate.includes('/')) {
    const slash = candidate.indexOf('/')
    return { provider: candidate.slice(0, slash), model: candidate.slice(slash + 1) }
  }
  const match = settings.models.hierarchy.find(entry => entry.model === candidate)
  if (match) return plainRoute(match)
  return { provider: 'deepseek-official', model: candidate }
}

export interface DispatchOptions<T> {
  routing: ModelRoutingConfig
  settings?: Pick<Settings, 'models'>
  executeCandidate: (model: string, signal: AbortSignal) => Promise<T>
  onFallback?: (event: FallbackEvent) => void
  nowFn?: () => number
}

export async function executeWithFallback<T>(options: DispatchOptions<T>): Promise<{
  result: T
  activeModel: string
  events: FallbackEvent[]
  exhaustion?: ExhaustionState
}> {
  const { routing, executeCandidate, onFallback, nowFn = Date.now } = options
  const startTime = nowFn()
  const deadline = startTime + routing.total_timeout_ms
  const candidateKeys = [routing.primary, ...routing.fallbacks].map(c => typeof c === 'string' ? c : `${c.provider}/${c.model}`)
  const attemptCounts = new Map<string, number>()
  const reasons: Record<string, string> = {}
  const events: FallbackEvent[] = []
  let totalAttempts = 0
  let candidateIndex = 0

  while (candidateIndex < candidateKeys.length) {
    const candidate = candidateKeys[candidateIndex]!
    const candidateTries = attemptCounts.get(candidate) ?? 0

    if (candidateTries >= routing.max_attempts_per_model) {
      candidateIndex++
      continue
    }

    if (totalAttempts >= routing.max_total_attempts) {
      const exhaustion: ExhaustionState = {
        exhausted: true,
        attempted_models: Object.keys(reasons),
        per_model_reasons: reasons,
        stopping_bound: `max_total_attempts (${routing.max_total_attempts})`,
        manual_recovery_action: 'operator_retry',
      }
      const err = new Error(`Total attempt bound exceeded (${routing.max_total_attempts})`)
      ;(err as unknown as { exhaustion: ExhaustionState }).exhaustion = exhaustion
      throw err
    }

    const now = nowFn()
    if (now >= deadline) {
      const exhaustion: ExhaustionState = {
        exhausted: true,
        attempted_models: Object.keys(reasons),
        per_model_reasons: reasons,
        stopping_bound: `total_timeout_ms (${routing.total_timeout_ms}ms)`,
        manual_recovery_action: 'operator_retry',
      }
      const err = new Error(`Routing deadline exceeded (${routing.total_timeout_ms}ms)`)
      ;(err as unknown as { exhaustion: ExhaustionState }).exhaustion = exhaustion
      throw err
    }

    const controller = new AbortController()
    const remainingMs = Math.max(1, deadline - now)
    const timer = setTimeout(() => {
      controller.abort(new Error(`In-flight request cancelled: routing deadline exceeded (${routing.total_timeout_ms}ms)`))
    }, remainingMs)

    totalAttempts++
    attemptCounts.set(candidate, candidateTries + 1)

    try {
      const result = await executeCandidate(candidate, controller.signal)
      clearTimeout(timer)
      return { result, activeModel: candidate, events }
    } catch (err: unknown) {
      clearTimeout(timer)
      const classified = classifyModelError(err)
      reasons[candidate] = classified.reason

      if (classified.action === 'stop' && !controller.signal.aborted) {
        throw err
      }

      if (controller.signal.aborted || nowFn() >= deadline) {
        const exhaustion: ExhaustionState = {
          exhausted: true,
          attempted_models: Object.keys(reasons),
          per_model_reasons: reasons,
          stopping_bound: `total_timeout_ms (${routing.total_timeout_ms}ms)`,
          manual_recovery_action: 'operator_retry',
        }
        const deadlineErr = new Error(`Routing deadline exceeded (${routing.total_timeout_ms}ms)`)
        ;(deadlineErr as unknown as { exhaustion: ExhaustionState }).exhaustion = exhaustion
        throw deadlineErr
      }

      if (classified.action === 'retry' && (attemptCounts.get(candidate) ?? 0) < routing.max_attempts_per_model) {
        continue
      }

      candidateIndex++
      if (candidateIndex < candidateKeys.length) {
        const nextCandidate = candidateKeys[candidateIndex]!
        const event: FallbackEvent = {
          requested_model: candidate,
          substituted_model: nextCandidate,
          reason: classified.reason,
          attempt_count: attemptCounts.get(candidate) ?? 1,
          timestamp: nowFn(),
        }
        events.push(event)
        if (onFallback) onFallback(event)
      }
    }
  }

  const exhaustion: ExhaustionState = {
    exhausted: true,
    attempted_models: Object.keys(reasons),
    per_model_reasons: reasons,
    stopping_bound: 'candidates_exhausted',
    manual_recovery_action: 'operator_retry',
  }
  const err = new Error('All candidate models exhausted')
  ;(err as unknown as { exhaustion: ExhaustionState }).exhaustion = exhaustion
  throw err
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

  const routing = settings.models.routing ?? settings.models.model_routing
  if (routing) {
    if (routing.fallbacks.length === 0) {
      return undefined // AC4: Empty fallbacks prevent substitution
    }
    const candidates = [routing.primary, ...routing.fallbacks].map(c => candidateToRoute(settings, c))
    const eligible = candidates.filter(route => !routeSkipReason(settings, route))
    const hasTried = (route: RoleModel) => triedRoutes.some(item => sameRoute(item, route))

    if (current) {
      const currentIndex = eligible.findIndex(item => sameRoute(item, current))
      if (currentIndex >= 0) {
        for (let i = currentIndex + 1; i < eligible.length; i++) {
          if (!hasTried(eligible[i]!)) {
            const isDeepSeek = /deepseek/i.test(`${eligible[i]!.provider} ${eligible[i]!.model}`)
            return { from: current, to: eligible[i]!, isDeepSeekFlash: isDeepSeek }
          }
        }
      }
    }

    for (const candidate of eligible) {
      if ((!current || !sameRoute(current, candidate)) && !hasTried(candidate)) {
        const isDeepSeek = /deepseek/i.test(`${candidate.provider} ${candidate.model}`)
        return { from: current ?? undefined, to: candidate, isDeepSeekFlash: isDeepSeek }
      }
    }
    return undefined
  }

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
