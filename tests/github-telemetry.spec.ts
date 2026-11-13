import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CliError, Commands, commandError } from '../src/infra/commands.ts'
import { GithubTelemetry, endpointOf, maskEndpoint, quotaHeaders, withCaller } from '../src/infra/github-telemetry.ts'
import { testDeployment } from './fixtures/deployment.ts'

const deployment = testDeployment({ github: { ...testDeployment().github, cli: '/path/agent-gh' } })
const SHA = '0123456789abcdef0123456789abcdef01234567'
const quota = (remaining: number, resource = 'core') => `X-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: ${remaining}\r\nX-Ratelimit-Reset: 1794613928\r\nX-Ratelimit-Resource: ${resource}\r\nAuthorization: Bearer ghp_${'a'.repeat(36)}`
const response = (status: string, body: unknown = [], headers = quota(4000)) => `HTTP/2.0 ${status}\r\n${headers}\r\n\r\n${JSON.stringify(body)}`
const failure = (status: number, headers: string, stderr = `gh: failed (HTTP ${status})`) => Object.assign(new Error('x'), { code: 1, stdout: `HTTP/2.0 ${status} X\r\n${headers}\r\n\r\n{"message":"m"}`, stderr })
function setup(now = () => Date.now()) {
  const telemetry = new GithubTelemetry(now)
  const commands = new Commands(() => deployment, {}, new AbortController().signal, telemetry)
  const run = vi.spyOn(commands, 'run')
  return { commands, run, telemetry }
}

describe('endpoint masking', () => {
  it('replaces the repository, numbers, SHAs, refs and file paths and drops the query', () => {
    expect(maskEndpoint('repos/acme/widgets/issues/12/comments?per_page=100&page=2')).toBe('repos/:o/:r/issues/:n/comments')
    expect(maskEndpoint(`repos/acme/widgets/commits/${SHA}/check-runs?per_page=100`)).toBe('repos/:o/:r/commits/:sha/check-runs')
    expect(maskEndpoint('repos/acme/widgets/commits/main/status')).toBe('repos/:o/:r/commits/:x/status')
    expect(maskEndpoint('repos/acme/widgets/contents/src/secret-name.ts')).toBe('repos/:o/:r/contents/:path')
    expect(maskEndpoint('repos/acme/widgets/pulls/comments')).toBe('repos/:o/:r/pulls/comments')
    expect(maskEndpoint('repos/acme/widgets')).toBe('repos/:o/:r')
    expect(maskEndpoint('notifications?all=false&since=2026-11-13T00%3A00%3A00Z')).toBe('notifications')
    expect(maskEndpoint(`repos/acme/widgets/git/ref/heads/${SHA}`)).not.toContain(SHA)
  })
  it('names the method only for writes', () => {
    expect(endpointOf(['api', 'repos/acme/widgets/issues/3/comments', '--method', 'POST', '-f', 'body=hello'])).toBe('POST repos/:o/:r/issues/:n/comments')
    expect(endpointOf(['api', 'repos/acme/widgets/pulls/3', '--method', 'GET'])).toBe('repos/:o/:r/pulls/:n')
    expect(endpointOf(['api', 'repos/acme/widgets/issues/3/comments', '-f', 'body=hello'])).toBe('POST repos/:o/:r/issues/:n/comments')
  })
})

describe('quota headers', () => {
  it('reads only remaining, reset and resource, and only from the header block', () => {
    expect(quotaHeaders(response('200 OK'))).toEqual({ remaining: 4000, reset: 1794613928, resource: 'core' })
    expect(quotaHeaders('HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 1\r\n\r\n{"x-ratelimit-remaining": 2}')).toBeUndefined()
    expect(quotaHeaders(`HTTP/2.0 200 OK\r\n\r\nX-Ratelimit-Remaining: 7\r\nX-Ratelimit-Reset: 1\r\nX-Ratelimit-Resource: core`)).toBeUndefined()
    expect(quotaHeaders(response('200 OK', [], 'X-Ratelimit-Remaining: 9\r\nX-Ratelimit-Reset: 5\r\nX-Ratelimit-Resource: ghp_secret!'))).toBeUndefined()
    expect(quotaHeaders('[]')).toBeUndefined()
  })
})

