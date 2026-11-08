import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DecisionInbox } from '../src/app/decision-inbox.ts'
import { adviseWithSpecialist, discoverNativeTools, specialistRoute, type SpecialistAdvise } from '../src/app/specialist-advice.ts'
import { SettingsSchema } from '../src/policy.ts'
import { seedProfiles } from '../src/core/specialist-profile.ts'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const events = [
  { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
  { type: 'assistant/message', seq: 1, time: 101, data: { turn: 1, step: 1, message: { id: 'source-message', role: 'assistant', content: [{ type: 'text', text: 'Deploy the Worker with wrangler to Cloudflare?' }] }, stream: [] } },
  { type: 'turn/end', seq: 2, time: 102, data: { turn: 1, reason: { kind: 'completed' } } },
] as unknown as SessionEvent[]
const source = { sessionId: 'session', sourceMessageId: 'source-message', sourceTurn: 1, sourceSeq: 1, draftRevision: 'rev-1' }
const options = [
  { id: 'docs-first', label: 'Read the Workers docs', prompt: 'Read the Workers docs before changing config.', why: 'Cheapest check.', recommended: true },
  { id: 'dry-run', label: 'Run wrangler dry-run', prompt: 'Run wrangler deploy --dry-run.', why: 'No writes.', recommended: false },
]
function open() { const db = new DatabaseSync(':memory:'); databases.push(db); const inbox = new DecisionInbox(db); inbox.capture('session', events); return { db, inbox } }
const settings = SettingsSchema.parse({})
const profiles = seedProfiles()
const names = ['bash', 'read', 'mcp__chrome__navigate']

it('routes a task to the Cloudflare Specialist on the SAME canonical record, with unavailable capability stated, and no second store', async () => {
  const { db, inbox } = open()
  const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => String(row.name))
  const before = tables()
  expect(inbox.list()).toHaveLength(0)
  const seen: any[] = []
  const advise: SpecialistAdvise = async request => { seen.push(request); return { model: 'mock-model', options } }
  const result = await adviseWithSpecialist({ inbox, source, events, profiles, settings, discovery: { toolNames: names, at: Date.now() }, task: 'Deploy the Worker with wrangler to Cloudflare', advise })
  expect(result.status).toBe('advised')
  if (result.status !== 'advised') return
  expect(result.route).toMatchObject({ profileId: 'cloudflare_specialist', basis: 'keyword' })
  expect(result.resolution.granted).toEqual(['advice.read'])
  expect(result.resolution.nextDecision).toContain('Cloudflare capability unavailable')
  // Same record, one job, no new tables, character attribution recorded, choices published once.
  expect(inbox.list()).toHaveLength(1)
  expect(tables()).toEqual(before)
  expect(result.item).toMatchObject({ character: { characterId: 'cloudflare_specialist', name: 'Cloudflare Specialist', mode: 'suggest' }, advisor: { status: 'ready', model: 'mock-model' }, canonical: { phase: 'ready' } })
  expect(result.item.choices.map(choice => choice.id)).toEqual(['docs-first', 'dry-run'])
  // The advice call is tool-free in contract: only a system prompt, context and route; it names pinned refs and says what is unavailable.
  expect(Object.keys(seen[0]).sort()).toEqual(['context', 'route', 'system'])
  expect(seen[0].system).toContain('Unavailable (do not claim or simulate them): cloudflare.docs.read, cloudflare.account.read')
  expect(seen[0].system).toContain('pin 6eb6c781aa9b')
})

