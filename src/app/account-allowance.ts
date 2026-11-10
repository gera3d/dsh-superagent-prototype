/**
 * Account allowance reader for Google and Anthropic subscriptions managed by installed dsh-agy-link
 * and DeepSeek Harness integrations.
 * Reads existing authenticated quota snapshots from the local Antigravity account pool without
 * making external paid calls, warming up models, or transmitting credentials.
 * Explicitly preserves account and source provenance:
 * - Google (Gemini): Antigravity account pool
 * - Antigravity Claude: Antigravity multi-model quota pool (Google account subscription)
 * - Anthropic (Direct): Direct Anthropic subscription (marked unavailable unless supported existing authenticated reader is present)
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type AllowanceSource = 'antigravity' | 'direct'

export interface AllowanceWindow {
  /** Remaining fraction between 0.0 and 1.0. Undefined if unreported; never fabricated or zeroed. */
  fraction?: number
  /** ISO timestamp string of window reset, if reported. */
  resetTime?: string
  /** Whether the window has expired or is older than the refresh threshold. */
  stale?: boolean
}

export type AllowanceStatus = 'available' | 'cooldown' | 'exhausted' | 'auth_required' | 'disabled' | 'unavailable' | 'unknown'

export interface ProviderAllowance {
  /** Unique provider key for display and identification */
  provider: 'google' | 'antigravity-claude' | 'anthropic-direct'
  /** Provider family */
  family: 'google' | 'anthropic'
  /** Authenticated upstream source identity */
  source: AllowanceSource
  /** Display label preserving source and family distinction */
  label: string
  /** Account provenance note */
  accountProvenance: string
  /** Rolling window (5-hour) reported by quota service. */
  rollingWindow?: AllowanceWindow
  /** Weekly allowance window reported by quota service. */
  weeklyWindow?: AllowanceWindow
  status: AllowanceStatus
  cooldownUntil?: number
  cooldownReason?: string
  description?: string
  stale: boolean
}

export interface AccountAllowanceReport {
  accountId: string
  accountAlias: string
  accountEmail?: string
  isPrimary: boolean
  source: AllowanceSource
  sourceLabel: string
  updatedAt?: number
  providers: ProviderAllowance[]
  stale: boolean
  problem?: 'pool_missing' | 'account_missing' | 'unreadable'
}

/** Raw pool.json shape as persisted by dsh-agy-link. */
interface RawPoolAccount {
  id: string
  alias?: string
  email?: string
  enabled?: boolean
  authRequired?: boolean
  authError?: string
  cooldowns?: Record<string, { cooldownUntil: number; reason?: string } | undefined>
  quotas?: Record<string, {
    remainingFraction?: number
    resetTime?: string
    weeklyFraction?: number
    weeklyResetTime?: string
    description?: string
    updatedAt?: number
  } | undefined>
}

interface RawPoolData {
  version?: number
  mode?: string
  accounts?: RawPoolAccount[]
  primaryAccountId?: string
  activeAccountIds?: Record<string, string>
  lastActiveAccountId?: string
}

function resolvePoolFilePath(overrideDir?: string): string {
  if (overrideDir) return join(overrideDir, 'pool.json')
  const dshState = process.env.DSH_STATE_DIR || join(homedir(), '.dsh')
  return join(dshState, 'agy-accounts', 'pool.json')
}

function sanitizeFraction(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
    return value
  }
  return undefined
}

function sanitizeIsoTime(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return value
  }
  return undefined
}

