import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountAllowanceReader, parseAccountAllowance } from '../src/app/account-allowance.ts'

describe('parseAccountAllowance', () => {
  const sampleLivePool = JSON.stringify({
    version: 1,
    mode: 'sequential',
    defaultCooldownMs: 900000,
    maxCooldownMs: 3600000,
    accounts: [
      {
        id: 'acc_primary',
        alias: 'Primary account (system sign-in)',
        defaultAlias: true,
        dir: '/private/tmp/secret-path',
        systemHome: true,
        enabled: true,
        createdAt: 1793644167360,
        cooldowns: {},
        quotas: {
          google: {
            remainingFraction: 0.6925984621047974,
            resetTime: '2026-11-08T20:25:42Z',
            weeklyFraction: 0.8699324131011963,
            weeklyResetTime: '2026-11-14T22:42:10Z',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            updatedAt: 1794161036386,
          },
          anthropic: {
            remainingFraction: 1,
            resetTime: '2026-11-08T23:03:56Z',
            weeklyFraction: 0.4993376135826111,
            weeklyResetTime: '2026-11-12T16:11:42Z',
            description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
            updatedAt: 1794161036386,
          },
        },
        email: 'operator@example.com',
        lastUsedAt: 1794161573102,
      },
    ],
    primaryAccountId: 'acc_primary',
    activeAccountIds: { google: 'acc_primary' },
  })

  it('correctly parses reported Google and Antigravity Claude allowance windows while preserving provenance', () => {
    const fixedNow = 1794161040000 // Just after updatedAt
    const report = parseAccountAllowance(sampleLivePool, fixedNow)

    expect(report.accountId).toBe('acc_primary')
    expect(report.accountAlias).toBe('Primary account (system sign-in)')
    expect(report.accountEmail).toBe('operator@example.com')
    expect(report.isPrimary).toBe(true)
    expect(report.source).toBe('antigravity')
    expect(report.sourceLabel).toBe('Google Antigravity')
    expect(report.problem).toBeUndefined()
    expect(report.providers).toHaveLength(3)

    // 1. Google (Gemini)
    const google = report.providers.find(p => p.provider === 'google')!
    expect(google).toBeDefined()
    expect(google.family).toBe('google')
    expect(google.source).toBe('antigravity')
    expect(google.label).toBe('Google (Gemini)')
    expect(google.accountProvenance).toContain('Google Antigravity (operator@example.com)')
    expect(google.status).toBe('available')
    expect(google.rollingWindow?.fraction).toBeCloseTo(0.6926, 3)
    expect(google.rollingWindow?.resetTime).toBe('2026-11-08T20:25:42Z')
    expect(google.weeklyWindow?.fraction).toBeCloseTo(0.8699, 3)
    expect(google.weeklyWindow?.resetTime).toBe('2026-11-14T22:42:10Z')

    // 2. Antigravity Claude (distinct model pool allowance under Google account)
    const agyClaude = report.providers.find(p => p.provider === 'antigravity-claude')!
    expect(agyClaude).toBeDefined()
    expect(agyClaude.family).toBe('anthropic')
    expect(agyClaude.source).toBe('antigravity')
    expect(agyClaude.label).toBe('Antigravity Claude')
    expect(agyClaude.accountProvenance).toBe('Google Antigravity model pool (multi-model quota)')
    expect(agyClaude.status).toBe('available')
    expect(agyClaude.rollingWindow?.fraction).toBe(1)
    expect(agyClaude.weeklyWindow?.fraction).toBeCloseTo(0.4993, 3)

    // 3. Direct Anthropic (separate subscription, marked unavailable when no reader exists)
    const directAnthropic = report.providers.find(p => p.provider === 'anthropic-direct')!
    expect(directAnthropic).toBeDefined()
    expect(directAnthropic.family).toBe('anthropic')
    expect(directAnthropic.source).toBe('direct')
    expect(directAnthropic.label).toBe('Anthropic (Direct)')
    expect(directAnthropic.accountProvenance).toBe('Direct Anthropic subscription / API')
    expect(directAnthropic.status).toBe('unavailable')
    expect(directAnthropic.rollingWindow).toBeUndefined()
    expect(directAnthropic.weeklyWindow).toBeUndefined()
  })

  it('regression: never mislabels Antigravity Claude quota as direct Anthropic subscription', () => {
    const report = parseAccountAllowance(sampleLivePool, 1794161040000)

    // Quotas from pool.json must NOT be returned under provider: 'anthropic' without source distinction
    const direct = report.providers.find(p => p.provider === 'anthropic-direct')!
    expect(direct.source).toBe('direct')
    expect(direct.status).toBe('unavailable')
    expect(direct.rollingWindow).toBeUndefined()

    // The Antigravity Claude quota must have source: 'antigravity'
    const agyClaude = report.providers.find(p => p.provider === 'antigravity-claude')!
    expect(agyClaude.source).toBe('antigravity')
    expect(agyClaude.label).toBe('Antigravity Claude')
    expect(agyClaude.accountProvenance).toContain('model pool')
  })

  it('never turns missing fraction or reset time into zero or fake dates', () => {
    const incompletePool = JSON.stringify({
      version: 1,
      accounts: [
        {
          id: 'acc_partial',
          alias: 'Partial Account',
          enabled: true,
          quotas: {
            google: {
              description: 'Gemini without reported fractions',
              updatedAt: 1794161036386,
            },
          },
        },
      ],
      primaryAccountId: 'acc_partial',
    })

    const report = parseAccountAllowance(incompletePool, 1794161037000)
    const google = report.providers.find(p => p.provider === 'google')!
    expect(google.rollingWindow).toBeUndefined()
    expect(google.weeklyWindow).toBeUndefined()
    expect(google.status).toBe('unknown')

    const agyClaude = report.providers.find(p => p.provider === 'antigravity-claude')!
    expect(agyClaude.rollingWindow).toBeUndefined()
    expect(agyClaude.status).toBe('unknown')

    const directAnthropic = report.providers.find(p => p.provider === 'anthropic-direct')!
    expect(directAnthropic.status).toBe('unavailable')
  })

  it('detects rate limits and cooldowns without reporting them as general availability', () => {
    const cooldownTime = Date.now() + 600_000 // 10 minutes in the future
    const cooldownPool = JSON.stringify({
      accounts: [
        {
          id: 'acc_1',
          enabled: true,
          cooldowns: {
            anthropic: { cooldownUntil: cooldownTime, reason: '429 Rate Limit Exceeded' },
          },
          quotas: {
            anthropic: { remainingFraction: 0, resetTime: '2026-11-08T23:00:00Z', updatedAt: Date.now() },
            google: { remainingFraction: 0.8, resetTime: '2026-11-08T23:00:00Z', updatedAt: Date.now() },
          },
        },
      ],
      primaryAccountId: 'acc_1',
    })

    const report = parseAccountAllowance(cooldownPool, Date.now())
    const agyClaude = report.providers.find(p => p.provider === 'antigravity-claude')!
    expect(agyClaude.status).toBe('cooldown')
    expect(agyClaude.cooldownUntil).toBe(cooldownTime)
    expect(agyClaude.cooldownReason).toBe('429 Rate Limit Exceeded')

    const google = report.providers.find(p => p.provider === 'google')!
    expect(google.status).toBe('available')
  })

  it('handles auth_required, disabled, and exhausted statuses', () => {
    const authReqPool = JSON.stringify({
      accounts: [{ id: 'acc_auth', enabled: true, authRequired: true, authError: 'Session expired' }],
      primaryAccountId: 'acc_auth',
    })
    const report1 = parseAccountAllowance(authReqPool, Date.now())
    expect(report1.providers[0]?.status).toBe('auth_required')

    const disabledPool = JSON.stringify({
      accounts: [{ id: 'acc_off', enabled: false }],
      primaryAccountId: 'acc_off',
    })
    const report2 = parseAccountAllowance(disabledPool, Date.now())
    expect(report2.providers[0]?.status).toBe('disabled')

    const exhaustedPool = JSON.stringify({
      accounts: [
        {
          id: 'acc_zero',
          enabled: true,
          quotas: { google: { remainingFraction: 0, updatedAt: Date.now() } },
        },
      ],
      primaryAccountId: 'acc_zero',
    })
    const report3 = parseAccountAllowance(exhaustedPool, Date.now())
    expect(report3.providers.find(p => p.provider === 'google')?.status).toBe('exhausted')
  })

  it('handles corrupted JSON or missing accounts gracefully', () => {
    const broken = parseAccountAllowance('invalid json!!', Date.now())
    expect(broken.problem).toBe('unreadable')
    expect(broken.providers).toEqual([])

    const empty = parseAccountAllowance(JSON.stringify({ accounts: [] }), Date.now())
    expect(empty.problem).toBe('account_missing')
    expect(empty.providers).toEqual([])
  })

  it('guarantees zero tokens, credentials, or internal directories are exposed', () => {
    const report = parseAccountAllowance(sampleLivePool, 1794161040000)
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('/private/tmp')
    expect(serialized).not.toContain('secret-path')
    expect(serialized).not.toContain('token')
  })
})

