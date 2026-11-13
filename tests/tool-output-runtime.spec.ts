/** The output bound at the real tool registry's post-execute boundary: installed Cordis Context and ToolRuntime, no mirrored logic. */
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { OUTPUT_BYTES, OUTPUT_DIRECTORY, installOutputBound } from '../src/app/tool-output.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'tool-output-runtime-')); dirs.push(dir); return dir }
const large = (tag: string, count = 500) => Array.from({ length: count }, (_, i) => `${tag}: line ${i}: ${'x'.repeat(35)}`).join('\n')
const bodyOf = (result: { content: { type: string; text?: string }[] }) => result.content.map(block => block.type === 'text' ? block.text : `<${block.type}>`).join('\n')

/** A registry with the bound installed for `agentId` over `directory`, and tools that return what a call asks for. */
function fixture(directory: string | null = temp(), options: { install?: boolean; agentId?: string; tools?: ToolRuntime } = {}) {
  const ctx = new Context()
  ctx.reflect.provide('systemPrompt', { tools: () => () => {} })
  const tools = options.tools ?? new ToolRuntime(ctx)
  if (options.install !== false) installOutputBound({ ctx, id: options.agentId }, () => directory ?? undefined)
  for (const name of ['bash', 'read', 'orchestrator_read']) {
    tools.register(defineTool({ name, description: 'Isolated fixture: returns the text it is given, no actual command',
      parameters: { text: { type: 'string', required: true }, fail: { type: 'boolean' }, image: { type: 'boolean' } },
      output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: value as string },
        ...((args as { image?: boolean }).image ? [{ type: 'image' as const, attachment: 'a' as never }] : [])] },
      execute: async args => { const a = args as { text: string; fail?: boolean }; if (a.fail) throw new Error(a.text); return a.text } }))
  }
  const run = (callId: string, text: string, extra: { name?: string; fail?: boolean; image?: boolean } = {}) => tools.execute({ callId: callId as never,
    name: extra.name ?? 'bash', arguments: { text, fail: extra.fail ?? false, image: extra.image ?? false }, signal: new AbortController().signal })
  const folder = directory ? join(directory, OUTPUT_DIRECTORY) : undefined
  const saved = () => folder && existsSync(folder) ? readdirSync(folder).filter(name => !name.endsWith('.tmp')) : []
  return { directory, folder, run, saved, tools, ctx }
}
/** The path the pointer in a bounded result names. */
const pointerIn = (body: string) => /Complete text: (.+?)\. Read it with offset\/limit or grep it\.\]/.exec(body)![1]!

it('bounds a successful oversized result, keeps its exit marker and saves the complete text byte for byte', async () => {
  const f = fixture(), text = `${large('successful')}\n[exit code: 0]`
  const result = await f.run('call-success', text)
  const body = bodyOf(result)
  expect(result.isError).toBe(false)
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(OUTPUT_BYTES)
  expect(body).toContain('[output bounded:')
  expect(body.endsWith('[exit code: 0]')).toBe(true)
  expect(readFileSync(pointerIn(body), 'utf8')).toBe(text)
})

it('passes an oversized thrown error through whole, still an error, and saves nothing', async () => {
  const f = fixture(), text = `${large('ERROR')}\ncritical terminal diagnostic`
  const result = await f.run('call-error', text, { fail: true })
  expect(result.isError).toBe(true)
  expect(bodyOf(result)).toContain('critical terminal diagnostic')
  expect(bodyOf(result)).not.toContain('[output bounded:')
  expect(bodyOf(result)).toContain(large('ERROR'))
  expect(f.saved()).toEqual([])
})

it('keeps both full outputs of tool calls whose ids differ only in characters a file name cannot hold', async () => {
  const f = fixture(), first = large('FIRST'), second = large('SECOND')
  const one = pointerIn(bodyOf(await f.run('call/a', first))), two = pointerIn(bodyOf(await f.run('call?a', second)))
  expect(one).not.toBe(two)
  expect(readFileSync(one, 'utf8')).toBe(first)
  expect(readFileSync(two, 'utf8')).toBe(second)
  expect(f.saved()).toHaveLength(2)
})

it('never overwrites an earlier pointer when a call id repeats with other output, as after a restart or in another Session sharing the directory', async () => {
  const directory = temp()
  const a = fixture(directory, { agentId: 'worker' }), b = fixture(directory, { agentId: 'worker' }), c = fixture(directory, { agentId: 'subagent' })
  const earlier = pointerIn(bodyOf(await a.run('call_1', large('BEFORE RESTART'))))
  const afterRestart = pointerIn(bodyOf(await b.run('call_1', large('AFTER RESTART'))))
  const subagent = pointerIn(bodyOf(await c.run('call_1', large('BEFORE RESTART'))))
  expect(new Set([earlier, afterRestart, subagent]).size).toBe(3)
  expect(readFileSync(earlier, 'utf8')).toBe(large('BEFORE RESTART'))
  expect(readFileSync(afterRestart, 'utf8')).toBe(large('AFTER RESTART'))
  expect(readFileSync(subagent, 'utf8')).toBe(large('BEFORE RESTART'))
})

