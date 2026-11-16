/**
 * The host boundary at which a Composio MCP tool result is consumed: DSH's `tools/post-execute` waterfall of a managed
 * worker Session. A Composio call that fails inside a successful MCP envelope (`successful: false`, a mixed batch) looks
 * like a success to the host; this listener re-classifies it and turns a failure into an error result whose content keeps
 * every successful batch entry, carries sanitized diagnostics and states one recovery action.
 *
 * It only reads results. It registers no tool, widens no allowlist, retries nothing and never reconnects an account: a
 * timeout or lost acknowledgement is reported as an unknown outcome that must be checked, not resent.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  CONNECTION_FAILURE_PATTERN, batchItemOutcome, envelopeOutcome, extractErrorMessage, isEnvelopeFailed, isRecord, unwrapComposioResult,
  type ComposioBatchData, type ToolResult,
} from './tools/composio.ts'

/**
 * A Composio MCP tool by provenance: the public name `dsh-mcp-client` gives a tool of the MCP server whose configured
 * `serverName` is `composio` (the `mcp-composio` plugin row of the web and superagent profiles) is `mcp__composio__<tool>`.
 * Any other server, including one whose name merely contains "composio", is not touched.
 */
export const COMPOSIO_TOOL = /^mcp__composio__/
export const isComposioTool = (name: string): boolean => COMPOSIO_TOOL.test(name)

export type ComposioFailureKind = 'connection_required' | 'uncertain_completion' | 'rate_limited' | 'action_failed' | 'transport_failure'
/** `failed`: nothing took effect that is known of; `partial`: some entries succeeded; `unknown`: the action may have run. */
export type ComposioCompletion = 'failed' | 'partial' | 'unknown'

export interface ComposioFailedEntry { index?: number; tool_slug?: string; kind: ComposioFailureKind; error: string; retry_after_seconds?: number }
/** A batch entry whose outcome the service did not confirm: malformed, without an explicit success flag, or flagged both successful and failed. */
export interface ComposioUnconfirmedEntry { index: number; tool_slug?: string; reason: 'malformed' | 'no_completion_evidence' | 'contradictory_flags' }
export interface ComposioAssessment {
  tool: string
  kind: ComposioFailureKind
  completion: ComposioCompletion
  /** Seconds the service asked to wait before a retry, the longest asked. */
  retryAfterSeconds?: number
  /** `unreported` counts every entry whose outcome is not confirmed: counted but missing, malformed, or without success evidence. */
  counts: { total?: number; succeeded: number; failed: number; unreported: number }
  failed: ComposioFailedEntry[]
  /** Batch entries the service explicitly reported as successful, exactly as returned. */
  succeeded: unknown[]
  /** Entries present in the batch whose outcome is unknown; they are never promoted to succeeded or offered for a retry. */
  unconfirmed: ComposioUnconfirmedEntry[]
  /** Distinct kinds present, most urgent first. */
  kinds: ComposioFailureKind[]
  message: string
}

/** Kinds whose Retry-After is kept: a wait floor for a rate limit, and for an unknown outcome a wait before checking it. */
const WAITED: readonly ComposioFailureKind[] = ['rate_limited', 'uncertain_completion']
const PRIORITY: readonly ComposioFailureKind[] = ['connection_required', 'uncertain_completion', 'rate_limited', 'action_failed', 'transport_failure']
const RATE_LIMIT = /rate[\s_-]?limit|too many requests|\b429\b|throttl|quota (?:exceeded|exhausted)|RATE_LIMIT/i
/** Wording that says the request may have been sent and its result lost: it outranks a rate-limit word in the same text. */
const LOST_OUTCOME = /time[sd]?[\s_-]?out|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EPIPE|socket hang up|deadline exceeded|\b50[234]\b|bad gateway|aborted|connection (?:closed|reset|lost)|stream (?:closed|ended)|no response|did not respond|not acknowledged|acknowledg|lost ack|-32001|-32000/i
/** Wording that only hints at an unknown outcome: it yields to an explicit rate limit. */
const MAYBE_LOST = /gateway|upstream/i
const CONNECTION_CODES = new Set(['NO_ACTIVE_CONNECTION', 'AUTH_REQUIRED', 'UNAUTHORIZED', 'CONNECTION_REQUIRED'])
const DIAGNOSTIC_CHARS = 300

