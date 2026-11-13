/**
 * Nested Composio result unwrapper: inspects tool execution results for embedded action failures,
 * maps nested single-action and batch failures to `isError: true`, preserves partial batch results,
 * and routes auth/connection failures to a distinct non-retryable `ComposioConnectionError`.
 */

export interface McpContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

export interface ToolResult {
  content?: McpContentBlock[]
  structuredContent?: unknown
  isError?: boolean
  [key: string]: unknown
}

export interface ComposioActionResponse {
  successful?: boolean
  data?: unknown
  error?: unknown
  message?: string
  [key: string]: unknown
}

export interface ComposioBatchItem {
  index?: number
  tool_slug?: string
  response?: ComposioActionResponse
  successful?: boolean
  data?: unknown
  error?: unknown
  [key: string]: unknown
}

export interface ComposioBatchData {
  results?: ComposioBatchItem[]
  total_count?: number
  success_count?: number
  error_count?: number
  [key: string]: unknown
}

export interface ComposioPayload {
  successful?: boolean
  data?: ComposioBatchData | unknown
  error?: unknown
  total_count?: number
  success_count?: number
  error_count?: number
  [key: string]: unknown
}

/**
 * Distinct non-retryable error indicating an external application connection or authentication
 * is missing, inactive, expired, or invalid. Callers should trigger connection management
 * (`COMPOSIO_MANAGE_CONNECTIONS`) rather than retrying the action.
 */
export class ComposioConnectionError extends Error {
  readonly retryable = false
  readonly nonRetryable = true
  readonly code = 'COMPOSIO_CONNECTION_REQUIRED'
  readonly toolSlug?: string
  readonly details?: unknown

