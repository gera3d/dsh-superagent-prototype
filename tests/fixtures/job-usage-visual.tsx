/** Isolated component fixture for the completed-job usage evidence, matching the repository's visual-evidence fixture convention. Never loaded by the real application. */
import { createRoot } from 'react-dom/client'
import { en } from '../../src/client/locales.ts'
import { PanelProvider } from '../../src/client/provider.tsx'
import { JobUsageSummary } from '../../src/client/job-usage.tsx'
import type { T } from '../../src/client/text.ts'

const translator = (dictionary: Record<string, string>): T => ((key: string, params?: Record<string, unknown>) => {
  const template = dictionary[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}) as T
const usage = {
  sessionId: 'worker-cost-summary',
  routes: [
    { provider: 'Particle AI', model: 'deepseek/deepseek-v4.1-flash', attempts: 12, uncachedInputTokens: 324_254,
      outputTokens: 120_790, cacheReadTokens: 78_306_688, totalTokens: 78_751_732 },
    { provider: 'OpenRouter', model: 'deepseek/deepseek-v4.1-pro', attempts: 3, uncachedInputTokens: 41_882, outputTokens: 9_115,
      totalTokens: 50_997 },
  ],
  totals: { uncachedInputTokens: 366_136, outputTokens: 129_905, cacheReadTokens: 78_306_688, totalTokens: 78_802_729 },
  coverage: { attempts: 18, reported: 15, cacheRead: 'partial' as const, cacheWrite: 'unreported' as const, attribution: 'complete' as const },
  cost: { kind: 'unavailable' as const, reason: 'noRecordedPrice' as const },
}
const mode = (globalThis as any).__fixtureMode ?? 'after'
const page = <div className="dt-page"><div className="dt-column">
  <header style={{ border: '1px solid #8b949e', padding: 12, color: '#d29922' }}>
    <strong>ISOLATED ACTUAL COMPONENT FIXTURE · {mode.toUpperCase()}</strong>
    <p>Not the user's application. The completed-Ticket area of the base revision, then the same area with the new summary.</p>
  </header>
  <div className="dt-page-head"><h2 className="dt-page-title">Show a trustworthy cost summary for completed jobs</h2></div>
  <div className="dt-row-meta dt-status-line"><span className="dt-lv"><span className="dt-lv-label">Status</span> <span
    className="dt-lv-value">Finished</span></span><span className="dt-lv"><span className="dt-lv-label">Updated</span> <span
    className="dt-lv-value">Nov 6, 2026, 20:10</span></span></div>
  <p className="dt-hint">Nov 6, 2026, 20:10 Pull request merged: #191</p>
  {mode === 'after' && <JobUsageSummary usage={usage} />}
</div></div>
createRoot(document.getElementById('root')!).render(<PanelProvider t={translator(en)}>{page}</PanelProvider>)
