/**
 * Specialist advice over the EXISTING canonical decision record.
 *
 * profile selection → existing job identity (claimCanonical on the session/message) → expert advice
 * (publishCanonical, one option-set revision) → explicit native continuation (the unchanged stage → Send → proof flow).
 *
 * No new store, queue or runtime. The advice model call is an injected port; this module never connects a service,
 * reads credentials or executes a recommendation. Integration seams (documented in docs/specialist-profiles.md):
 *  - outside-progress observation repair: feeds `ActivityEvent`s through `activityFromSessionEvents`; no store here;
 *  - Sonnet quality escalation: untouched, the route comes from the existing `constrainedRoute`/`helperRoute`.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CharacterConfig } from '../core/character.ts'
import type { DecisionCharacterAttribution, PendingDecisionItem } from '../core/decision.ts'
import { resolveCapabilities, type CapabilityResolution, type NativeDiscovery } from '../core/specialist-capability.ts'
import { CAPABILITY_IDS, profileCharacter, resolveProfile, seedProfiles, type CapabilityId, type SpecialistProfile } from '../core/specialist-profile.ts'
import { coordinate, routeSpecialist, type CoordinationDelivery, type RouteDecision } from '../core/specialist-routing.ts'
import type { RoleModel, Settings } from '../policy.ts'
import { DecisionInbox, InboxError, type CanonicalSource } from './decision-inbox.ts'
import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_SENIOR_DEVELOPER_CHARACTER } from '../core/character.ts'
import { helperSystemPrompt, suggestHelper, type HelperDigest, type HelperSuggestions } from './routes/helper.ts'
import { defaultRoute, helperRoute } from './role-models.ts'

export type AdviceOption = { id: string; label: string; prompt: string; why: string; recommended: boolean }
/** Injected model call; production would wrap the existing helper transport. Receives no tools. */
export type SpecialistAdvise = (request: { system: string; context: string; route: RoleModel | null }) => Promise<{ model: string; options: AdviceOption[] }>

/** Read-only adapter over the native tool registry (`ctx.tools.schemas()`); any failure means "nothing discovered". */
export function discoverNativeTools(tools: { schemas?: () => readonly { name: string }[] } | undefined, now = Date.now()): NativeDiscovery {
  try { return { toolNames: (tools?.schemas?.() ?? []).map(schema => String(schema.name)), at: now } }
  catch { return { toolNames: [], at: now } }
}

/** Optional services may be absent from an independently injected provider; absence must fail closed, not abort publication. */
export function discoverContextTools(ctx: Pick<Context, 'tools'>): NativeDiscovery {
  try { return discoverNativeTools(ctx.tools) }
  catch { return { toolNames: [], at: Date.now() } }
}

/** Inheritance only: the profile names a role; the existing routing (parked providers, conserve mode) decides. */
export function specialistRoute(settings: Settings, profile: SpecialistProfile): RoleModel | null {
  return profile.modelPolicy.inherit === 'helper' ? helperRoute(settings) : defaultRoute(settings, profile.modelPolicy.inherit === 'eval' ? 'eval' : 'executor')
}

/**
 * Bounded profile metadata carried through the normal helper response and the canonical publish body. Every field is
 * an enum or a registry id: nothing here is free text, a credential or a grant. Display names are re-derived from the
 * registry on the server, never trusted from the caller.
 */
export const SpecialistAttributionSchema = z.object({
  profileId: z.string().min(1).max(100),
  basis: z.enum(['requested', 'keyword', 'default']),
  unavailable: z.array(z.enum(CAPABILITY_IDS as [CapabilityId, ...CapabilityId[]])).max(8),
}).strict()
export type SpecialistAttribution = z.infer<typeof SpecialistAttributionSchema>

/** Registry-derived decision attribution; undefined for an unknown id (the publish then records no attribution). */
export function attributionFor(input: SpecialistAttribution, profiles: readonly SpecialistProfile[] = seedProfiles(), discovery?: NativeDiscovery): DecisionCharacterAttribution | undefined {
  const profile = profiles.find(candidate => candidate.id === input.profileId)
  if (!profile) return undefined
  // Caller metadata cannot hide a missing native connection. Recompute from the current registry/discovery.
  const unavailable = resolveCapabilities(profile, discovery).refused.filter(item => item.reason !== 'not_grantable').map(item => item.id)
  return { characterId: profile.id, name: profile.identity.name, specialty: profile.specialty, brief: profile.identity.title, mode: 'suggest',
    rationale: `Selected by ${input.basis}.${unavailable.length ? ` Unavailable: ${unavailable.join(', ')}.` : ''}`,
    ...(unavailable.length ? { unavailable } : {}) }
}

export interface PrepareInput {
  profiles: readonly SpecialistProfile[]
  settings: Settings
  discovery?: NativeDiscovery
  task: string
  requestedProfileId?: string
  /** Recorded deliveries the Administrator may read (bounded by `coordinate`); ignored by other profiles. */
  deliveries?: readonly CoordinationDelivery[]
  now?: number
}
export type PreparedSpecialist =
  | { status: 'prepared'; route: RouteDecision; profile: SpecialistProfile; resolution: CapabilityResolution; system: string; modelRoute: RoleModel | null; attribution: SpecialistAttribution }
  | { status: 'refused'; route: RouteDecision; resolution: CapabilityResolution; reason: string }