  constructor(message: string, options?: { toolSlug?: string; details?: unknown; cause?: unknown }) {
    super(message, options?.cause ? { cause: options.cause } : undefined)
    this.name = 'ComposioConnectionError'
    this.toolSlug = options?.toolSlug
    this.details = options?.details
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export function isComposioConnectionError(error: unknown): error is ComposioConnectionError {
  return error instanceof ComposioConnectionError
    || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'COMPOSIO_CONNECTION_REQUIRED')
}

export const CONNECTION_FAILURE_PATTERN = /(?:connection required|no active connection|authorization required|unauthorized|not connected|connect your account|auth(?:entication)? (?:required|failed)|invalid (?:token|api[-_ ]?key)|token expired|connection (?:is )?(?:not active|inactive|expired)|re-?authenticate|NO_ACTIVE_CONNECTION|AUTH_REQUIRED)/i

export interface UnwrapComposioOptions {
  /** If true, throws ComposioConnectionError immediately when an auth/connection failure is detected */
  throwOnConnectionError?: boolean
}

export interface UnwrappedComposioResult extends ToolResult {
  isError: boolean
  connectionError?: ComposioConnectionError
}

export function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

/** A failure report an envelope carries in its `error`: a non-empty string, an object or array (a message, code or details), or a bare `true`. */
function hasErrorValue(error: unknown): boolean {
  if (typeof error === 'string') return error.trim() !== ''
  if (Array.isArray(error)) return error.length > 0
  return isRecord(error) ? Object.keys(error).length > 0 : error === true
}

/** How an envelope or batch entry ended, by what the service itself reported (never by the business data under `data`). */
export type EnvelopeOutcome = 'failed' | 'succeeded' | 'contradictory' | 'unconfirmed'

/**
 * One rule for a single-action envelope and a batch entry alike. `levels` are the objects that may carry the flags: the
 * envelope/entry itself and its `response`. An explicit `successful: false` is a failure; an explicit `successful: true` is a
 * success that outranks an `error` the service attached (a warning or note), so a completed mutation is never relabelled
 * failed. `true` at one level and `false` at another contradict each other: the outcome is unknown and neither is claimed.
 * Without any flag, an `error` the level carries is the service's own failure report; otherwise nothing confirms the outcome.
 * `error: null`, `""` and `false` are no report at all.
 */
export function envelopeOutcome(...levels: unknown[]): EnvelopeOutcome {
  const records = levels.filter(isRecord)
  const said = (value: boolean) => records.some(level => level.successful === value)
  if (said(true) && said(false)) return 'contradictory'
  if (said(false)) return 'failed'
  if (said(true)) return 'succeeded'
  return records.some(level => hasErrorValue(level.error)) ? 'failed' : 'unconfirmed'
}

/** The outcome of one batch entry, by its own flag and its `response`'s. */
export const batchItemOutcome = (item: Record<string, unknown>): EnvelopeOutcome => envelopeOutcome(item, item.response)

/** Whether one batch entry needs failure handling: it reported a failure, or its own flags contradict each other. */
export function isBatchItemFailed(item: Record<string, unknown>): boolean {
  const outcome = batchItemOutcome(item)
  return outcome === 'failed' || outcome === 'contradictory'
}

/**
 * Whether the root of a single-action envelope reports its own failure (or contradicts itself, which is not a success).
 * Composio's envelope is `{ successful, data, error }`: the action's business data lives under `data`, so the root `error`
 * is the service's own report and an `error` inside `data` never counts. See `envelopeOutcome` for the precedence.
 */
export function isEnvelopeFailed(payload: Record<string, unknown>): boolean {
  const outcome = envelopeOutcome(payload, payload.response)
  return outcome === 'failed' || outcome === 'contradictory'
}

function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function extractErrorMessage(err: unknown): string | undefined {
  if (typeof err === 'string') return err
  if (isRecord(err)) {
    if (typeof err.message === 'string') return err.message
    if (typeof err.error === 'string') return err.error
    if (typeof err.msg === 'string') return err.msg
    if (typeof err.description === 'string') return err.description
  }
  return undefined
}

function detectConnectionError(candidate: unknown, toolSlugFallback?: string): ComposioConnectionError | undefined {
  if (!candidate) return undefined
  if (typeof candidate === 'string') {
    if (CONNECTION_FAILURE_PATTERN.test(candidate)) {
      return new ComposioConnectionError(candidate, { toolSlug: toolSlugFallback })
    }
    return undefined
  }
  if (isRecord(candidate)) {
    const errorMsg = extractErrorMessage(candidate.error) ?? extractErrorMessage(candidate.message)
    const slug = (typeof candidate.tool_slug === 'string' ? candidate.tool_slug : toolSlugFallback)

    if (errorMsg && CONNECTION_FAILURE_PATTERN.test(errorMsg)) {
      return new ComposioConnectionError(errorMsg, { toolSlug: slug, details: candidate })
    }

    const code = candidate.code ?? candidate.error_code
    if (typeof code === 'string' && (code === 'NO_ACTIVE_CONNECTION' || code === 'AUTH_REQUIRED' || code === 'UNAUTHORIZED')) {
      const msg = errorMsg ?? `Connection required: ${code}`
      return new ComposioConnectionError(msg, { toolSlug: slug, details: candidate })
    }
  }
  return undefined
}

/**
 * Unwraps a tool result from Composio:
 * 1. Inspects structuredContent and JSON text content blocks.
 * 2. Maps single-action `successful: false` to `isError: true`.
 * 3. Maps batch `error_count > 0` (or individual failed items) to `isError: true`.
 * 4. Preserves `data.results` (and full diagnostic structures) for mixed batches.
 * 5. Identifies auth/connection failures and routes them to a distinct non-retryable `ComposioConnectionError`.
 */
export function unwrapComposioResult<T extends ToolResult>(
  result: T,
  options?: UnwrapComposioOptions,
): T & UnwrappedComposioResult {
  const unwrapped: T & UnwrappedComposioResult = {
    ...result,
    isError: result.isError ?? false,
  }

  const payloads: unknown[] = []
  if (result.structuredContent !== undefined) {
    payloads.push(result.structuredContent)
  }
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        const parsed = parseJsonSafe(block.text)
        if (parsed !== undefined) {
          payloads.push(parsed)
        }
      }
    }
  }

  let hasFailure = unwrapped.isError
  let connectionError: ComposioConnectionError | undefined

  for (const payload of payloads) {
    if (!isRecord(payload)) continue

    const batchData = (isRecord(payload.data) && Array.isArray((payload.data as ComposioBatchData).results))
      ? (payload.data as ComposioBatchData)
      : (Array.isArray((payload as ComposioBatchData).results) ? (payload as ComposioBatchData) : undefined)

    if (batchData && Array.isArray(batchData.results)) {
      const errorCount = typeof batchData.error_count === 'number'
        ? batchData.error_count
        : (typeof (payload as { error_count?: unknown }).error_count === 'number'
            ? (payload as { error_count: number }).error_count
            : undefined)

      let batchHasError = (errorCount !== undefined && errorCount > 0) || isEnvelopeFailed({ ...payload, response: undefined })

      for (const item of batchData.results) {
        if (!isRecord(item)) continue
        const itemResp = isRecord(item.response) ? item.response : undefined
        if (isBatchItemFailed(item)) {
          batchHasError = true
          if (!connectionError) {
            connectionError = detectConnectionError(itemResp, item.tool_slug as string | undefined)
              ?? detectConnectionError(item, item.tool_slug as string | undefined)
          }
        }
      }

      if (batchHasError) {
        hasFailure = true
      }
    } else {
      // Business data is under `data`; an `error` inside it is not the envelope's report (see isEnvelopeFailed).
      const isFailed = isEnvelopeFailed(payload)

      if (isFailed) {
        hasFailure = true
        if (!connectionError) {
          connectionError = detectConnectionError(payload)
            ?? (isRecord(payload.response) ? detectConnectionError(payload.response) : undefined)
        }
      }
    }

    if (!connectionError && hasFailure && payload.error) {
      connectionError = detectConnectionError(payload.error)
    }
  }

  // Raw text is scanned only once a failure is established: a successful business payload (an email, a document) may
  // legitimately contain words such as "unauthorized" and must not be taken for a lost connection.
  if (!connectionError && hasFailure && Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        const found = detectConnectionError(block.text)
        if (found) {
          connectionError = found
          break
        }
      }
    }
  }

  unwrapped.isError = hasFailure
  if (connectionError) {
    unwrapped.connectionError = connectionError
    if (options?.throwOnConnectionError) {
      throw connectionError
    }
  }

  return unwrapped
}

/**
 * If the tool result contains a Composio auth/connection error, throws `ComposioConnectionError`.
 */
export function routeComposioError(result: ToolResult): void {
  const unwrapped = unwrapComposioResult(result)
  if (unwrapped.connectionError) {
    throw unwrapped.connectionError
  }
}

/**
 * Wraps a tool execution callback, automatically applying `unwrapComposioResult`.
 */
export function wrapComposioExecutor<
  Args extends unknown[],
  R extends ToolResult,
>(
  executor: (...args: Args) => Promise<R>,
  options?: UnwrapComposioOptions,
): (...args: Args) => Promise<R & UnwrappedComposioResult> {
  return async (...args: Args): Promise<R & UnwrappedComposioResult> => {
    const raw = await executor(...args)
    return unwrapComposioResult(raw, options) as R & UnwrappedComposioResult
  }
}
