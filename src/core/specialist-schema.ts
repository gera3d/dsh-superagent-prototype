/** Server-side validation of the specialist registry (zod stays out of the client bundle). */
import { z } from 'zod'
import type { CharacterConfig } from './character.ts'
import { ACTIVITY_STATES, CAPABILITY_IDS, type CapabilityId, type KnowledgeRef, type SpecialistProfile } from './specialist-profile.ts'

const Id = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)
const Text = (max: number) => z.string().trim().min(1).max(max)

export const KnowledgeRefSchema = z.object({
  id: Id, kind: z.enum(['skill', 'doc', 'repo']), title: Text(200), source: z.string().url().max(500),
  pin: Text(80), version: z.number().int().positive(), license: Text(60), provenance: Text(500),
}).strict() satisfies z.ZodType<KnowledgeRef>

export const SpecialistProfileSchema = z.object({
  id: Id,
  version: z.number().int().positive(),
  identity: z.object({ name: Text(80), title: Text(120), avatar: Id }).strict(),
  specialty: Text(300),
  characterId: z.string().max(64).optional(),
  knowledge: z.array(KnowledgeRefSchema).max(12),
  // Closed enum: an unknown capability identifier is a validation error, never silently kept.
  capabilities: z.array(z.enum(CAPABILITY_IDS as [CapabilityId, ...CapabilityId[]])).max(12),
  modelPolicy: z.object({ inherit: z.enum(['helper', 'executor', 'eval']) }).strict(),
  owner: z.object({ kind: z.enum(['operator', 'role']), id: Id }).strict(),
  activityStates: z.array(z.enum(ACTIVITY_STATES)).min(1).max(ACTIVITY_STATES.length),
  routing: z.object({ keywords: z.array(Text(40)).max(24) }).strict(),
}).strict() satisfies z.ZodType<SpecialistProfile>

export interface RegistryProblem { profileId: string; problem: string }

/**
 * Validates a registry: unique ids, a compatible link to the live character settings (never a conflicting second
 * identity), and no state/capability that the schema does not know. Returns problems instead of throwing so the
 * panel can show them.
 */
export function validateRegistry(profiles: readonly SpecialistProfile[], characters: readonly CharacterConfig[]): RegistryProblem[] {
  const problems: RegistryProblem[] = []
  const seen = new Set<string>()
  for (const profile of profiles) {
    const parsed = SpecialistProfileSchema.safeParse(profile)
    if (!parsed.success) { problems.push({ profileId: String(profile?.id), problem: parsed.error.issues[0]?.message ?? 'Invalid profile' }); continue }
    if (seen.has(profile.id)) problems.push({ profileId: profile.id, problem: 'Duplicate profile id' })
    seen.add(profile.id)
    if (profile.characterId && !characters.some(character => character.id === profile.characterId))
      problems.push({ profileId: profile.id, problem: `Character ${profile.characterId} is not configured` })
    if (profile.characterId) {
      const character = characters.find(item => item.id === profile.characterId)
      if (character && character.mode !== 'suggest_only') problems.push({ profileId: profile.id, problem: 'Linked character is not suggest_only; specialists never auto-push' })
    }
    const unpinned = profile.knowledge.find(ref => !/^[0-9a-f]{40}$/.test(ref.pin) && !/^v?\d+\.\d+/.test(ref.pin))
    if (unpinned) problems.push({ profileId: profile.id, problem: `Knowledge ${unpinned.id} is not pinned to a commit or version` })
  }
  return problems
}

