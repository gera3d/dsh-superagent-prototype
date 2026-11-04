/** Resolves and seeds per-role default models on newly created sessions without mutating the global DSH default. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { RoleModel, Settings } from '../policy.ts'

/** The two job types whose default model an existing settings block names: assessment (Eval) and execution (Executor). */
export type JobType = 'eval' | 'executor'
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
