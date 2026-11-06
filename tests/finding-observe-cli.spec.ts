import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { main, observationBase, observeFinding } from '../scripts/finding-observe.ts'

afterEach(() => vi.restoreAllMocks())
it('allows only loopback observation origins and rejects action-like CLI arguments', async () => {
  for (const url of ['https://127.0.0.1:3082', 'http://example.com', 'http://user:secret@localhost', 'http://localhost/action', 'http://localhost/?token=x']) expect(() => observationBase(url)).toThrow()
  expect(observationBase('http://127.0.0.1:3082').origin).toBe('http://127.0.0.1:3082')
  await expect(main(['--url', 'http://127.0.0.1:3082', '--confirm', 'fix_now'])).rejects.toThrow('only --list or --input')
})
it('uses real loopback HTTP read/observe only, without spoofed local-operator approval headers', async () => {
  const calls: { path?: string; method?: string; headers: Record<string, unknown>; body: string }[] = []
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    calls.push({ path: req.url, method: req.method, headers: req.headers, body })
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ execution_authorized: false }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback server')
    const base = `http://127.0.0.1:${address.port}`
    await observeFinding(base)
    const input = { dedupKey: 'one', title: 'Verify report', problem: 'Unsupported observation', scope: 'Verify only', owner: 'team', kind: 'verification' as const,
      requirements: ['Record evidence'], repository: 'org/repo', occurrence: { id: 'one', reference: 'issue/171', evidence: 'Observation' } }
    expect(await observeFinding(base, input)).toEqual({ execution_authorized: false })
    expect(calls.map(c => [c.method, c.path])).toEqual([['GET', '/orchestrator/api/findings'], ['POST', '/orchestrator/api/findings/observe']])
    for (const call of calls) {
      expect(call.headers['x-orchestrator-request']).toBe('1')
      expect(call.headers.origin).toBeUndefined(); expect(call.headers['sec-fetch-site']).toBeUndefined()
      expect(call.headers['sec-fetch-dest']).toBeUndefined()
    }
    expect(JSON.parse(calls[1]!.body)).toEqual(input)
    await expect(observeFinding(base, { ...input, actor: 'local-operator' } as never)).rejects.toThrow()
    expect(calls).toHaveLength(2)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
