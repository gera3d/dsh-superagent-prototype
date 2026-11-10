// Replays the tool results of recorded worker Sessions through the output bound and reports the model-facing bytes saved.
// Usage: node scripts/replay-output-bound.mjs <session.v4.jsonl>... (decompress .zstd first: zstd -dc file > out.jsonl)
import { readFileSync } from 'node:fs'
import { BOUNDED_TOOLS, boundOutput, OUTPUT_BYTES, OUTPUT_LINES } from '../src/app/tool-output.ts'
const tokens = bytes => Math.round(bytes / 4)
let total = { results: 0, bounded: 0, before: 0, after: 0, boundedBefore: 0, worstAfter: 0, linesOver: 0, tailLost: 0, carriedTokenSteps: 0 }
for (const path of process.argv.slice(2)) {
  const calls = new Map()
  const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const steps = rows.filter(e => e.type === 'assistant/message').length
  let step = 0
  for (const e of rows) {
    const d = e.data
    if (e.type === 'assistant/message') step++
    if (e.type === 'assistant/message') for (const b of d.message.content) if (b.type === 'tool-call') calls.set(b.id, b.name)
    if (e.type !== 'tool/result') continue
    const text = d.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n'), name = calls.get(d.message.toolCallId)
    const size = Buffer.byteLength(text); total.results++; total.before += size
    if (!BOUNDED_TOOLS.has(name) || (text.split('\n').length <= OUTPUT_LINES && size <= OUTPUT_BYTES) || d.message.content.some(b => b.type !== 'text')) { total.after += size; continue }
    const out = boundOutput(text, '/x/.tool-output/c-bash.txt'), after = Buffer.byteLength(out)
    total.bounded++; total.boundedBefore += size; total.after += after; total.worstAfter = Math.max(total.worstAfter, after)
    total.carriedTokenSteps += tokens(size - after) * (steps - step)
    if (out.split('\n').length > OUTPUT_LINES) total.linesOver++
    if (text.split('\n').at(-1).slice(0, 300) !== out.split('\n').at(-1)) total.tailLost++
  }
}
// carriedTokenSteps: tokens removed from a result times the later requests that would have carried it (cache reads or input).
console.log(JSON.stringify({ ...total, beforeTokensApprox: tokens(total.before), afterTokensApprox: tokens(total.after),
  savedPct: +(100 * (1 - total.after / total.before)).toFixed(1) }, null, 1))