/** Profile selection, capability intersection and the tool-free system prompt; shared by every caller so there is one implementation. */
export function prepareSpecialist(input: PrepareInput): PreparedSpecialist {
  const route = routeSpecialist(input.task, input.profiles, input.requestedProfileId)
  const base = input.profiles.find(profile => profile.id === route.profileId)
  if (!base) throw new InboxError(404, 'Specialist profile not found')
  const { profile, enabled } = resolveProfile(base, characters(input.settings))
  const resolution = resolveCapabilities(profile, input.discovery, input.now ?? Date.now())
  if (!enabled) return { status: 'refused', route, resolution, reason: 'The linked character is disabled in settings' }
  const proposals = coordinate(resolution, input.deliveries ?? [])
  if (!resolution.granted.includes('advice.read') && !proposals.length) return { status: 'refused', route, resolution, reason: 'Profile has no advice capability' }
  const unavailable = resolution.refused.filter(item => item.reason !== 'not_grantable').map(item => item.id)
  const system = helperSystemPrompt(profileCharacter(profile, characters(input.settings))) + [
    '', `Granted capabilities: ${resolution.granted.join(', ') || 'none'}.`,
    unavailable.length ? `Unavailable (do not claim or simulate them): ${unavailable.join(', ')}.` : '',
    ...(proposals.length ? ['Recorded deliveries (advise ONLY on these existing delegated actions; never propose acceptance, a new action kind or a different owner; a person still confirms and Sends):',
      ...proposals.map(item => `- ${item.deliveryId} "${item.title.slice(0, 120)}" owner ${item.owner.slice(0, 60)}: ${item.kind}${item.actionKind ? ` ${item.actionKind}` : ''} — ${item.note.slice(0, 160)}`)] : []),
    ...profile.knowledge.map(ref => `Pinned reference: ${ref.title} (${ref.license}, pin ${ref.pin.slice(0, 12)}) — ${ref.source}`),
  ].filter(Boolean).join('\n')
  return { status: 'prepared', route, profile, resolution, system, modelRoute: specialistRoute(input.settings, profile),
    attribution: { profileId: profile.id, basis: route.basis, unavailable: unavailable.slice(0, 8) as CapabilityId[] } }
}

/**
 * Production seam used by `POST helper/suggest`: the SAME tool-free helper generation, with the routed profile's prompt
 * and inherited route. Returns the bounded attribution the caller relays on publish. A refused profile (disabled
 * character, no advice capability) yields no specialist and the unchanged Senior Developer helper.
 */
export async function suggestWithSpecialist(ctx: Context, digest: HelperDigest, settings: Settings, workflowContext: string | undefined,
  options: { profiles?: readonly SpecialistProfile[]; deliveries?: readonly CoordinationDelivery[]; tools?: Parameters<typeof discoverNativeTools>[0] } = {}): Promise<HelperSuggestions & { specialist?: SpecialistAttribution }> {
  const profiles = options.profiles ?? seedProfiles(settings.characters.characters.find(character => character.id === DEFAULT_SENIOR_DEVELOPER_CHARACTER.id))
  const prepared = prepareSpecialist({ profiles, settings, discovery: discoverNativeTools(options.tools), deliveries: options.deliveries, task: `${digest.summary}\n${digest.latestTurn}` })
  if (prepared.status === 'refused') return suggestHelper(ctx, digest, settings, workflowContext)
  const suggestions = await suggestHelper(ctx, digest, settings, workflowContext, { system: prepared.system, route: prepared.modelRoute })
  return { ...suggestions, specialist: prepared.attribution }
}

export interface SpecialistAdviceInput extends PrepareInput {
  inbox: DecisionInbox
  source: CanonicalSource
  events: readonly SessionEvent[]
  advise: SpecialistAdvise
}
export type SpecialistAdviceResult =
  | { status: 'advised'; route: RouteDecision; resolution: CapabilityResolution; item: PendingDecisionItem; modelRoute: RoleModel | null }
  | { status: 'refused'; route: RouteDecision; resolution: CapabilityResolution; reason: string }

const characters = (settings: Settings): CharacterConfig[] => settings.characters.characters

/** Standalone claim-owning variant (own lease). The host-driven path claims/publishes itself and uses `suggestWithSpecialist`. */
export async function adviseWithSpecialist(input: SpecialistAdviceInput): Promise<SpecialistAdviceResult> {
  const now = input.now ?? Date.now()
  const prepared = prepareSpecialist({ ...input, now })
  if (prepared.status === 'refused') return prepared
  const { route, profile, resolution, system, modelRoute } = prepared

  // Existing job identity: the canonical decision for this session/message. claimCanonical creates it only if missing.
  const claim = input.inbox.claimCanonical({ ...input.source, owner: `specialist:${profile.id}:${randomUUID()}` }, input.events, now)
  if (!claim.claimed || !claim.leaseToken) return { status: 'refused', route, resolution, reason: 'The decision is already being advised, published or staged' }
  try {
    const advice = await input.advise({ system, context: input.task.slice(0, 4000), route: modelRoute })
    input.inbox.publishCanonical({ ...input.source, leaseToken: claim.leaseToken, model: advice.model, options: advice.options }, input.events)
  } catch (error) {
    input.inbox.failCanonical({ ...input.source, leaseToken: claim.leaseToken, error: error instanceof Error ? error.message : String(error) }, input.events)
    throw error
  }
  const attribution = attributionFor(prepared.attribution, input.profiles, input.discovery)!
  const item = input.inbox.attributeCharacter(claim.item.id, { ...attribution, rationale: [attribution.rationale, resolution.nextDecision].filter(Boolean).join(' ').slice(0, 600) })
  return { status: 'advised', route, resolution, item, modelRoute }
}
