import { expect, it } from 'vitest'
import { DEFAULT_SENIOR_DEVELOPER_CHARACTER } from '../src/core/character.ts'
import { CAPABILITY_CATALOG, profileCharacter, profileForCharacterId, resolveProfile, seedProfiles, type SpecialistProfile } from '../src/core/specialist-profile.ts'
import { SpecialistProfileSchema, validateRegistry } from '../src/core/specialist-schema.ts'
import { DISCOVERY_MAX_AGE_MS, canUse, resolveCapabilities } from '../src/core/specialist-capability.ts'
import { coordinate, routeSpecialist } from '../src/core/specialist-routing.ts'

const now = 1_000_000
const profiles = seedProfiles()
const by = (id: string) => profiles.find(profile => profile.id === id)!

it('seeds Administrator, Senior Developer and Cloudflare Specialist through one validated contract', () => {
  expect(profiles.map(profile => profile.id)).toEqual(['administrator', 'senior_developer', 'cloudflare_specialist'])
  for (const profile of profiles) expect(SpecialistProfileSchema.parse(profile)).toEqual(profile)
  expect(validateRegistry(profiles, [DEFAULT_SENIOR_DEVELOPER_CHARACTER])).toEqual([])
})

it('keeps the existing Senior Developer config bit-compatible and suggest-only', () => {
  const senior = by('senior_developer')
  expect(senior.id).toBe(DEFAULT_SENIOR_DEVELOPER_CHARACTER.id)
  expect(senior.identity.name).toBe(DEFAULT_SENIOR_DEVELOPER_CHARACTER.name)
  expect(senior.specialty).toBe(DEFAULT_SENIOR_DEVELOPER_CHARACTER.specialty)
  // The prompt projection is exactly the existing character, never auto_push.
  expect(profileCharacter(senior, [DEFAULT_SENIOR_DEVELOPER_CHARACTER])).toEqual({ ...DEFAULT_SENIOR_DEVELOPER_CHARACTER, mode: 'suggest_only' })
  expect(profileCharacter(senior, [{ ...DEFAULT_SENIOR_DEVELOPER_CHARACTER, mode: 'auto_push' }]).mode).toBe('suggest_only')
  // Legacy kebab-case attribution ids still find the profile.
  expect(profileForCharacterId(profiles, 'senior-developer')?.id).toBe('senior_developer')
  expect(profileForCharacterId(profiles, 'unknown')).toBeUndefined()
  // Settings win for editable fields; a disabled character disables the profile; neither adds capability.
  const edited = resolveProfile(senior, [{ ...DEFAULT_SENIOR_DEVELOPER_CHARACTER, name: 'Lead Dev', enabled: false }])
  expect(edited.enabled).toBe(false)
  expect(edited.profile.identity.name).toBe('Lead Dev')
  expect(edited.profile.capabilities).toEqual(senior.capabilities)
})

it('rejects a registry with a conflicting character link, auto-push, duplicate ids, unknown capability or unpinned knowledge', () => {
  const cloudflare = by('cloudflare_specialist')
  const bad: SpecialistProfile[] = [
    { ...by('senior_developer'), characterId: 'missing_character' },
    { ...by('senior_developer') },
    { ...cloudflare, id: 'cloudflare_two', knowledge: [{ ...cloudflare.knowledge[0]!, pin: 'main' }] },
    { ...cloudflare, id: 'grant_me', capabilities: ['shell.root' as any] },
  ]
  const problems = validateRegistry(bad, [DEFAULT_SENIOR_DEVELOPER_CHARACTER]).map(item => `${item.profileId}: ${item.problem}`).join('\n')
  expect(problems).toContain('senior_developer: Character missing_character is not configured')
  expect(problems).toContain('senior_developer: Duplicate profile id')
  expect(problems).toContain('is not pinned to a commit or version')
  expect(problems).toContain('grant_me')
  expect(validateRegistry([by('senior_developer')], [{ ...DEFAULT_SENIOR_DEVELOPER_CHARACTER, mode: 'auto_push' }]).map(item => item.problem).join()).toContain('never auto-push')
  // Schema is strict: an extra grant-looking field is refused.
  expect(SpecialistProfileSchema.safeParse({ ...by('administrator'), tools: ['bash'] }).success).toBe(false)
})