export function parseAccountAllowance(rawJson: string, now: number = Date.now()): AccountAllowanceReport {
  let pool: RawPoolData
  try {
    pool = JSON.parse(rawJson) as RawPoolData
  } catch {
    return {
      accountId: '',
      accountAlias: 'Unknown',
      isPrimary: false,
      source: 'antigravity',
      sourceLabel: 'Google Antigravity',
      providers: [],
      stale: true,
      problem: 'unreadable',
    }
  }

  const accounts = Array.isArray(pool.accounts) ? pool.accounts : []
  if (accounts.length === 0) {
    return {
      accountId: '',
      accountAlias: 'No accounts configured',
      isPrimary: false,
      source: 'antigravity',
      sourceLabel: 'Google Antigravity',
      providers: [],
      stale: true,
      problem: 'account_missing',
    }
  }

  const activeId = pool.activeAccountIds?.google ?? pool.lastActiveAccountId ?? pool.primaryAccountId
  const account = accounts.find(a => a.id === activeId) ?? accounts.find(a => a.id === pool.primaryAccountId) ?? accounts[0]!

  const isPrimary = account.id === pool.primaryAccountId
  const quotas = account.quotas ?? {}
  const cooldowns = account.cooldowns ?? {}

  let overallStale = false
  const STALE_THRESHOLD_MS = 15 * 60 * 1000 // 15 minutes without an update

  // 1. Google (Gemini) from Antigravity pool
  const rawGoogleQuota = quotas.google
  const rawGoogleCooldown = cooldowns.google

  const googleRollingFrac = sanitizeFraction(rawGoogleQuota?.remainingFraction)
  const googleRollingReset = sanitizeIsoTime(rawGoogleQuota?.resetTime)
  const googleWeeklyFrac = sanitizeFraction(rawGoogleQuota?.weeklyFraction)
  const googleWeeklyReset = sanitizeIsoTime(rawGoogleQuota?.weeklyResetTime)

  const googleRollingPassed = googleRollingReset ? Date.parse(googleRollingReset) < now : false
  const googleWeeklyPassed = googleWeeklyReset ? Date.parse(googleWeeklyReset) < now : false

  const googleUpdatedAt = rawGoogleQuota?.updatedAt
  const googleIsStale = !googleUpdatedAt || (now - googleUpdatedAt > STALE_THRESHOLD_MS) || googleRollingPassed
  if (googleIsStale) overallStale = true

  let googleStatus: AllowanceStatus = 'unknown'
  let googleCooldownUntil: number | undefined
  let googleCooldownReason: string | undefined

  if (!account.enabled) {
    googleStatus = 'disabled'
  } else if (account.authRequired) {
    googleStatus = 'auth_required'
  } else if (rawGoogleCooldown && typeof rawGoogleCooldown.cooldownUntil === 'number' && rawGoogleCooldown.cooldownUntil > now) {
    googleStatus = 'cooldown'
    googleCooldownUntil = rawGoogleCooldown.cooldownUntil
    googleCooldownReason = rawGoogleCooldown.reason || 'Cooldown active'
  } else if (googleRollingFrac === 0 || googleWeeklyFrac === 0) {
    googleStatus = 'exhausted'
  } else if (googleRollingFrac !== undefined || googleWeeklyFrac !== undefined) {
    googleStatus = 'available'
  }

  const googleRollingWindow: AllowanceWindow | undefined = (googleRollingFrac !== undefined || googleRollingReset !== undefined)
    ? { fraction: googleRollingFrac, resetTime: googleRollingReset, stale: googleRollingPassed }
    : undefined

  const googleWeeklyWindow: AllowanceWindow | undefined = (googleWeeklyFrac !== undefined || googleWeeklyReset !== undefined)
    ? { fraction: googleWeeklyFrac, resetTime: googleWeeklyReset, stale: googleWeeklyPassed }
    : undefined

  const googleProvider: ProviderAllowance = {
    provider: 'google',
    family: 'google',
    source: 'antigravity',
    label: 'Google (Gemini)',
    accountProvenance: `Google Antigravity (${account.email || account.alias || account.id})`,
    rollingWindow: googleRollingWindow,
    weeklyWindow: googleWeeklyWindow,
    status: googleStatus,
    cooldownUntil: googleCooldownUntil,
    cooldownReason: googleCooldownReason,
    description: rawGoogleQuota?.description,
    stale: googleIsStale,
  }

  // 2. Antigravity Claude: multi-model quota pool provided via the Google Antigravity account
  const rawAgyClaudeQuota = quotas.anthropic
  const rawAgyClaudeCooldown = cooldowns.anthropic

  const agyClaudeRollingFrac = sanitizeFraction(rawAgyClaudeQuota?.remainingFraction)
  const agyClaudeRollingReset = sanitizeIsoTime(rawAgyClaudeQuota?.resetTime)
  const agyClaudeWeeklyFrac = sanitizeFraction(rawAgyClaudeQuota?.weeklyFraction)
  const agyClaudeWeeklyReset = sanitizeIsoTime(rawAgyClaudeQuota?.weeklyResetTime)

  const agyClaudeRollingPassed = agyClaudeRollingReset ? Date.parse(agyClaudeRollingReset) < now : false
  const agyClaudeWeeklyPassed = agyClaudeWeeklyReset ? Date.parse(agyClaudeWeeklyReset) < now : false

  const agyClaudeUpdatedAt = rawAgyClaudeQuota?.updatedAt
  const agyClaudeIsStale = !agyClaudeUpdatedAt || (now - agyClaudeUpdatedAt > STALE_THRESHOLD_MS) || agyClaudeRollingPassed
  if (agyClaudeIsStale) overallStale = true

  let agyClaudeStatus: AllowanceStatus = 'unknown'
  let agyClaudeCooldownUntil: number | undefined
  let agyClaudeCooldownReason: string | undefined

  if (!account.enabled) {
    agyClaudeStatus = 'disabled'
  } else if (account.authRequired) {
    agyClaudeStatus = 'auth_required'
  } else if (rawAgyClaudeCooldown && typeof rawAgyClaudeCooldown.cooldownUntil === 'number' && rawAgyClaudeCooldown.cooldownUntil > now) {
    agyClaudeStatus = 'cooldown'
    agyClaudeCooldownUntil = rawAgyClaudeCooldown.cooldownUntil
    agyClaudeCooldownReason = rawAgyClaudeCooldown.reason || 'Cooldown active'
  } else if (agyClaudeRollingFrac === 0 || agyClaudeWeeklyFrac === 0) {
    agyClaudeStatus = 'exhausted'
  } else if (agyClaudeRollingFrac !== undefined || agyClaudeWeeklyFrac !== undefined) {
    agyClaudeStatus = 'available'
  }

  const agyClaudeRollingWindow: AllowanceWindow | undefined = (agyClaudeRollingFrac !== undefined || agyClaudeRollingReset !== undefined)
    ? { fraction: agyClaudeRollingFrac, resetTime: agyClaudeRollingReset, stale: agyClaudeRollingPassed }
    : undefined

  const agyClaudeWeeklyWindow: AllowanceWindow | undefined = (agyClaudeWeeklyFrac !== undefined || agyClaudeWeeklyReset !== undefined)
    ? { fraction: agyClaudeWeeklyFrac, resetTime: agyClaudeWeeklyReset, stale: agyClaudeWeeklyPassed }
    : undefined

  const agyClaudeProvider: ProviderAllowance = {
    provider: 'antigravity-claude',
    family: 'anthropic',
    source: 'antigravity',
    label: 'Antigravity Claude',
    accountProvenance: 'Google Antigravity model pool (multi-model quota)',
    rollingWindow: agyClaudeRollingWindow,
    weeklyWindow: agyClaudeWeeklyWindow,
    status: agyClaudeStatus,
    cooldownUntil: agyClaudeCooldownUntil,
    cooldownReason: agyClaudeCooldownReason,
    description: rawAgyClaudeQuota?.description,
    stale: agyClaudeIsStale,
  }

  // 3. Direct Anthropic: separate authenticated subscription/account (no local reader currently configured)
  const directAnthropicProvider: ProviderAllowance = {
    provider: 'anthropic-direct',
    family: 'anthropic',
    source: 'direct',
    label: 'Anthropic (Direct)',
    accountProvenance: 'Direct Anthropic subscription / API',
    status: 'unavailable',
    description: 'No local authenticated quota reader configured for direct Anthropic subscription',
    stale: false,
  }

  const providers: ProviderAllowance[] = [googleProvider, agyClaudeProvider, directAnthropicProvider]

  const latestUpdatedAt = Math.max(
    googleUpdatedAt ?? 0,
    agyClaudeUpdatedAt ?? 0,
    0,
  )

  return {
    accountId: account.id,
    accountAlias: account.alias || account.id,
    accountEmail: account.email,
    isPrimary,
    source: 'antigravity',
    sourceLabel: 'Google Antigravity',
    updatedAt: latestUpdatedAt > 0 ? latestUpdatedAt : undefined,
    providers,
    stale: overallStale || (googleIsStale && agyClaudeIsStale),
  }
}

