/**
 * Compact native account allowance display for Google and Anthropic subscriptions beside chat.
 * Injects into documented DeepSeek Harness extension slots:
 * - conversation.session.header.actions (compact badge visible beside chat controls)
 * - sidebar.right.pane.tab (expandable detailed panel in the right sidebar beside chat)
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { AccountAllowanceReport, ProviderAllowance } from '../app/account-allowance.ts'
import type { T } from './text.ts'
import { en } from './locales.ts'

export const ALLOWANCE_TAB_KIND = 'allowance'
export const ALLOWANCE_TAB_ID = 'dsh-superagent.account-allowance'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.right.pane.tab': { kind: 'keyed'; scope: 'session'; keyProps: Record<string, object> }
  }
}

export interface AllowanceClientContext extends Context {
  sidebarRight?: {
    openTab: (kind: string, options?: { paneId?: string; replaceTab?: string; preferNewPane?: boolean }) => void
    isExpanded: () => boolean
    toggleExpanded: () => void
  }
}

let sharedReportCache: { report: AccountAllowanceReport; fetchedAt: number } | undefined
let sharedInFlight: Promise<AccountAllowanceReport> | undefined
const listeners = new Set<(report: AccountAllowanceReport) => void>()

function notifyListeners(report: AccountAllowanceReport) {
  sharedReportCache = { report, fetchedAt: Date.now() }
  for (const listener of listeners) {
    try { listener(report) } catch {}
  }
}

export async function fetchAllowanceReport(force = false): Promise<AccountAllowanceReport> {
  const now = Date.now()
  if (!force && sharedReportCache && now - sharedReportCache.fetchedAt < 15_000) {
    return sharedReportCache.report
  }

  if (sharedInFlight) return sharedInFlight

  sharedInFlight = (async () => {
    try {
      const url = force ? '/orchestrator/api/allowance/refresh' : '/orchestrator/api/allowance'
      const method = force ? 'POST' : 'GET'
      const res = await fetch(url, {
        method,
        headers: { 'x-orchestrator-request': '1' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const report: AccountAllowanceReport = force && data.report ? data.report : data
      notifyListeners(report)
      return report
    } catch {
      const fallback: AccountAllowanceReport = {
        accountId: '',
        accountAlias: 'Allowance unavailable',
        isPrimary: false,
        source: 'antigravity',
        sourceLabel: 'Google Antigravity',
        providers: [],
        stale: true,
        problem: 'unreadable',
      }
      return fallback
    } finally {
      sharedInFlight = undefined
    }
  })()

  return sharedInFlight
}

export function useAccountAllowance(initialReport?: AccountAllowanceReport) {
  const [report, setReport] = useState<AccountAllowanceReport | undefined>(
    initialReport ?? sharedReportCache?.report,
  )
  const [loading, setLoading] = useState(!report && !initialReport)
  const isMounted = useRef(true)

  useEffect(() => {
    isMounted.current = true
    const onUpdate = (newReport: AccountAllowanceReport) => {
      if (isMounted.current) setReport(newReport)
    }
    listeners.add(onUpdate)

    if (!initialReport && (!sharedReportCache || Date.now() - sharedReportCache.fetchedAt > 15_000)) {
      setLoading(true)
      fetchAllowanceReport().then(r => {
        if (isMounted.current) {
          setReport(r)
          setLoading(false)
        }
      })
    }

    return () => {
      isMounted.current = false
      listeners.delete(onUpdate)
    }
  }, [initialReport])

  const refresh = useCallback(async () => {
    setLoading(true)
    const updated = await fetchAllowanceReport(true)
    if (isMounted.current) {
      setReport(updated)
      setLoading(false)
    }
  }, [])

  return { report, loading, refresh }
}

function formatRelativeTime(isoString?: string): string {
  if (!isoString) return '--'
  const target = Date.parse(isoString)
  if (Number.isNaN(target)) return '--'
  const diffSec = Math.round((target - Date.now()) / 1000)
  if (diffSec <= 0) return 'now'
  if (diffSec < 60) return `${diffSec}s`
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m`
  const diffHours = Math.floor(diffMin / 60)
  const remMin = diffMin % 60
  if (diffHours < 24) return remMin > 0 ? `${diffHours}h ${remMin}m` : `${diffHours}h`
  const diffDays = Math.floor(diffHours / 24)
  const remHours = diffHours % 24
  return remHours > 0 ? `${diffDays}d ${remHours}h` : `${diffDays}d`
}

function formatPercent(fraction?: number): string {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return '--'
  return `${Math.round(fraction * 100)}%`
}

export function AllowanceIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
      <circle cx="7" cy="15" r="1.5" />
      <path d="M12 15h6" />
    </svg>
  )
}

/** One quota window gauge row: rolling 5-hour or weekly window. */
export function QuotaWindowRow({
  title,
  window,
  t,
}: {
  title: string
  window?: { fraction?: number; resetTime?: string; stale?: boolean }
  t: T
}) {
  const fraction = window?.fraction
  const percentText = formatPercent(fraction)
  const relativeReset = formatRelativeTime(window?.resetTime)
  const pct = fraction !== undefined ? Math.min(100, Math.max(0, fraction * 100)) : 0

  let tone = 'normal'
  if (fraction !== undefined) {
    if (fraction <= 0.1) tone = 'danger'
    else if (fraction <= 0.25) tone = 'warn'
  }

  return (
    <div className="dt-allowance-window" data-tone={tone}>
      <div className="dt-allowance-window-header">
        <span className="dt-allowance-window-title">{title}</span>
        <span className="dt-allowance-window-percent dt-mono">{percentText}</span>
      </div>
      <div
        className="dt-allowance-bar-track"
        role="progressbar"
        aria-valuenow={fraction !== undefined ? Math.round(pct) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${title} remaining`}
      >
        <div
          className="dt-allowance-bar-fill"
          style={{ width: fraction !== undefined ? `${pct}%` : '0%' }}
        />
      </div>
      <div className="dt-allowance-window-footer">
        <span className="dt-row-meta">
          {window?.resetTime ? t('allowanceResetIn', { time: relativeReset }) : '--'}
        </span>
        {window?.stale && <span className="dt-tag" data-tone="warn">{t('allowanceStale')}</span>}
      </div>
    </div>
  )
}

/** Individual provider allowance card (Google or Anthropic). */
export function ProviderAllowanceCard({
  allowance,
  t,
}: {
  allowance: ProviderAllowance
  t: T
}) {
  const isGoogle = allowance.family === 'google'
  const icon = isGoogle ? '✦' : '✽'

  let statusBadge: ReactNode = null
  if (allowance.status === 'cooldown') {
    const rem = allowance.cooldownUntil ? formatRelativeTime(new Date(allowance.cooldownUntil).toISOString()) : 'active'
    statusBadge = <span className="dt-tag" data-tone="warn">{t('allowanceCooldown', { time: rem })}</span>
  } else if (allowance.status === 'auth_required') {
    statusBadge = <span className="dt-tag" data-tone="danger">{t('allowanceAuthRequired')}</span>
  } else if (allowance.status === 'disabled') {
    statusBadge = <span className="dt-tag" data-tone="outline">{t('allowanceDisabled')}</span>
  } else if (allowance.status === 'exhausted') {
    statusBadge = <span className="dt-tag" data-tone="danger">{t('allowanceExhausted')}</span>
  } else if (allowance.status === 'available') {
    statusBadge = <span className="dt-tag" data-tone="success">{t('allowanceAvailable')}</span>
  } else if (allowance.status === 'unavailable') {
    statusBadge = <span className="dt-tag" data-tone="outline">{t('allowanceUnavailable')}</span>
  } else {
    statusBadge = <span className="dt-tag" data-tone="outline">{t('allowanceUnavailable')}</span>
  }

  const sourceBadge = allowance.source === 'antigravity'
    ? <span className="dt-tag dt-allowance-source-tag" data-tone="outline">{t('allowanceAntigravityPoolBadge')}</span>
    : <span className="dt-tag dt-allowance-source-tag" data-tone="outline">{t('allowanceDirectBadge')}</span>

  return (
    <div className="dt-allowance-card" data-provider={allowance.provider}>
      <div className="dt-allowance-card-header">
        <div className="dt-allowance-card-title">
          <span className="dt-allowance-provider-icon" aria-hidden>{icon}</span>
          <span className="dt-allowance-provider-name">{allowance.label}</span>
          {sourceBadge}
        </div>
        {statusBadge}
      </div>

      <div className="dt-allowance-card-provenance dt-row-meta">
        {allowance.accountProvenance}
      </div>

      <div className="dt-allowance-card-body">
        <QuotaWindowRow
          title={t('allowanceRolling')}
          window={allowance.rollingWindow}
          t={t}
        />
        <QuotaWindowRow
          title={t('allowanceWeekly')}
          window={allowance.weeklyWindow}
          t={t}
        />
      </div>

      {allowance.description && (
        <div className="dt-allowance-card-desc dt-row-meta">
          {allowance.description}
        </div>
      )}
    </div>
  )
}

/** Detailed allowance view rendered inside the Right Sidebar tab beside chat. */
export function AllowanceSidebarBody({
  report: initialReport,
  t,
}: {
  report?: AccountAllowanceReport
  t?: T
}) {
  const translate = t ?? (((k: string, p?: Record<string, unknown>) => {
    let s = (en as Record<string, string>)[k] ?? k
    if (p) {
      for (const [pk, pv] of Object.entries(p)) s = s.replace(`{${pk}}`, String(pv))
    }
    return s
  }) as T)

  const { report, loading, refresh } = useAccountAllowance(initialReport)

  if (!report || report.problem === 'account_missing') {
    return (
      <div className="dt-allowance-sidebar-pane">
        <div className="dt-allowance-empty">
          <AllowanceIcon size={24} />
          <p>{translate('allowanceNoAccount')}</p>
        </div>
      </div>
    )
  }

  const updatedTime = report.updatedAt ? new Date(report.updatedAt).toLocaleTimeString() : undefined

  return (
    <div className="dt-allowance-sidebar-pane">
      <div className="dt-allowance-pane-header">
        <div className="dt-allowance-account-info">
          <span className="dt-allowance-pane-title">{translate('allowanceTitle')}</span>
          <div className="dt-allowance-account-badge">
            <span className="dt-mono dt-allowance-email">{report.accountEmail || report.accountAlias}</span>
            {report.isPrimary && <span className="dt-tag" data-tone="outline">{translate('allowancePrimary')}</span>}
            <span className="dt-tag dt-allowance-source-tag" data-tone="outline">{report.sourceLabel}</span>
          </div>
        </div>
        <button
          type="button"
          className="dt-button dt-button-compact"
          onClick={() => { void refresh() }}
          disabled={loading}
          aria-label={translate('allowanceRefresh')}
        >
          {loading ? translate('allowanceRefreshing') : translate('allowanceRefresh')}
        </button>
      </div>

      <div className="dt-allowance-card-list">
        {report.providers.map(p => (
          <ProviderAllowanceCard key={p.provider} allowance={p} t={translate} />
        ))}
      </div>

      <div className="dt-allowance-pane-footer">
        {updatedTime && (
          <span className="dt-row-meta">
            {translate('allowanceUpdated', { time: updatedTime })}
          </span>
        )}
        <span className="dt-allowance-note">
          {translate('allowanceLocalNote')}
        </span>
      </div>
    </div>
  )
}

/**
 * Compact pill badge rendered inside `conversation.session.header.actions` beside chat.
 * Shows high-level Google and Anthropic allowance with quick click-to-expand.
 */
export function AllowanceHeaderBadge({
  ctx,
  report: initialReport,
  t,
}: {
  ctx?: AllowanceClientContext
  report?: AccountAllowanceReport
  t?: T
}) {
  const translate = t ?? (((k: string, p?: Record<string, unknown>) => {
    let s = (en as Record<string, string>)[k] ?? k
    if (p) {
      for (const [pk, pv] of Object.entries(p)) s = s.replace(`{${pk}}`, String(pv))
    }
    return s
  }) as T)

  const { report, loading } = useAccountAllowance(initialReport)
  const [popoverOpen, setPopoverOpen] = useState(false)

  const google = report?.providers.find(p => p.provider === 'google')
  const agyClaude = report?.providers.find(p => p.provider === 'antigravity-claude')
  const directAnthropic = report?.providers.find(p => p.provider === 'anthropic-direct')

  const gPercent = formatPercent(google?.rollingWindow?.fraction)
  const acPercent = formatPercent(agyClaude?.rollingWindow?.fraction)
  const dirPercent = formatPercent(directAnthropic?.rollingWindow?.fraction)

  const handleClick = useCallback(() => {
    if (ctx?.sidebarRight) {
      ctx.sidebarRight.openTab(ALLOWANCE_TAB_KIND)
    } else {
      setPopoverOpen(open => !open)
    }
  }, [ctx])

  const isWarning = (
    google?.status === 'cooldown' || google?.status === 'exhausted' ||
    agyClaude?.status === 'cooldown' || agyClaude?.status === 'exhausted'
  )

  const badgeAria = directAnthropic?.status === 'unavailable'
    ? `${translate('allowanceTitle')}: Google ${gPercent}, Antigravity Claude ${acPercent}, Anthropic (Direct) ${translate('allowanceUnavailable')}`
    : `${translate('allowanceTitle')}: Google ${gPercent}, Antigravity Claude ${acPercent}, Anthropic (Direct) ${dirPercent}`

  return (
    <div className="dt-allowance-badge-container">
      <button
        type="button"
        className="dt-allowance-header-badge"
        onClick={handleClick}
        title={translate('allowanceTitle')}
        aria-label={badgeAria}
        data-warning={isWarning ? 'true' : undefined}
      >
        <span className="dt-allowance-badge-icon" aria-hidden>
          <AllowanceIcon size={14} />
        </span>
        <span className="dt-allowance-badge-item" title="Google (Gemini)">
          <span className="dt-allowance-badge-label">G</span>
          <span className="dt-mono">{loading && !report ? '...' : gPercent}</span>
        </span>
        <span className="dt-allowance-badge-sep" aria-hidden>·</span>
        <span className="dt-allowance-badge-item" title="Antigravity Claude">
          <span className="dt-allowance-badge-label">AC</span>
          <span className="dt-mono">{loading && !report ? '...' : acPercent}</span>
        </span>
        <span className="dt-allowance-badge-sep" aria-hidden>·</span>
        <span className="dt-allowance-badge-item" title="Anthropic (Direct: Unavailable)">
          <span className="dt-allowance-badge-label">A</span>
          <span className="dt-mono">{loading && !report ? '...' : dirPercent}</span>
        </span>
      </button>

      {popoverOpen && !ctx?.sidebarRight && (
        <div className="dt-allowance-inline-popover">
          <div className="dt-allowance-popover-backdrop" onClick={() => setPopoverOpen(false)} />
          <div className="dt-allowance-popover-content">
            <AllowanceSidebarBody report={report} t={translate} />
          </div>
        </div>
      )}
    </div>
  )
}