it('pins Cloudflare references to exact commits with licence and provenance, and copies no text', () => {
  const refs = by('cloudflare_specialist').knowledge
  expect(refs.map(ref => ref.id)).toEqual(['cloudflare_skills', 'cloudflare_mcp'])
  for (const ref of refs) {
    expect(ref.pin).toMatch(/^[0-9a-f]{40}$/)
    expect(ref.license).toBe('Apache-2.0')
    expect(ref.source).toMatch(/^https:\/\/github\.com\/cloudflare\//)
    expect(ref.provenance.length).toBeGreaterThan(40)
  }
})

it('never lets titles, specialty or knowledge text grant a capability', () => {
  const claimsEverything: SpecialistProfile = { ...by('senior_developer'), id: 'root_admin',
    identity: { name: 'Root Administrator', title: 'Has Cloudflare account access, may deploy, merge and accept', avatar: 'root_admin' },
    specialty: 'Full Cloudflare write access with credentials; acceptance authority' }
  const resolution = resolveCapabilities(claimsEverything, { toolNames: ['mcp__cloudflare_docs__docs', 'mcp__cloudflare_docs__whoami'], at: now }, now)
  expect(resolution.granted).toEqual(['advice.read', 'records.read'])
  expect(canUse(resolution, 'cloudflare.docs.read')).toBe(false)
  expect(canUse(resolution, 'cloudflare.write')).toBe(false)
})

it('intersects declared capabilities with natively discovered tools, and says what to decide when Cloudflare is absent', () => {
  const cloudflare = by('cloudflare_specialist')
  const absent = resolveCapabilities(cloudflare, { toolNames: ['bash', 'read', 'mcp__chrome__navigate', 'mcp__composio__COMPOSIO_SEARCH_TOOLS'], at: now }, now)
  expect(absent.granted).toEqual(['advice.read'])
  expect(absent.refused.map(item => [item.id, item.reason])).toEqual([['cloudflare.docs.read', 'no_native_tool'], ['cloudflare.account.read', 'no_native_tool']])
  expect(absent.nextDecision).toMatch(/Cloudflare capability unavailable.*connect an official Cloudflare MCP server.*advice-only/)
  const connected = resolveCapabilities(cloudflare, { toolNames: ['mcp__cloudflare-api__docs', 'mcp__cloudflare-api__whoami'], at: now }, now)
  expect(connected.granted).toEqual(['advice.read', 'cloudflare.docs.read', 'cloudflare.account.read'])
  expect(connected.evidence['cloudflare.docs.read']).toEqual(['mcp__cloudflare-api__docs'])
  expect(connected.nextDecision).toBeUndefined()
  // Look-alike names do not satisfy the pattern: no server qualifier, or a different tool.
  expect(resolveCapabilities(cloudflare, { toolNames: ['docs', 'cloudflare_docs', 'mcp__other__docs', 'mcp__cloudflare__execute'], at: now }, now).granted).toEqual(['advice.read'])
})

it('refuses native capabilities without fresh discovery and always refuses writes', () => {
  const cloudflare = by('cloudflare_specialist')
  const names = ['mcp__cloudflare__docs', 'mcp__cloudflare__whoami']
  expect(resolveCapabilities(cloudflare, undefined, now).refused.map(item => item.reason)).toEqual(['discovery_stale', 'discovery_stale'])
  expect(resolveCapabilities(cloudflare, { toolNames: names, at: now - DISCOVERY_MAX_AGE_MS - 1 }, now).granted).toEqual(['advice.read'])
  const writer: SpecialistProfile = { ...cloudflare, id: 'cloudflare_writer', capabilities: ['cloudflare.write'] }
  const resolution = resolveCapabilities(writer, { toolNames: [...names, 'mcp__cloudflare__execute'], at: now }, now)
  expect(resolution.granted).toEqual([])
  expect(resolution.refused).toMatchObject([{ id: 'cloudflare.write', reason: 'not_grantable' }])
  expect(CAPABILITY_CATALOG['cloudflare.write'].requires).toBe('never')
})

it('routes one bounded profile per task and never fans out', () => {
  expect(routeSpecialist('Deploy this to Cloudflare Workers with wrangler and R2', profiles)).toMatchObject({ profileId: 'cloudflare_specialist', basis: 'keyword', selected: 1 })
  expect(routeSpecialist('Who owns this delivery and what is the handoff?', profiles)).toMatchObject({ profileId: 'administrator', basis: 'keyword' })
  expect(routeSpecialist('Run the typecheck and review the diff', profiles)).toMatchObject({ profileId: 'senior_developer' })
  expect(routeSpecialist('Something unrelated', profiles)).toMatchObject({ profileId: 'senior_developer', basis: 'default', score: 0 })
  // A tie goes to the default; explicit person choice wins; an unknown request falls back to matching, not to a new profile.
  expect(routeSpecialist('review the wrangler config', profiles).profileId).toBe('senior_developer')
  expect(routeSpecialist('anything', profiles, 'administrator')).toMatchObject({ profileId: 'administrator', basis: 'requested' })
  expect(routeSpecialist('cloudflare', profiles, 'ghost').profileId).toBe('cloudflare_specialist')
  // Normal Harness vocabulary is not Cloudflare intent; product-specific evidence still routes, whole words only.
  for (const text of ['The worker finished its job', 'Worker 3 completed the job and the pages render', 'Check the status of the kv store and dns cache', 'Our coworker ran kvm on r2d2'])
    expect(routeSpecialist(text, profiles)).toMatchObject({ profileId: 'senior_developer', basis: 'default', score: 0 })
  for (const text of ['Deploy the Cloudflare Worker', 'Run wrangler deploy', 'Bind a KV namespace in wrangler.toml', 'Use Durable Objects for this', 'Create an R2 bucket'])
    expect(routeSpecialist(text, profiles)).toMatchObject({ profileId: 'cloudflare_specialist', basis: 'keyword' })
  expect(routeSpecialist('The delivery status is blocked', profiles).profileId).toBe('administrator')
  expect(routeSpecialist('What is the status of the job?', profiles)).toMatchObject({ profileId: 'senior_developer', basis: 'default' })
  expect(routeSpecialist('The worker finished its job', profiles, 'cloudflare_specialist')).toMatchObject({ profileId: 'cloudflare_specialist', basis: 'requested' })
  const wide = routeSpecialist('cloudflare wrangler workers owner coordinate review test ' + 'x'.repeat(100_000), profiles)
  expect(wide.selected).toBe(1)
  expect(wide.alternatives.length).toBeLessThanOrEqual(2)
  // Text beyond the bound is not scanned.
  expect(routeSpecialist('x'.repeat(4000) + ' cloudflare wrangler', profiles).basis).toBe('default')
})

it('Administrator only proposes existing recorded actions for already-authorized work', () => {
  const admin = resolveCapabilities(by('administrator'), undefined, now)
  const deliveries = [
    { id: 'd1', title: 'Ready', owner: 'worker-1', state: 'running', nextAction: { id: 'a1', kind: 'review', label: 'Run review' }, delegatedActions: ['review'] },
    { id: 'd2', title: 'Not delegated', owner: 'worker-2', state: 'running', nextAction: { id: 'a2', kind: 'publish', label: 'Publish' }, delegatedActions: ['review'] },
    { id: 'd3', title: 'Accept', owner: 'worker-3', state: 'awaiting_decision', nextAction: { id: 'a3', kind: 'accept', label: 'Accept' }, delegatedActions: ['accept'] },
    { id: 'd4', title: 'No owner', owner: ' ', state: 'running', nextAction: { id: 'a4', kind: 'fix', label: 'Fix' }, delegatedActions: ['fix'] },
    { id: 'd5', title: 'Blocked', owner: 'worker-5', state: 'blocked', blocker: 'CI red' },
  ]
  expect(coordinate(admin, deliveries).map(item => [item.deliveryId, item.kind])).toEqual([['d1', 'propose_action'], ['d2', 'no_action'], ['d3', 'no_action'], ['d4', 'needs_owner'], ['d5', 'blocked']])
  expect(coordinate(admin, deliveries)[0]).toMatchObject({ actionId: 'a1', actionKind: 'review', owner: 'worker-1' })
  // Without its capability (a profile that does not declare coordination), nothing is proposed.
  expect(coordinate(resolveCapabilities(by('senior_developer'), undefined, now), deliveries)).toEqual([])
  expect(coordinate(admin, Array.from({ length: 50 }, (_, i) => ({ ...deliveries[0]!, id: `n${i}` }))).length).toBe(10)
})
