/**
 * Read-only per-job usage projection for completed Tickets: the native recorded provider/model route and the
 * provider-reported token buckets of the worker Session, folded from its durable log the way DSH's `tokenUsage`
 * projection does. It adds no ledger of its own: every figure comes from `request/context`/`request/header` and the
 * `usage` sample of a settled `assistant/message`/`assistant/attempt`, and any gap stays visible instead of becoming a
 * zero. Monetary cost is unavailable unless an explicit rate table covers every contributing route; no billing endpoint
 * or credential value is ever read.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'

/** One event from a persisted Session log, as the projection needs to see it. */
interface StoredEvent { readonly seq: number; readonly type: string; readonly data: unknown }
/** The provider-reported counts of one model attempt. Cache fields are optional because adapters report them optionally. */
interface UsageSample {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}
/** Token counts of the attempts attributed to one provider/model route. */
export interface UsageRoute {
  provider: string
  model: string
  attempts: number
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens: number
}
/** Which recorded attempts of the route carry the optional cache bucket: `exact` (all), `partial` (some), `unreported` (none). */
export type BucketCoverage = 'exact' | 'partial' | 'unreported'
/** What a job's recorded usage can and cannot prove. */
export interface JobUsageCoverage {
  /** Settled model attempts that left an event in the log. */
  attempts: number
  /** Attempts whose event carried a provider usage sample. */
  reported: number
  cacheRead: BucketCoverage
  cacheWrite: BucketCoverage
  /** `partial` when some usage could not be attributed to a recorded provider/model route. */
  attribution: 'complete' | 'partial'
}
/** Monetary cost: reported only when a rate table covers every route, and always labelled as an estimate. */
export type JobUsageCost =
  | { kind: 'unavailable'; reason: 'noRecordedPrice' }
  | { kind: 'estimated'; currency: 'USD'; amount: number; note: 'rateTable'
    /** Set when some recorded usage is missing or unattributed, so the amount covers recorded routes only. */
    partial?: true }
/** Token prices in USD per million tokens of one exact provider/model route. */
export interface UsageRate {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}
/** The trustworthy usage summary of one completed job's worker Session. */
export interface JobUsage {
  sessionId: string
  routes: UsageRoute[]
  totals: { uncachedInputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number
    cacheWriteTokens?: number }
  coverage: JobUsageCoverage
  cost: JobUsageCost
  /** `missing` when the worker Session has no stored log, `unreadable` when reading it failed. */
  problem?: 'missing' | 'unreadable'
}
const UNATTRIBUTED = 'unattributed'
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
/** A safe non-negative integer count, or undefined when the field is absent or unusable. */
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
/** The route a usage sample belongs to; an absent route stays visibly unattributed. */
interface Route { provider: string; model: string }
/** The usage sample a settled attempt reports, from its explicit field or its packed stream. */
function usageOf(event: StoredEvent): UsageSample | undefined {
  const data = record(event.data)
  if (!data) return undefined
  const direct = sampleOf(data.usage)
  if (direct) return direct
  const stream = Array.isArray(data.stream) ? data.stream : []
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const item = record(stream[index])
    if (item?.type !== 'chunk') continue
    const chunk = record(item.chunk)
    if (chunk?.type === 'usage') return sampleOf(chunk.usage)
  }
  return undefined
}
/** Validates one usage object; absent counts make the sample unusable rather than zero. */
function sampleOf(value: unknown): UsageSample | undefined {
  const usage = record(value)
  if (!usage) return undefined
  const uncachedInputTokens = count(usage.inputTokens), outputTokens = count(usage.outputTokens)
  if (uncachedInputTokens === undefined || outputTokens === undefined) return undefined
  const cacheReadTokens = count(usage.cacheReadTokens), cacheWriteTokens = count(usage.cacheWriteTokens)
  return { uncachedInputTokens, outputTokens, ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens } }
}
/** The route recorded on a request header, if any. */
function headerRoute(event: StoredEvent): Route | undefined {
  const header = record(record(event.data)?.header), config = record(header?.config)
  const provider = typeof config?.provider === 'string' ? config.provider : undefined
  const model = typeof config?.model === 'string' ? config.model : undefined
  return provider && model ? { provider, model } : undefined
}
/** The route recorded on a `request/context` snapshot, if any. */
function contextRoute(event: StoredEvent): Route | undefined {
  const data = record(event.data)
  const provider = typeof data?.provider === 'string' ? data.provider : undefined
  const model = typeof data?.model === 'string' ? data.model : undefined
  return provider && model ? { provider, model } : undefined
}
const routeKey = (route: Route): string => `${route.provider}\u0000${route.model}`
/** One route's accumulator, with per-bucket reporting counts for honest partial coverage. */
interface RouteBucket {
  route?: Route
  reported: number
  cacheRead: number
  cacheReadReported: number
  cacheWrite: number
  cacheWriteReported: number
  uncachedInputTokens: number
  outputTokens: number
}
const emptyBucket = (route?: Route): RouteBucket => ({ ...route ? { route } : {}, reported: 0, cacheRead: 0,
  cacheReadReported: 0, cacheWrite: 0, cacheWriteReported: 0, uncachedInputTokens: 0, outputTokens: 0 })
