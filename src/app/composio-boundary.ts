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
  CONNECTION_FAILURE_PATTERN, extractErrorMessage, isBatchItemFailed, isRecord, unwrapComposioResult,
  type ComposioBatchData, type ToolResult,
} from './tools/composio.ts'

/** A Composio MCP tool by provenance: `mcp__<server>__<tool>` with `composio` in the server part. Nothing else is touched. */
export const COMPOSIO_TOOL = /^mcp__[A-Za-z0-9_-]*composio[A-Za-z0-9_-]*__/i
export const isComposioTool = (name: string): boolean => COMPOSIO_TOOL.test(name)

export type ComposioFailureKind = 'connection_required' | 'uncertain_completion' | 'rate_limited' | 'action_failed' | 'transport_failure'
/** `failed`: nothing took effect that is known of; `partial`: some entries succeeded; `unknown`: the action may have run. */
export type ComposioCompletion = 'failed' | 'partial' | 'unknown'

export interface ComposioFailedEntry { index?: number; tool_slug?: string; kind: ComposioFailureKind; error: string; retry_after_seconds?: number }
export interface ComposioAssessment {
  tool: string
  kind: ComposioFailureKind
  completion: ComposioCompletion
  /** Seconds the service asked to wait before a retry, the longest asked. */
  retryAfterSeconds?: number
  counts: { total?: number; succeeded: number; failed: number; unreported: number }
  failed: ComposioFailedEntry[]
  /** Successful batch entries exactly as the service returned them. */
  succeeded: unknown[]
  /** Distinct kinds present, most urgent first. */
  kinds: ComposioFailureKind[]
  message: string
}

const PRIORITY: readonly ComposioFailureKind[] = ['connection_required', 'uncertain_completion', 'rate_limited', 'action_failed', 'transport_failure']
const RATE_LIMIT = /rate[\s_-]?limit|too many requests|\b429\b|throttl|quota (?:exceeded|exhausted)|RATE_LIMIT/i
const UNCERTAIN = /time[sd]?[\s_-]?out|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EPIPE|socket hang up|deadline exceeded|\b50[234]\b|gateway|bad gateway|aborted|connection (?:closed|reset|lost)|stream (?:closed|ended)|no response|did not respond|not acknowledged|acknowledg|upstream|-32001|-32000/i
const CONNECTION_CODES = new Set(['NO_ACTIVE_CONNECTION', 'AUTH_REQUIRED', 'UNAUTHORIZED', 'CONNECTION_REQUIRED'])
const DIAGNOSTIC_CHARS = 300

