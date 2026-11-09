/** Compact recorded usage of a completed job's worker Session: actual routes, token buckets, coverage and honest cost. */
import type { JobUsage } from '../app/job-usage.ts'
import type { TicketPageView } from './api.ts'
import { Hint } from './widgets.tsx'
import { usePanel } from './provider.tsx'

type Usage = NonNullable<TicketPageView['usage']>

/** One route row: its actual provider/model and the token buckets it billed. */
function RouteLine({ route, t }: { route: Usage['routes'][number]; t: ReturnType<typeof usePanel>['t'] }) {
  const count = (value: number) => value.toLocaleString(t('lang'))
  const buckets = [`${t('jobUsageInput')} ${count(route.uncachedInputTokens)}`,
    `${t('jobUsageOutput')} ${count(route.outputTokens)}`]
  if (route.cacheReadTokens !== undefined) buckets.push(`${t('jobUsageCacheRead')} ${count(route.cacheReadTokens)}`)
  if (route.cacheWriteTokens !== undefined) buckets.push(`${t('jobUsageCacheWrite')} ${count(route.cacheWriteTokens)}`)
  return <li className="dt-job-usage-route">
    <span className="dt-mono dt-job-usage-model">{route.provider} · {route.model}</span>
    <span className="dt-row-meta">{buckets.join(' · ')}</span>
  </li>
}
/**
 * The completed job's recorded usage, shown beside its ended status: the actual recorded route rather than the current
 * settings, disjoint uncached/cache buckets, an explicit coverage sentence (helper, ranker and other Sessions stay outside),
 * and an unavailable cost unless a rate table priced every route. A missing or unreadable log is stated, not zeroed.
 */
export function JobUsageSummary({ usage }: { usage: JobUsage }) {
  const { t } = usePanel()
  if (usage.problem) return <div className="dt-job-usage"><Hint>{t(usage.problem === 'missing' ? 'jobUsageMissing'
    : 'jobUsageUnreadable')}</Hint></div>
  const numbers = usage.routes.filter(route => route.totalTokens > 0)
  if (!numbers.length && usage.coverage.reported === 0) return <div className="dt-job-usage"><Hint>{t('jobUsageNoSamples')}</Hint></div>
  const partial = usage.coverage.reported < usage.coverage.attempts
  const coverage = partial
    ? t('jobUsagePartial', { reported: usage.coverage.reported, attempts: usage.coverage.attempts })
    : t('jobUsageExact', { attempts: usage.coverage.attempts })
  const cachePartial = usage.coverage.cacheRead === 'partial' || usage.coverage.cacheWrite === 'partial'
  const amount = usage.cost.kind === 'estimated'
    ? `$${usage.cost.amount.toLocaleString(t('lang'), { maximumFractionDigits: 6 })}` : undefined
  return <div className="dt-job-usage">
    <div className="dt-job-usage-title">
      <span className="dt-lv-label">{t('jobUsage')}</span>
      <span className="dt-row-meta">{t('jobUsageSession')}</span>
    </div>
    <ul className="dt-plain-list">{numbers.map(route => <RouteLine key={`${route.provider}/${route.model}`} route={route} t={t} />)}</ul>
    <div className="dt-row-meta">
      <span>{coverage}</span>
      <span>{t('jobUsageOutside')}</span>
      {cachePartial && <span>{t('jobUsageCachePartial')}</span>}
      {usage.coverage.attribution === 'partial' && <span>{t('jobUsageUnattributed')}</span>}
      <span className="dt-tag" data-tone="outline">{usage.cost.kind === 'estimated'
        ? t(usage.cost.partial ? 'jobUsageCostEstimatedPartial' : 'jobUsageCostEstimated', { amount: amount! })
        : t('jobUsageCostUnavailable')}</span>
    </div>
  </div>
}