/** A settlement event indexes its replacement slot by model turn and step. */
interface Slot { turn: number; step: number; sample?: UsageSample; key?: string }
/**
 * The incremental fold of one worker Session log. `seq` deduplicates replayed events; the replacement slot mirrors
 * DSH's `tokenUsage` projection: a same-step settlement replaces its sample, and `llm/retry-started` ends that
 * replacement scope so a retried billing attempt counts again. `offset` lets the reader consume only new events.
 */
export class JobUsageFold {
  /** Events already consumed from the Session log, including duplicates skipped by their `seq`. */
  offset = 0
  private readonly seen = new Set<number>()
  private readonly buckets = new Map<string, RouteBucket>()
  private route: Route | undefined
  private last: Slot | undefined
  private attempts = 0
  private reported = 0
  /** Consume new persisted events; a repeated `seq` is ignored so a replay never counts twice. */
  observe(events: readonly StoredEvent[]): void {
    for (const event of events) {
      this.offset += 1
      if (this.seen.has(event.seq)) continue
      this.seen.add(event.seq)
      this.apply(event)
    }
  }
  private apply(event: StoredEvent): void {
    if (event.type === 'request/header') { this.route = headerRoute(event) ?? this.route; return }
    if (event.type === 'request/context') { this.route = contextRoute(event) ?? this.route; return }
    if (event.type === 'llm/retry-started') {
      const retried = record(event.data)
      if (this.last && this.last.turn === retried?.turn && this.last.step === retried?.step) this.last = undefined
      return
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return
    const data = record(event.data)
    const turn = count(data?.turn), step = count(data?.step)
    const sample = usageOf(event)
    const replacement = turn !== undefined && step !== undefined && this.last?.turn === turn && this.last.step === step
    const key = this.route ? routeKey(this.route) : UNATTRIBUTED
    // A duplicate settlement of the same step repeats its own sample (or absence) on the same route and never counts again.
    if (replacement && this.last?.key === key && sameSample(this.last?.sample, sample)) return
    // A sample-less message on a step with known usage does not erase prior reported usage.
    if (replacement && sample === undefined && this.last?.sample !== undefined) return
    // A settlement on a new step begins a new attempt.
    if (!replacement) this.attempts += 1
    // Replacing a previous sample of this step withdraws its old route's counters.
    if (replacement && this.last?.sample && this.last.key) {
      this.withdraw({ key: this.last.key, sample: this.last.sample })
      this.reported -= 1
    }
    if (sample !== undefined) {
      this.reported += 1
      const bucket = this.bucketOf(key, this.route)
      bucket.reported += 1
      if (sample.cacheReadTokens !== undefined) bucket.cacheReadReported += 1
      if (sample.cacheWriteTokens !== undefined) bucket.cacheWriteReported += 1
      this.add(key, sample, 1)
    }
    this.last = turn === undefined || step === undefined ? undefined : { turn, step, sample, key }
  }
  private bucketOf(key: string, route?: Route): RouteBucket {
    let bucket = this.buckets.get(key)
    if (!bucket) { bucket = emptyBucket(route); this.buckets.set(key, bucket) }
    return bucket
  }
  /** Remove a replaced sample's counters from the route that had counted them. */
  private withdraw({ key, sample }: { key: string; sample: UsageSample }): void {
    const bucket = this.buckets.get(key)
    if (!bucket) return
    bucket.reported -= 1
    if (sample.cacheReadTokens !== undefined) bucket.cacheReadReported -= 1
    if (sample.cacheWriteTokens !== undefined) bucket.cacheWriteReported -= 1
    this.add(key, sample, -1)
  }
  private add(key: string, sample: UsageSample, sign: 1 | -1): void {
    const bucket = this.buckets.get(key) ?? this.bucketOf(key, this.route)
    bucket.uncachedInputTokens += sign * sample.uncachedInputTokens
    bucket.outputTokens += sign * sample.outputTokens
    bucket.cacheRead += sign * (sample.cacheReadTokens ?? 0)
    bucket.cacheWrite += sign * (sample.cacheWriteTokens ?? 0)
  }
  /** Finish the fold into the panel-facing summary. */
  summary(sessionId: string, rates?: Readonly<Record<string, UsageRate>>): JobUsage {
    const buckets = [...this.buckets.values()]
    const routes = buckets.flatMap((item): UsageRoute[] => item.route && item.reported > 0 ? [{ provider: item.route.provider,
      model: item.route.model, attempts: item.reported, uncachedInputTokens: item.uncachedInputTokens, outputTokens: item.outputTokens,
      ...item.cacheReadReported > 0 ? { cacheReadTokens: item.cacheRead } : {},
      ...item.cacheWriteReported > 0 ? { cacheWriteTokens: item.cacheWrite } : {},
      totalTokens: item.uncachedInputTokens + item.outputTokens + item.cacheRead + item.cacheWrite }] : [])
      .sort((left, right) => right.totalTokens - left.totalTokens)
    const total = (pick: (item: RouteBucket) => number) => buckets.reduce((sum, item) => sum + pick(item), 0)
    const cacheReadReported = total(item => item.cacheReadReported), cacheWriteReported = total(item => item.cacheWriteReported)
    const unattributed = this.buckets.get(UNATTRIBUTED)
    const hasUnattributed = Boolean(unattributed && unattributed.reported > 0)
    const coverage: JobUsageCoverage = { attempts: this.attempts, reported: this.reported,
      cacheRead: coverageOf(cacheReadReported, this.reported), cacheWrite: coverageOf(cacheWriteReported, this.reported),
      attribution: hasUnattributed ? 'partial' : 'complete' }
    const uncachedInputTokens = total(item => item.uncachedInputTokens), outputTokens = total(item => item.outputTokens)
    const cacheReadTokens = total(item => item.cacheRead), cacheWriteTokens = total(item => item.cacheWrite)
    const partial = hasUnattributed || this.reported < this.attempts
    return { sessionId, routes, totals: { uncachedInputTokens, outputTokens, totalTokens: uncachedInputTokens + outputTokens
      + cacheReadTokens + cacheWriteTokens, ...cacheReadReported > 0 ? { cacheReadTokens } : {},
      ...cacheWriteReported > 0 ? { cacheWriteTokens } : {} }, coverage, cost: estimateCost(routes, rates, partial) }
  }
}
const sameSample = (left?: UsageSample, right?: UsageSample): boolean =>
  left === undefined ? right === undefined : right !== undefined
  && left.uncachedInputTokens === right.uncachedInputTokens && left.outputTokens === right.outputTokens
  && left.cacheReadTokens === right.cacheReadTokens && left.cacheWriteTokens === right.cacheWriteTokens
const coverageOf = (reported: number, samples: number): BucketCoverage =>
  reported === 0 ? 'unreported' : reported === samples ? 'exact' : 'partial'
/**
 * Price recorded usage from an explicit per-route rate table. Every contributing route must be covered; when one is not,
 * the result is unavailable rather than a zero or a partially priced total. A partial recorded coverage keeps the estimate
 * but marks it, so the panel can say the amount covers recorded routes only.
 * @param routes - the attributed routes of one job
 * @param rates - USD per million tokens keyed by `provider/model`
 * @param partial - whether some recorded usage is missing or unattributed
 */
export function estimateCost(routes: readonly UsageRoute[], rates?: Readonly<Record<string, UsageRate>>,
  partial = false): JobUsageCost {
  if (!rates || routes.length === 0) return { kind: 'unavailable', reason: 'noRecordedPrice' }
  let amount = 0
  for (const route of routes) {
    const rate = rates[`${route.provider}/${route.model}`]
    if (!rate) return { kind: 'unavailable', reason: 'noRecordedPrice' }
    amount += (route.uncachedInputTokens * rate.input + route.outputTokens * rate.output
      + (route.cacheReadTokens ?? 0) * (rate.cacheRead ?? rate.input)
      + (route.cacheWriteTokens ?? 0) * (rate.cacheWrite ?? rate.input)) / 1_000_000
  }
  return { kind: 'estimated', currency: 'USD', amount: Math.round(amount * 1e6) / 1e6, note: 'rateTable',
    ...partial ? { partial: true } : {} }
}
/** The empty summary a missing or unreadable worker Session log produces; totals stay empty, never zero-billed. */
const noUsage = (sessionId: string, problem: 'missing' | 'unreadable'): JobUsage => ({ sessionId, routes: [],
  totals: { uncachedInputTokens: 0, outputTokens: 0, totalTokens: 0 },
  coverage: { attempts: 0, reported: 0, cacheRead: 'unreported', cacheWrite: 'unreported', attribution: 'complete' },
  cost: { kind: 'unavailable', reason: 'noRecordedPrice' }, problem })
/** A fold and the persistence revision whose events it has consumed. */
interface FoldState { fold: JobUsageFold; revision: SessionPersistenceRevision }

const DEFAULT_CACHE_MAX_ENTRIES = 64

/**
 * Read a completed job's usage from its worker Session's durable log, keeping its fold for later polls.
 * Folds are cached with bounded LRU eviction (default 64 entries). When a session log changes, growing logs
 * with sequential continuity and count evidence are appended incrementally. Recreated, truncated or unknown-count
 * logs with changed revisions invalidate earlier folds and re-fold from offset 0 to guarantee fresh counts.
 * Note: If a persistence backend produces identical revisions for rewritten contents without event counts,
 * incremental safety relies on distinct persistence revisions.
 */
export class JobUsageReader {
  /** Bounded LRU cache of active fold states keyed by Session ID. */
  readonly folds = new Map<string, FoldState>()
  private readonly rates?: Readonly<Record<string, UsageRate>>
  private readonly maxEntries: number

