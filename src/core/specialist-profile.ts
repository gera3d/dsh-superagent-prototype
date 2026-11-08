/**
 * Specialist profile registry: ONE typed contract over the existing character mechanism.
 *
 * A profile DECLARES identity, specialty, versioned knowledge references, capability identifiers, model-policy
 * inheritance, an owner and the activity states it can show. A declaration is never a grant: the effective
 * capabilities are the intersection with what the native Harness actually exposes (`specialist-capability.ts`).
 * Titles, briefs and knowledge text carry no capability, tool, credential, access or acceptance authority.
 */
import { DEFAULT_SENIOR_DEVELOPER_CHARACTER, type CharacterConfig } from './character.ts'

/** The closed activity vocabulary. `unknown` is a display fallback for missing/stale evidence, never "working". */
export const ACTIVITY_STATES = ['idle', 'investigating', 'tools', 'testing', 'waiting', 'blocked', 'complete'] as const
export type ActivityState = (typeof ACTIVITY_STATES)[number]
export const WORKING_STATES: readonly ActivityState[] = ['investigating', 'tools', 'testing']

/**
 * Closed capability catalog. A profile may only name identifiers from here; an identifier is only a name for a
 * requirement that native discovery must satisfy. Nothing here executes work.
 */
export const CAPABILITY_CATALOG = {
  /** Tool-free advice through the existing helper route; always native. */
  'advice.read': { requires: 'builtin', summary: 'Give tool-free advice for a decision.' },
  /** Read recorded decisions/deliveries through existing native projections. */
  'records.read': { requires: 'builtin', summary: 'Read recorded decisions, deliveries and owners.' },
  /** Propose an existing typed action for ALREADY authorized work; a person still confirms and Sends. */
  'coordinate.typed_action': { requires: 'builtin', summary: 'Propose existing typed actions for already-authorized work.' },
  /** Search Cloudflare developer documentation through a native MCP tool. */
  'cloudflare.docs.read': { requires: 'native_tool', pattern: /^mcp__[A-Za-z0-9_-]*cloudflare[A-Za-z0-9_-]*__(docs|search)$/i,
    summary: 'Search Cloudflare documentation through a connected native Cloudflare MCP tool.' },
  /** Read the connected Cloudflare account (whoami / read-only API search). */
  'cloudflare.account.read': { requires: 'native_tool', pattern: /^mcp__[A-Za-z0-9_-]*cloudflare[A-Za-z0-9_-]*__(whoami|search)$/i,
    summary: 'Read the connected Cloudflare account through a native Cloudflare MCP tool.' },
  /** Reserved. No v1 profile may be granted live Cloudflare writes; always refused. */
  'cloudflare.write': { requires: 'never', summary: 'Mutate Cloudflare resources. Not grantable in v1.' },
} as const
export type CapabilityId = keyof typeof CAPABILITY_CATALOG
export const CAPABILITY_IDS = Object.keys(CAPABILITY_CATALOG) as CapabilityId[]

/** Versioned, pinned knowledge/skill reference. It carries provenance and licence, never authority. */
export interface KnowledgeRef {
  id: string
  kind: 'skill' | 'doc' | 'repo'
  title: string
  /** Official source location. */
  source: string
  /** Exact pin (commit SHA or released version); a floating branch is not a pin. */
  pin: string
  version: number
  license: string
  /** Where the content was inspected and how it is used (reference only vs copied). */
  provenance: string
}

export interface SpecialistProfile {
  id: string
  version: number
  identity: { name: string; title: string; avatar: string }
  specialty: string
  /** Existing CharacterConfig id this profile extends (compat link); settings still win for editable fields. */
  characterId?: string
  knowledge: KnowledgeRef[]
  capabilities: CapabilityId[]
  /** Inherits an existing role route from settings.models; never names a provider, model or key. */
  modelPolicy: { inherit: 'helper' | 'executor' | 'eval' }
  owner: { kind: 'operator' | 'role'; id: string }
  activityStates: ActivityState[]
  /** Selection keywords for the bounded router. Selecting a profile grants nothing. */
  routing: { keywords: string[] }
}

const CLOUDFLARE_SKILLS_PIN = '6eb6c781aa9b6438e0c7307bd102788a75fe1a6d'
const CLOUDFLARE_MCP_PIN = '563b71037a3cc1f1ed52d944133abb3aca5a0901'
const ALL_STATES: ActivityState[] = [...ACTIVITY_STATES]

/** Senior Developer identity is derived from the existing default character so the two cannot drift. */
function seniorDeveloper(character: CharacterConfig): SpecialistProfile {
  return { id: character.id, version: 1, identity: { name: character.name, title: 'Verification-first reviewer', avatar: 'senior_developer' },
    specialty: character.specialty, characterId: character.id, knowledge: [], capabilities: ['advice.read', 'records.read'],
    modelPolicy: { inherit: 'helper' }, owner: { kind: 'operator', id: 'gera' }, activityStates: ALL_STATES,
    routing: { keywords: ['test', 'typecheck', 'diff', 'refactor', 'review', 'regression', 'architecture', 'bug'] } }
}

