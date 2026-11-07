/** Host model selection; routing policy is shared with the settings preview. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { constrainedRoute, conservationActive } from '../model-routing.ts'
import type { RoleModel, Settings } from '../policy.ts'
export * from '../model-routing.ts'

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

/** Install after model selection hooks so availability is the final request-boundary decision. */
export function installRoutingGuard(ctx: Context, agent: Agent, settingsOf: () => Settings): () => void {
  return agent.ctx.on('agent/request', async (_payload, next) => {
    const result = await next()
    const settings = settingsOf()
    if (!conservationActive(settings) && !settings.models.subscriptions.some(mark => mark.status !== 'available')) return result
    const route = constrainedRoute(settings, result as RoleModel)
    if (!route) throw new Error('No eligible managed model route')
    const selected = await resolveRoleModel(ctx, route)
    const { reasoningEffort: _oldEffort, ...rest } = result
    return { ...rest, ...selected }
  }, { prepend: true })
}