it('continues only through the unchanged explicit native Prepare → Send flow, and attribution cannot touch a staged record', async () => {
  const { inbox } = open()
  const result = await adviseWithSpecialist({ inbox, source, events, profiles, settings, task: 'Review the diff and typecheck', advise: async () => ({ model: 'mock', options }) })
  if (result.status !== 'advised') throw new Error('expected advice')
  expect(result.route.profileId).toBe('senior_developer')
  const id = result.item.id, attemptId = randomUUID()
  // Advice alone never resolves anything.
  expect(inbox.get(id)).toMatchObject({ status: 'pending' })
  const staged = inbox.stage(id, { attemptId, choiceId: 'docs-first', draftText: 'Read the Workers docs before changing config.' })
  expect(staged).toMatchObject({ execution: 'not_executed', item: { status: 'pending' } })
  expect(() => inbox.attributeCharacter(id, { characterId: 'administrator', name: 'Administrator', mode: 'suggest' })).toThrow('open, unstaged')
  inbox.bindSubmission(id, { attemptId, submissionId: 'native-1' }, events)
  expect(inbox.get(id)?.status).toBe('pending')
  inbox.capture('session', [...events, { type: 'user/message', seq: 3, time: 1003, data: { id: 'native-message-3', role: 'user', source: { kind: 'user', rpcId: 'native-1' }, content: [{ type: 'text', text: 'Read the Workers docs before changing config.' }] } } as unknown as SessionEvent])
  expect(inbox.get(id)).toMatchObject({ status: 'resolved', resolvedChoice: 'docs-first', resolutionBasis: 'submitted', character: { characterId: 'senior_developer' } })
})

it('refuses duplicate advice for the same job, a disabled profile and a failing advisor leaves a recorded error without choices', async () => {
  const { inbox } = open()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const first = adviseWithSpecialist({ inbox, source, events, profiles, settings, task: 'review', advise: async () => { await gate; return { model: 'm', options } } })
  const second = await adviseWithSpecialist({ inbox, source, events, profiles, settings, task: 'review', advise: async () => { throw new Error('must not run') } })
  expect(second).toMatchObject({ status: 'refused', reason: expect.stringContaining('already being advised') })
  release(); expect((await first).status).toBe('advised')
  expect(inbox.list()).toHaveLength(1)

  const other = open()
  const disabled = SettingsSchema.parse({ characters: { characters: [{ ...settings.characters.characters[0]!, enabled: false }] } })
  expect(await adviseWithSpecialist({ inbox: other.inbox, source, events, profiles, settings: disabled, task: 'review', advise: async () => ({ model: 'm', options }) }))
    .toMatchObject({ status: 'refused', reason: expect.stringContaining('disabled') })

  const failing = open()
  await expect(adviseWithSpecialist({ inbox: failing.inbox, source, events, profiles, settings, task: 'review', advise: async () => { throw new Error('model down') } })).rejects.toThrow('model down')
  expect(failing.inbox.list()[0]).toMatchObject({ choices: [], advisor: { status: 'error' } })
})

it('inherits the existing model route and never names a provider; discovery is read-only and fail-closed', () => {
  const route = (id: string) => specialistRoute(settings, profiles.find(profile => profile.id === id)!)
  expect(route('senior_developer')).toEqual(route('cloudflare_specialist'))
  expect(profiles.every(profile => Object.keys(profile.modelPolicy).join() === 'inherit')).toBe(true)
  const sol = { provider: 'openai-codex', model: 'gpt-6.1-sol', starred: true }, gemini = { provider: 'antigravity', model: 'gemini-3.8-flash', starred: true }
  const open = SettingsSchema.parse({ models: { hierarchy: [sol, gemini], helper: { provider: sol.provider, model: sol.model } } })
  const parked = SettingsSchema.parse({ models: { hierarchy: [sol, gemini], helper: { provider: sol.provider, model: sol.model }, subscriptions: [{ provider: 'openai-codex', status: 'conserved' }] } })
  // Same inheritance path as the existing helper: the parked OpenAI route is skipped, the saved order is untouched.
  expect(specialistRoute(open, profiles[1]!)?.provider).toBe('openai-codex')
  for (const profile of profiles) expect(specialistRoute(parked, profile)?.provider).not.toBe('openai-codex')
  expect(discoverNativeTools({ schemas: () => [{ name: 'bash' }, { name: 'mcp__cf__docs' }] }, 5)).toEqual({ toolNames: ['bash', 'mcp__cf__docs'], at: 5 })
  expect(discoverNativeTools({ schemas: () => { throw new Error('boom') } }, 5).toolNames).toEqual([])
  expect(discoverNativeTools(undefined, 5).toolNames).toEqual([])
})
