import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { BOUNDED_TOOLS, OUTPUT_BYTES, OUTPUT_DIRECTORY, OUTPUT_LINES, boundOutput, installOutputBound, outputFileName } from '../src/app/tool-output.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'tool-output-')); dirs.push(dir); return dir }
const bytes = (text: string) => Buffer.byteLength(text)

type Handler = (exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<{ kind: string; content?: { type: string; text: string }[] }>
/** The listener the bound registers, called as the tool registry's waterfall would, with `decision` as what later listeners decided. */
function listener(directory: string | undefined) {
  let handler: Handler | undefined
  const dispose = installOutputBound({ ctx: { on: (_event: string, fn: Handler) => { handler = fn; return () => {} } } } as never, () => directory)
  expect(typeof dispose).toBe('function')
  return (name: string, text: string, decision: unknown = { kind: 'accept' }, blocks?: unknown[], isError = false) => handler!({ name, callId: 'call_1:x' },
    { isError, content: blocks ?? [{ type: 'text', text }] }, async () => decision)
}
const numbered = (count: number, width = 20) => Array.from({ length: count }, (_, i) => `line ${i + 1} ${'x'.repeat(width)}`).join('\n')

it('passes output within both limits through byte for byte', () => {
  const text = numbered(OUTPUT_LINES, 10).slice(0, OUTPUT_BYTES)
  expect(text.split('\n').length).toBeLessThanOrEqual(OUTPUT_LINES)
  expect(boundOutput(text, '/f')).toBe(text)
})

it('bounds a long listing to the limits, keeping its first lines, its last lines and a pointer to the full text', () => {
  const text = `${numbered(2000)}\n[exit code: 3]`
  const bounded = boundOutput(text, '/ticket/.tool-output/c-bash.txt')
  expect(bytes(bounded)).toBeLessThanOrEqual(OUTPUT_BYTES)
  expect(bounded.split('\n').length).toBeLessThanOrEqual(OUTPUT_LINES)
  expect(bounded.startsWith('line 1 ')).toBe(true)
  expect(bounded.endsWith('[exit code: 3]')).toBe(true)
  expect(bounded).toContain('line 2000 ')
  expect(bounded).toMatch(/\[output bounded: 2001 lines, \d+ bytes; \d+ lines omitted.*\/ticket\/\.tool-output\/c-bash\.txt\. Read it with offset\/limit or grep it\.\]/)
})

it('bounds a few very long lines by bytes and marks the cut', () => {
  const text = `first\n${'y'.repeat(20_000)}\n${'z'.repeat(20_000)}\n[status: completed, exit code: 0]`
  const bounded = boundOutput(text, '/f')
  expect(bytes(bounded)).toBeLessThanOrEqual(OUTPUT_BYTES)
  expect(bounded).toContain('…')
  expect(bounded.endsWith('[status: completed, exit code: 0]')).toBe(true)
})

it('keeps multi-byte output within the byte limit', () => {
  const bounded = boundOutput(Array.from({ length: 500 }, (_, i) => `行${i} ${'错误'.repeat(60)}`).join('\n'), '/f')
  expect(bytes(bounded)).toBeLessThanOrEqual(OUTPUT_BYTES)
})

it('keeps the host\'s own spill pointer and exit marker when oversized output already carries them', () => {
  const text = `${numbered(900)}\n\n(Omitted 6986 bytes. Full formatted result stored at: /tmp/spill/x-bash.txt. Use read with offset/limit, or grep this path to search within it.)\n[exit code: 1]`
  const bounded = boundOutput(text, '/f')
  expect(bounded).toContain('stored at: /tmp/spill/x-bash.txt')
  expect(bounded.endsWith('[exit code: 1]')).toBe(true)
})

it('saves the complete text and replaces only an oversized bounded tool result', async () => {
  const dir = temp(), run = listener(dir), text = `${numbered(1500)}\n[exit code: 0]`
  const decision = await run('bash', text)
  const [file] = readdirSync(join(dir, OUTPUT_DIRECTORY))
  expect(file).toBe(outputFileName({ callId: 'call_1:x', tool: 'bash' }, text))
  expect(readFileSync(join(dir, OUTPUT_DIRECTORY, file!), 'utf8')).toBe(text)
  expect(decision.kind).toBe('accept')
  expect(decision.content![0]!.text).toContain(join(dir, OUTPUT_DIRECTORY, file!))
  expect(decision.content![0]!.text.endsWith('[exit code: 0]')).toBe(true)
  // Within the limits, other tools, errors decided by a later listener, and non-text blocks all pass untouched.
  expect(await run('bash', 'short\n[exit code: 0]')).toEqual({ kind: 'accept' })
  expect(await run('read', text)).toEqual({ kind: 'accept' })
  expect(await run('skill', text)).toEqual({ kind: 'accept' })
  const blocked = { kind: 'block', feedback: [{ type: 'text', text }] }
  expect(await run('bash', text, blocked)).toBe(blocked)
  const image = [{ type: 'text', text }, { type: 'image', path: '/i.png' }]
  expect(await run('bash', text, { kind: 'accept' }, image)).toEqual({ kind: 'accept' })
  expect(readdirSync(join(dir, OUTPUT_DIRECTORY))).toHaveLength(1)
  // A result that reports an error is never bounded, nor saved.
  expect(await run('bash', text, { kind: 'accept' }, undefined, true)).toEqual({ kind: 'accept' })
  expect(readdirSync(join(dir, OUTPUT_DIRECTORY))).toHaveLength(1)
})

it('bounds the content a later listener already replaced, and keeps what the decision carries', async () => {
  const dir = temp(), run = listener(dir), context = [{ role: 'user' }]
  const decision = await run('job_output', '', { kind: 'accept', content: [{ type: 'text', text: numbered(400) }], additionalContexts: context })
  expect(decision).toMatchObject({ kind: 'accept', additionalContexts: context })
  expect(bytes(decision.content![0]!.text)).toBeLessThanOrEqual(OUTPUT_BYTES)
})

it('leaves the original output visible when the full text cannot be saved or has nowhere to go', async () => {
  const text = numbered(1500)
  expect(await listener(undefined)('bash', text)).toEqual({ kind: 'accept' })
  const file = join(temp(), 'occupied'); await import('node:fs').then(fs => fs.writeFileSync(file, 'x'))
  expect(await listener(file)('bash', text)).toEqual({ kind: 'accept' })
})

it('bounds shell, job and search output only', () => {
  expect([...BOUNDED_TOOLS].sort()).toEqual(['bash', 'glob', 'grep', 'job_list', 'job_output', 'pwsh'])
})

it('keeps the limits and the end of the text for any mix of long lines, wide characters and long pointers', () => {
  let seed = 7
  const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647
  const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)]!
  for (let round = 0; round < 400; round++) {
    const unit = pick(['x', '错', '😀', 'ab '])
    const body = Array.from({ length: pick([2, 60, 99, 100, 101, 400]) }, () => unit.repeat(Math.floor(next() ** 3 * pick([5, 80, 400, 6000]))))
    const status = pick(['[exit code: 0]', '[status: failed, exit code: 137]', `${'x'.repeat(500)} [exit code: 1]`])
    const text = `${body.join('\n')}\n${status}`, pointer = `/${'p'.repeat(pick([10, 200, 900]))}.txt`
    const bounded = boundOutput(text, pointer)
    if (text.split('\n').length <= OUTPUT_LINES && bytes(text) <= OUTPUT_BYTES) { expect(bounded).toBe(text); continue }
    expect(bytes(bounded)).toBeLessThanOrEqual(OUTPUT_BYTES)
    expect(bounded.split('\n').length).toBeLessThanOrEqual(OUTPUT_LINES)
    expect(bounded).toContain(pointer)
    expect(bounded.endsWith(status.slice(-100))).toBe(true)
    expect(bounded).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
  }
})

