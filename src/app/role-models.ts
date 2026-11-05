/** Resolves and seeds per-role default models on newly created sessions without mutating the global DSH default. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { RoleModel, Settings } from '../policy.ts'

/** The two job types whose default model an existing settings block names: assessment (Eval) and execution (Executor). */
export type JobType = 'eval' | 'executor'
/** DeepSeek's cheap flash model: last-resort fallback when no model in the escalation ladder is available. */
export const DEEPSEEK_FALLBACK_ROUTE: RoleModel = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
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
  const configured = job === 'eval' ? settings.eval.model : settings.executor.model
  if (configured) return plainRoute(configured)
  const first = starredRoutes(settings)[0] ?? settings.models.hierarchy[0]
  return first ? plainRoute(first) : null
}
/** Both job types' starting routes, as the settings panel and the `models` resource report them. */
export const roleDefaults = (settings: Pick<Settings, 'eval' | 'executor' | 'models'>): Record<'orchestrator' | 'worker', RoleModel | null> =>
  ({ orchestrator: defaultRoute(settings, 'eval'), worker: defaultRoute(settings, 'executor') })
/**
 * The routes a job type may still escalate to, in hierarchy order after its current route. `previous` is the last escalated
 * route and `used` how many escalations the ticket already recorded; the hierarchy's `maxEscalations` caps the latter.
 */
export function escalationChain(settings: Pick<Settings, 'eval' | 'executor' | 'models'>, job: JobType, previous?: RoleModel,
  used = 0): RoleModel[] {
  if (used >= settings.models.maxEscalations) return []
  const current = previous ?? defaultRoute(settings, job)
  const hierarchy = settings.models.hierarchy
  // A current route outside the hierarchy leaves the whole hierarchy open; one inside it starts after its own place.
  const index = current ? hierarchy.findIndex(entry => sameRoute(entry, current)) : -1
  return hierarchy.slice(index + 1).filter(entry => !current || !sameRoute(entry, current)).map(plainRoute)
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
  const ladder = settings.models.hierarchy.map(plainRoute)
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
  if (!hasTried(DEEPSEEK_FALLBACK_ROUTE) && (!current || !sameRoute(current, DEEPSEEK_FALLBACK_ROUTE))) {
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

/** Resolve a configured route through the live provider; catalog membership is not a restriction. */
export async function resolveRoleModel(ctx: Context, model: RoleModel): Promise<ModelSelection> {
  const value = await ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}) })
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}

/**
 * Append a selection and pin the Session's next request to it. The selection is injected into that request's prompt and
 * route, then later manual or durable selections win. Appending the event leaves the global DSH default untouched, which
 * `sessionController.selectModel` changes.
 */
async function applyRoleModel(ctx: Context, agent: Agent, model: RoleModel): Promise<void> {
  const selected = await resolveRoleModel(ctx, model)
  agent.session.append('model/selection', selected)
  let initial = true
  let assembled: ModelSelection | undefined
  agent.ctx.effect(() => {
    const disposers = [
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selection = initial ? selected : undefined
        const result = await next()
        assembled = selection
        return selection ? { ...result, variables: { ...result.variables, provider: selection.provider, model: selection.model } } : result
      }, { prepend: true }),
      agent.ctx.on('agent/request', async (_payload, next) => {
        const result = await next()
        if (!assembled) return result
        const { reasoningEffort: _inherited, ...rest } = result
        return { ...rest, ...assembled }
      }, { prepend: true }),
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && (event.type === 'request/header' || event.type === 'model/selection')) initial = false
      }),
    ]
    return () => disposers.forEach(dispose => dispose())
  })
  await ctx.sessionPersistence.flush()
}

/** Select a route for the next request of an existing Session, which an escalated Assignment uses for its first turn. */
export async function selectRoleModel(ctx: Context, agent: Agent, model: RoleModel): Promise<void> {
  await applyRoleModel(ctx, agent, model)
}

/** Seed a role's configured model onto a brand-new session before its first request, leaving later manual or durable selections intact. */
export async function initializeRoleModel(ctx: Context, agent: Agent, model: RoleModel | null): Promise<void> {
  if (!model) return
  if (agent.session.requestHeader() || agent.session.snapshotEvents().some(event => event.type === 'model/selection')) return
  await applyRoleModel(ctx, agent, model)
}
