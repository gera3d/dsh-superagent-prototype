/** The output bound as Sessions installs it: a real worker, a worker's subagent and the main Session, each with the installed ToolRuntime. */
import type { Context } from '@deepseek-ai/cordis'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { OUTPUT_BYTES, OUTPUT_DIRECTORY } from '../src/app/tool-output.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime(undefined, { realTools: () => true }) })
afterEach(async () => { await h.stop() })
const large = (tag: string) => Array.from({ length: 500 }, (_, i) => `${tag}: line ${i}: ${'x'.repeat(35)}`).join('\n')
const bodyOf = (result: { content: { type: string; text?: string }[] }) => result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
const pointerIn = (body: string) => /Complete text: (.+?)\. Read it with offset\/limit or grep it\.\]/.exec(body)![1]!
const runtimeOf = (sessionId: string) => (h.agents.get(sessionId) as unknown as { ctx: Context & { tools: ToolRuntime } }).ctx.tools
const agentOf = (sessionId: string) => h.agents.get(sessionId) as unknown as object
/** Runs the fixture's bash tool in the Session's own registry; each call has an id a file name cannot hold. */
function withBash(sessionId: string, name = 'bash') {
  const tools = runtimeOf(sessionId)
  let n = 0
  return (text: string, fail = false) => tools.execute({ agent: agentOf(sessionId) as never, callId: `call/${++n}` as never, name, arguments: { text, fail }, signal: new AbortController().signal })
}
async function subagent(id: string, parent: string) {
  await (h.controller.create as (options: { sessionId: string }) => Promise<void>)({ sessionId: id })
  const agent = h.agents.get(id)! as unknown as { session: { header: { parentSession?: string } } }
  agent.session.header = { parentSession: parent }
  bindScopeParent(agent, agentOf(parent))
  await (h.runtime as unknown as { ctx: Context }).ctx.parallel('agent/created', { agent } as never)
}

it('bounds a worker\'s oversized bash output into its ticket directory, keeps an error whole and keeps both of two look-alike calls', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const bash = withBash(sessionId), dir = ticket.execution!.directory
  const text = `${large('WORKER')}\n[exit code: 0]`
  const bounded = bodyOf(await bash(text))
  expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(OUTPUT_BYTES)
  expect(bounded.endsWith('[exit code: 0]')).toBe(true)
  expect(pointerIn(bounded).startsWith(join(dir, OUTPUT_DIRECTORY))).toBe(true)
  expect(readFileSync(pointerIn(bounded), 'utf8')).toBe(text)
  const failed = await bash(`${large('ERROR')}\ndiagnostic`, true)
  expect(failed.isError).toBe(true)
  expect(bodyOf(failed)).toContain('diagnostic')
  expect(bodyOf(failed)).not.toContain('[output bounded:')
  expect(readdirSync(join(dir, OUTPUT_DIRECTORY))).toHaveLength(1)
})

it('keeps the outputs of a worker and its subagent apart even when their call ids are the same', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await subagent('child-1', sessionId)
  const worker = withBash(sessionId), child = withBash('child-1')
  // Both are call/1 in the same ticket directory, with other output.
  const one = pointerIn(bodyOf(await worker(large('WORKER')))), two = pointerIn(bodyOf(await child(large('SUBAGENT'))))
  expect(one).not.toBe(two)
  expect(readFileSync(one, 'utf8')).toBe(large('WORKER'))
  expect(readFileSync(two, 'utf8')).toBe(large('SUBAGENT'))
  expect(readdirSync(join(ticket.execution!.directory, OUTPUT_DIRECTORY))).toHaveLength(2)
})

it('leaves the main Session and an ordinary user\'s Session unbounded', async () => {
  const text = large('CONTROL')
  // The main Session may only run a few tools; its registry carries no bound.
  const main = runtimeOf(h.runtime.masterId)
  expect(bodyOf(await main.execute({ agent: agentOf(h.runtime.masterId) as never, callId: 'c1' as never, name: 'job_output', arguments: { text }, signal: new AbortController().signal }))).toBe(text)
  // A Session of a person, which is neither the main Session nor a worker's.
  await (h.controller.create as (options: { sessionId: string }) => Promise<void>)({ sessionId: 'person-1' })
  const person = h.agents.get('person-1')! as unknown as { ctx: Context; session: { header: object } }
  person.session.header = {}
  await (h.runtime as unknown as { ctx: Context }).ctx.parallel('agent/created', { agent: person } as never)
  const bash = withBash('person-1')
  expect(bodyOf(await bash(text))).toBe(text)
})
