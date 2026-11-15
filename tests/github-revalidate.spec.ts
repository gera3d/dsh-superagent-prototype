import { afterEach, expect, it, vi } from 'vitest'
import { CliError, Commands, Validators } from '../src/infra/commands.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { readPull } from '../src/sources/github-pull.ts'
import { pullChecks } from '../src/sources/github-read.ts'
import { testDeployment } from './fixtures/deployment.ts'

afterEach(() => vi.restoreAllMocks())

/** A fake GitHub that honours If-None-Match; `counted` holds the requests that would spend primary quota (every one but a 304). */
function fakeGithub() {
  const routes = new Map<string, { version: number; value: unknown; pages?: unknown[]; etag?: boolean }>()
  const seen: { path: string; conditional?: string; paginated: boolean }[] = []
  const counted: string[] = []
  const prefix = 'repos/acme/widgets/'
  vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => {
    const path = args[1]!.slice(prefix.length)
    const header = args.indexOf('-H'), conditional = header < 0 ? undefined : args[header + 1]!.replace('If-None-Match: ', '')
    seen.push({ path, ...conditional ? { conditional } : {}, paginated: args.includes('--paginate') })
    const route = routes.get(path.split('?')[0]! + (path.includes('?') ? '?' + path.split('?')[1] : ''))
    if (!route) throw new CliError('gh: Not Found (HTTP 404)', 404, 1)
    const etag = `"v${route.version}"`
    if (conditional !== undefined && conditional === etag) throw new CliError('gh: HTTP 304', 304, 1)
    counted.push(path)
    if (args.includes('--paginate')) return JSON.stringify(route.pages ?? [route.value])
    const link = route.pages ? 'Link: <https://api.github.com/next>; rel="next"\r\n' : ''
    return `HTTP/2.0 200 OK\r\n${route.etag === false ? '' : `Etag: ${etag}\r\n`}${link}\r\n${JSON.stringify(route.value)}`
  })
  return { routes, seen, counted }
}
const pull = (sha: string) => ({ state: 'open', html_url: 'https://github.com/acme/widgets/pull/9', user: { login: 'agent-bot' }, head: { sha, ref: 'agent/nine', repo: { full_name: 'acme/widgets' } } })
const setup = () => {
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  return { commands, ctx: { commands } as unknown as SourceContext, ...fakeGithub() }
}

it('revalidates an unchanged PR with its ETag and parses the stored body again on 304', async () => {
  const { ctx, routes, seen, counted } = setup()
  routes.set('pulls/9', { version: 1, value: pull('abc') })
  const first = await readPull(ctx, 9)
  const second = await readPull(ctx, 9, new AbortController().signal)
  expect(second).toEqual(first)
  expect(second).not.toBe(first)
  expect(second.head).not.toBe(first.head)
  expect(seen.map(read => read.conditional)).toEqual([undefined, '"v1"'])
  expect(counted).toHaveLength(1)
})

it('returns and stores the new body when the head SHA changed', async () => {
  const { ctx, routes, seen } = setup()
  routes.set('pulls/9', { version: 1, value: pull('abc') })
  await readPull(ctx, 9)
  routes.set('pulls/9', { version: 2, value: pull('def') })
  expect((await readPull(ctx, 9)).head.sha).toBe('def')
  expect((await readPull(ctx, 9)).head.sha).toBe('def')
  expect(seen.map(read => read.conditional)).toEqual([undefined, '"v1"', '"v2"'])
})

it('drops the entry on an error and surfaces it, then reads unconditionally', async () => {
  const { ctx, routes, seen } = setup()
  routes.set('pulls/9', { version: 1, value: pull('abc') })
  await readPull(ctx, 9)
  routes.delete('pulls/9')
  await expect(readPull(ctx, 9)).rejects.toMatchObject({ code: 404 })
  routes.set('pulls/9', { version: 1, value: pull('abc') })
  await readPull(ctx, 9)
  expect(seen.map(read => read.conditional)).toEqual([undefined, '"v1"', undefined])
})