describe('request counts', () => {
  it('counts each call by caller, masked endpoint and outcome without making any request of its own', async () => {
    const { commands, run, telemetry } = setup()
    run.mockImplementation(async (_program, args) => {
      const path = args[1]!
      if (path.endsWith('/pulls/comments')) throw commandError(Object.assign(new Error('x'), { code: 1, stdout: 'HTTP/2.0 304 Not Modified\r\n\r\n', stderr: 'gh: HTTP 304' }), 'gh')
      return args.includes('--include') ? response('200 OK') : '[]'
    })
    await withCaller('poll-comments', async () => {
      await commands.api('issues/comments?per_page=100', '--include')
      await commands.api('issues/comments?per_page=100', '--include')
      await commands.api('issues/comments?per_page=100&since=2026-11-13', '--include')
    })
    await withCaller('poll-thread', async () => { await commands.api(z.array(z.unknown()), 'issues/12/comments?per_page=100&page=1') })
    await withCaller('poll-comments', async () => { await commands.api('pulls/comments', '--include').catch(() => undefined) })
    await commands.api(z.array(z.unknown()), 'issues/9')
    // One request for each call above, and none added by counting.
    expect(run).toHaveBeenCalledTimes(6)
    const view = telemetry.view()
    expect(view.hour).toMatchObject({ requests: 6, '200': 6 - 1, '304': 1, free: 1, charged: 5 })
    expect(view.callers).toEqual([
      { caller: 'poll-comments', requests: 4, free: 1, limited: 0 },
      { caller: 'other', requests: 1, free: 0, limited: 0 },
      { caller: 'poll-thread', requests: 1, free: 0, limited: 0 }])
    expect(view.endpoints.map(item => item.endpoint)).toEqual(['repos/:o/:r/issues/comments', 'repos/:o/:r/issues/:n', 'repos/:o/:r/issues/:n/comments', 'repos/:o/:r/pulls/comments'])
    expect(view.quota).toMatchObject({ remaining: 4000, reset: 1794613928, resource: 'core' })
  })
  it('counts 304 as free, other 2xx separately, and quota refusals as limited', async () => {
    const { commands, run, telemetry } = setup()
    run.mockResolvedValueOnce(response('201 Created', {}))
    await commands.api('issues/3/comments', '--include', '--method', 'POST')
    run.mockRejectedValueOnce(commandError(Object.assign(new Error('x'), { code: 1, stdout: 'HTTP/2.0 304 Not Modified\r\n\r\n', stderr: 'gh: HTTP 304' }), 'gh'))
    await expect(commands.api('issues?state=all', '--include')).rejects.toMatchObject({ code: 304 })
    run.mockRejectedValueOnce(commandError(failure(403, 'X-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 1794613999\r\nX-Ratelimit-Resource: core', 'gh: API rate limit exceeded (HTTP 403)'), 'gh'))
    await expect(commands.api('issues?state=all', '--include')).rejects.toMatchObject({ rate: { kind: 'primary' } })
    run.mockRejectedValueOnce(commandError(failure(429, 'Retry-After: 30'), 'gh'))
    await expect(commands.api('issues?state=all')).rejects.toMatchObject({ rate: { kind: 'secondary' } })
    run.mockRejectedValueOnce(commandError(failure(404, 'X-Ratelimit-Remaining: 3999\r\nX-Ratelimit-Reset: 1794613998\r\nX-Ratelimit-Resource: core'), 'gh'))
    await expect(commands.api('pulls/77')).rejects.toBeInstanceOf(CliError)
    run.mockRejectedValueOnce(commandError(failure(403, 'X-Ratelimit-Remaining: 4000', 'gh: forbidden (HTTP 403)'), 'gh'))
    await expect(commands.api('pulls/77')).rejects.toBeInstanceOf(CliError)
    const { hour, quota } = telemetry.view()
    expect(hour).toMatchObject({ requests: 6, '2xx': 1, '304': 1, limited: 2, error: 2, free: 1, charged: 5 })
    // The failed 404 carried the newest complete header set.
    expect(quota).toMatchObject({ remaining: 3999, reset: 1794613998 })
  })
  it('counts every page of a paginated call as a request', async () => {
    const { commands, run, telemetry } = setup()
    run.mockResolvedValue(JSON.stringify([[{ id: 1 }], [{ id: 2 }], []]))
    await withCaller('poll-ticket-checks', () => commands.pages(z.object({ id: z.number() }), 'commits/main/statuses?per_page=100'))
    expect(telemetry.view().hour.requests).toBe(3)
  })
  it('leaves other tools and output errors as they were', async () => {
    const { commands, run, telemetry } = setup()
    run.mockResolvedValueOnce('not json')
    await expect(commands.gh(['api', 'repos/acme/widgets'])).rejects.toThrow()
    run.mockResolvedValueOnce('{}')
    await commands.gh(['auth', 'status'])
    expect(telemetry.view().hour.requests).toBe(1)
  })
  it('shares the counters with the commands made for one poll round', () => {
    const { commands, telemetry } = setup()
    expect(commands.withSignal(new AbortController().signal).telemetry).toBe(telemetry)
  })
})