  constructor(private readonly ctx: Context, options: { rates?: Readonly<Record<string, UsageRate>>; maxEntries?: number } = {}) {
    this.rates = options.rates
    this.maxEntries = options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES
  }

  private remember(sessionId: string, state: FoldState): void {
    this.folds.delete(sessionId)
    this.folds.set(sessionId, state)
    while (this.folds.size > this.maxEntries) {
      const oldest = this.folds.keys().next().value
      if (oldest === undefined) break
      this.folds.delete(oldest)
    }
  }

  private touch(sessionId: string, state: FoldState): void {
    this.folds.delete(sessionId)
    this.folds.set(sessionId, state)
  }

  /** The recorded summary for one worker Session, or the reason it cannot be shown. */
  async of(sessionId: string): Promise<JobUsage | undefined> {
    try {
      // An unchanged revision means an unchanged log, so a repeated ticket read only reuses the fold.
      const observed = await this.ctx.sessionPersistence.stat(sessionId as SessionId)
      if (!observed) { this.folds.delete(sessionId); return noUsage(sessionId, 'missing') }
      const cached = this.folds.get(sessionId)
      if (cached && cached.revision === observed.revision) {
        this.touch(sessionId, cached)
        return cached.fold.summary(sessionId, this.rates)
      }
      // Flush the worker's best-effort appends only when the log changed since the fold was built.
      await this.ctx.sessionPersistence.flush()
      const stat = await this.ctx.sessionPersistence.stat(sessionId as SessionId)
      if (!stat) { this.folds.delete(sessionId); return noUsage(sessionId, 'missing') }
      let fold = cached?.fold
      // A Session rewritten, truncated or recreated with equal or fewer events invalidates an earlier fold.
      // An absent eventCount provides no count evidence, so unequal revisions must be re-folded from offset 0.
      if (fold && (stat.eventCount === undefined || stat.eventCount <= fold.offset)) fold = undefined
      fold ??= new JobUsageFold()
      await using handle = await this.ctx.sessionPersistence.open(sessionId as SessionId, 'read')
      for (;;) {
        const { events } = await handle.read(fold.offset, 256)
        if (!events.length) break
        if (fold.offset > 0 && events[0]?.seq !== fold.offset) {
          // Sequence discontinuity: log was recreated from scratch; reset and re-read from 0.
          fold = new JobUsageFold()
          continue
        }
        fold.observe(events)
      }
      this.remember(sessionId, { fold, revision: stat.revision })
      return fold.summary(sessionId, this.rates)
    } catch {
      this.folds.delete(sessionId)
      return noUsage(sessionId, 'unreadable')
    }
  }
}