/** Seed registry. Order is stable; the Senior Developer is the default for unmatched work. */
export function seedProfiles(character: CharacterConfig = DEFAULT_SENIOR_DEVELOPER_CHARACTER): SpecialistProfile[] {
  return [
    { id: 'administrator', version: 1, identity: { name: 'Administrator', title: 'Coordinator of already-authorized work', avatar: 'administrator' },
      specialty: 'Ownership, sequencing and hand-offs across recorded deliveries', knowledge: [],
      capabilities: ['records.read', 'coordinate.typed_action'], modelPolicy: { inherit: 'eval' }, owner: { kind: 'operator', id: 'gera' },
      activityStates: ALL_STATES, routing: { keywords: ['who owns', 'coordinate', 'handoff', 'hand-off', 'delivery status', 'next owner', 'sequence the'] } },
    seniorDeveloper(character),
    { id: 'cloudflare_specialist', version: 1, identity: { name: 'Cloudflare Specialist', title: 'Cloudflare platform advisor', avatar: 'cloudflare_specialist' },
      specialty: 'Cloudflare Workers, Pages, DNS, R2, D1, KV and Wrangler guidance',
      knowledge: [
        { id: 'cloudflare_skills', kind: 'skill', title: 'Cloudflare Skills (Wrangler, Workers, Durable Objects, Agents SDK, best practices)',
          source: 'https://github.com/cloudflare/skills', pin: CLOUDFLARE_SKILLS_PIN, version: 1, license: 'Apache-2.0',
          provenance: 'Official Cloudflare repository; pinned commit and LICENSE inspected read-only via gh. Referenced by name and pin only; no skill text is copied into this repository.' },
        { id: 'cloudflare_mcp', kind: 'repo', title: 'Cloudflare MCP server (docs, search, execute, whoami)',
          source: 'https://github.com/cloudflare/mcp', pin: CLOUDFLARE_MCP_PIN, version: 1, license: 'Apache-2.0',
          provenance: 'Official Cloudflare repository README inspected read-only via gh at the pinned commit. Documents the tool names only; no connection, credential or install is performed here.' },
      ],
      // Declared, not granted: docs/account reads need a connected native Cloudflare MCP tool; writes are never grantable.
      capabilities: ['advice.read', 'cloudflare.docs.read', 'cloudflare.account.read'],
      modelPolicy: { inherit: 'helper' }, owner: { kind: 'operator', id: 'gera' }, activityStates: ALL_STATES,
      routing: { keywords: ['cloudflare', 'wrangler', 'wrangler.toml', 'workers.dev', 'workers kv', 'durable object', 'durable objects', 'r2 bucket', 'd1 database', 'kv namespace'] } },
  ]
}

/**
 * Settings win for the editable character fields (name, specialty), matching how the helper already resolves
 * `senior_developer`. A disabled linked character disables the profile. Capabilities, owner and knowledge never
 * come from settings or from text.
 */
export function resolveProfile(profile: SpecialistProfile, characters: readonly CharacterConfig[]): { profile: SpecialistProfile; enabled: boolean } {
  if (!profile.characterId) return { profile, enabled: true }
  const character = characters.find(item => item.id === profile.characterId)
  if (!character) return { profile, enabled: true }
  return { enabled: character.enabled, profile: { ...profile, specialty: character.specialty, identity: { ...profile.identity, name: character.name } } }
}

/** Compatibility projection used by the existing helper/evaluator prompts (`helperSystemPrompt`). */
export function profileCharacter(profile: SpecialistProfile, characters: readonly CharacterConfig[] = []): CharacterConfig {
  const linked = profile.characterId ? characters.find(item => item.id === profile.characterId) ?? (profile.characterId === DEFAULT_SENIOR_DEVELOPER_CHARACTER.id ? DEFAULT_SENIOR_DEVELOPER_CHARACTER : undefined) : undefined
  if (linked) return { ...linked, mode: 'suggest_only' }
  return { id: profile.id, name: profile.identity.name, specialty: profile.specialty,
    brief: `${profile.identity.title}. Advise within the declared specialty and cite the pinned references by name; never claim tool access that was not discovered.`,
    standards: ['Advice only; a person confirms and Sends', 'State when a needed capability is unavailable', 'Never invent verification results'],
    permissionToDisagree: true, inclinedTools: [], mode: 'suggest_only', apiKeyEnv: '', enabled: true }
}

/** Existing `DecisionCharacterAttribution.characterId` uses kebab-case for the legacy Senior Developer. */
export function profileForCharacterId(profiles: readonly SpecialistProfile[], characterId: string | undefined): SpecialistProfile | undefined {
  if (!characterId) return undefined
  const normalized = characterId.replaceAll('-', '_')
  return profiles.find(profile => profile.id === normalized || profile.characterId === normalized)
}
