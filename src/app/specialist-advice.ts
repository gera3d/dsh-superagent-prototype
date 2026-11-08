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
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CharacterConfig } from '../core/character.ts'
import type { PendingDecisionItem } from '../core/decision.ts'
import { resolveCapabilities, type CapabilityResolution, type NativeDiscovery } from '../core/specialist-capability.ts'
import { profileCharacter, resolveProfile, type SpecialistProfile } from '../core/specialist-profile.ts'
import { routeSpecialist, type RouteDecision } from '../core/specialist-routing.ts'
import type { RoleModel, Settings } from '../policy.ts'
import { DecisionInbox, InboxError, type CanonicalSource } from './decision-inbox.ts'
import { helperSystemPrompt } from './routes/helper.ts'
import { defaultRoute, helperRoute } from './role-models.ts'

export type AdviceOption = { id: string; label: string; prompt: string; why: string; recommended: boolean }
/** Injected model call; production would wrap the existing helper transport. Receives no tools. */
export type SpecialistAdvise = (request: { system: string; context: string; route: RoleModel | null }) => Promise<{ model: string; options: AdviceOption[] }>

/** Read-only adapter over the native tool registry (`ctx.tools.schemas()`); any failure means "nothing discovered". */
export function discoverNativeTools(tools: { schemas?: () => readonly { name: string }[] } | undefined, now = Date.now()): NativeDiscovery {
  try { return { toolNames: (tools?.schemas?.() ?? []).map(schema => String(schema.name)), at: now } }
  catch { return { toolNames: [], at: now } }
}

/** Inheritance only: the profile names a role; the existing routing (parked providers, conserve mode) decides. */
export function specialistRoute(settings: Settings, profile: SpecialistProfile): RoleModel | null {
  return profile.modelPolicy.inherit === 'helper' ? helperRoute(settings) : defaultRoute(settings, profile.modelPolicy.inherit === 'eval' ? 'eval' : 'executor')
}

export interface SpecialistAdviceInput {
  inbox: DecisionInbox
  source: CanonicalSource
  events: readonly SessionEvent[]
  profiles: readonly SpecialistProfile[]
  settings: Settings
  discovery?: NativeDiscovery
  task: string
  requestedProfileId?: string
  advise: SpecialistAdvise
  now?: number
}
export type SpecialistAdviceResult =
  | { status: 'advised'; route: RouteDecision; resolution: CapabilityResolution; item: PendingDecisionItem; modelRoute: RoleModel | null }
  | { status: 'refused'; route: RouteDecision; resolution: CapabilityResolution; reason: string }

const characters = (settings: Settings): CharacterConfig[] => settings.characters.characters

export async function adviseWithSpecialist(input: SpecialistAdviceInput): Promise<SpecialistAdviceResult> {
  const now = input.now ?? Date.now()
  const route = routeSpecialist(input.task, input.profiles, input.requestedProfileId)
  const base = input.profiles.find(profile => profile.id === route.profileId)
  if (!base) throw new InboxError(404, 'Specialist profile not found')
  const { profile, enabled } = resolveProfile(base, characters(input.settings))
  const resolution = resolveCapabilities(profile, input.discovery, now)
  if (!enabled) return { status: 'refused', route, resolution, reason: 'The linked character is disabled in settings' }
  if (!resolution.granted.includes('advice.read')) return { status: 'refused', route, resolution, reason: 'Profile has no advice capability' }

  // Existing job identity: the canonical decision for this session/message. claimCanonical creates it only if missing.
  const claim = input.inbox.claimCanonical({ ...input.source, owner: `specialist:${profile.id}:${randomUUID()}` }, input.events, now)
  if (!claim.claimed || !claim.leaseToken) return { status: 'refused', route, resolution, reason: 'The decision is already being advised, published or staged' }

  const unavailable = resolution.refused.filter(item => item.reason !== 'not_grantable').map(item => item.id)
  const system = helperSystemPrompt(profileCharacter(profile, characters(input.settings))) + [
    '', `Granted capabilities: ${resolution.granted.join(', ') || 'none'}.`,
    unavailable.length ? `Unavailable (do not claim or simulate them): ${unavailable.join(', ')}.` : '',
    ...profile.knowledge.map(ref => `Pinned reference: ${ref.title} (${ref.license}, pin ${ref.pin.slice(0, 12)}) — ${ref.source}`),
  ].filter(Boolean).join('\n')
  const modelRoute = specialistRoute(input.settings, profile)
  try {
    const advice = await input.advise({ system, context: input.task.slice(0, 4000), route: modelRoute })
    input.inbox.publishCanonical({ ...input.source, leaseToken: claim.leaseToken, model: advice.model, options: advice.options }, input.events)
  } catch (error) {
    input.inbox.failCanonical({ ...input.source, leaseToken: claim.leaseToken, error: error instanceof Error ? error.message : String(error) }, input.events)
    throw error
  }
  const item = input.inbox.attributeCharacter(claim.item.id, { characterId: profile.id, name: profile.identity.name, specialty: profile.specialty,
    brief: profile.identity.title, mode: 'suggest',
    rationale: [`Selected by ${route.basis}.`, resolution.nextDecision].filter(Boolean).join(' ').slice(0, 600) })
  return { status: 'advised', route, resolution, item, modelRoute }
}
