/**
 * Capability resolution: declared ∩ natively discovered. Pure and read-only.
 *
 * Discovery input is a plain list of native tool names (the Harness registers MCP tools as
 * `mcp__<server>__<tool>`; an adapter may read `ctx.tools.schemas()` names). This module never connects,
 * installs, authenticates or calls anything, and never reads text fields of a profile.
 */
import { CAPABILITY_CATALOG, type CapabilityId, type SpecialistProfile } from './specialist-profile.ts'

export interface NativeDiscovery {
  /** Names of tools the native Harness exposes right now. */
  toolNames: readonly string[]
  /** When the list was read (epoch ms); lets callers refuse an old snapshot. */
  at: number
}

export type RefusalReason = 'no_native_tool' | 'not_grantable' | 'discovery_stale'
export interface CapabilityRefusal { id: CapabilityId; reason: RefusalReason; detail: string }
export interface CapabilityResolution {
  profileId: string
  granted: CapabilityId[]
  refused: CapabilityRefusal[]
  /** Native tool names that satisfied each granted native capability (evidence, not a credential). */
  evidence: Partial<Record<CapabilityId, string[]>>
  /** Specific next decision for a person when something declared is unavailable; absent when nothing is missing. */
  nextDecision?: string
}

export const DISCOVERY_MAX_AGE_MS = 5 * 60_000

/** The one place that turns a declaration into an effective capability. */
export function resolveCapabilities(profile: SpecialistProfile, discovery: NativeDiscovery | undefined, now = Date.now()): CapabilityResolution {
  const granted: CapabilityId[] = [], refused: CapabilityRefusal[] = [], evidence: Partial<Record<CapabilityId, string[]>> = {}
  const fresh = !!discovery && Number.isFinite(discovery.at) && now - discovery.at <= DISCOVERY_MAX_AGE_MS && discovery.at <= now + 60_000
  for (const id of new Set(profile.capabilities)) {
    const entry = CAPABILITY_CATALOG[id] as { requires: 'builtin' | 'native_tool' | 'never'; pattern?: RegExp }
    if (!entry) { refused.push({ id, reason: 'not_grantable', detail: 'Unknown capability identifier' }); continue }
    if (entry.requires === 'builtin') { granted.push(id); continue }
    if (entry.requires === 'never') { refused.push({ id, reason: 'not_grantable', detail: 'Not grantable in this version' }); continue }
    if (!fresh) { refused.push({ id, reason: 'discovery_stale', detail: discovery ? 'Native tool discovery is stale' : 'Native tool discovery has not run' }); continue }
    const matches = discovery!.toolNames.filter(name => entry.pattern!.test(name))
    if (!matches.length) { refused.push({ id, reason: 'no_native_tool', detail: 'No matching native tool is connected in this Harness' }); continue }
    granted.push(id); evidence[id] = matches.slice(0, 8)
  }
  const missing = refused.filter(item => item.reason !== 'not_grantable')
  const cloudflareMissing = missing.some(item => item.id.startsWith('cloudflare.'))
  return { profileId: profile.id, granted, refused, evidence,
    ...(missing.length ? { nextDecision: cloudflareMissing
      ? 'Cloudflare capability unavailable: decide whether to connect an official Cloudflare MCP server to this Harness (a person adds and authorizes it), or keep the Cloudflare Specialist advice-only from its pinned references.'
      : 'A declared native capability is unavailable: connect the missing native tool or remove the declaration.' } : {}) }
}

/** Refuse before acting: true only when the capability was actually granted by discovery or is built in. */
export function canUse(resolution: CapabilityResolution, id: CapabilityId): boolean { return resolution.granted.includes(id) }