/** Reads the current subscription allowance of an account through the configured provider adapters. */
export class AccountAllowanceReader {
  private cache: { report: AccountAllowanceReport; cachedAt: number } | undefined
  private inFlight: Promise<AccountAllowanceReport> | undefined
  private readonly ttlMs: number
  private readonly poolDir?: string

  constructor(options: { ttlMs?: number; poolDir?: string } = {}) {
    this.ttlMs = options.ttlMs ?? 15_000 // 15 seconds cache
    this.poolDir = options.poolDir
  }

  async report(force: boolean = false): Promise<AccountAllowanceReport> {
    const now = Date.now()
    if (!force && this.cache && now - this.cache.cachedAt < this.ttlMs) {
      return this.cache.report
    }

    if (this.inFlight) return this.inFlight

    this.inFlight = this.readInternal(now)
      .finally(() => { this.inFlight = undefined })

    const result = await this.inFlight
    this.cache = { report: result, cachedAt: now }
    return result
  }

  async refresh(): Promise<AccountAllowanceReport> {
    return this.report(true)
  }

  private async readInternal(now: number): Promise<AccountAllowanceReport> {
    const filePath = resolvePoolFilePath(this.poolDir)
    if (!existsSync(filePath)) {
      return {
        accountId: '',
        accountAlias: 'No accounts configured',
        isPrimary: false,
        source: 'antigravity',
        sourceLabel: 'Google Antigravity',
        providers: [],
        stale: true,
        problem: 'pool_missing',
      }
    }

    try {
      const content = readFileSync(filePath, 'utf8')
      return parseAccountAllowance(content, now)
    } catch {
      return {
        accountId: '',
        accountAlias: 'Unknown',
        isPrimary: false,
        source: 'antigravity',
        sourceLabel: 'Google Antigravity',
        providers: [],
        stale: true,
        problem: 'unreadable',
      }
    }
  }
}
