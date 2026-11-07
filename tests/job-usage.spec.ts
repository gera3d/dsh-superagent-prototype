/** The completed-job usage projection: replay deduplication, native replacement/retry semantics, route attribution, coverage and cost. */
import { expect, it } from 'vitest'
import { JobUsageFold, JobUsageReader, estimateCost } from '../src/app/job-usage.ts'

let seq = 0
const event = (type: string, data: unknown) => ({ seq: seq++, type, data })
/** Reset the sequence so one test's persisted log reads as one contiguous Session. */
const reset = () => { seq = 0 }
const header = (provider: string, model: string) => event('request/header', { header: { config: { provider, model } } })
const route = (provider: string, model: string) => event('request/context', { provider, model })
const message = (turn: number, step: number, usage?: Record<string, number>, stream?: unknown[]) =>
  event('assistant/message', { turn, step, message: {}, stream: stream ?? [], ...usage ? { usage } : {} })
const retry = (turn: number, step: number) => event('llm/retry-started', { turn, step })
const fold = (events: ReturnType<typeof event>[]) => { const value = new JobUsageFold(); value.observe(events); return value }
const routeOf = (value: ReturnType<typeof fold>, model: string) => value.summary('worker-t').routes.find(item => item.model === model)

it('deduplicates replayed sequence numbers and repeated same-step settlements', () => {
  reset()
  const first = message(0, 0, { inputTokens: 10, outputTokens: 5 })
  const duplicate = { ...first }
  const sameStep = message(0, 0, { inputTokens: 10, outputTokens: 5 })
  const value = fold([header('Particle AI', 'deepseek/flash'), first, duplicate, sameStep])
  const summary = value.summary('worker-t')
  expect(summary.coverage).toMatchObject({ attempts: 1, reported: 1 })
  expect(summary.totals).toMatchObject({ uncachedInputTokens: 10, outputTokens: 5, totalTokens: 15 })
  expect(summary.routes).toEqual([{ provider: 'Particle AI', model: 'deepseek/flash', attempts: 1, uncachedInputTokens: 10,
    outputTokens: 5, totalTokens: 15 }])
})

it('replaces one step’s earlier sample and counts a retried attempt again after llm/retry-started', () => {
  reset()
  const value = fold([header('Particle AI', 'deepseek/flash'), message(0, 0, { inputTokens: 10, outputTokens: 5 }),
    message(0, 0, { inputTokens: 12, outputTokens: 6 }), retry(0, 1), message(0, 1, { inputTokens: 20, outputTokens: 7 })])
  const summary = value.summary('worker-t')
  expect(summary.coverage).toMatchObject({ attempts: 2, reported: 2 })
  expect(summary.totals).toMatchObject({ uncachedInputTokens: 32, outputTokens: 13, totalTokens: 45 })
})

it('keeps uncached, cached-read and cached-write counts disjoint and reports where cache coverage stops', () => {
  reset()
  const exact = fold([header('Particle AI', 'deepseek/flash'),
    message(0, 0, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 })])
  expect(exact.summary('worker-t').totals).toMatchObject({ uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 100,
    cacheWriteTokens: 20, totalTokens: 135 })
  expect(exact.summary('worker-t').coverage).toMatchObject({ cacheRead: 'exact', cacheWrite: 'exact' })
  reset()
  const partial = fold([header('Particle AI', 'deepseek/flash'),
    message(0, 0, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 }), message(0, 1, { inputTokens: 3, outputTokens: 1 })])
  const summary = partial.summary('worker-t')
  expect(summary.totals).toMatchObject({ uncachedInputTokens: 13, outputTokens: 6, cacheReadTokens: 100, totalTokens: 119 })
  expect(summary.totals.cacheWriteTokens).toBeUndefined()
  expect(summary.coverage).toMatchObject({ cacheRead: 'partial', cacheWrite: 'unreported' })
  reset()
  const none = fold([header('Particle AI', 'deepseek/flash'), message(0, 0, { inputTokens: 4, outputTokens: 2 })])
  expect(none.summary('worker-t').coverage).toMatchObject({ cacheRead: 'unreported', cacheWrite: 'unreported' })
  expect(none.summary('worker-t').totals.cacheReadTokens).toBeUndefined()
})

it('attributes each attempt to the actual persisted route and keeps mixed-model jobs apart', () => {
  reset()
  const summary = fold([header('Particle AI', 'deepseek/flash'), message(0, 0, { inputTokens: 10, outputTokens: 5 }),
    route('OpenRouter', 'deepseek/pro'), message(0, 1, { inputTokens: 7, outputTokens: 3 }),
    route('Particle AI', 'deepseek/flash'), message(0, 2, { inputTokens: 1, outputTokens: 1 })]).summary('worker-t')
  expect(summary.routes).toEqual([
    { provider: 'Particle AI', model: 'deepseek/flash', attempts: 2, uncachedInputTokens: 11, outputTokens: 6, totalTokens: 17 },
    { provider: 'OpenRouter', model: 'deepseek/pro', attempts: 1, uncachedInputTokens: 7, outputTokens: 3, totalTokens: 10 },
  ])
  expect(summary.coverage.attribution).toBe('complete')
})