it('reuses the one file when the very same call and output are replayed', async () => {
  const f = fixture(), text = large('REPLAY')
  const one = pointerIn(bodyOf(await f.run('call_9', text))), two = pointerIn(bodyOf(await f.run('call_9', text)))
  expect(two).toBe(one)
  expect(f.saved()).toHaveLength(1)
  expect(readFileSync(one, 'utf8')).toBe(text)
})

it('leaves a result as it was and replaces no file when the name holds other content, is a symbolic link or the folder is not a directory', async () => {
  const text = large('SAVE FAILS')
  // The one name the call would take, occupied by other content: found by a first run whose file is then altered.
  const taken = fixture()
  const pointer = pointerIn(bodyOf(await taken.run('call_t', text)))
  writeFileSync(pointer, 'someone else\'s text')
  expect(bodyOf(await taken.run('call_t', text))).toBe(text)
  expect(readFileSync(pointer, 'utf8')).toBe('someone else\'s text')
  // The same name as a symbolic link to a file that must stay as it is.
  const linked = fixture(), victim = join(temp(), 'victim.txt')
  writeFileSync(victim, 'victim')
  const target = pointerIn(bodyOf(await linked.run('call_l', text)))
  rmSync(target); symlinkSync(victim, target)
  expect(bodyOf(await linked.run('call_l', text))).toBe(text)
  expect(readFileSync(victim, 'utf8')).toBe('victim')
  // The output folder is a symbolic link, or a file.
  const outside = temp(), redirected = fixture()
  symlinkSync(outside, redirected.folder!)
  expect(bodyOf(await redirected.run('call_d', text))).toBe(text)
  expect(readdirSync(outside)).toEqual([])
  const blocked = fixture(); mkdirSync(blocked.directory!, { recursive: true }); writeFileSync(blocked.folder!, 'x')
  expect(bodyOf(await blocked.run('call_f', text))).toBe(text)
  // No directory to keep the text in.
  expect(bodyOf(await fixture(null).run('call_n', text))).toBe(text)
})

it('leaves output that cannot be kept exactly as it was', async () => {
  const f = fixture(), text = `${large('LONE')}\n\ud800 broken`
  expect(bodyOf(await f.run('call_s', text))).toBe(text)
  expect(f.saved()).toEqual([])
})

it('bounds only console and search output: reads, orchestration reads, non-text results and short results stay whole', async () => {
  const f = fixture(), text = large('WHOLE')
  expect(bodyOf(await f.run('c1', text, { name: 'read' }))).toBe(text)
  expect(bodyOf(await f.run('c2', text, { name: 'orchestrator_read' }))).toBe(text)
  expect(bodyOf(await f.run('c3', text, { image: true }))).toBe(`${text}\n<image>`)
  expect(bodyOf(await f.run('c4', 'short\n[exit code: 0]'))).toBe('short\n[exit code: 0]')
  expect(f.saved()).toEqual([])
})

it('leaves every result whole where the bound is not installed', async () => {
  const f = fixture(temp(), { install: false }), text = large('NOT INSTALLED')
  expect(bodyOf(await f.run('c1', text))).toBe(text)
  expect(f.saved()).toEqual([])
})

it('leaves a blocked result as the blocking listener made it', async () => {
  const f = fixture(), text = large('BLOCKED')
  f.ctx.on('tools/post-execute', async () => ({ kind: 'block', feedback: [{ type: 'text', text: `blocked: ${text}` }] }))
  const result = await f.run('c1', text)
  expect(result.isError).toBe(true)
  expect(bodyOf(result)).toContain('blocked: ')
  expect(bodyOf(result)).not.toContain('[output bounded:')
  expect(f.saved()).toEqual([])
})

it('keeps the terminal status of a true one-line oversized result, whole and saved byte for byte', async () => {
  const f = fixture()
  for (const [id, marker] of [['single-a', '[exit code: 137]'], ['single-b', '[status: completed, exit code: 4]']] as const) {
    const text = `${'x'.repeat(20000)}${marker}`
    expect(text.split('\n')).toHaveLength(1)
    const result = await f.run(id, text), body = bodyOf(result)
    expect(result.isError).toBe(false)
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(OUTPUT_BYTES)
    expect(body).toContain('[output bounded: 1 lines')
    expect(body.endsWith(marker)).toBe(true)
    expect(readFileSync(pointerIn(body), 'utf8')).toBe(text)
  }
})

it('bounds a successful result saved under a long directory path, with a pointer that opens and the status kept', async () => {
  const root = temp(), deep = join(root, ...Array.from({ length: 3 }, (_, i) => `ticket-directory-${i}-${'d'.repeat(230)}`))
  mkdirSync(deep, { recursive: true })
  const f = fixture(deep), text = `${large('deep')}\n[exit code: 3]`, body = bodyOf(await f.run('call-deep', text))
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(OUTPUT_BYTES)
  expect(body.endsWith('[exit code: 3]')).toBe(true)
  expect(readFileSync(pointerIn(body), 'utf8')).toBe(text)
})

it('leaves the original output whole when the ticket directory path is too long for any file system to hold the saved text', async () => {
  const root = temp(), tooLong = join(root, ...Array.from({ length: 24 }, (_, i) => `d${i}-${'d'.repeat(200)}`)), text = `${large('long-path')}\n[exit code: 9]`
  const f = fixture(tooLong), body = bodyOf(await f.run('call-too-long', text))
  expect(body).toBe(text)
  expect(existsSync(tooLong)).toBe(false)
})
