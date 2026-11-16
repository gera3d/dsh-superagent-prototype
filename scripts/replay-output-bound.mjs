// Replays tool results through the REAL output bound (installOutputBound on an installed ToolRuntime), not the pure helper, and
// reports model-facing bytes before and after, with the sha256 of every input so a run can be reproduced.
// Usage: node scripts/replay-output-bound.mjs [--synthetic] [session.v4.jsonl]...
//   --synthetic  adds a fixed deterministic corpus (ids and hashes printed), needing no recorded Session.
// Recorded sessions (decompress .zstd first: zstd -dc file > out.jsonl) replay each text tool result by its recorded tool name,
// error flag and call id. Bytes/4 is only a token estimate; allowance burn, billing and provider cache effects are NOT derivable.
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BOUNDED_TOOLS, OUTPUT_BYTES, OUTPUT_DIRECTORY, OUTPUT_LINES, installOutputBound } from '../src/app/tool-output.ts'

const sha = data => createHash('sha256').update(data).digest('hex')
const tokens = bytes => Math.round(bytes / 4)
const cases = []   // { corpus, id, tool, text, isError }
const synthetic = (id, tool, lines, width, tail, isError = false) =>
  cases.push({ corpus: 'synthetic', id, tool, isError, text: Array.from({ length: lines }, (_, i) => `${id} line ${i}: ${'x'.repeat(width)}`).join('\n') + (tail ? `\n${tail}` : '') })
if (process.argv.includes('--synthetic')) {
  synthetic('S1-bash-1000-lines', 'bash', 1000, 60, '[exit code: 0]')
  synthetic('S2-bash-failed-long', 'bash', 400, 80, '[exit code: 137]')
  synthetic('S3-grep-300', 'grep', 300, 120)
  synthetic('S4-bash-oversized-error', 'bash', 600, 60, '[exit code: 1]', true)
  synthetic('S5-bash-under-limit', 'bash', 50, 40, '[exit code: 0]')
  synthetic('S6-read-large-never-bounded', 'read', 800, 60)
  synthetic('S7-bash-huge-line-then-status', 'bash', 1, 20000, '[status: completed, exit code: 4]')   // two lines: a huge line, then the status
  cases.push({ corpus: 'synthetic', id: 'S8-bash-true-single-line', tool: 'bash', isError: false, text: `${'x'.repeat(20000)}[exit code: 137]` })   // exactly one line
}
for (const path of process.argv.slice(2).filter(arg => !arg.startsWith('--'))) {
  const calls = new Map(), corpus = `${path}@${sha(readFileSync(path)).slice(0, 12)}`
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    const e = JSON.parse(line), d = e.data
    if (e.type === 'assistant/message') for (const b of d.message.content) if (b.type === 'tool-call') calls.set(b.id, b.name)
    if (e.type !== 'tool/result' || d.message.content.some(b => b.type !== 'text')) continue
    cases.push({ corpus, id: d.message.toolCallId, tool: calls.get(d.message.toolCallId) ?? '?', isError: Boolean(d.message.isError),
      text: d.message.content.map(b => b.text).join('\n') })
  }
}

const directory = mkdtempSync(join(tmpdir(), 'replay-output-bound-'))
const ctx = new Context()
ctx.reflect.provide('systemPrompt', { tools: () => () => {} })
const tools = new ToolRuntime(ctx)
installOutputBound({ ctx, id: 'replay' }, () => directory)
const replayed = new Map()   // call id -> the case the fixture tool returns or throws
for (const name of new Set(cases.map(item => item.tool))) {
  tools.register(defineTool({ name, description: 'Replays a recorded result', parameters: { id: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async args => { const item = replayed.get(args.id); if (item.isError) throw new Error(item.text); return item.text } }))
}
const total = { results: 0, boundedResults: 0, beforeBytes: 0, afterBytes: 0, worstBoundedBytes: 0, overLimit: 0, errorsAltered: 0, tailLost: 0, retrievalMismatch: 0 }
const rows = []
for (const [index, item] of cases.entries()) {
  const callId = `${item.id}#${index}`
  replayed.set(callId, item)
  const result = await tools.execute({ callId, name: item.tool, arguments: { id: callId }, signal: new AbortController().signal })
  const after = result.content.map(b => b.text).join('\n'), before = Buffer.byteLength(item.text), now = Buffer.byteLength(after)
  // An error reaches the model wrapped by the runtime ("Error: ..."), so a result is bounded only when it carries the notice.
  const bounded = after.includes('[output bounded:')
  total.results++; total.beforeBytes += before; total.afterBytes += now
  if (item.isError && (bounded || !result.isError || !after.includes(item.text))) total.errorsAltered++
  if (bounded) {
    total.boundedResults++; total.worstBoundedBytes = Math.max(total.worstBoundedBytes, now)
    if (now > OUTPUT_BYTES || after.split('\n').length > OUTPUT_LINES) total.overLimit++
    if (!after.endsWith(item.text.split('\n').at(-1).slice(-60))) total.tailLost++
    const file = /Complete text: (.+?)(?:\. Read it with|\])/.exec(after)?.[1]
    if (!file || sha(readFileSync(file)) !== sha(item.text)) total.retrievalMismatch++
  }
  rows.push({ corpus: item.corpus, id: item.id, tool: item.tool, error: item.isError, sha256: sha(item.text).slice(0, 16), beforeBytes: before, afterBytes: now, bounded })
}
// The output directory only exists once something was bounded; an empty, all-short or all-error corpus reports 0 saved files.
const saved = join(directory, OUTPUT_DIRECTORY)
const savedFiles = existsSync(saved) ? readdirSync(saved).length : 0
rmSync(directory, { recursive: true, force: true })
console.log(JSON.stringify({ limits: { OUTPUT_LINES, OUTPUT_BYTES, tools: [...BOUNDED_TOOLS] }, ...total, savedFiles,
  beforeTokensApprox: tokens(total.beforeBytes), afterTokensApprox: tokens(total.afterBytes),
  savedPct: total.beforeBytes ? +(100 * (1 - total.afterBytes / total.beforeBytes)).toFixed(1) : 0,
  note: 'bytes/4 estimate of model-facing tool-result text only; excludes quota, cost and cache pricing', rows }, null, 1))