it('marks unattributed attempts and attempts without a usage sample instead of inventing either', () => {
  reset()
  const summary = fold([message(0, 0, { inputTokens: 9, outputTokens: 4 }), message(0, 1)]).summary('worker-t')
  expect(summary.routes).toEqual([])
  expect(summary.coverage).toMatchObject({ attempts: 2, reported: 1, attribution: 'partial' })
  expect(summary.totals).toMatchObject({ uncachedInputTokens: 9, outputTokens: 4, totalTokens: 13 })
})

it('reports unknown cost as unavailable and prices only from a rate table that covers every route', () => {
  reset()
  const summary = fold([header('Particle AI', 'deepseek/flash'),
    message(0, 0, { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 250_000 })]).summary('worker-t')
  expect(summary.cost).toEqual({ kind: 'unavailable', reason: 'noRecordedPrice' })
  expect(estimateCost(summary.routes, { 'Particle AI/deepseek/flash': { input: 1, output: 2, cacheRead: 0.5 } }))
    .toEqual({ kind: 'estimated', currency: 'USD', amount: 2.125, note: 'rateTable' })
  expect(estimateCost(summary.routes, { 'Other/provider': { input: 1, output: 1 } }))
    .toEqual({ kind: 'unavailable', reason: 'noRecordedPrice' })
  expect(estimateCost([], { 'Particle AI/deepseek/flash': { input: 1, output: 1 } }))
    .toEqual({ kind: 'unavailable', reason: 'noRecordedPrice' })
  reset()
  const mixed = fold([message(0, 0, { inputTokens: 9, outputTokens: 4 }), route('Particle AI', 'deepseek/flash'),
    message(0, 1, { inputTokens: 1_000_000, outputTokens: 500_000 })]).summary('worker-t',
    { 'Particle AI/deepseek/flash': { input: 1, output: 2 } })
  expect(mixed.cost).toEqual({ kind: 'estimated', currency: 'USD', amount: 2, note: 'rateTable', partial: true })
  expect(estimateCost(summary.routes, { 'Particle AI/deepseek/flash': { input: 1, output: 2 } }, true))
    .toMatchObject({ kind: 'estimated', partial: true })
})

it('reports an empty completed job as no recorded samples, not a zero cost', () => {
  expect(new JobUsageFold().summary('worker-t')).toMatchObject({ routes: [], cost: { kind: 'unavailable' },
    coverage: { attempts: 0, reported: 0, cacheRead: 'unreported', cacheWrite: 'unreported', attribution: 'complete' } })
})

/** A minimal persistence stand-in: one read handle over a mutable event log. */
function persistence(events: ReturnType<typeof event>[], options: { stat?: boolean; fail?: boolean } = {}) {
  const reads: number[] = [], flushes: number[] = []
  return {
    reads,
    flushes,
    service: {
      async flush() { flushes.push(events.length) },
      async stat() {
        return options.stat === false ? undefined : { eventCount: events.length, revision: `rev-${events.length}` }
      },
      async open() {
        if (options.fail) throw new Error('unreadable')
        return {
          async read(offset: number, length: number) {
            reads.push(offset)
            return { events: events.slice(offset, offset + length), eventState: 'detached' as const }
          },
          async [Symbol.asyncDispose]() {},
        }
      },
    },
  }
}

it('reads the durable worker Session log once and only new events on later polls', async () => {
  reset()
  const events = [header('Particle AI', 'deepseek/flash'), message(0, 0, { inputTokens: 10, outputTokens: 5 })]
  const fake = persistence(events)
  const reader = new JobUsageReader({ sessionPersistence: fake.service } as never)
  const first = await reader.of('worker-t')
  expect(first?.totals).toMatchObject({ uncachedInputTokens: 10, outputTokens: 5 })
  expect(fake.reads).toEqual([0, 2])
  events.push(route('OpenRouter', 'deepseek/pro'), message(0, 1, { inputTokens: 3, outputTokens: 2 }))
  const second = await reader.of('worker-t')
  expect(second!.totals).toMatchObject({ uncachedInputTokens: 13, outputTokens: 7 })
  expect(second!.routes).toHaveLength(2)
  expect(fake.reads).toEqual([0, 2, 2, 4])
  const flushes = fake.flushes.length
  await reader.of('worker-t')
  expect(fake.reads).toEqual([0, 2, 2, 4])
  expect(fake.flushes).toHaveLength(flushes)
})

it('reads an empty worker Session as recorded no samples instead of a priced zero', async () => {
  const summary = await new JobUsageReader({ sessionPersistence: persistence([]).service } as never).of('worker-t')
  expect(summary).toMatchObject({ routes: [], cost: { kind: 'unavailable' }, coverage: { attempts: 0, reported: 0 } })
  expect(summary?.problem).toBeUndefined()
})

it('states a missing or unreadable worker Session rather than reporting zero usage', async () => {
  const missing = new JobUsageReader({ sessionPersistence: persistence([], { stat: false }).service } as never)
  expect(await missing.of('worker-t')).toMatchObject({ problem: 'missing', routes: [] })
  const unreadable = new JobUsageReader({ sessionPersistence: persistence([], { fail: true }).service } as never)
  expect(await unreadable.of('worker-t')).toMatchObject({ problem: 'unreadable', routes: [] })
})
