/**
 * Bounded profile selection and Administrator coordination. Pure; grants nothing.
 * Selecting a profile only chooses WHO advises; the work, owner and authority stay on the existing recorded job.
 */
import type { SpecialistProfile } from './specialist-profile.ts'
import { canUse, type CapabilityResolution } from './specialist-capability.ts'

export const ROUTING_TEXT_MAX = 4000
export const COORDINATION_MAX = 10
export const DEFAULT_PROFILE_ID = 'senior_developer'

export interface RouteDecision {
  profileId: string
  /** Why: `requested` (explicit person choice), `keyword` or `default`. */
  basis: 'requested' | 'keyword' | 'default'
  score: number
  /** Always one profile: routing never fans out. */
  selected: 1
  /** Runner-ups for transparency, at most two. */
  alternatives: { profileId: string; score: number }[]
}

/** Deterministic keyword scoring over a length-bounded text; ties resolve to registry order, then the default. */
export function routeSpecialist(text: string, profiles: readonly SpecialistProfile[], requestedProfileId?: string): RouteDecision {
  const enabled = profiles.filter(profile => profile.activityStates.length > 0)
  if (requestedProfileId) {
    const requested = enabled.find(profile => profile.id === requestedProfileId)
    if (requested) return { profileId: requested.id, basis: 'requested', score: 1, selected: 1, alternatives: [] }
  }
  const haystack = text.slice(0, ROUTING_TEXT_MAX).toLowerCase()
  const scored = enabled.map((profile, index) => ({ profileId: profile.id, index,
    score: profile.routing.keywords.reduce((total, word) => total + (haystack.includes(word.toLowerCase()) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score || (a.profileId === DEFAULT_PROFILE_ID ? -1 : b.profileId === DEFAULT_PROFILE_ID ? 1 : a.index - b.index))
  const best = scored[0]
  if (!best || best.score === 0) {
    const fallback = enabled.find(profile => profile.id === DEFAULT_PROFILE_ID) ?? enabled[0]
    return { profileId: fallback?.id ?? DEFAULT_PROFILE_ID, basis: 'default', score: 0, selected: 1, alternatives: [] }
  }
  return { profileId: best.profileId, basis: 'keyword', score: best.score, selected: 1,
    alternatives: scored.slice(1, 3).filter(item => item.score > 0).map(({ profileId, score }) => ({ profileId, score })) }
}

/** The minimum of a recorded delivery the Administrator may read; structurally satisfied by `Delivery`. */
export interface CoordinationDelivery {
  id: string; title: string; owner: string; state: string; blocker?: string
  nextAction?: { id: string; kind: string; label: string }
  delegatedActions?: readonly string[]
}
export interface CoordinationProposal {
  deliveryId: string; title: string; owner: string
  /** `propose_action`: an existing typed action a person still confirms. `needs_owner`/`blocked`: nothing proposed. */
  kind: 'propose_action' | 'needs_owner' | 'blocked' | 'no_action'
  actionId?: string; actionKind?: string; note: string
}

/**
 * Administrator output. It only reads recorded deliveries and PROPOSES the existing recorded next action, and only
 * when the delivery already names an owner and the action kind is one the delivery already delegated. It never
 * executes, never proposes `accept`, and never crosses to a delivery it was not handed.
 */
export function coordinate(resolution: CapabilityResolution, deliveries: readonly CoordinationDelivery[]): CoordinationProposal[] {
  if (!canUse(resolution, 'coordinate.typed_action') || !canUse(resolution, 'records.read')) return []
  return deliveries.slice(0, COORDINATION_MAX).map((delivery): CoordinationProposal => {
    const base = { deliveryId: delivery.id, title: delivery.title, owner: delivery.owner }
    if (!delivery.owner.trim()) return { ...base, kind: 'needs_owner', note: 'No recorded owner; a person must assign one first.' }
    if (delivery.state === 'blocked' || delivery.blocker) return { ...base, kind: 'blocked', note: delivery.blocker ?? 'Delivery is blocked.' }
    const action = delivery.nextAction
    if (!action) return { ...base, kind: 'no_action', note: 'No recorded next action.' }
    if (action.kind === 'accept') return { ...base, kind: 'no_action', note: 'Acceptance is a person-only decision; it is never proposed here.' }
    if (!delivery.delegatedActions?.includes(action.kind)) return { ...base, kind: 'no_action', note: `Action ${action.kind} is not delegated on this delivery.` }
    return { ...base, kind: 'propose_action', actionId: action.id, actionKind: action.kind, note: `Propose recorded action "${action.label}"; a person confirms.` }
  })
}
