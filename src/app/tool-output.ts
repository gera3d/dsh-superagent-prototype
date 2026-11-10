/** Bounds oversized shell and search output in a worker's model context while keeping the complete text in a durable file. */
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Output past either limit is replaced in the model-facing result; the complete text stays in a file the replacement names. */
export const OUTPUT_LINES = 100, OUTPUT_BYTES = 4096
/** Tools whose text is raw console or search output; file reads, skills and orchestration reads are never bounded here. */
export const BOUNDED_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh', 'job_output', 'job_list', 'grep', 'glob'])
/** Directory in a ticket directory that keeps the complete text of each bounded result. */
export const OUTPUT_DIRECTORY = '.tool-output'
const HEAD_LINES = 30, LINE_CHARS = 300, HEAD_SHARE = 0.4
const bytes = (text: string) => Buffer.byteLength(text)

/** `line` cut to at most `budget` bytes and `LINE_CHARS` characters, marked when cut. */
function fit(line: string, budget: number): string {
  if (line.length <= LINE_CHARS && bytes(line) <= budget) return line
  let cut = line.slice(0, LINE_CHARS)
  while (cut && bytes(cut) + 3 > budget) cut = cut.slice(0, -1)
  return cut ? `${cut}…` : ''
}

/**
 * The first and last lines of `text` that fit the limits, with a notice between them that states what was omitted and where
 * the complete text is. The last lines are always kept, as the exit code, status marker and any earlier truncation notice
 * of the tool end the text. `text` within both limits is returned unchanged.
 */
export function boundOutput(text: string, file: string): string {
  const lines = text.split('\n')
  if (lines.length <= OUTPUT_LINES && bytes(text) <= OUTPUT_BYTES) return text
  const notice = (kept: number) => `[output bounded: ${lines.length} lines, ${bytes(text)} bytes; ${lines.length - kept} lines omitted, lines over ${LINE_CHARS} characters cut. `
    + `Complete text: ${file}. Read it with offset/limit or grep it.]`
  const room = OUTPUT_BYTES - bytes(notice(lines.length)) - 2
  // The tail is chosen first, so the last lines (exit code, status marker) are always kept; the head takes what remains.
  const head: string[] = [], tail: string[] = []
  let tailUsed = 0, start = lines.length
  for (let at = lines.length - 1; at > 0 && tail.length < OUTPUT_LINES / 2 - 1; at--) {
    const kept = fit(lines[at]!, Math.floor(room * (1 - HEAD_SHARE)) - tailUsed - 1)
    if (!kept && lines[at]) break
    tail.unshift(kept); tailUsed += bytes(kept) + 1; start = at
  }
  let used = 0
  for (let at = 0; at < start && head.length < HEAD_LINES; at++) {
    const kept = fit(lines[at]!, room - tailUsed - used - 1)
    if (!kept && lines[at]) break
    head.push(kept); used += bytes(kept) + 1
  }
  return [...head, notice(head.length + tail.length), ...tail].join('\n')
}

/** The file name a call's complete output is saved under: stable per call, and safe in any file system. */
export const outputFileName = (callId: string, tool: string): string => `${callId.replace(/[^\w-]/g, '_')}-${tool.replace(/[^\w-]/g, '_')}.txt`

/**
 * Registers a post-execute listener on one agent that replaces an oversized text result of a `BOUNDED_TOOLS` tool with its
 * bounded form, after saving the complete text under `directory`. A result that is an error decision, holds anything but
 * text, fits the limits, or whose file cannot be written is left as it was.
 */
export function installOutputBound(agent: { ctx: Context }, directory: () => string | undefined): () => void {
  return agent.ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!BOUNDED_TOOLS.has(exec.name) || decision.kind !== 'accept' || decision.value !== undefined) return decision
    const content = decision.content ?? result.content
    if (!content.length || content.some(block => block.type !== 'text')) return decision
    const text = content.map(block => (block as { text: string }).text).join('\n')
    if (text.split('\n').length <= OUTPUT_LINES && bytes(text) <= OUTPUT_BYTES) return decision
    const root = directory()
    if (!root) return decision
    try {
      const folder = join(root, OUTPUT_DIRECTORY), file = join(folder, outputFileName(exec.callId, exec.name))
      await mkdir(folder, { recursive: true, mode: 0o700 })
      await writeFile(file, text, { mode: 0o600 })
      return { ...decision, content: [{ type: 'text', text: boundOutput(text, file) }] }
    } catch { return decision }
  })
}
