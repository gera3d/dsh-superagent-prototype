/**
 * Per-ticket counter of the `gh` calls workers make, written by the `gh` shim and read back for the ticket page and source health.
 * One line per call: `<UTC date>T<hour>\t<subcommand>[\t<masked api endpoint>]`. Arguments, bodies, headers and tokens are never recorded.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const ghCallsDir = (stateDir: string): string => join(stateDir, 'gh-calls')
/** Ticket ids become file names, so the shim and the reader accept only this alphabet. */
export const safeTicketId = (id: string): boolean => /^[A-Za-z0-9_-]+$/.test(id)

export interface GhCalls {
  total: number
  /** Calls per UTC hour (`YYYY-MM-DDTHH`), oldest first. */
  hours: { hour: string; count: number }[]
  /** Calls per subcommand (`pr view`) or masked `api` endpoint (`api repos/:o/:r/issues/:n/comments`), most called first. */
  commands: { name: string; count: number }[]
}

const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2})\t([a-z][a-z -]*)(?:\t(.*))?$/
const parse = (text: string): { hour: string; name: string }[] => text.split('\n').flatMap(line => {
  const match = LINE.exec(line)
  return match ? [{ hour: match[1]!, name: match[3] ? `${match[2]} ${match[3]}` : match[2]! }] : []
})

/** Reads one ticket's counter; a ticket that made no `gh` call, or an unreadable counter, counts as zero. */
export async function readTicketCalls(stateDir: string, ticketId: string): Promise<GhCalls> {
  const text = safeTicketId(ticketId) ? await readFile(join(ghCallsDir(stateDir), ticketId), 'utf8').catch(() => '') : ''
  const hours = new Map<string, number>(), commands = new Map<string, number>()
  const entries = parse(text)
  for (const { hour, name } of entries) { hours.set(hour, (hours.get(hour) ?? 0) + 1); commands.set(name, (commands.get(name) ?? 0) + 1) }
  return {
    total: entries.length,
    hours: [...hours].map(([hour, count]) => ({ hour, count })).sort((a, b) => a.hour.localeCompare(b.hour)),
    commands: [...commands].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  }
}

/** UTC hour key of an instant, in the shim's format. */
export const hourKey = (at: Date): string => at.toISOString().slice(0, 13)

/** Counts every ticket's `gh` calls made during the UTC hour of `at`, skipping counters not touched since that hour began. */
export async function hourlyCalls(stateDir: string, at = new Date()): Promise<{ hour: string; total: number }> {
  const hour = hourKey(at), start = Date.parse(`${hour}:00:00Z`)
  const dir = ghCallsDir(stateDir)
  const names = await readdir(dir).catch(() => [] as string[])
  const counts = await Promise.all(names.map(async name => {
    try {
      if ((await stat(join(dir, name))).mtimeMs < start) return 0
      return parse(await readFile(join(dir, name), 'utf8')).filter(entry => entry.hour === hour).length
    } catch { return 0 }
  }))
  return { hour, total: counts.reduce((sum, count) => sum + count, 0) }
}