/** Diagnostic text with credentials, authorization headers and secret-looking values replaced, cut to a useful length. */
export function sanitizeDiagnostic(text: string, max = DIAGNOSTIC_CHARS): string {
  let out = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
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
  if (RATE_LIMIT.test(text) || (code !== undefined && RATE_LIMIT.test(code))) return 'rate_limited'
  if (UNCERTAIN.test(text) || (code !== undefined && UNCERTAIN.test(code))) return 'uncertain_completion'
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

/** The envelope(s) of a result, structured content first: a tool value shaped like an MCP result, JSON text blocks, structuredContent. */
function payloadsOf(result: ToolResult & { value?: unknown }): Record<string, unknown>[] {
  const found: unknown[] = []
  const value = result.value
  if (isRecord(value)) {
    if (value.structuredContent !== undefined) found.push(value.structuredContent)
    if (Array.isArray(value.content)) for (const block of value.content as ToolResult['content'] & unknown[]) found.push(parse(block?.text))
    if ('successful' in value || 'results' in value || isRecord(value.data)) found.push(value)
  }
  if (result.structuredContent !== undefined) found.push(result.structuredContent)
  for (const block of Array.isArray(result.content) ? result.content : []) if (block?.type === 'text') found.push(parse(block.text))
  return found.filter(isRecord)
}
function parse(text: unknown): unknown {
  if (typeof text !== 'string') return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

/**
 * Classifies one Composio tool result, or `undefined` when it is not a failure: not a Composio tool, a success, or a payload
 * that does not carry Composio's own failure markers (business data is never judged by its words).
 */
export function assessComposioResult(name: string, result: ToolResult & { value?: unknown; error?: { message?: string } }): ComposioAssessment | undefined {
  if (!isComposioTool(name)) return undefined
  const text = textOf(result)
  const transport = result.isError === true
  const unwrapped = unwrapComposioResult({ ...result, ...(isRecord(result.value) && result.value.structuredContent !== undefined && result.structuredContent === undefined ? { structuredContent: result.value.structuredContent } : {}) })
  const payloads = payloadsOf(result)
  const batchPayload = payloads.find(item => batchOf(item))
  const batch = batchPayload ? batchOf(batchPayload) : undefined
  const failed: ComposioFailedEntry[] = [], succeeded: unknown[] = []
  let unreported = 0, total: number | undefined

  if (batch && batchPayload && !transport) {
    const entries = batch.results!
    total = typeof batch.total_count === 'number' ? batch.total_count : typeof batchPayload.total_count === 'number' ? batchPayload.total_count : undefined
    entries.forEach((item, position) => {
      if (!isRecord(item)) return
      if (!isBatchItemFailed(item)) { succeeded.push(item); return }
      const message = errorTextOf(item)
      const response = isRecord(item.response) ? item.response : undefined
      const kind = kindOf(message, response ?? item)
      const retry = retryAfterSeconds(response, item, message)
      failed.push({ index: typeof item.index === 'number' ? item.index : position, ...(typeof item.tool_slug === 'string' ? { tool_slug: item.tool_slug } : {}),
        kind, error: sanitizeDiagnostic(message), ...(retry !== undefined && kind === 'rate_limited' ? { retry_after_seconds: retry } : {}) })
    })
    // Entries the service counted but never reported: their outcome is unknown.
    if (total !== undefined && total > entries.length) unreported = total - entries.length
    const declaredErrors = typeof batch.error_count === 'number' ? batch.error_count : typeof batchPayload.error_count === 'number' ? batchPayload.error_count : 0
    if (!failed.length && !unreported && (declaredErrors > 0 || batchPayload.successful === false)) {
      const message = errorTextOf(batchPayload)
      failed.push({ kind: kindOf(message, batchPayload), error: sanitizeDiagnostic(message) })
    }
  } else if (transport || unwrapped.isError) {
    // A protocol/transport failure, or a single action whose own envelope says it failed.
    const envelope = payloads.find(item => item.successful === false) ?? payloads[0]
    const message = transport && !envelope
      ? (text || result.error?.message || 'The Composio tool call failed')
      : errorTextOf(envelope ?? {}) !== 'The action reported a failure without a message' ? errorTextOf(envelope!) : (text || 'The action reported a failure without a message')
    const kind = unwrapped.connectionError ? 'connection_required' : kindOf(message, envelope, transport)
    failed.push({ kind, error: sanitizeDiagnostic(message), ...(kind === 'rate_limited' ? optionalRetry(retryAfterSeconds(envelope, message)) : {}) })
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
    failed, succeeded,
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
/** One recovery sentence per kind present; each says what not to do before what to do. */
function recoveryFor(kind: ComposioFailureKind, assessment: ComposioAssessment): string {
  switch (kind) {
    case 'connection_required':
      return 'Do not retry and do not reconnect or re-authorize yourself. Tell the person which app needs its Composio connection (re)authorized, ask them to do it, and report this ticket blocked with that single action until they confirm.'
    case 'uncertain_completion':
      return 'The action may already have run: do NOT resend it. Check the external state with a read-only lookup, or ask the person to check, and let a person decide before anything is repeated.'
    case 'rate_limited':
      return assessment.retryAfterSeconds !== undefined
        ? `Wait at least ${assessment.retryAfterSeconds} seconds (the service's Retry-After) before retrying only the failed entries, once; do not loop.`
        : 'The service gave no Retry-After: wait before retrying only the failed entries, once, and do not loop. If it repeats, report the limit to the person.'
    case 'action_failed':
      return 'The action ran and reported failure: read the error, correct the input or the target, and retry only the failed entries.'
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
    counts: assessment.counts, recovery, failed: assessment.failed, succeeded: assessment.succeeded } })}`
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