/** Diagnostic text with credentials, authorization headers and secret-looking values replaced, cut to a useful length. */
export function sanitizeDiagnostic(text: string, max = DIAGNOSTIC_CHARS): string {
  let out = text.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, ' ')
  out = out
    .replace(/\b((?:proxy-)?authorization|cookie|set-cookie)\b(\s*["']?\s*[:=]\s*)(?:(?:Bearer|Basic|Token)\s+)?[^\n"',;]+/gi, '$1$2[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [redacted]')
    .replace(/\b([\w-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|token|signature)[\w-]*)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1$2[redacted]')
    .replace(/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted]')
    .replace(/\b(?:sk|pk|rk|ak|ck|uak)[-_][A-Za-z0-9_-]{16,}\b/g, '[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/g, '[redacted]')
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ').trim()
  return out.length > max ? `${out.slice(0, max - 1)}…` : out
}

/** Seconds from a `Retry-After` the service stated: a number or HTTP date in a field, a header, or the message text. */
export function retryAfterSeconds(...sources: unknown[]): number | undefined {
  const fromValue = (value: unknown, unit: 's' | 'ms'): number | undefined => {
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(value) ? Number(value) : undefined
    if (number !== undefined && Number.isFinite(number) && number >= 0) return Math.ceil(unit === 'ms' ? number / 1000 : number)
    if (typeof value === 'string') {
      const date = Date.parse(value)
      if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000))
    }
    return undefined
  }
  const found: number[] = []
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || value === null || value === undefined) return
    if (typeof value === 'string') {
      const match = /(?:retry[\s_-]?after|try again in|retry in)\W{0,4}(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)?/i.exec(value)
      if (match) found.push(fromValue(match[1], /^m/i.test(match[2] ?? '') ? 'ms' : 's') ?? 0)
      return
    }
    if (!isRecord(value)) return
    for (const [key, entry] of Object.entries(value)) {
      const name = key.toLowerCase().replace(/[\s_-]/g, '')
      if (name === 'retryafter' || name === 'retryafterseconds') { const seconds = fromValue(entry, 's'); if (seconds !== undefined) found.push(seconds) }
      else if (name === 'retryafterms' || name === 'retryaftermilliseconds') { const seconds = fromValue(entry, 'ms'); if (seconds !== undefined) found.push(seconds) }
      else if (isRecord(entry) || typeof entry === 'string') visit(entry, depth + 1)
    }
  }
  for (const source of sources) visit(source, 0)
  return found.length ? Math.max(...found) : undefined
}

function kindOf(text: string, candidate?: unknown, transport = false): ComposioFailureKind {
  const code = isRecord(candidate) ? [candidate.code, candidate.error_code, isRecord(candidate.error) ? candidate.error.code : undefined].find(value => typeof value === 'string') as string | undefined : undefined
  if (CONNECTION_FAILURE_PATTERN.test(text) || (code !== undefined && CONNECTION_CODES.has(code.toUpperCase()))) return 'connection_required'
  const says = (pattern: RegExp) => pattern.test(text) || (code !== undefined && pattern.test(code))
  // A lost acknowledgement or timeout dominates: the request may have run, whatever else the message says about limits.
  if (says(LOST_OUTCOME)) return 'uncertain_completion'
  if (says(RATE_LIMIT)) return 'rate_limited'
  if (says(MAYBE_LOST)) return 'uncertain_completion'
  return transport ? 'transport_failure' : 'action_failed'
}

const textOf = (result: ToolResult): string => (Array.isArray(result.content) ? result.content : [])
  .map(block => block?.type === 'text' && typeof block.text === 'string' ? block.text : '').filter(Boolean).join('\n')

function errorTextOf(item: Record<string, unknown>): string {
  const response = isRecord(item.response) ? item.response : undefined
  const raw = extractErrorMessage(response?.error) ?? extractErrorMessage(item.error) ?? extractErrorMessage(response?.message) ?? extractErrorMessage(item.message)
  if (raw) return raw
  const stringified = response?.error ?? item.error
  return typeof stringified === 'object' && stringified !== null ? JSON.stringify(stringified) : 'The action reported a failure without a message'
}

/** The batch payload (`results` array) of a parsed Composio payload, if it is one. */
function batchOf(payload: Record<string, unknown>): ComposioBatchData | undefined {
  if (isRecord(payload.data) && Array.isArray((payload.data as ComposioBatchData).results)) return payload.data as ComposioBatchData
  return Array.isArray((payload as ComposioBatchData).results) ? payload as ComposioBatchData : undefined
}

/**
 * Whether a batch is a Composio execution batch, whose entries must each say how they ended. Search or listing results also
 * arrive as a `results` array and carry no such flag, so they are not held to it.
 */
function isExecutionBatch(batch: ComposioBatchData, payload: Record<string, unknown>, entries: unknown[]): boolean {
  const counted = [batch, payload].some(source => ['total_count', 'success_count', 'error_count'].some(key => typeof source[key] === 'number'))
  return counted || payload.successful === false
    || entries.some(item => isRecord(item) && (isRecord(item.response) || typeof item.successful === 'boolean'))
}

/** The envelope(s) of a result, structured content first: a tool value shaped like an MCP result, JSON text blocks, structuredContent. */
function payloadsOf(result: ToolResult & { value?: unknown }, embedded: boolean): Record<string, unknown>[] {
  const found: unknown[] = []
  const value = result.value
  if (isRecord(value)) {
    if (value.structuredContent !== undefined) found.push(value.structuredContent)
    if (Array.isArray(value.content)) for (const block of value.content as ToolResult['content'] & unknown[]) found.push(parse(block?.text, embedded))
    if ('successful' in value || 'results' in value || isRecord(value.data) || (!Array.isArray(value.content) && 'error' in value)) found.push(value)
  }
  if (result.structuredContent !== undefined) found.push(result.structuredContent)
  for (const block of Array.isArray(result.content) ? result.content : []) if (block?.type === 'text') found.push(parse(block.text, embedded))
  return found.filter(isRecord)
}
/**
 * JSON from a text block. A failed MCP call reaches the host as a thrown error, so its text is the service's body behind an
 * `Error: ` prefix (and possibly a JSON-RPC prefix such as `MCP error -32000:`): for a result already known to be an error,
 * `embedded` reads the first `{` to the last `}`. A successful result's prose is never searched for JSON.
 */
function parse(text: unknown, embedded = false): unknown {
  if (typeof text !== 'string') return undefined
  try { return JSON.parse(text) } catch { /* not plain JSON */ }
  if (!embedded) return undefined
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return undefined }
}