it('drops the entry when the body no longer parses', async () => {
  const { ctx, routes, seen } = setup()
  routes.set('pulls/9', { version: 1, value: pull('abc') })
  await readPull(ctx, 9)
  routes.set('pulls/9', { version: 2, value: { nonsense: true } })
  await expect(readPull(ctx, 9)).rejects.toThrow()
  routes.set('pulls/9', { version: 2, value: pull('def') })
  expect((await readPull(ctx, 9)).head.sha).toBe('def')
  expect(seen.map(read => read.conditional)).toEqual([undefined, '"v1"', undefined])
})

it('never sends the header for a forced fresh read, and never reuses a body without a 304', async () => {
  const { ctx, routes, seen, counted } = setup()
  routes.set('pulls/9', { version: 1, value: pull('abc') })
  await readPull(ctx, 9)
  await readPull(ctx, 9, undefined, { fresh: true })
  expect(seen.map(read => read.conditional)).toEqual([undefined, undefined])
  expect(counted).toHaveLength(2)
  // A response without an ETag is not remembered.
  routes.set('pulls/10', { version: 1, value: pull('abc'), etag: false })
  await readPull(ctx, 10)
  await readPull(ctx, 10)
  expect(seen.slice(2).map(read => read.conditional)).toEqual([undefined, undefined])
})

it('keeps entries bounded, least recently used first', () => {
  const validators = new Validators(2)
  validators.set('a', { etag: '1', body: '{}' })
  validators.set('b', { etag: '2', body: '{}' })
  validators.get('a')
  validators.set('c', 'pages')
  expect(validators.get('b')).toBeUndefined()
  expect(validators.get('a')).toBeDefined()
  expect(validators.size).toBe(2)
})

const checksRoute = 'commits/abc/check-runs?per_page=100', statusesRoute = 'commits/abc/statuses?per_page=100'
const run = (name: string, conclusion: string | null = 'success') => ({ name, status: conclusion ? 'completed' : 'in_progress', conclusion })

it('costs no counted request for an idle PR after the first round, and sees a changed check', async () => {
  const { commands, ctx, routes, counted } = setup()
  routes.set('pulls/9', { version: 1, value: pull('abc') })
  routes.set(checksRoute, { version: 1, value: { check_runs: [run('test', null)] } })
  routes.set(statusesRoute, { version: 1, value: [{ context: 'build', state: 'success' }] })
  const round = async () => { const pr = await readPull(ctx, 9); return pullChecks(commands, pr.head.sha) }
  const first = await round()
  expect(counted).toHaveLength(3)
  for (let index = 0; index < 5; index++) expect(await round()).toEqual(first)
  expect(counted).toHaveLength(3)
  routes.set(checksRoute, { version: 2, value: { check_runs: [run('test', 'failure')] } })
  expect((await round()).checks).toEqual([run('test', 'failure')])
  expect(counted).toHaveLength(4)
})

it('forces fresh check reads without the header', async () => {
  const { commands, routes, seen } = setup()
  routes.set(checksRoute, { version: 1, value: { check_runs: [] } })
  routes.set(statusesRoute, { version: 1, value: [] })
  await pullChecks(commands, 'abc')
  await pullChecks(commands, 'abc', undefined, { fresh: true })
  expect(seen.map(read => read.conditional)).toEqual([undefined, undefined, undefined, undefined])
})

it('reads a multi-page check list normally and never revalidates it', async () => {
  const { commands, routes, seen } = setup()
  routes.set(checksRoute, { version: 1, value: { check_runs: [run('a')] }, pages: [{ check_runs: [run('a')] }, { check_runs: [run('b')] }] })
  routes.set(statusesRoute, { version: 1, value: [] })
  expect((await pullChecks(commands, 'abc')).checks.map(check => check.name)).toEqual(['a', 'b'])
  expect((await pullChecks(commands, 'abc')).checks.map(check => check.name)).toEqual(['a', 'b'])
  const checkReads = seen.filter(read => read.path === checksRoute)
  expect(checkReads.map(read => [read.paginated, read.conditional])).toEqual([[false, undefined], [true, undefined], [true, undefined]])
})

it('does not share entries between separate Commands', async () => {
  const { ctx, routes, seen } = setup()
  routes.set('pulls/9', { version: 1, value: pull('abc') })
  await readPull(ctx, 9)
  const other = new Commands(() => testDeployment(), {}, new AbortController().signal)
  await readPull({ commands: other } as unknown as SourceContext, 9)
  expect(seen.map(read => read.conditional)).toEqual([undefined, undefined])
})
