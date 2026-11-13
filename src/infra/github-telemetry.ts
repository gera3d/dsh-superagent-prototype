/**
 * Request telemetry for the agent's GitHub calls: counts by caller, masked endpoint and outcome, an hourly rolling window,
 * a small persisted daily summary, and the last `x-ratelimit-*` facts. It stores only counters and those three header values,
 * never tokens, other headers, request bodies or response bodies, and it never makes a request of its own.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** `200`, `304` (conditional hit, free), other 2xx, quota refusals (403/429 with quota signals), and every other failure. */
export const OUTCOMES = ['200', '304', '2xx', 'limited', 'error'] as const
export type Outcome = typeof OUTCOMES[number]
export type Counts = Record<Outcome, number>
/** The three quota headers GitHub puts on a response; `reset` is epoch seconds. */
export interface QuotaHeaders { remaining: number; reset: number; resource: string }
export interface QuotaFacts extends QuotaHeaders { /** Epoch milliseconds when the response was seen. */ at: number }
/** Persisted daily summary: counts per `caller|endpoint` for each of the last days (UTC), plus the last quota facts per resource. */
export interface TelemetrySummary { days: Record<string, Record<string, Counts>>; quota: Record<string, QuotaFacts> }
export interface TelemetryTotals extends Counts { requests: number; /** 304 responses, which cost no quota. */ free: number; /** Requests that count against the quota. */ charged: number }
export interface TelemetryView {
  /** The last 60 minutes. */
  hour: TelemetryTotals
  /** The current UTC day, including what was restored after a restart. */
  day: TelemetryTotals & { date: string }
  /** Busiest callers of the last hour. */
  callers: { caller: string; requests: number; free: number; limited: number }[]
  /** Busiest endpoints of the last hour. */
  endpoints: { endpoint: string; requests: number; free: number }[]
  /** Last known quota facts for the `core` resource (or the newest other resource when `core` was never seen). */
  quota?: QuotaFacts
  /** One line for health detail. */
  text: string
}
export interface Sample { caller: string; endpoint: string; outcome: Outcome; /** Requests this call made (pages of a paginated call); 1 by default. */ weight?: number; quota?: QuotaHeaders | undefined }

const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
const DAYS_KEPT = 3
/** Bounds the cardinality of a day's `caller|endpoint` keys so a new URL shape cannot grow the persisted summary without limit. */
const MAX_KEYS = 200
const OVERFLOW = 'other|:overflow'
export const TOP = 5

const callers = new AsyncLocalStorage<string>()
/** Runs `work` so every GitHub call it starts is attributed to `caller` (a short lowercase name such as `poll-notifications`). */
export const withCaller = <T>(caller: string, work: () => T): T => callers.run(caller, work)
/** The caller the running code was attributed to, `other` outside any attribution. */
export const currentCaller = (): string => callers.getStore() ?? 'other'
const callerName = (name: string): string => /^[a-z][a-z0-9-]{0,39}$/.test(name) ? name : 'other'

/** Collections whose next path segment is a free-form value (a ref, branch, tag, user or label name). */
const ONE = new Set(['commits', 'branches', 'tags', 'users', 'orgs', 'labels', 'releases', 'milestones', 'deployments', 'teams'])
/** Collections whose remaining path is free-form (file paths, ref paths, comparison ranges). */
const REST = new Set(['contents', 'compare', 'ref', 'refs', 'heads', 'trees', 'blobs'])
/**
 * Reduces an API path to a template without anything specific to one request: the query is dropped, the repository becomes
 * `:o/:r`, numbers become `:n`, commit SHAs `:sha`, and refs, names and file paths `:x`/`:path`. Only short lowercase words survive as literals.
 */