/**
 * Classifies one Composio tool result, or `undefined` when it is not a failure: not a Composio tool, a success, or a payload
 * that does not carry Composio's own failure markers (business data is never judged by its words).
 */
export function assessComposioResult(name: string, result: ToolResult & { value?: unknown; error?: { message?: string } }): ComposioAssessment | undefined {
  if (!isComposioTool(name)) return undefined
  const text = textOf(result)
  // A failed call is flagged by the registry result, or by an MCP error envelope a tool returned as its value.
  const transport = result.isError === true || (isRecord(result.value) && result.value.isError === true)
  const unwrapped = unwrapComposioResult({ ...result, ...(isRecord(result.value) && result.value.structuredContent !== undefined && result.structuredContent === undefined ? { structuredContent: result.value.structuredContent } : {}) })
  const payloads = payloadsOf(result, transport)
  const batchPayload = payloads.find(item => batchOf(item))
  const batch = batchPayload ? batchOf(batchPayload) : undefined
  const failed: ComposioFailedEntry[] = [], succeeded: unknown[] = [], unconfirmed: ComposioUnconfirmedEntry[] = []
  let unreported = 0, total: number | undefined

  if (batch && batchPayload) {
    const entries = batch.results!
    total = typeof batch.total_count === 'number' ? batch.total_count : typeof batchPayload.total_count === 'number' ? batchPayload.total_count : undefined
    const executed = isExecutionBatch(batch, batchPayload, entries)
    entries.forEach((item, position) => {
      if (!isRecord(item)) { if (executed) unconfirmed.push({ index: position, reason: 'malformed' }); return }
      // The same rule as a single action's envelope: an explicit `successful: true` is kept as a success even if the entry also
      // carries an `error` note; an entry whose flags contradict each other, or that has none, is unknown, never claimed or dropped.
      const outcome = batchItemOutcome(item)
      if (outcome !== 'failed') {
        if (outcome === 'succeeded' || (!executed && outcome === 'unconfirmed')) succeeded.push(item)
        else unconfirmed.push({ index: typeof item.index === 'number' ? item.index : position, ...(typeof item.tool_slug === 'string' ? { tool_slug: item.tool_slug } : {}),
          reason: outcome === 'contradictory' ? 'contradictory_flags' : 'no_completion_evidence' })
        return
      }
      const message = errorTextOf(item)
      const response = isRecord(item.response) ? item.response : undefined
      const kind = kindOf(message, response ?? item)
      const retry = retryAfterSeconds(response, item, message)
      failed.push({ index: typeof item.index === 'number' ? item.index : position, ...(typeof item.tool_slug === 'string' ? { tool_slug: item.tool_slug } : {}),
        kind, error: sanitizeDiagnostic(message), ...(retry !== undefined && WAITED.includes(kind) ? { retry_after_seconds: retry } : {}) })
    })
    // Entries the service counted but never reported, and those it reported without confirming: their outcome is unknown.
    unreported = (total !== undefined && total > entries.length ? total - entries.length : 0) + unconfirmed.length
    const declaredErrors = typeof batch.error_count === 'number' ? batch.error_count : typeof batchPayload.error_count === 'number' ? batchPayload.error_count : 0
    if (!failed.length && (declaredErrors > 0 || isEnvelopeFailed({ ...batchPayload, response: undefined }))) {
      const message = errorTextOf(batchPayload)
      // The same rule as a single envelope: flags that contradict each other do not say the batch did not run.
      const kind = envelopeOutcome(batchPayload, batchPayload.response) === 'contradictory' ? 'uncertain_completion' : kindOf(message, batchPayload)
      failed.push({ kind, error: sanitizeDiagnostic(message), ...(WAITED.includes(kind) ? optionalRetry(retryAfterSeconds(batchPayload, message)) : {}) })
    }
  }
  if (!batch && (transport || unwrapped.isError) || (batch && transport && !failed.length && !unreported)) {
    // A protocol/transport failure, or a single action whose own envelope says it failed. A transport error that carried a
    // batch with no failed entry is still a failure: the outcome of what it carried is not known.
    const envelope = payloads.find(isEnvelopeFailed) ?? payloads[0]
    const message = transport && !envelope
      ? (text || result.error?.message || 'The Composio tool call failed')
      : errorTextOf(envelope ?? {}) !== 'The action reported a failure without a message' ? errorTextOf(envelope!) : (text || 'The action reported a failure without a message')
    // An envelope that says both successful and failed does not say the action did not run: its outcome is unknown, whether or
    // not the MCP result or the tool call around it was flagged as an error (a bridge throws an `isError` result as text).
    const conflicting = envelope !== undefined && envelopeOutcome(envelope, envelope.response) === 'contradictory'
    const kind = unwrapped.connectionError ? 'connection_required' : conflicting ? 'uncertain_completion' : kindOf(message, envelope, transport)
    failed.push({ kind, error: sanitizeDiagnostic(message), ...(WAITED.includes(kind) ? optionalRetry(retryAfterSeconds(envelope, message)) : {}) })
  }

  if (!failed.length && !unreported) return undefined
  const kinds = PRIORITY.filter(kind => failed.some(entry => entry.kind === kind) || (kind === 'uncertain_completion' && unreported > 0))
  const kind = kinds[0]!
  const uncertain = kinds.includes('uncertain_completion') || (kinds.includes('transport_failure') && !succeeded.length)
  const retry = failed.flatMap(entry => entry.retry_after_seconds === undefined ? [] : [entry.retry_after_seconds])
  return {
    tool: name, kind, kinds,
    completion: succeeded.length ? 'partial' : uncertain ? 'unknown' : 'failed',
    ...(retry.length ? { retryAfterSeconds: Math.max(...retry) } : {}),
    counts: { ...(total !== undefined ? { total } : {}), succeeded: succeeded.length, failed: failed.length, unreported },
    failed, succeeded, unconfirmed,
    message: failed[0]?.error ?? `${unreported} batch ${unreported === 1 ? 'entry was' : 'entries were'} counted by the service but not reported`,
  }
}
const optionalRetry = (seconds: number | undefined) => seconds === undefined ? {} : { retry_after_seconds: seconds }

