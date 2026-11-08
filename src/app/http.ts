/** Loopback-only management HTTP routes with same-origin enforcement for the web panel. */
import { adviceContext } from './advice-context.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, createReadStream } from 'node:fs'
import { extname } from 'node:path'
import { z } from 'zod'
import type { DecisionEvaluationRequest, PendingDecisionItem } from '../core/decision.ts'
import { THREAD_FILTERS, TICKET_FILTERS, type Api, type ApiResponse, type RouteParams } from './api.ts'
import { configuredDecisionReply } from './decision-evaluator.ts'
import { evaluateDecisionWithFallback } from './decision-ranker.ts'
import { evaluateWithCharacter } from './character-evaluator.ts'
import { HELPER_BODY_MAX_BYTES, HelperDigestSchema } from './routes/helper.ts'
import { attributionFor, discoverContextTools, SpecialistAttributionSchema, suggestWithSpecialist } from './specialist-advice.ts'
import { DEFAULT_SENIOR_DEVELOPER_CHARACTER } from '../core/character.ts'
import { DecisionInbox, InboxError, decisionQuestion, durableDecisionEvents, registerDecisionCapture, ticketDecisions, submitDecision, stageDecision, restartDecision } from './decision-inbox.ts'
import { sourceSkills } from './context.ts'
import { LifecycleRequest, enrichLifecycle, lifecycleAction, type LifecycleCommands } from './lifecycle-decisions.ts'
import type { LifecyclePublication } from './lifecycle-publication.ts'
import { PublicationError } from './publication.ts'
import { DeliveryConflict, deliveryFingerprint } from './feature-delivery.ts'
import { DeliveryIntakeRequest } from './delivery-intake.ts'
import { FindingIntakeSchema, FindingConfirmSchema, FindingReviewSchema, FindingError, findingDecision } from './finding.ts'
import type { FindingRuntime } from './finding-runtime.ts'
import { FindingEvidenceRequest } from './finding-evidence.ts'
import { snapshotProof } from './publication-proof.ts'
import { ProgressObservationSchema, ProgressStore } from './progress.ts'
import { FeatureDeliveryRuntime, deliveryDecision, reconcileInboxCurrency } from './delivery-runtime.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { policyVersion, type Settings as PolicySettings } from '../policy.ts'
import { seedProfiles } from '../core/specialist-profile.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { UserError, ticketStage, type EngineForPeople, type Ticket } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { ticketOfSession, workerSessionId, type DshExecutor } from '../executor/dsh.ts'
import type { JobUsage, JobUsageReader } from './job-usage.ts'
import type { Health } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { overview } from './views/overview.ts'
import { settingsView } from './views/settings.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'

export interface HttpHost {
  readonly store: Store
  readonly commands?: LifecycleCommands
  readonly publication?: LifecyclePublication
  readonly deliveries?: FeatureDeliveryRuntime
  readonly findings?: FindingRuntime
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery' | 'prompt'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels'>
  readonly engine: EngineForPeople
  readonly executor: Pick<DshExecutor, 'activeCount'> & Partial<Pick<DshExecutor, 'running'>>
  /** Reads a completed job's recorded usage from its worker Session log. */
  readonly usage: Pick<JobUsageReader, 'of'>
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  configured(): boolean
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
}
/**
 * Represents a client-facing 400 or 404 error raised during management route parsing or lookup.
 * Route handlers throw it when request bodies are malformed or target records are missing, and registerHttp serializes its status and message in the HTTP response.
 */
