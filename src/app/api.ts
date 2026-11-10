/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { BrandingConfig } from '../policy.ts'
import type { AccountAllowanceReport } from './account-allowance.ts'
import type { LifecycleAction, LifecycleResult } from './lifecycle-decisions.ts'
import type { DecisionEvaluationRequest, DecisionEvaluationResult, PendingDecisionItem } from '../core/decision.ts'
import type { CharacterEvaluationResult } from '../core/character.ts'
import type { HelperDigest, HelperSuggestions } from './routes/helper.ts'
import type { SpecialistAttribution } from './specialist-advice.ts'
import type { CanonicalClaim, CanonicalPublish, CanonicalScore, CanonicalFailure, CanonicalResult, DecisionResolution, DecisionStagingResult, DecisionDiscardResult, StageDecisionRequest, BindDecisionSubmission, RestartDecisionRequest, DecisionRestartResult } from './decision-inbox.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface Api {
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'GET allowance': { response: AccountAllowanceReport }
  'POST allowance/refresh': { response: { refreshed: boolean; report: AccountAllowanceReport } }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/canonical/revise': { body: Omit<CanonicalClaim, 'owner' | 'purpose'> & { expectedDecisionId: string; reason: string }; response: CanonicalResult }
  'POST decisions/canonical/claim': { body: CanonicalClaim; response: CanonicalResult }
  'POST decisions/canonical/publish': { body: CanonicalPublish & { specialist?: SpecialistAttribution }; response: CanonicalResult }
  'POST decisions/canonical/score': { body: CanonicalScore; response: CanonicalResult }
  'POST decisions/canonical/fail': { body: CanonicalFailure; response: CanonicalResult }
  'GET progress': { query?: { ticket?: string }; response: { items: Array<import('./progress.ts').ProgressView | import('./progress.ts').ProgressObservation> } }
  'POST progress/observe': { body: import('./progress.ts').ProgressInput; response: { observation: import('./progress.ts').ProgressObservation; duplicate: boolean; current: import('./progress.ts').ProgressView; execution_authorized: false } }
  'GET findings': { response: { items: import('./finding.ts').Finding[] } }
  'POST findings/observe': { body: import('./finding.ts').FindingIntake; response: { finding: import('./finding.ts').Finding; item: PendingDecisionItem; execution_authorized: false } }
  'POST findings': { body: import('./finding.ts').FindingIntake; response: { finding: import('./finding.ts').Finding; item: PendingDecisionItem } }
  'POST findings/:id/evidence': { body: import('./finding-evidence.ts').FindingEvidenceInput; response: { finding: import('./finding.ts').Finding; item: PendingDecisionItem } }
  'POST findings/:id/review': { body: import('./finding.ts').FindingReview; response: { finding: import('./finding.ts').Finding; item: PendingDecisionItem } }
  'POST findings/:id/revisit': { body: { revision: number }; response: { finding: import('./finding.ts').Finding; item: PendingDecisionItem } }
  'POST findings/:id/confirm': { body: { revision: number; choiceId: 'fix_now' | 'queue_next' | 'defer' }; response: { finding: import('./finding.ts').Finding; item: PendingDecisionItem } }
  'POST findings/:id/release': { body: { revision: number }; response: { finding: import('./finding.ts').Finding; delivery: import('./feature-delivery.ts').Delivery; item: PendingDecisionItem } }
  'POST findings/:id/coordinate': { body: import('./finding-coordination.ts').FindingCoordinationRequest; response: { finding: import('./finding.ts').Finding; item: PendingDecisionItem } }
  'GET deliveries': { response: { items: import('./feature-delivery.ts').Delivery[] } }
  'POST deliveries': { body: import('./delivery-intake.ts').DeliveryIntake; response: { delivery: import('./feature-delivery.ts').Delivery; item: PendingDecisionItem } }
  'POST deliveries/:id/reconcile': { body: { revision: number; actionId: string }; response: { delivery: import('./feature-delivery.ts').Delivery; item: PendingDecisionItem } }
  'POST deliveries/:id/prepare': { body: { revision: number; requirements: string[] }; response: { delivery: import('./feature-delivery.ts').Delivery; item: PendingDecisionItem } }
  'POST deliveries/:id/evidence': { body: { revision: number; requirements: string[]; reference: string; outcome?: 'passed' | 'failed' }; response: { delivery: import('./feature-delivery.ts').Delivery; item: PendingDecisionItem } }
  'POST deliveries/:id/recheck': { body: { revision: number }; response: { delivery: import('./feature-delivery.ts').Delivery; item: PendingDecisionItem } }
  'POST deliveries/:id/bind': { body: { revision: number; intake: import('./delivery-intake.ts').DeliveryIntake }; response: { delivery: import('./feature-delivery.ts').Delivery; item: PendingDecisionItem } }
  'POST deliveries/:id/confirm': { body: { revision: number; actionId: string }; response: { delivery: import('./feature-delivery.ts').Delivery; item: PendingDecisionItem } }
  'GET decisions/inbox': { response: { items: PendingDecisionItem[] } }
  'POST decisions/inbox': { body: PendingDecisionItem; response: { ok: boolean; id: string } }
  'POST helper/context': { body: { sessionId: string }; response: { context: string } }
  'POST helper/suggest': { body: HelperDigest & { sessionId?: string }; response: HelperSuggestions & { specialist?: SpecialistAttribution } }
  'POST decisions/evaluate': { body: DecisionEvaluationRequest; response: DecisionEvaluationResult }
  'POST decisions/character-evaluate': { body: DecisionEvaluationRequest & { characterId?: string; diff?: string; testOutput?: string; ticketRequest?: string }; response: CharacterEvaluationResult }
  'POST decisions/:id/lifecycle': { body: { action: LifecycleAction; approval?: { publicationId: string; requestId: string } }; response: LifecycleResult }
  'POST decisions/:id/resolve': { body: { choiceId: string }; response: DecisionResolution }
  'POST decisions/:id/restart': { body: RestartDecisionRequest; response: DecisionRestartResult }
  'POST decisions/:id/stage': { body: StageDecisionRequest; response: DecisionStagingResult }
  'POST decisions/:id/submission': { body: BindDecisionSubmission; response: DecisionStagingResult }
  'POST decisions/:id/discard-staging': { body: { attemptId: string }; response: DecisionDiscardResult }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET branding': { response: { branding: BrandingConfig; revision: number } }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