describe('rolling window and daily summary', () => {
  it('keeps one hour in the window and the day totals beyond it', () => {
    let now = Date.parse('2026-11-13T10:00:00Z')
    const telemetry = new GithubTelemetry(() => now)
    telemetry.record({ caller: 'poll-notifications', endpoint: 'notifications', outcome: '200' })
    now += 30 * 60_000
    telemetry.record({ caller: 'poll-thread', endpoint: 'repos/:o/:r/issues/:n', outcome: '304' })
    expect(telemetry.view().hour.requests).toBe(2)
    now += 40 * 60_000
    const view = telemetry.view()
    expect(view.hour.requests).toBe(1)
    expect(view.day).toMatchObject({ date: '2026-11-13', requests: 2 })
  })
  it('lists at most the five busiest callers', () => {
    const telemetry = new GithubTelemetry()
    for (const [index, name] of ['a', 'b', 'c', 'd', 'e', 'f', 'g'].entries()) for (let n = 0; n <= index; n += 1) telemetry.record({ caller: `poll-${name}`, endpoint: 'x', outcome: '200' })
    expect(telemetry.view().callers.map(item => item.caller)).toEqual(['poll-g', 'poll-f', 'poll-e', 'poll-d', 'poll-c'])
    expect(telemetry.view().text).toContain('top callers: poll-g 7, poll-f 6')
  })
  it('survives a restart through the persisted summary, and forgets days past three', () => {
    let now = Date.parse('2026-11-13T10:00:00Z')
    const first = new GithubTelemetry(() => now)
    first.record({ caller: 'poll-notifications', endpoint: 'notifications', outcome: '200', quota: { remaining: 4100, reset: 1794613928, resource: 'core' } })
    first.record({ caller: 'poll-notifications', endpoint: 'notifications', outcome: '304' })
    const stored = JSON.parse(JSON.stringify(first.summary()))
    now += 10 * 60_000
    const second = new GithubTelemetry(() => now)
    second.restore(stored)
    second.record({ caller: 'poll-notifications', endpoint: 'notifications', outcome: '200' })
    const view = second.view()
    expect(view.day).toMatchObject({ requests: 3, '200': 2, '304': 1 })
    expect(view.hour.requests).toBe(1)
    expect(view.quota).toMatchObject({ remaining: 4100, reset: 1794613928 })
    now += 4 * 86_400_000
    second.record({ caller: 'other', endpoint: 'x', outcome: '200' })
    expect(Object.keys(second.summary().days)).toEqual(['2026-11-17'])
  })
  it('ignores a malformed stored summary and keeps its key set bounded', () => {
    const telemetry = new GithubTelemetry()
    telemetry.restore({ days: { 'not a day': {}, '2026-11-13': { 'x|y': { '200': -1 }, 'Bad Caller|z': { '200': 1, '304': 0, '2xx': 0, limited: 0, error: 0 } } }, quota: { core: { remaining: 'x' } } })
    telemetry.restore('garbage')
    expect(telemetry.summary()).toEqual({ days: {}, quota: {} })
    for (let n = 0; n < 500; n += 1) telemetry.record({ caller: 'other', endpoint: `endpoint-${n}`, outcome: '200' })
    expect(Object.keys(Object.values(telemetry.summary().days)[0]!).length).toBeLessThanOrEqual(201)
    expect(telemetry.view().day.requests).toBe(500)
  })
})

describe('what is stored', () => {
  it('holds only counters and the three quota values, never tokens, other headers or bodies', async () => {
    const { commands, run, telemetry } = setup()
    const token = `ghp_${'a'.repeat(36)}`
    run.mockResolvedValue(response('200 OK', { secret: 'body-text', token }))
    await withCaller('poll-notifications', () => commands.api(`issues/5/comments?access_token=${token}`, '--include', '-H', `Authorization: Bearer ${token}`))
    await commands.api(`commits/${SHA}/check-runs`, '--include', '-f', `body=${token}`)
    const stored = JSON.stringify({ summary: telemetry.summary(), view: telemetry.view() })
    for (const forbidden of [token, 'ghp_', 'Bearer', 'Authorization', 'body-text', 'secret', SHA, 'access_token', 'X-Ratelimit-Limit']) expect(stored).not.toContain(forbidden)
    expect(Object.keys(telemetry.summary().quota.core!).sort()).toEqual(['at', 'remaining', 'reset', 'resource'])
  })
})
