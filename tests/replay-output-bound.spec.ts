/** The documented replay script on corpora with nothing to bound: it must report zeros, not abort after measuring. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A recorded-Session file: one assistant tool call and its text result per entry. */
function session(results: { name?: string; text: string; isError?: boolean }[]) {
  const dir = mkdtempSync(join(tmpdir(), 'replay-spec-')); dirs.push(dir)
  const lines = results.flatMap((result, i) => [
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: `c${i}`, name: result.name ?? 'bash' }] } } },
    { type: 'tool/result', data: { message: { toolCallId: `c${i}`, isError: Boolean(result.isError), content: [{ type: 'text', text: result.text }] } } },
  ])
  const path = join(dir, 's.jsonl')
  writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  return path
}

function replay(...args: string[]) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/replay-output-bound.mjs', ...args], { encoding: 'utf8' })
  return { status: run.status, stderr: run.stderr, report: run.status === 0 ? JSON.parse(run.stdout) : null }
}
const long = (tag: string, count = 500) => Array.from({ length: count }, (_, i) => `${tag} ${i}: ${'x'.repeat(40)}`).join('\n')

it('reports zeros for an empty invocation instead of failing on the missing output directory', () => {
  const { status, stderr, report } = replay()
  expect(stderr).not.toContain('ENOENT')
  expect(status).toBe(0)
  expect(report).toMatchObject({ results: 0, boundedResults: 0, savedFiles: 0, overLimit: 0, errorsAltered: 0, tailLost: 0, retrievalMismatch: 0, savedPct: 0 })
})

it('reports savedFiles 0 for a recorded session whose results are all under the limit', () => {
  const { status, report } = replay(session([{ text: 'short output\n[exit code: 0]' }, { name: 'grep', text: 'a:1: hit' }]))
  expect(status).toBe(0)
  expect(report).toMatchObject({ results: 2, boundedResults: 0, savedFiles: 0, errorsAltered: 0 })
  expect(report.beforeBytes).toBe(report.afterBytes)
})

it('reports savedFiles 0 for a session whose only oversized results are errors, and leaves them whole', () => {
  const failing = `${long('boom')}\n[exit code: 1]`
  const { status, report } = replay(session([{ text: failing, isError: true }, { text: 'tiny error', isError: true }]))
  expect(status).toBe(0)
  expect(report).toMatchObject({ results: 2, boundedResults: 0, savedFiles: 0, errorsAltered: 0, overLimit: 0 })
  // The error text reaches the model whole (wrapped by the runtime), so it is never smaller than the recorded text.
  expect(report.afterBytes).toBeGreaterThanOrEqual(report.beforeBytes)
})

it('still bounds and saves a successful oversized result, keeping the status tail and the retrievable full text', () => {
  const { status, report } = replay(session([{ text: `${long('ok')}\n[exit code: 0]` }]))
  expect(status).toBe(0)
  expect(report).toMatchObject({ results: 1, boundedResults: 1, savedFiles: 1, overLimit: 0, tailLost: 0, retrievalMismatch: 0 })
  expect(report.afterBytes).toBeLessThan(report.beforeBytes)
})

it('the controlled synthetic corpus keeps an oversized error whole (S4) alongside bounded successes', () => {
  const { status, report } = replay('--synthetic')
  expect(status).toBe(0)
  const s4 = report.rows.find((row: { id: string }) => row.id.startsWith('S4-'))
  expect(s4).toMatchObject({ error: true, bounded: false })
  expect(s4.beforeBytes).toBeGreaterThan(4096)
  expect(report).toMatchObject({ errorsAltered: 0, overLimit: 0, tailLost: 0, retrievalMismatch: 0 })
  expect(report.boundedResults).toBeGreaterThan(0)
})
