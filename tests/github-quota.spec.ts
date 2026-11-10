import { expect, it } from 'vitest'
import { commandError, cooldownSeconds, rateLimit, CliError } from '../src/infra/commands.ts'

const failure = (headers: string, stderr: string) => Object.assign(new Error('x'), { code: 1, stdout: `${headers}\n\n{"message":"m"}`, stderr })

it('classifies primary exhaustion from remaining 0 and reset', () => {
  const error = commandError(failure('HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: 1794277963', 'gh: API rate limit exceeded (HTTP 403)'), 'gh')
  expect(error).toBeInstanceOf(CliError)
  expect((error as CliError).rate).toEqual({ kind: 'primary', resetAt: 1794277963000 })
  expect(cooldownSeconds({ kind: 'primary', resetAt: 1794277963000 }, 1794277900000, 0)).toBe(63)
})
it('classifies secondary limits from 429 and retry-after, capped and jittered', () => {
  expect(rateLimit('HTTP/2.0 429 Too Many\nRetry-After: 120\n\n{}', 'gh: (HTTP 429)')).toEqual({ kind: 'secondary', retryAfter: 120 })
  expect(rateLimit('HTTP/2.0 403 Forbidden\nRetry-After: 30\n\n{}')).toMatchObject({ kind: 'secondary' })
  expect(cooldownSeconds({ kind: 'secondary', retryAfter: 120 }, 0, 0.5)).toBe(125)
  expect(cooldownSeconds({ kind: 'secondary' }, 0, 0)).toBe(60)
  expect(cooldownSeconds({ kind: 'primary', resetAt: 1e15 }, 0, 1)).toBe(86400)
})
it('does not treat permission, auth, 304 or 5xx failures as quota', () => {
  expect(rateLimit('HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 4000\n\n{}', 'gh: forbidden (HTTP 403)')).toBeUndefined()
  expect(rateLimit('HTTP/2.0 401 Unauthorized\nX-Ratelimit-Remaining: 0\n\n{}')).toBeUndefined()
  expect(rateLimit('HTTP/2.0 502 Bad\n\n{}')).toBeUndefined()
  expect((commandError(failure('HTTP/2.0 304 Not Modified', 'gh: HTTP 304'), 'gh') as CliError).code).toBe(304)
  expect((commandError(failure('HTTP/2.0 304 Not Modified', 'gh: HTTP 304'), 'gh') as CliError).rate).toBeUndefined()
})