describe('AccountAllowanceReader', () => {
  it('reads pool file and caches report across successive queries', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'allowance-test-'))
    try {
      const poolFile = join(tmp, 'pool.json')
      writeFileSync(poolFile, JSON.stringify({
        accounts: [{
          id: 'acc_test',
          enabled: true,
          quotas: {
            google: { remainingFraction: 0.75, resetTime: '2026-11-08T22:00:00Z', updatedAt: Date.now() },
          },
        }],
        primaryAccountId: 'acc_test',
      }))

      const reader = new AccountAllowanceReader({ poolDir: tmp, ttlMs: 10_000 })
      const first = await reader.report()
      expect(first.accountId).toBe('acc_test')
      expect(first.providers.find(p => p.provider === 'google')?.rollingWindow?.fraction).toBe(0.75)

      // Modify file on disk; cached report should still return 0.75
      writeFileSync(poolFile, JSON.stringify({
        accounts: [{
          id: 'acc_test',
          enabled: true,
          quotas: {
            google: { remainingFraction: 0.10, resetTime: '2026-11-08T22:00:00Z', updatedAt: Date.now() },
          },
        }],
        primaryAccountId: 'acc_test',
      }))

      const cached = await reader.report()
      expect(cached.providers.find(p => p.provider === 'google')?.rollingWindow?.fraction).toBe(0.75)

      // Force refresh picks up the new value
      const refreshed = await reader.refresh()
      expect(refreshed.providers.find(p => p.provider === 'google')?.rollingWindow?.fraction).toBe(0.10)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('reports pool_missing when the pool file does not exist', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'allowance-missing-'))
    try {
      const reader = new AccountAllowanceReader({ poolDir: tmp })
      const res = await reader.report()
      expect(res.problem).toBe('pool_missing')
      expect(res.stale).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('shares in-flight promise during concurrent requests', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'allowance-concurrent-'))
    try {
      const poolFile = join(tmp, 'pool.json')
      writeFileSync(poolFile, JSON.stringify({
        accounts: [{ id: 'acc_c', enabled: true }],
        primaryAccountId: 'acc_c',
      }))

      const reader = new AccountAllowanceReader({ poolDir: tmp, ttlMs: 0 })
      const [r1, r2] = await Promise.all([reader.report(), reader.report()])
      expect(r1).toBe(r2) // Identical object reference from shared promise
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