it('keeps the status that ends one very long last line', () => {
  const bounded = boundOutput(`${numbered(300)}\n${'z'.repeat(9000)} [status: completed, exit code: 4]`, '/f')
  expect(bytes(bounded)).toBeLessThanOrEqual(OUTPUT_BYTES)
  expect(bounded.endsWith('[status: completed, exit code: 4]')).toBe(true)
})

it('keeps the status that ends a text of one line, at and just past the limit', () => {
  const status = '[status: completed, exit code: 137]'
  for (const unit of ['x', '错', '😀']) {
    const exact = unit.repeat(Math.floor((OUTPUT_BYTES - bytes(status)) / bytes(unit))) + status
    expect(bytes(exact)).toBeLessThanOrEqual(OUTPUT_BYTES)
    expect(boundOutput(exact, '/f')).toBe(exact)
    for (const size of [OUTPUT_BYTES + 1, 20000]) {
      const text = unit.repeat(Math.ceil(size / bytes(unit))) + status, bounded = boundOutput(text, '/saved/file.txt')
      expect(text.split('\n')).toHaveLength(1)
      expect(bytes(bounded)).toBeLessThanOrEqual(OUTPUT_BYTES)
      expect(bounded).toContain('Complete text: /saved/file.txt')
      expect(bounded.endsWith(status)).toBe(true)
      expect(bounded).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
    }
  }
})

it('keeps the whole pointer and the status when the pointer is so long the full notice has no room', () => {
  const status = '[exit code: 137]', pointer = `/${'p'.repeat(3900)}.txt`
  for (const text of [`${'x'.repeat(20000)}${status}`, `${numbered(300)}\n${status}`]) {
    const bounded = boundOutput(text, pointer)
    expect(bytes(bounded)).toBeLessThanOrEqual(OUTPUT_BYTES)
    expect(bounded).toContain(`Complete text: ${pointer}`)
    expect(bounded.endsWith(status)).toBe(true)
  }
})