class RouteError extends Error { constructor(readonly status: 400 | 404, message: string) { super(message) } }
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
export function isLoopbackHost(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (!isLoopbackHost(req, port)) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
/** Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof FindingError) return [error.status, { error: error.message }]
  if (error instanceof DeliveryConflict) return [409, { error: error.message }]
  if (error instanceof RouteError || error instanceof InboxError || error instanceof PublicationError) return [error.status, { error: error.message }]
  if (error instanceof UserError) return [error.missing ? 404 : 400, { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
  return { stateDir, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get() }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  return {
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, feishuProblem: runtime.feishuProblem ?? null,
    accounts: resolved ? { repository: resolved.repository, agent: resolved.github.login, feishu: resolved.feishu ? { appId: resolved.feishu.appId, brand: resolved.feishu.brand, botId: resolved.feishu.botId, name: resolved.feishu.name } : null } : null,
  }
}
/** Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-superagent status` (`docs/006-deployment.md`). */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    masterId: runtime.masterId, paused: settings.paused, health: runtime.health }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, feishuProblem: runtime.feishuProblem })
export type StateView = ReturnType<typeof stateView>
/** Builds a ticket's detail view; `environment` is empty while waiting for setup because it requires the resolved deployment. */
async function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  // A job's recorded usage is read from its one worker Session, only once an Assignment actually started in it.
  const usage: JobUsage | undefined = detail.assignments.some(assignment => assignment.startedAt)
    ? await runtime.usage.of(workerSessionId(id)) : undefined
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [], ...usage ? { usage } : {} }
}
export type TicketPageView = Awaited<ReturnType<typeof ticketPage>>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills), skillPrefix: SKILL_PREFIX, parts, defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>; localApproval?: boolean
}
type Routes = { [K in keyof Api]: (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>> }
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
function imageMime(file: string): string {
  const ext = extname(file).toLowerCase()
  switch (ext) {
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.jpg': case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.ico': return 'image/x-icon'
    default: return 'application/octet-stream'
  }
}

const SourceBlock = z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor', 'decisions', 'models', 'characters', 'branding']), SourceBlock])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })
const DecisionChoiceSchema = z.object({ id: z.string().min(1).max(200), label: z.string().min(1).max(2000), description: z.string().max(4000).optional(), prompt: z.string().min(1).max(12000).optional(), added: z.boolean().optional() })
const DecisionEvaluation = z.object({ context: z.string().max(30000), sessionId: z.string().min(1).max(300).optional(), question: z.string().max(4000), choices: z.array(DecisionChoiceSchema).min(2).max(12), provider: z.enum(['auto', 'deepseek', 'typesafe-jev', 'openai-luna']).optional() })
const CharacterEvaluationRequestSchema = DecisionEvaluation.extend({
  characterId: z.string().max(100).optional(),
  diff: z.string().max(120_000).optional(),
  testOutput: z.string().max(120_000).optional(),
  ticketRequest: z.string().max(30_000).optional(),
})
export const DecisionStageRequest = z.object({ choiceId: z.string().min(1).max(200), attemptId: z.string().uuid(), draftText: z.string().min(1).max(120000) }).strict()
export const DecisionSubmissionRequest = z.object({ attemptId: z.string().uuid(), submissionId: z.string().min(1).max(300), retryOf: z.string().min(1).max(300).optional() }).strict()
export const DecisionDiscardRequest = z.object({ attemptId: z.string().uuid() }).strict()
export const DeliveryConfirmRequest = z.object({ revision: z.number().int().positive(), actionId: z.string().min(1).max(300) }).strict()
export const DecisionRestartRequest = z.object({ sessionId: z.string().min(1).max(300) }).strict()
export const DecisionEvaluationSchema = z.object({ recommendedValue: z.string(), confidence: z.number().min(0).max(1), rationale: z.string().max(4000),
  distribution: z.array(z.object({ id: z.string(), probability: z.number().min(0).max(1) })).max(12), provider: z.string().max(300), latencyMs: z.number().nonnegative() })
const CanonicalSourceSchema = z.object({ sessionId: z.string().min(1).max(300), sourceMessageId: z.string().min(1).max(300), sourceTurn: z.number().int().nonnegative(), sourceSeq: z.number().int().nonnegative(), draftRevision: z.string().min(1).max(300) })
const CanonicalWriteSchema = CanonicalSourceSchema.extend({ leaseToken: z.string().uuid() })
export const CanonicalClaimSchema = CanonicalSourceSchema.extend({ owner: z.string().min(1).max(300), purpose: z.literal('score').optional() }).strict()
export const CanonicalPublishSchema = CanonicalWriteSchema.extend({ specialist: SpecialistAttributionSchema.optional(), model: z.string().min(1).max(300), options: z.array(z.object({ id: z.string().min(1).max(200), label: z.string().min(1).max(2000), prompt: z.string().min(1).max(12000), why: z.string().max(4000), recommended: z.boolean(), added: z.boolean().optional() }).strict()).min(2).max(4) }).strict()
export const CanonicalScoreSchema = CanonicalWriteSchema.extend({ evaluation: DecisionEvaluationSchema }).strict()
export const CanonicalFailureSchema = CanonicalWriteSchema.extend({ error: z.string().min(1).max(4000) }).strict()
export async function canonicalOperation(ctx: Context, inbox: DecisionInbox, operation: string, body: unknown, settings?: PolicySettings) {
  if (operation === 'revise') { const input = CanonicalSourceSchema.extend({ expectedDecisionId: z.string().min(1).max(300), reason: z.string().trim().min(1).max(1000) }).strict().parse(body); return inbox.reviseCanonical(input, await durableDecisionEvents(ctx, input.sessionId)) }
  if (operation === 'claim') { const input = CanonicalClaimSchema.parse(body); return inbox.claimCanonical(input, await durableDecisionEvents(ctx, input.sessionId)) }
  if (operation === 'publish') {
    const { specialist, ...input } = CanonicalPublishSchema.parse(body)
    const published = inbox.publishCanonical(input, await durableDecisionEvents(ctx, input.sessionId))
    // Attribution only, on the SAME record, derived from the registry. A staged/closed/invalidated record refuses it and the publication stands.
    const profiles = seedProfiles(settings?.characters.characters.find(character => character.id === DEFAULT_SENIOR_DEVELOPER_CHARACTER.id))
    const attribution = specialist ? attributionFor(specialist, profiles, discoverContextTools(ctx)) : undefined
    if (!attribution || published.item.character) return published
    try { return { ...published, item: inbox.attributeCharacter(published.item.id, attribution) } }
    catch (error) { if (error instanceof InboxError) return published; throw error }
  }
  if (operation === 'score') { const input = CanonicalScoreSchema.parse(body); return inbox.scoreCanonical(input, await durableDecisionEvents(ctx, input.sessionId)) }
  if (operation === 'fail') { const input = CanonicalFailureSchema.parse(body); return inbox.failCanonical(input, await durableDecisionEvents(ctx, input.sessionId)) }
  throw new InboxError(404, 'Unknown canonical operation')
}
const DecisionOptionSetSchema = z.object({ revision: z.number().int().positive(), key: z.string().max(300).optional(), model: z.string().max(300).optional(),
  createdAt: z.number().finite(), choices: z.array(DecisionChoiceSchema).min(1).max(12), hiddenOptions: z.array(DecisionChoiceSchema).max(12).optional(),
  recommendation: DecisionEvaluationSchema, restoredFrom: z.number().int().positive().optional() })
export const DecisionInboxItem = z.object({
  id: z.string().min(1).max(300), sessionId: z.string().min(1), sourceMessageId: z.string().min(1),
  sourceSeq: z.number().int().nonnegative().optional(), sourceTurn: z.number().int().nonnegative().optional(),
  ticketTitle: z.string().max(2000), trigger: z.string().max(4000), status: z.literal('pending'),
  urgency: z.enum(['high', 'medium', 'low']), createdAt: z.number().finite(),
  context: z.string().max(30000), question: z.string().max(4000), choices: z.array(DecisionChoiceSchema).min(2).max(12),
  hiddenOptions: z.array(DecisionChoiceSchema).max(12).optional(), optionSets: z.array(DecisionOptionSetSchema).max(100).optional(),
  recommendation: DecisionEvaluationSchema,
})

export function isSessionEnded(runtime: HttpHost, item: PendingDecisionItem): boolean {
  if (item.actionMode === 'feature_delivery' || item.actionMode === 'finding_triage' || (!item.ticketId && item.id.startsWith('chat-')
    && (item.staging || decisionQuestion(item.context) || decisionQuestion(item.question)))) return false
  const sessionId = item.sessionId
  if (sessionId) {
    const ticketId = ticketOfSession(sessionId)
    if (ticketId) {
      const ticket = runtime.store.tickets.get(ticketId)
      if (!ticket || ticket.ended || ticketStage(ticket).stage === 'ended') return true
    }
  }
  if (item.ticketId) {
    const ticket = runtime.store.tickets.get(item.ticketId)
    if (!ticket || ticket.ended || ticketStage(ticket).stage === 'ended') return true
  }
  return false
}

function routes(runtime: HttpHost, ctx: Context, inbox: () => DecisionInbox, progress: () => ProgressStore): Routes {
  const refreshTickets = () => {
    const open = runtime.store.tickets.open?.() ?? []
    inbox().syncTickets(ticketDecisions(open), open)
    for (const item of inbox().list()) {
      if (item.status === 'pending' && isSessionEnded(runtime, item)) {
        inbox().invalidate(item, 'The originating session has ended. This decision can no longer be answered.')
      }
    }
  }
  const { store } = runtime
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  const contextFor = async (sessionId?: string) => {
    const ticketId = sessionId ? ticketOfSession(sessionId) : undefined
    const ticket = ticketId ? store.tickets.get(ticketId) : undefined
    const delivery = ticket && runtime.deliveries?.store.list().find(d => d.workers.includes(`worker-${ticket.id}`) || d.workers.includes(ticket.id))
    // Pre-upgrade prepared cards carry no recorded proof; derive the exact-pin observation from the live protected snapshot.
    const prepared = delivery?.preparedPublication
    const proof = prepared ? await snapshotProof(prepared, runtime.publication) : undefined
    return adviceContext(ticket, proof && delivery && prepared ? { ...delivery, preparedPublication: { ...prepared, proof } } : delivery, ticket ? progress().current(ticket.id) : undefined)
  }
  return {
    'GET state': () => stateView(runtime),
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem),
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir),
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    'POST decisions/canonical/revise': async ({ body }) => canonicalOperation(ctx, inbox(), 'revise', await body()),
    'POST decisions/canonical/claim': async ({ body }) => canonicalOperation(ctx, inbox(), 'claim', await body()),
    'POST decisions/canonical/publish': async ({ body }) => canonicalOperation(ctx, inbox(), 'publish', await body(), store.settings()),
    'POST decisions/canonical/score': async ({ body }) => canonicalOperation(ctx, inbox(), 'score', await body()),
    'POST decisions/canonical/fail': async ({ body }) => canonicalOperation(ctx, inbox(), 'fail', await body()),
    'GET progress': ({ query }) => ({ items: query.ticket ? progress().history(query.ticket) : progress().tickets().flatMap(id => progress().current(id) ?? []) }),
    'POST progress/observe': async ({ body, localApproval }) => {
      if (!localApproval) throw new PublicationError(403, 'Explicit local operator progress observation required')
      const input = ProgressObservationSchema.parse(await body())
      if (!runtime.store.tickets.get(input.ticketId)) throw new PublicationError(409, 'Progress must be associated with an existing ticket')
      const { observation, duplicate } = progress().observe(input as never, { source: 'operator', reference: 'orchestrator-http:progress-observation', actor: 'local-operator' })
      if (runtime.deliveries) reconcileInboxCurrency(inbox(), runtime.deliveries.store, runtime.publication, runtime.findings?.store, progress())
      return { observation, duplicate, current: progress().current(input.ticketId)!, execution_authorized: false as const }
    },
    'GET findings': () => ({ items: runtime.findings?.store.list() ?? [] }),
    'POST findings/observe': async ({ body }) => {
      if (!runtime.findings) throw new PublicationError(409, 'Finding coordinator is not configured')
      const input = FindingIntakeSchema.parse(await body())
      const finding = runtime.findings.observe(input, { source: 'external', reference: 'orchestrator-http:observation-only' })
      void runtime.findings.request().catch(error => ctx.logger.warn('External finding advice: %s', String(error)))
      return { finding, item: findingDecision(finding), execution_authorized: false as const }
    },
    'POST findings': async ({ body, localApproval }) => {
      if (!localApproval) throw new PublicationError(403, 'Explicit local operator finding intake required')
      if (!runtime.findings) throw new PublicationError(409, 'Finding coordinator is not configured')
      const input = FindingIntakeSchema.parse(await body())
      if (input.repository !== runtime.deployment.repository) throw new PublicationError(409, 'Finding repository must match this deployment')
      if (input.existingDeliveryId && !runtime.deliveries?.store.get(input.existingDeliveryId)) throw new PublicationError(409, 'Linked delivery does not exist')
      const finding = runtime.findings.observe(input, { source: 'operator', reference: 'orchestrator-http:local-intake', actor: 'local-operator' })
      void runtime.findings.request().catch(error => ctx.logger.warn('Finding advice: %s', String(error)))
      return { finding, item: findingDecision(finding) }
    },
    'POST findings/:id/evidence': async ({ params, body, localApproval }) => {
      if (!localApproval) throw new PublicationError(403, 'Explicit local operator evidence recording required')
      if (!runtime.findings) throw new PublicationError(409, 'Finding coordinator is not configured')
      const { revision, ...evidence } = FindingEvidenceRequest.parse(await body())
      const finding = store.atomic(() => {
        const current = runtime.findings!.store.get(params.id)
        if (!current || current.revision !== revision || !current.job?.ticketId || !['running', 'blocked'].includes(current.state))
          throw new FindingError(409, 'Evidence requires the current dispatched finding revision')
        return runtime.findings!.store.reportEvidence(params.id, evidence)
      })
      return { finding, item: findingDecision(finding) }
    },
    'POST findings/:id/review': async ({ params, body, localApproval }) => {
      if (!localApproval) throw new PublicationError(403, 'Explicit local operator evidence review required')
      if (!runtime.findings) throw new PublicationError(409, 'Finding coordinator is not configured')
      const request = FindingReviewSchema.parse(await body())
      const finding = runtime.findings.review(params.id, request, 'local-operator')
      void runtime.findings.request().catch(error => ctx.logger.warn('Finding review: %s', String(error)))
      return { finding, item: findingDecision(finding) }
    },
    'POST findings/:id/revisit': async ({ params, body, localApproval }) => {
      if (!localApproval) throw new PublicationError(403, 'Explicit local operator revisit required')
      if (!runtime.findings) throw new PublicationError(409, 'Finding coordinator is not configured')
      const { revision } = z.object({ revision: z.number().int().positive() }).strict().parse(await body())
      const finding = store.atomic(() => {
        if (runtime.findings!.store.get(params.id)?.revision !== revision) throw new FindingError(409, 'Stale finding revision')
        return runtime.findings!.store.revisit(params.id)
      })
      void runtime.findings.request().catch(error => ctx.logger.warn('Finding revisit: %s', String(error)))
      return { finding, item: findingDecision(finding) }
    },
    'POST findings/:id/confirm': async ({ params, body, localApproval }) => {
      if (!localApproval) throw new PublicationError(403, 'Explicit local operator finding confirmation required')
      if (!runtime.findings) throw new PublicationError(409, 'Finding coordinator is not configured')
      const request = FindingConfirmSchema.parse(await body())
      const finding = runtime.findings.store.confirm(params.id, request, 'local-operator')
      void runtime.findings.request().catch(error => ctx.logger.warn('Finding dispatch: %s', String(error)))
      return { finding, item: findingDecision(finding) }
    },
    'GET deliveries': () => ({ items: runtime.deliveries?.store.list() ?? [] }),
    'POST deliveries': async ({ body, localApproval }) => {
      if (!localApproval) throw new PublicationError(403, 'Explicit local operator intake required')
      if (!runtime.deliveries) throw new PublicationError(409, 'Delivery coordinator is not configured')
      const input = DeliveryIntakeRequest.parse(await body())
      if (input.workers.some(id => !store.tickets.get(id) || store.tickets.get(id)?.ended?.by === 'human')) throw new PublicationError(409, 'Intake workers must exist and retain their original mandate')
      const delivery = runtime.deliveries.store.create({ ...input, authorities: ['local-operator'] })
      void runtime.deliveries.request().catch(error => ctx.logger.warn('Delivery intake: %s', String(error)))
      return { delivery, item: deliveryDecision(delivery) }
    },
    'POST deliveries/:id/bind': async ({ params, body, localApproval }) => {
      if (!localApproval) throw new PublicationError(403, 'Explicit local operator scope binding required')
      if (!runtime.deliveries) throw new PublicationError(409, 'Delivery coordinator is not configured')
      const { revision, intake } = z.object({ revision: z.number().int().positive(), intake: DeliveryIntakeRequest }).strict().parse(await body())
      if (intake.id !== params.id || intake.workers.some(id => !store.tickets.get(id) || store.tickets.get(id)?.ended?.by === 'human')) throw new PublicationError(409, 'Scope binding must retain the original authorized workers')
      const input = { ...intake, authorities: ['local-operator'] }
      const delivery = runtime.deliveries.store.bindScope(params.id, revision, input, { actor: 'local-operator', source: 'local_operator',
        reference: `orchestrator-http:bind:${params.id}:${revision}`, scope: deliveryFingerprint(input) })
      void runtime.deliveries.request().catch(error => ctx.logger.warn('Delivery scope binding: %s', String(error)))
      return { delivery, item: deliveryDecision(delivery) }
    },
    'POST deliveries/:id/reconcile': async ({ params, body, localApproval }) => {
      if (!localApproval) throw new PublicationError(403, 'Explicit local operator reconciliation required')
      if (!runtime.deliveries) throw new PublicationError(409, 'Delivery coordinator is not configured')
      const request = DeliveryConfirmRequest.parse(await body())
      const current = runtime.deliveries.store.get(params.id)
      if (!current?.reconciliation) throw new PublicationError(409, 'No exact parked handoff is available for reconciliation')
      const delivery = runtime.deliveries.store.resume(params.id, request.revision, { actor: 'local-operator', source: 'local_operator',
        reference: `orchestrator-http:reconcile:${params.id}:${request.revision}:${request.actionId}`, scope: current.reconciliation.actionId }, request.actionId)
      void runtime.deliveries.request().catch(error => ctx.logger.warn('Delivery reconciliation: %s', String(error)))
      return { delivery, item: deliveryDecision(delivery) }
    },
    'POST deliveries/:id/recheck': async ({ params, body, localApproval }) => {
      if (!localApproval) throw new PublicationError(403, 'Explicit local operator recheck required')
      if (!runtime.deliveries) throw new PublicationError(409, 'Delivery coordinator is not configured')
      const { revision } = z.object({ revision: z.number().int().positive() }).strict().parse(await body())
      const delivery = runtime.deliveries.recheck(params.id, revision)
      void runtime.deliveries.request().catch(error => ctx.logger.warn('Delivery preparation recheck: %s', String(error)))
      return { delivery, item: deliveryDecision(delivery) }
    },
    'POST deliveries/:id/confirm': async ({ params, body, localApproval }) => {
      if (!localApproval) throw new PublicationError(403, 'Explicit local operator confirmation required')
      if (!runtime.deliveries) throw new PublicationError(409, 'Delivery coordinator is not configured')
      const request = DeliveryConfirmRequest.parse(await body())
      const current = runtime.deliveries.store.get(params.id)
      if (!current?.nextAction) throw new PublicationError(409, 'No currently executable delivery action')
      if (current.nextAction.kind === 'accept' && runtime.findings?.store.list().some(finding => finding.existingDeliveryId === params.id && finding.state !== 'resolved'))
        throw new PublicationError(409, 'Linked findings still require evidence review; delivery acceptance remains unavailable')
      const delivery = runtime.deliveries.store.confirm(params.id, request, { actor: 'local-operator', source: 'local_operator',
        reference: `orchestrator-http:${params.id}:${request.revision}:${request.actionId}`, scope: current.nextAction.fingerprint })
      void runtime.deliveries.request().catch(error => ctx.logger.warn('Delivery handoff: %s', String(error)))
      return { delivery, item: deliveryDecision(delivery) }
    },
    'GET decisions/inbox': async () => {
      refreshTickets()
      await runtime.publication?.refresh?.()
      const items = inbox().list().filter(item => {
        const current = item.lifecycle && item.ticketId ? store.tickets.get(item.ticketId) : undefined
        return !current || !runtime.executor.running?.(current)
      })
      const projected = runtime.publication?.project?.(items) ?? items
      const delivered = runtime.deliveries?.project(projected) ?? projected
      return { items: await enrichLifecycle(runtime.findings?.project(delivered) ?? delivered, runtime.commands, runtime.configured() ? runtime.deployment.repository : undefined, runtime.publication) }
    },
    'POST decisions/:id/lifecycle': async ({ params, body, localApproval }) => {
      const { action, approval } = LifecycleRequest.parse(await body())
      refreshTickets()
      return lifecycleAction({ getTicket: id => store.tickets.get(id), retryTicket: id => runtime.engine.retryTicket(id),
        repository: runtime.deployment.repository, commands: runtime.commands, publication: runtime.publication,
        approvalActor: localApproval ? 'local-operator' : undefined,
        busy: current => runtime.executor.running?.(current) ?? false }, inbox().get(params.id), action, approval)
    },
    'POST decisions/inbox': async ({ body }) => {
      const item = DecisionInboxItem.parse(await body())
      if (new Set(item.choices.map(choice => choice.id)).size !== item.choices.length) throw new RouteError(400, 'Choice ids must be distinct')
      const saved = inbox().put(item)
      return { ok: true, id: saved.id }
    },
    'POST helper/context': async ({ body }) => {
      const request = z.object({ sessionId: z.string().min(1).max(300) }).strict().parse(await body(1024))
      return { context: await contextFor(request.sessionId) }
    },
    'POST helper/suggest': async ({ body }) => {
      const request = HelperDigestSchema.extend({ sessionId: z.string().min(1).max(300).optional() }).parse(await body(HELPER_BODY_MAX_BYTES))
      const { sessionId, ...digest } = request
      return suggestWithSpecialist(ctx, digest, store.settings(), await contextFor(sessionId), { tools: ctx.tools, deliveries: runtime.deliveries?.store.list() })
    },
    'POST decisions/evaluate': async ({ body }) => {
      const payload = DecisionEvaluation.parse(await body())
      const settings = store.settings()
      return evaluateDecisionWithFallback({ ...payload, context: `${payload.context.slice(-16000)}\nSHARED WORKFLOW CONTEXT:\n${await contextFor(payload.sessionId)}` }, {
        decisions: settings.decisions,
        settings,
        call: request => configuredDecisionReply(ctx, request, settings),
      })
    },
    'POST decisions/character-evaluate': async ({ body }) => {
      const payload = CharacterEvaluationRequestSchema.parse(await body())
      const settings = store.settings()
      const character = (payload.characterId
        ? settings.characters.characters.find(c => c.id === payload.characterId)
        : undefined) ?? settings.characters.characters.find(c => c.id === settings.characters.defaultCharacterId) ?? settings.characters.characters[0] ?? DEFAULT_SENIOR_DEVELOPER_CHARACTER
      const rankerResult = await evaluateDecisionWithFallback(payload, {
        decisions: settings.decisions,
        settings,
        call: request => configuredDecisionReply(ctx, request, settings),
      })
      return evaluateWithCharacter(character, payload, {
        rankerResult,
        ctx,
        diff: payload.diff,
        testOutput: payload.testOutput,
        ticketRequest: payload.ticketRequest,
      })
    },
    'POST decisions/:id/resolve': async ({ params, body }) => {
      const { choiceId } = z.object({ choiceId: z.string().min(1).max(200) }).strict().parse(await body())
      if (params.id.startsWith('dec-')) refreshTickets()
      const item = inbox().get(params.id)
      if (!item) throw new InboxError(404, 'Decision not found')
      if (item.lifecycle) throw new InboxError(409, 'Use the explicit lifecycle action endpoint')
      if (item.status === 'stale') throw new InboxError(409, `Decision is stale: ${item.staleReason || 'Open the source conversation for current context.'}`)
      if (item.status === 'resolved') return inbox().resolve(params.id, choiceId)

      if (isSessionEnded(runtime, item)) {
        inbox().invalidate(item, 'The originating session has ended. This decision can no longer be answered.')
        throw new InboxError(409, 'The originating session has ended. This decision can no longer be answered.')
      }

      return inbox().resolve(params.id, choiceId)
    },
    'POST decisions/:id/restart': async ({ params, body }) => restartDecision(ctx, inbox(), params.id, DecisionRestartRequest.parse(await body())),
    'POST decisions/:id/stage': async ({ params, body }) => stageDecision(ctx, inbox(), params.id, DecisionStageRequest.parse(await body())),
    'POST decisions/:id/submission': async ({ params, body }) => submitDecision(ctx, inbox(), params.id, DecisionSubmissionRequest.parse(await body())),
    'POST decisions/:id/discard-staging': async ({ params, body }) => inbox().discardStaging(params.id, DecisionDiscardRequest.parse(await body()).attemptId),
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET tickets': ({ query }) => {
      const { state, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'POST tickets/:id/retry': ({ params }) => { const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/stop': ({ params }) => { const id = ticket(params.id); runtime.engine.stopTicket(id); return { stopped: true } },
    'POST executor/pause': async ({ body }) => runtime.settings.pause(z.object({ paused: z.boolean() }).parse(await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
      if (!known) throw new RouteError(404, 'Source not found')
      const request = SaveRequest.parse(await body())
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET branding': () => ({
      branding: store.settings().branding,
      revision: store.blockRevision('branding'),
    }),
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    'GET models': () => runtime.models(),
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: Routes, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
export function registerHttp(ctx: Context, runtime: HttpHost): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  let savedInbox: DecisionInbox | undefined
  const inbox = () => savedInbox ??= new DecisionInbox(runtime.store.db)
  let savedProgress: ProgressStore | undefined
  const progress = () => savedProgress ??= new ProgressStore(runtime.store.db)
  const capture = registerDecisionCapture(ctx, inbox)
  const table = routes(runtime, ctx, inbox, progress)
  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      if (url.pathname === '/orchestrator/api/branding/raw') {
        if (!isLoopbackHost(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
        const variant = url.searchParams.get('variant')
        const { branding } = runtime.store.settings()
        const target = (variant === 'dark' ? branding.logoDark : variant === 'light' ? branding.logoLight : '')
          || branding.logo || branding.logoDark || branding.logoLight
        if (!target) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('No logo configured'); return }
        if (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('data:')) {
          res.writeHead(302, { Location: target })
          res.end()
          return
        }
        if (!existsSync(target)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Logo file not found'); return
        }
        res.writeHead(200, { 'Content-Type': imageMime(target), 'Cache-Control': 'no-cache' })
        createReadStream(target).pipe(res)
        return
      }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      try {
        await runtime.ready
        if (url.pathname.includes('/decisions/')) {
          if (!/\/(stage|submission|restart)$/.test(url.pathname)) await capture.ready
          if (runtime.deliveries) reconcileInboxCurrency(inbox(), runtime.deliveries.store, runtime.publication, runtime.findings?.store, progress())
        }
        const route = match(table, req.method ?? 'GET', url.pathname.slice('/orchestrator/api/'.length).split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        const query = Object.fromEntries(url.searchParams)
        // Privileged UI approval requires the browser's same-origin fetch envelope in addition to management CSRF protection.
        // This is a trusted-local-operator boundary, not authentication against hostile processes running as the same OS user.
        const localApproval = req.headers.origin === `http://${req.headers.host}` && req.headers['sec-fetch-site'] === 'same-origin'
          && ['cors', 'same-origin'].includes(String(req.headers['sec-fetch-mode'])) && req.headers['sec-fetch-dest'] === 'empty'
        let result = await route.run({ params: route.params as never, query, localApproval, body: maxBytes => readBody(req, maxBytes) })
        if (url.pathname.includes('/decisions/') && runtime.deliveries) {
          reconcileInboxCurrency(inbox(), runtime.deliveries.store, runtime.publication, runtime.findings?.store, progress())
          if (result && typeof result === 'object' && 'item' in result && result.item && typeof result.item === 'object' && 'id' in result.item && typeof result.item.id === 'string') {
            result = { ...result, item: inbox().get(result.item.id) ?? result.item }
          }
        }
        json(res, 200, result)
      } catch (error) { json(res, ...failure(error)) }
    } })]
  return () => { capture.dispose(); for (const dispose of disposers) dispose() }
}
