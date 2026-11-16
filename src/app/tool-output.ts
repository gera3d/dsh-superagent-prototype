/** Bounds oversized shell and search output in a worker's model context while keeping the complete text in a durable file. */
import type { Context } from '@deepseek-ai/cordis'
import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Output past either limit is replaced in the model-facing result; the complete text stays in a file the replacement names. */
export const OUTPUT_LINES = 100, OUTPUT_BYTES = 4096
/** Tools whose text is raw console or search output; file reads, skills and orchestration reads are never bounded here. */
export const BOUNDED_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh', 'job_output', 'job_list', 'grep', 'glob'])
/** Directory in a ticket directory that keeps the complete text of each bounded result. */
export const OUTPUT_DIRECTORY = '.tool-output'
const HEAD_LINES = 30, LINE_CHARS = 300, END_CHARS = 120, HEAD_SHARE = 0.4
const bytes = (text: string) => Buffer.byteLength(text)

/**
 * `line` cut to at most `budget` bytes and `LINE_CHARS` characters, marked when cut, never inside a character. With `end`, the
 * cut keeps the line's last `END_CHARS` characters as well, and gives up its head before any of that end, so a status or exit
 * marker that ends the text survives.
 */
function fit(line: string, budget: number, end = false): string {
  const chars = Array.from(line)
  if (chars.length <= LINE_CHARS && bytes(line) <= budget) return line
  const tail = end ? chars.slice(-END_CHARS) : [], head = chars.slice(0, end ? LINE_CHARS - END_CHARS - 1 : LINE_CHARS)
  const size = () => bytes(head.join('')) + bytes(tail.join('')) + 3
  while (size() > budget && (head.length || tail.length)) { if (head.length > (end ? 0 : tail.length) || !tail.length) head.pop(); else tail.shift() }
  return head.length || tail.length ? `${head.join('')}…${tail.join('')}` : ''
}

/**
 * The fallback for a pointer so long that the full notice leaves no room: the sizes, the whole `file` pointer and as much of the
 * end of `text` as then fits, so the exit code or status marker is kept and the pointer is never cut. When even this exceeds the
 * limits (a file name of several kilobytes), the caller must not use it; `installOutputBound` then leaves the result unchanged.
 */
function compact(text: string, lines: string[], file: string): string {
  const head = `[output bounded: ${lines.length} lines, ${bytes(text)} bytes. Complete text: ${file}]`
  const room = OUTPUT_BYTES - bytes(head) - 2
  // Only the end of the last line, as much as fits: a status marker is read from its start, so it is never cut into by a head.
  const end = Array.from(lines.at(-1)!).slice(-END_CHARS)
  while (end.length && bytes(end.join('')) + 3 > room) end.shift()
  return end.length ? `${head}\n…${end.join('')}` : head
}

/**
 * The first and last lines of `text` that fit the limits, with a notice between them that states what was omitted and where
 * the complete text is. The last lines are always kept, as the exit code, status marker and any earlier truncation notice
 * of the tool end the text; a very long last line, or the only line, keeps its end. `text` within both limits is returned
 * unchanged; the result stays within `OUTPUT_BYTES` bytes and `OUTPUT_LINES` lines unless `file` alone is longer than that,
 * which the caller must check.
 */
export function boundOutput(text: string, file: string): string {
  const lines = text.split('\n')
  if (lines.length <= OUTPUT_LINES && bytes(text) <= OUTPUT_BYTES) return text
  const notice = (omitted: number) => `[output bounded: ${lines.length} lines, ${bytes(text)} bytes; ${omitted} lines omitted, lines over ${LINE_CHARS} characters cut. `
    + `Complete text: ${file}. Read it with offset/limit or grep it.]`
  const build = (room: number): string => {
    // The tail is chosen first, so the last lines (exit code, status marker) are always kept; the head takes what remains.
    // Each line costs its bytes and a newline.
    const head: string[] = [], tail: string[] = []
    let tailUsed = 0, start = lines.length
    // A text of one line has no head: its only line is also its last, so it is cut with its end kept like any last line.
    for (let at = lines.length - 1; at >= (lines.length === 1 ? 0 : 1) && tail.length < OUTPUT_LINES / 2 - 1; at--) {
      const kept = fit(lines[at]!, Math.floor(room * (1 - HEAD_SHARE)) - tailUsed - 1, at === lines.length - 1)
      if (!kept && lines[at]) break
      tail.unshift(kept); tailUsed += bytes(kept) + 1; start = at
    }
    let used = 0
    for (let at = 0; at < start && head.length < HEAD_LINES; at++) {
      const kept = fit(lines[at]!, room - tailUsed - used - 1)
      if (!kept && lines[at]) break
      head.push(kept); used += bytes(kept) + 1
    }
    return [...head, notice(lines.length - head.length - tail.length), ...tail].join('\n')
  }
  // The notice is budgeted at its longest (every line omitted); the check below guards the limits against any miscount.
  let room = OUTPUT_BYTES - bytes(notice(lines.length)) - 2
  for (;;) {
    const result = build(room)
    if (bytes(result) <= OUTPUT_BYTES && result.split('\n').length <= OUTPUT_LINES) return result
    room -= Math.max(16, bytes(result) - OUTPUT_BYTES)
    if (room < 0) return compact(text, lines, file)
  }
}