const HEADLINE: Record<ComposioFailureKind, string> = {
  connection_required: 'a connection or authorization is missing or expired',
  uncertain_completion: 'the outcome is unknown (timeout or lost acknowledgement)',
  rate_limited: 'the service rate-limited the call',
  action_failed: 'the action reported a failure',
  transport_failure: 'the Composio tool call failed',
}
/** Which entries a recovery sentence is about: those of the kind, by batch index, or the whole call when it is not a batch. */
function scopeOf(assessment: ComposioAssessment, kind: ComposioFailureKind): string {
  const entries = assessment.failed.filter(entry => entry.kind === kind)
  const indices = entries.flatMap(entry => entry.index === undefined ? [] : [entry.index])
  return indices.length ? `entry ${indices.join(', ')}` : assessment.counts.total === undefined && !assessment.succeeded.length ? 'the call' : 'the entries of this kind'
}
/** The longest Retry-After the service stated for entries of this kind. */
function waitFor(assessment: ComposioAssessment, kind: ComposioFailureKind): number | undefined {
  const seconds = assessment.failed.flatMap(entry => entry.kind === kind && entry.retry_after_seconds !== undefined ? [entry.retry_after_seconds] : [])
  return seconds.length ? Math.max(...seconds) : undefined
}
/** What an unknown outcome is about: entries by index (failed with an unknown outcome and unconfirmed), the call, and entries the service never reported. */
function unknownSubject(assessment: ComposioAssessment): string {
  const indices = [...new Set([
    ...assessment.failed.flatMap(entry => entry.kind === 'uncertain_completion' && entry.index !== undefined ? [entry.index] : []),
    ...assessment.unconfirmed.map(entry => entry.index),
  ])].sort((a, b) => a - b)
  const missing = assessment.counts.unreported - assessment.unconfirmed.length
  const parts: string[] = []
  if (indices.length) parts.push(`${indices.length === 1 ? 'entry' : 'entries'} ${indices.join(', ')}`)
  else if (assessment.failed.some(entry => entry.kind === 'uncertain_completion' && entry.index === undefined)) parts.push('the call')
  if (missing > 0) parts.push(`${missing} unreported entr${missing === 1 ? 'y' : 'ies'}`)
  return parts.join(' and ') || 'the call'
}
/**
 * One recovery sentence per kind present; each says what not to do before what to do, and names only the entries it applies
 * to, so that no entry that succeeded or whose outcome is unknown is ever offered for a retry.
 */
