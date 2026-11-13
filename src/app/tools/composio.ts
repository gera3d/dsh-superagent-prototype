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

/** Whether one batch entry reports its own action failure, by its own flag or an error it carries. */
export function isBatchItemFailed(item: Record<string, unknown>): boolean {
  const response = isRecord(item.response) ? item.response : undefined
  return item.successful === false || response?.successful === false || !!item.error || !!response?.error
}

/** A failure report an envelope carries in its `error`: a non-empty string, or an object (a message, code or details). */
function hasErrorValue(error: unknown): boolean {
  return typeof error === 'string' ? error.trim() !== '' : isRecord(error) && Object.keys(error).length > 0
}

/**
 * Whether the root of a single-action envelope reports its own failure: `successful: false`, or an `error` the envelope
 * carries without saying `successful: true`. Composio's envelope is `{ successful, data, error }`: the action's business
 * data lives under `data`, so the root `error` is the service's own report and an `error` inside `data` never counts.
 * An explicit `successful: true` outranks an `error` string, and `error: null`, `""` or `false` are no report at all.
 */
export function isEnvelopeFailed(payload: Record<string, unknown>): boolean {
  const reports = (envelope: Record<string, unknown>): boolean => envelope.successful === false || (envelope.successful !== true && hasErrorValue(envelope.error))
  return reports(payload) || (isRecord(payload.response) && reports(payload.response))
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