export function maskEndpoint(path: string): string {
  const parts = (path.split(/[?#]/, 1)[0] ?? '').split('/').filter(Boolean)
  const out: string[] = []
  let previous = ''
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!
    if (i === 0 && part === 'repos') { out.push('repos'); if (parts.length > 1) out.push(':o'); if (parts.length > 2) out.push(':r'); i = Math.min(2, parts.length - 1); previous = 'repos'; continue }
    if (REST.has(previous)) { out.push(':path'); break }
    out.push(mask(part, ONE.has(previous)))
    previous = part
  }
  return out.join('/').slice(0, 120)
}
function mask(part: string, free: boolean): string {
  if (/^\d+$/.test(part)) return ':n'
  if (/^[0-9a-f]{7,64}$/i.test(part) && /\d/.test(part)) return ':sha'
  return !free && /^[a-z][a-z_-]{0,31}$/.test(part) ? part : ':x'
}
/** The endpoint key of a `gh api` invocation: the masked path, prefixed with the method unless it is a read. */
export function endpointOf(args: readonly string[]): string {
  const method = args.findIndex(arg => arg === '--method' || arg === '-X')
  const named = method >= 0 ? args[method + 1]?.toUpperCase() : undefined
  const verb = named ?? (args.some(arg => ['-f', '-F', '--field', '--raw-field', '--input'].includes(arg)) ? 'POST' : 'GET')
  const path = maskEndpoint(args[1] ?? '')
  return /^[A-Z]{3,7}$/.test(verb) && verb !== 'GET' ? `${verb} ${path}` : path
}

/**
 * Reads only the three quota headers (`x-ratelimit-remaining`, `-reset`, `-resource`) from `gh api --include` output;
 * the first blank line ends the headers, so a body is never read. Returns undefined unless all three are present and well-formed.
 */
export function quotaHeaders(stdout: unknown): QuotaHeaders | undefined {
  if (typeof stdout !== 'string') return undefined
  const split = stdout.search(/\r?\n\r?\n/)
  const headers = split < 0 ? stdout : stdout.slice(0, split)
  const text = (name: string) => new RegExp(`^${name}:[ \\t]*([^\\r\\n]*)`, 'im').exec(headers)?.[1]?.trim()
  const remaining = text('x-ratelimit-remaining'), reset = text('x-ratelimit-reset'), resource = text('x-ratelimit-resource')
  if (!remaining || !reset || !resource || !/^\d{1,9}$/.test(remaining) || !/^\d{1,12}$/.test(reset) || !/^[a-z_]{1,32}$/.test(resource)) return undefined
  return { remaining: Number(remaining), reset: Number(reset), resource }
}
/** The HTTP status of `gh api --include` output, if its first line carries one. */
export function statusOf(stdout: unknown): number | undefined {
  const status = typeof stdout === 'string' ? /^HTTP\/\S+\s+(\d{3})/m.exec(stdout.slice(0, 200))?.[1] : undefined
  return status ? Number(status) : undefined
}

const empty = (): Counts => ({ '200': 0, '304': 0, '2xx': 0, limited: 0, error: 0 })
const total = (counts: Counts): number => OUTCOMES.reduce((sum, outcome) => sum + counts[outcome], 0)
const totals = (counts: Counts): TelemetryTotals => {
  const requests = total(counts)
  return { ...counts, requests, free: counts['304'], charged: requests - counts['304'] }
}
const slot = (map: Map<string, Counts>, key: string): Counts => { const counts = map.get(key) ?? empty(); map.set(key, counts); return counts }
const add = (into: Counts, from: Counts): void => { for (const outcome of OUTCOMES) into[outcome] += from[outcome] }
const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10)
const valid = (value: unknown): value is Counts => !!value && typeof value === 'object'
  && OUTCOMES.every(outcome => Number.isSafeInteger((value as Counts)[outcome]) && (value as Counts)[outcome] >= 0)

/** Counters for GitHub requests. One instance belongs to `Commands`; the GitHub Source restores and persists its summary. */
export class GithubTelemetry {
  /** Counts per minute (start of minute, epoch ms) and `caller|endpoint`; entries older than an hour are dropped. */
  private readonly minutes = new Map<number, Map<string, Counts>>()
  private readonly days = new Map<string, Map<string, Counts>>()
  private readonly quota = new Map<string, QuotaFacts>()
  constructor(private readonly now: () => number = Date.now) {}

  /** Records one call (`weight` requests) of a caller on an endpoint, with the quota headers of its response when it carried them. */
  record(sample: Sample): void {
    const at = this.now()
    const weight = Math.max(1, Math.floor(sample.weight ?? 1))
    const key = `${callerName(sample.caller)}|${sample.endpoint.replace(/[|\r\n]/g, ' ').slice(0, 120)}`
    const minute = Math.floor(at / MINUTE_MS) * MINUTE_MS
    const recent = this.minutes.get(minute) ?? new Map<string, Counts>()
    this.minutes.set(minute, recent)
    slot(recent, key)[sample.outcome] += weight
    const date = dayOf(at)
    const day = this.days.get(date) ?? new Map<string, Counts>()
    this.days.set(date, day)
    slot(day, day.has(key) || day.size < MAX_KEYS ? key : OVERFLOW)[sample.outcome] += weight
    if (sample.quota) this.quota.set(sample.quota.resource, { ...sample.quota, at })
    this.prune(at)
  }
  private prune(at: number): void {
    for (const minute of this.minutes.keys()) if (minute <= at - HOUR_MS) this.minutes.delete(minute)
    const oldest = dayOf(at - (DAYS_KEPT - 1) * 86_400_000)
    for (const day of this.days.keys()) if (day < oldest) this.days.delete(day)
  }
  /** The persisted form: the last few days of counts and the last quota facts. */
  summary(): TelemetrySummary {
    this.prune(this.now())
    return { days: Object.fromEntries([...this.days].map(([day, counts]) => [day, Object.fromEntries(counts)])),
      quota: Object.fromEntries(this.quota) }
  }
  /** Restores a persisted summary after a restart, ignoring anything malformed; counts already recorded are kept and added to. */
  restore(stored: unknown): void {
    if (!stored || typeof stored !== 'object') return
    const { days, quota } = stored as Partial<TelemetrySummary>
    for (const [day, counts] of Object.entries(days ?? {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !counts || typeof counts !== 'object') continue
      const into = this.days.get(day) ?? new Map<string, Counts>()
      for (const [key, value] of Object.entries(counts)) {
        if (!/^[a-z][a-z0-9-]{0,39}\|[^|\r\n]{0,120}$/.test(key) || !valid(value)) continue
        const existing = into.get(key) ?? empty()
        add(existing, value)
        into.set(key, existing)
      }
      if (into.size) this.days.set(day, into)
    }
    for (const [resource, facts] of Object.entries(quota ?? {})) {
      const seen = this.quota.get(resource)
      if (/^[a-z_]{1,32}$/.test(resource) && facts && Number.isSafeInteger(facts.remaining) && Number.isSafeInteger(facts.reset) && Number.isSafeInteger(facts.at)
        && (!seen || seen.at < facts.at)) this.quota.set(resource, { remaining: facts.remaining, reset: facts.reset, resource, at: facts.at })
    }
    this.prune(this.now())
  }
  /** Totals, busiest callers and endpoints of the last hour, the day so far and the last quota facts. */
  view(): TelemetryView {
    const at = this.now()
    this.prune(at)
    const hour = empty()
    const byCaller = new Map<string, Counts>(), byEndpoint = new Map<string, Counts>()
    for (const minute of this.minutes.values()) {
      for (const [key, counts] of minute) {
        add(hour, counts)
        const [caller = 'other', endpoint = ''] = key.split('|')
        for (const [map, name] of [[byCaller, caller], [byEndpoint, endpoint]] as const) { const sum = map.get(name) ?? empty(); add(sum, counts); map.set(name, sum) }
      }
    }
    const date = dayOf(at)
    const today = empty()
    for (const counts of this.days.get(date)?.values() ?? []) add(today, counts)
    const top = <T>(map: Map<string, Counts>, shape: (name: string, counts: Counts) => T) =>
      [...map].sort((a, b) => total(b[1]) - total(a[1]) || a[0].localeCompare(b[0])).slice(0, TOP).map(([name, counts]) => shape(name, counts))
    const facts = this.quota.get('core') ?? [...this.quota.values()].sort((a, b) => b.at - a.at)[0]
    const view: Omit<TelemetryView, 'text'> = { hour: totals(hour), day: { date, ...totals(today) },
      callers: top(byCaller, (caller, c) => ({ caller, requests: total(c), free: c['304'], limited: c.limited })),
      endpoints: top(byEndpoint, (endpoint, c) => ({ endpoint, requests: total(c), free: c['304'] })), ...facts ? { quota: facts } : {} }
    return { ...view, text: describe(view) }
  }
}
/** One-line summary: hour and day totals, the top callers, and the last known remaining quota with its reset time. */
function describe(view: Omit<TelemetryView, 'text'>): string {
  const { hour, day, callers: top, quota } = view
  const parts = [`GitHub requests: ${hour.requests} in the last hour (${hour.free} free, ${hour.limited} limited), ${day.requests} today`]
  if (top.length) parts.push(`top callers: ${top.map(item => `${item.caller} ${item.requests}`).join(', ')}`)
  if (quota) parts.push(`${quota.resource} quota ${quota.remaining} left, resets ${new Date(quota.reset * 1000).toISOString()}`)
  return parts.join('; ')
}