function recoveryFor(kind: ComposioFailureKind, assessment: ComposioAssessment): string {
  const scope = scopeOf(assessment, kind)
  const mixed = assessment.counts.succeeded > 0 || assessment.kinds.length > 1
  switch (kind) {
    case 'connection_required':
      return 'Do not retry and do not reconnect or re-authorize yourself. Tell the person which app needs its Composio connection (re)authorized, ask them to do it, and report this ticket blocked with that single action until they confirm.'
    case 'uncertain_completion': {
      const wait = waitFor(assessment, kind)
      return `The outcome of ${unknownSubject(assessment)} is unknown (it may already have run): do NOT resend it, whatever a rate limit or Retry-After in the message says. Check the external state with a read-only lookup${wait !== undefined ? ` (not before ${wait} seconds, the service's Retry-After, a wait floor only, not evidence about whether it ran)` : ''}, or ask the person to check, and let a person decide before anything is repeated.`
    }
    case 'rate_limited': {
      const wait = waitFor(assessment, kind)
      return wait !== undefined
        ? `Wait at least ${wait} seconds (the service's Retry-After), then retry ${scope} once, only after that wait; the service reported a rate limit for it. Never include an entry that succeeded or whose outcome is unknown; do not loop.`
        : `The service gave no Retry-After: wait before retrying ${scope} once, which the service reported as rate-limited. Never include an entry that succeeded or whose outcome is unknown; do not loop. If it repeats, report the limit to the person.`
    }
    case 'action_failed':
      return `${scope === 'the call' ? 'The action' : `The ${scope === 'the entries of this kind' ? 'failed entries' : scope}`} ran and reported failure: read the error and correct the input or the target before retrying ${scope === 'the call' ? 'it' : 'only that'}${mixed ? '; never an entry that succeeded or whose outcome is unknown' : ''}.`
    case 'transport_failure':
      return 'The call did not return a usable result and may or may not have run. Do not resend a side-effecting action blindly: verify its effect first (read-only lookup or ask the person); only a read-only call is safe to repeat.'
  }
}

/** The error content a failed Composio call is given: a headline, the recovery, and JSON with the kept successes and diagnostics. */
export function composioFeedback(assessment: ComposioAssessment): string {
  const recovery = assessment.kinds.map(kind => recoveryFor(kind, assessment))
  if (assessment.succeeded.length) recovery.push(`Entries already in "succeeded" took effect: never repeat them and keep their results.`)
  const headline = assessment.completion === 'partial'
    ? `Composio batch partially failed: ${assessment.counts.succeeded} succeeded, ${assessment.counts.failed}${assessment.counts.unreported ? ` failed and ${assessment.counts.unreported} unreported` : ' failed'}; ${HEADLINE[assessment.kind]}.`
    : `Composio call failed: ${HEADLINE[assessment.kind]}.`
  return `${headline}\n${JSON.stringify({ composio_failure: {
    tool: assessment.tool, classification: assessment.kind, completion: assessment.completion,
    ...(assessment.retryAfterSeconds !== undefined ? { retry_after_seconds: assessment.retryAfterSeconds } : {}),
    counts: assessment.counts, recovery, failed: assessment.failed, ...(assessment.unconfirmed.length ? { unconfirmed: assessment.unconfirmed } : {}), succeeded: assessment.succeeded } })}`
}

/**
 * Registers the Composio classification on one agent's `tools/post-execute`. A result of any other tool, a success, an
 * unknown payload, and a result that something else already blocked pass unchanged; so does any result this cannot read.
 */
export function installComposioBoundary(agent: { ctx: Context }): () => void {
  return agent.ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!isComposioTool(exec.name) || decision.kind !== 'accept') return decision
    try {
      const content = decision.content ?? result.content
      const value = decision.value !== undefined ? decision.value : result.isError ? undefined : result.value
      const assessment = assessComposioResult(exec.name, { content: content as ToolResult['content'], isError: result.isError, value,
        ...(result.isError ? { error: result.error } : {}) })
      if (!assessment) return decision
      // A block drops the contexts the tool deferred, so they are carried over with the decision's own.
      const additionalContexts = [...(result.additionalContexts ?? []), ...(decision.additionalContexts ?? [])]
      return { kind: 'block', feedback: [{ type: 'text', text: composioFeedback(assessment) }],
        ...(additionalContexts.length ? { additionalContexts } : {}) }
    } catch { return decision }
  })
}
