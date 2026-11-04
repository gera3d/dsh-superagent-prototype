import { describe, expect, it } from 'vitest'
import {
  unwrapComposioResult,
  routeComposioError,
  wrapComposioExecutor,
  ComposioConnectionError,
  isComposioConnectionError,
  type ToolResult,
} from '../src/app/tools/composio.ts'
import { transient } from '../src/executor/dsh.ts'

const textResult = (payload: unknown, extra: Partial<ToolResult> = {}): ToolResult => ({
  content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
  ...extra,
})

describe('Composio nested result unwrapper', () => {
  describe('single-action unwrapping', () => {
    it('maps JSON text content successful:false to isError:true', () => {
      const raw = textResult({ successful: false, data: null, error: 'MOCK action failed' })
      expect(raw.isError).toBeUndefined()

      const unwrapped = unwrapComposioResult(raw)
      expect(unwrapped.isError).toBe(true)
      expect(unwrapped.connectionError).toBeUndefined()
    })

    it('maps structuredContent successful:false to isError:true', () => {
      const raw: ToolResult = {
        content: [{ type: 'text', text: 'MOCK structured action failed' }],
        structuredContent: { successful: false, error: 'MOCK action failed' },
      }
      const unwrapped = unwrapComposioResult(raw)
      expect(unwrapped.isError).toBe(true)
      expect(unwrapped.connectionError).toBeUndefined()
    })

    it('preserves isError:false for successful single-action execution in text JSON', () => {
      const raw = textResult({ successful: true, data: { id: 'issue_123' }, error: null })
      const unwrapped = unwrapComposioResult(raw)
      expect(unwrapped.isError).toBe(false)
      expect(unwrapped.connectionError).toBeUndefined()
    })

    it('preserves isError:false for successful single-action execution in structuredContent', () => {
      const raw: ToolResult = {
        content: [{ type: 'text', text: 'Action succeeded' }],
        structuredContent: { successful: true, data: { id: 456 } },
      }
      const unwrapped = unwrapComposioResult(raw)
      expect(unwrapped.isError).toBe(false)
    })
  })

  describe('batch unwrapping and result preservation', () => {
    it('maps batch error_count > 0 to isError:true even when top-level successful is true', () => {
      const raw = textResult({
        successful: true,
        data: {
          results: [
            { tool_slug: 'MOCK_READ', response: { successful: true, data: { kept: true } } },
            { tool_slug: 'MOCK_WRITE', response: { successful: false, error: 'Write failed' } },
          ],
          total_count: 2,
          success_count: 1,
          error_count: 1,
        },
      })
      const unwrapped = unwrapComposioResult(raw)
      expect(unwrapped.isError).toBe(true)
    })

    it('preserves data.results completely for mixed batches', () => {
      const batchPayload = {
        successful: true,
        data: {
          results: [
            { index: 0, tool_slug: 'MOCK_READ', response: { successful: true, data: { kept: true, count: 42 } } },
            { index: 1, tool_slug: 'MOCK_WRITE', response: { successful: false, error: 'Connection refused by peer' } },
          ],
          total_count: 2,
          success_count: 1,
          error_count: 1,
        },
      }
      const raw = textResult(batchPayload)
      const unwrapped = unwrapComposioResult(raw)

      expect(unwrapped.isError).toBe(true)

      // Ensure content text is intact and contains both results
      const firstBlock = unwrapped.content?.[0]
      expect(firstBlock?.text).toBeDefined()
      const parsed = JSON.parse(firstBlock!.text!)
      expect(parsed.data.results).toHaveLength(2)
      expect(parsed.data.results[0]?.response.successful).toBe(true)
      expect(parsed.data.results[0]?.response.data.kept).toBe(true)
      expect(parsed.data.results[0]?.response.data.count).toBe(42)
      expect(parsed.data.results[1]?.response.successful).toBe(false)
      expect(parsed.data.results[1]?.response.error).toBe('Connection refused by peer')
    })

    it('preserves data.results in structuredContent for mixed batches', () => {
      const raw: ToolResult = {
        content: [{ type: 'text', text: 'Mixed batch completed' }],
        structuredContent: {
          results: [
            { tool_slug: 'ACTION_A', successful: true, data: { ok: true } },
            { tool_slug: 'ACTION_B', successful: false, error: 'Failed step' },
          ],
          error_count: 1,
        },
      }
      const unwrapped = unwrapComposioResult(raw)
      expect(unwrapped.isError).toBe(true)
      const sc = unwrapped.structuredContent as { results: Array<{ successful: boolean }> }
      expect(sc.results[0]?.successful).toBe(true)
      expect(sc.results[1]?.successful).toBe(false)
    })

    it('leaves isError:false when batch has zero errors', () => {
      const raw = textResult({
        successful: true,
        data: {
          results: [
            { tool_slug: 'MOCK_READ', response: { successful: true, data: { status: 'ok' } } },
          ],
          total_count: 1,
          success_count: 1,
          error_count: 0,
        },
      })
      const unwrapped = unwrapComposioResult(raw)
      expect(unwrapped.isError).toBe(false)
    })
  })

  describe('auth and connection failure routing', () => {
    it('routes single-action connection failure to distinct non-retryable ComposioConnectionError', () => {
      const raw = textResult({
        successful: false,
        error: 'MOCK connection required',
        data: null,
      })
      const unwrapped = unwrapComposioResult(raw)
      expect(unwrapped.isError).toBe(true)
      expect(unwrapped.connectionError).toBeDefined()
      expect(isComposioConnectionError(unwrapped.connectionError)).toBe(true)
      expect(unwrapped.connectionError?.retryable).toBe(false)
      expect(unwrapped.connectionError?.nonRetryable).toBe(true)
      expect(unwrapped.connectionError?.code).toBe('COMPOSIO_CONNECTION_REQUIRED')
      expect(unwrapped.connectionError?.message).toContain('connection required')

      // Verifies Superagent transient() does not consider it a transient error
      expect(transient(unwrapped.connectionError)).toBe(false)
    })

    it('routes batch item connection failure while preserving data.results', () => {
      const raw = textResult({
        successful: true,
        data: {
          results: [
            { tool_slug: 'GITHUB_READ', response: { successful: true, data: { title: 'Issue 1' } } },
            { tool_slug: 'GITHUB_WRITE', response: { successful: false, error: 'No active connection found for github. Please connect your account.' } },
          ],
          total_count: 2,
          success_count: 1,
          error_count: 1,
        },
      })
      const unwrapped = unwrapComposioResult(raw)
      expect(unwrapped.isError).toBe(true)
      expect(unwrapped.connectionError).toBeDefined()
      expect(unwrapped.connectionError?.toolSlug).toBe('GITHUB_WRITE')
      expect(unwrapped.connectionError?.message).toContain('No active connection found')

      // Diagnostic preservation check
      const firstBlock = unwrapped.content?.[0]
      expect(firstBlock?.text).toBeDefined()
      const parsed = JSON.parse(firstBlock!.text!)
      expect(parsed.data.results[0]?.response.data.title).toBe('Issue 1')
      expect(parsed.data.results[1]?.response.successful).toBe(false)
    })

    it('throws ComposioConnectionError when throwOnConnectionError option is true', () => {
      const raw = textResult({ successful: false, error: 'authorization required' })
      expect(() => unwrapComposioResult(raw, { throwOnConnectionError: true }))
        .toThrow(ComposioConnectionError)
    })

    it('does not throw on ordinary non-connection action failures even with throwOnConnectionError: true', () => {
      const raw = textResult({ successful: false, error: 'Validation failed: field xyz is required' })
      expect(() => unwrapComposioResult(raw, { throwOnConnectionError: true })).not.toThrow()
      const unwrapped = unwrapComposioResult(raw, { throwOnConnectionError: true })
      expect(unwrapped.isError).toBe(true)
      expect(unwrapped.connectionError).toBeUndefined()
    })

    it('routeComposioError throws only on connection failures', () => {
      const connFailure = textResult({ successful: false, error: 'connection required' })
      expect(() => routeComposioError(connFailure)).toThrow(ComposioConnectionError)

      const normalFailure = textResult({ successful: false, error: 'Syntax error' })
      expect(() => routeComposioError(normalFailure)).not.toThrow()

      const success = textResult({ successful: true, data: {} })
      expect(() => routeComposioError(success)).not.toThrow()
    })
  })

  describe('wrapComposioExecutor', () => {
    it('transparently unwraps executor results and sets isError', async () => {
      const mockExecutor = async () => textResult({
        successful: true,
        data: {
          results: [
            { tool_slug: 'TEST_TOOL', response: { successful: false, error: 'MOCK connection required' } },
          ],
          error_count: 1,
        },
      })

      const wrapped = wrapComposioExecutor(mockExecutor)
      const result = await wrapped()

      expect(result.isError).toBe(true)
      expect(result.connectionError).toBeInstanceOf(ComposioConnectionError)
      expect(result.connectionError?.toolSlug).toBe('TEST_TOOL')
    })
  })

  describe('protocol errors and edge cases', () => {
    it('preserves existing isError:true from MCP protocol errors', () => {
      const raw: ToolResult = {
        content: [{ type: 'text', text: 'MCP timeout' }],
        isError: true,
      }
      const unwrapped = unwrapComposioResult(raw)
      expect(unwrapped.isError).toBe(true)
    })

    it('handles non-JSON plain text gracefully', () => {
      const raw: ToolResult = {
        content: [{ type: 'text', text: 'plain non-json text' }],
        isError: false,
      }
      const unwrapped = unwrapComposioResult(raw)
      expect(unwrapped.isError).toBe(false)
    })

    it('handles empty tool results gracefully', () => {
      const unwrapped = unwrapComposioResult({})
      expect(unwrapped.isError).toBe(false)
    })
  })
})
