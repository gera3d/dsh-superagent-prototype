// @vitest-environment jsdom
// The completed-job usage summary shown beside an ended Ticket's outcome.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { all, click, mount, text, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'
import type { TicketPageView } from '../src/client/api.ts'

usePanel()
const ended = { at: '2026-09-21T00:00:00Z', by: 'human' as const, reason: 'Human asked to stop', outcome: 'stopped' as const }

/** Open the ended Ticket with the given usage summary and return the rendered text. */
async function open(usage: NonNullable<TicketPageView['usage']>): Promise<string> {
  server.ticketDetails.t0 = { ...server.ticketDetails.t1!, id: 't0', title: '旧工单', ended,
    assignments: [{ id: 'a0', state: 'ended', createdAt: '2026-09-20T00:00:00Z', startedAt: '2026-09-20T00:01:00Z',
      endedAt: '2026-09-20T00:10:00Z' }], usage }
  await mount()
  await click(zh['tab.execution'])
  await click(zh['ticketFilter.ended'])
  await click(all('.dt-open').find(button => button.textContent === '旧工单')!)
  return text()
}

it('shows the finished job’s actual route and token buckets with unavailable cost stated, not zero', async () => {
  const shown = await open({
    sessionId: 'worker-t0',
    routes: [{ provider: 'Particle AI', model: 'deepseek/deepseek-v4.1-flash', attempts: 2, uncachedInputTokens: 1000,
      outputTokens: 500, cacheReadTokens: 200_000, totalTokens: 201_500 }],
    totals: { uncachedInputTokens: 1000, outputTokens: 500, cacheReadTokens: 200_000, totalTokens: 201_500 },
    coverage: { attempts: 2, reported: 2, cacheRead: 'exact', cacheWrite: 'unreported', attribution: 'complete' },
    cost: { kind: 'unavailable', reason: 'noRecordedPrice' },
  })
  expect(shown).toContain(zh.jobUsage)
  expect(shown).toContain('Particle AI · deepseek/deepseek-v4.1-flash')
  expect(shown).toContain(`${zh.jobUsageInput} 1,000`)
  expect(shown).toContain(`${zh.jobUsageOutput} 500`)
  expect(shown).toContain(`${zh.jobUsageCacheRead} 200,000`)
  expect(shown).not.toContain(zh.jobUsageCacheWrite)
  expect(shown).toContain(zh.jobUsageExact.replace('{attempts}', '2'))
  expect(shown).toContain(zh.jobUsageOutside)
  expect(shown).toContain(zh.jobUsageCostUnavailable)
})

it('labels partial coverage and an estimated cost instead of presenting either as exact', async () => {
  const shown = await open({
    sessionId: 'worker-t0',
    routes: [{ provider: 'Particle AI', model: 'deepseek/flash', attempts: 1, uncachedInputTokens: 1000, outputTokens: 500,
      cacheReadTokens: 200_000, totalTokens: 201_500 },
    { provider: 'OpenRouter', model: 'deepseek/pro', attempts: 1, uncachedInputTokens: 20, outputTokens: 10, totalTokens: 30 }],
    totals: { uncachedInputTokens: 1020, outputTokens: 510, cacheReadTokens: 200_000, totalTokens: 201_530 },
    coverage: { attempts: 3, reported: 2, cacheRead: 'partial', cacheWrite: 'unreported', attribution: 'partial' },
    cost: { kind: 'estimated', currency: 'USD', amount: 1.5, note: 'rateTable', partial: true },
  })
  expect(shown).toContain('OpenRouter · deepseek/pro')
  expect(shown).toContain(zh.jobUsagePartial.replace('{reported}', '2').replace('{attempts}', '3'))
  expect(shown).toContain(zh.jobUsageCachePartial)
  expect(shown).toContain(zh.jobUsageUnattributed)
  expect(shown).toContain(zh.jobUsageCostEstimatedPartial.replace('{amount}', '$1.5'))
  expect(shown).not.toContain(zh.jobUsageCostEstimated.replace('{amount}', '$1.5'))
})

it('states an empty or missing worker Session instead of zero usage or cost', async () => {
  const empty = await open({ sessionId: 'worker-t0', routes: [], totals: { uncachedInputTokens: 0, outputTokens: 0,
    totalTokens: 0 }, coverage: { attempts: 0, reported: 0, cacheRead: 'unreported', cacheWrite: 'unreported',
    attribution: 'complete' }, cost: { kind: 'unavailable', reason: 'noRecordedPrice' } })
  expect(empty).toContain(zh.jobUsageNoSamples)
  expect(empty).not.toContain(zh.jobUsageCostUnavailable)
  const missing = await open({ sessionId: 'worker-t0', routes: [], totals: { uncachedInputTokens: 0, outputTokens: 0,
    totalTokens: 0 }, coverage: { attempts: 0, reported: 0, cacheRead: 'unreported', cacheWrite: 'unreported',
    attribution: 'complete' }, cost: { kind: 'unavailable', reason: 'noRecordedPrice' }, problem: 'missing' })
  expect(missing).toContain(zh.jobUsageMissing)
})
