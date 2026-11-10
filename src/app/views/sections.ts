/** Project sections overview: sections with icons, task progress, base-thread relation and the pending taxonomy proposal. */
import { canRetry, liveTicket, ticketStage } from '../../core/index.ts'
import { SECTION_ICONS, SectionError, progressOf, type Member, type Proposal, type SectionStore, type SectionWithMembers, type TaskInfo,
  type TaskState } from '../sections.ts'
import { newestFirst, snapshot, type ViewHost } from './records.ts'
import { ticketRow } from './tickets.ts'

/** Open tickets listed as unassigned are capped so a large backlog stays readable. */
const UNASSIGNED_LIMIT = 50

export function taskKnown(host: Pick<ViewHost, 'store'>) {
  // The server can confirm tickets; a Session id is checked for shape only because the DSH Session catalog is browser-side.
  return (member: Member) => member.kind === 'session' || host.store.tickets.get(member.id) !== undefined
}
export function ticketInfo(host: Pick<ViewHost, 'store'>, id: string): TaskInfo | undefined {
  const ticket = host.store.tickets.get(id)
  return ticket && { stage: ticketStage(ticket).stage, retryable: canRetry(ticket) }
}

function sectionView(host: ViewHost, view: ReturnType<typeof snapshot>, section: SectionWithMembers) {
  const tasks = section.members.map(member => {
    const ticket = member.kind === 'ticket' ? host.store.tickets.get(member.id) : undefined
    const stage: TaskState['stage'] = ticket ? ticketStage(ticket).stage : 'unknown'
    return { kind: member.kind, id: member.id, stage, ...ticket ? { ticket: ticketRow(view, ticket) } : {} }
  })
  const { icon, ...rest } = section
  return { ...rest, icon: { name: icon, ...SECTION_ICONS[icon] }, tasks, progress: progressOf(tasks) }
}

export function sectionsOverview(host: ViewHost, sections: SectionStore, project: string) {
  if (!project) throw new SectionError(400, 'A project is required')
  const view = snapshot(host)
  const stored = sections.list(project)
  const assigned = new Set(stored.flatMap(section => section.members.filter(member => member.kind === 'ticket').map(member => member.id)))
  const proposal: Proposal | undefined = sections.pending(project)
  const shown = stored.map(section => sectionView(host, view, section))
  const loose = stored.length ? host.store.tickets.open().filter(ticket => liveTicket(ticket) && !assigned.has(ticket.id)).sort(newestFirst) : []
  const all = shown.flatMap(section => section.tasks)
  return {
    project,
    structure: stored.length ? 'approved' as const : proposal ? 'proposed' as const : 'none' as const,
    sections: shown,
    totals: progressOf(all),
    unassigned: { total: loose.length, items: loose.slice(0, UNASSIGNED_LIMIT).map(ticket => ticketRow(view, ticket)) },
    ...proposal ? { proposal } : {},
  }
}
export type SectionsOverviewView = ReturnType<typeof sectionsOverview>
export type SectionView = SectionsOverviewView['sections'][number]