/** What identifies one tool call across Sessions, subagents, turns, retries and restarts. */
export interface OutputIdentity { agent?: string; callId: string; rootCallId?: string; tool: string }
const digest = (text: string, length: number) => createHash('sha256').update(text).digest('hex').slice(0, length)
const slug = (text: string, length: number) => text.replace(/[^\w-]/g, '_').slice(0, length)

/**
 * The file name a call's complete output is saved under, safe in any file system. It holds a digest of the whole call identity
 * (a JSON encoding, which cannot make two different identities equal) and one of the text, so two calls whose ids only look
 * alike, or one call id reused by another Session, subagent, turn or restart, never share a name unless they hold exactly the
 * same text; a returned pointer therefore names its text for as long as the file exists.
 */
export const outputFileName = (identity: OutputIdentity, text: string): string => {
  const who = digest(JSON.stringify([identity.agent ?? null, identity.rootCallId ?? null, identity.callId, identity.tool]), 20)
  return `${slug(identity.tool, 24)}-${slug(identity.callId, 40)}-${who}-${digest(text, 20)}.txt`
}

/**
 * Saves `text` in `folder` under `name` without ever replacing a file: the text is written completely to a private temporary
 * file, which is then hard-linked to the name, so a reader sees all of the text or no file, and an existing name (or a symbolic
 * link at it) is left alone. A name that already exists is reused only when it is a regular file holding exactly `text`.
 * Resolves to the saved path; rejects when the text cannot be kept exactly.
 */
async function save(folder: string, name: string, text: string): Promise<string> {
  const data = Buffer.from(text, 'utf8')
  // A text that does not survive UTF-8 (a lone surrogate) cannot be kept exactly.
  if (data.toString('utf8') !== text) throw new Error('text is not representable as UTF-8')
  await mkdir(folder, { recursive: true, mode: 0o700 })
  if (!(await lstat(folder)).isDirectory()) throw new Error('output folder is not a directory')
  const file = join(folder, name), temporary = join(folder, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: 'wx' })
    try { await link(temporary, file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!(await lstat(file)).isFile() || !(await readFile(file)).equals(data)) throw new Error('output name is taken by other content')
    }
    return file
  } finally { await unlink(temporary).catch(() => {}) }
}

/**
 * Registers a post-execute listener on one agent that replaces an oversized text result of a `BOUNDED_TOOLS` tool with its
 * bounded form, after saving the complete text under `directory`. A result that is an error (thrown or reported), an error
 * decision, holds anything but text, fits the limits, whose complete text cannot be saved exactly, or whose bounded form would
 * break a limit or lose the pointer is left as it was.
 */
export function installOutputBound(agent: { ctx: Context; id?: string }, directory: () => string | undefined): () => void {
  return agent.ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!BOUNDED_TOOLS.has(exec.name) || result.isError || decision.kind !== 'accept' || decision.value !== undefined) return decision
    const content = decision.content ?? result.content
    if (!content.length || content.some(block => block.type !== 'text')) return decision
    const text = content.map(block => (block as { text: string }).text).join('\n')
    if (text.split('\n').length <= OUTPUT_LINES && bytes(text) <= OUTPUT_BYTES) return decision
    const root = directory()
    if (!root) return decision
    try {
      const identity: OutputIdentity = { agent: exec.agent?.id ?? agent.id, callId: String(exec.callId), tool: exec.name,
        ...(exec.rootCallId === undefined ? {} : { rootCallId: String(exec.rootCallId) }) }
      const file = await save(join(root, OUTPUT_DIRECTORY), outputFileName(identity, text), text)
      const bounded = boundOutput(text, file)
      // A replacement that breaks a limit or lost the pointer (a path of several kilobytes) is worth less than the original text.
      if (bytes(bounded) > OUTPUT_BYTES || bounded.split('\n').length > OUTPUT_LINES || !bounded.includes(`Complete text: ${file}`)) return decision
      return { ...decision, content: [{ type: 'text', text: bounded }] }
    } catch { return decision }
  })
}
