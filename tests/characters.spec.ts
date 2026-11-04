import { describe, expect, it } from 'vitest'
import {
  CharacterSchema,
  CharactersConfigSchema,
  DEFAULT_CHARACTERS,
  LOCKED_ESCALATION_LIST,
  isLockedEscalation,
  SettingsSchema,
} from '../src/policy.ts'

describe('Characters configuration schema & defaults', () => {
  it('validates a well-formed character', () => {
    const valid = {
      id: 'senior-dev',
      name: 'Senior Developer',
      specialty: 'Code Quality & Testing',
      brief: 'Enforces strict code standards, tests first.',
      tools: ['vitest', 'tsc'],
      mode: 'suggest',
      enabled: true,
    }
    expect(CharacterSchema.parse(valid)).toEqual(valid)
  })

  it('rejects characters missing mandatory fields', () => {
    expect(() => CharacterSchema.parse({ id: 'bad' })).toThrow()
    expect(() =>
      CharacterSchema.parse({
        id: 'bad',
        name: '',
        specialty: 'Testing',
        brief: 'Test',
      }),
    ).toThrow()
  })

  it('provides the Senior Developer as the first default character', () => {
    const config = CharactersConfigSchema.parse({})
    expect(config.items.length).toBeGreaterThanOrEqual(1)
    const first = config.items[0]!
    expect(first.id).toBe('senior-developer')
    expect(first.name).toBe('Senior Developer')
    expect(first.specialty).toContain('Code Quality')
    expect(first.mode).toBe('suggest')
    expect(first.tools).toContain('vitest')
    expect(first.tools).toContain('tsc')
    expect(config.activeCharacterId).toBe('senior-developer')
  })

  it('parses within the full SettingsSchema', () => {
    const settings = SettingsSchema.parse({})
    expect(settings.characters).toBeDefined()
    expect(settings.characters.items[0]?.name).toBe('Senior Developer')
    expect(settings.decisions).toBeDefined()
  })
})

describe('Locked escalation boundaries', () => {
  it('defines the 5 mandatory human-approval categories', () => {
    expect(LOCKED_ESCALATION_LIST).toHaveLength(5)
    const ids = LOCKED_ESCALATION_LIST.map(item => item.id)
    expect(ids).toContain('financial_operations')
    expect(ids).toContain('destructive_operations')
    expect(ids).toContain('secrets_credentials')
    expect(ids).toContain('identity_impersonation')
    expect(ids).toContain('undecided_tradeoffs')
  })

  it('detects locked escalation keywords across sensitive actions', () => {
    expect(isLockedEscalation('Send payment of $500 for API billing')).toBe(true)
    expect(isLockedEscalation('Delete git branch and clear database tables')).toBe(true)
    expect(isLockedEscalation('Export production AWS secret key')).toBe(true)
    expect(isLockedEscalation('Impersonate user and broadcast update')).toBe(true)
    expect(isLockedEscalation('Genuinely undecided between architecture A and B')).toBe(true)
    expect(isLockedEscalation('Run vitest test suite')).toBe(false)
  })
})
