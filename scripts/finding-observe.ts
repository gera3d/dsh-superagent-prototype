/** Observation-only bootstrap for external coordinators. Never sends local approval headers or actions. */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { FindingIntakeSchema, type FindingIntake } from '../src/app/finding.ts'

export function observationBase(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Use an explicit plain HTTP loopback origin without credentials, path, query or fragment')
  return url
}
export async function observeFinding(base: string, input?: FindingIntake): Promise<unknown> {
  const origin = observationBase(base)
  const path = input ? '/orchestrator/api/findings/observe' : '/orchestrator/api/findings'
  const response = await fetch(new URL(path, origin), {
    method: input ? 'POST' : 'GET',
    headers: { 'x-orchestrator-request': '1', ...(input ? { 'content-type': 'application/json' } : {}) },
    ...(input ? { body: JSON.stringify(FindingIntakeSchema.parse(input)) } : {}),
    signal: AbortSignal.timeout(30_000), redirect: 'error',
  })
  const value: unknown = await response.json()
  if (!response.ok) throw new Error(`Observation transport rejected (${response.status}): ${JSON.stringify(value)}`)
  return value
}
export async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Read: finding-observe.ts --url http://127.0.0.1:PORT --list\nObserve only: finding-observe.ts --url http://127.0.0.1:PORT --input observation.json\nNo confirm/review/revisit/evidence/publication commands are supported.')
    return
  }
  if (args[0] !== '--url' || !args[1] || !['--list', '--input'].includes(args[2] ?? '')
    || (args[2] === '--list' ? args.length !== 3 : args.length !== 4)) throw new Error('Use --help; only --list or --input with an explicit --url is allowed')
  const input = args[2] === '--input' ? FindingIntakeSchema.parse(JSON.parse(readFileSync(args[3]!, 'utf8'))) : undefined
  console.log(JSON.stringify(await observeFinding(args[1], input), null, 2))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
