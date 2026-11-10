/**
 * Project sections: operator-approved named groups of a project's existing tasks, each with one fixed icon and an optional
 * base thread (an existing DSH Session). A project is a DSH workspace id; a task is a reference to an existing superagent
 * Ticket (`ticket`) or DSH Session (`session`), so no task, queue or session record is duplicated here.
 *
 * Authority: sections are organizational data only. Nothing in this module starts, stops, retries or messages a task; the
 * steering previews at the bottom report what an existing control would act on and always state `execution_authorized: false`.
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

/** The small fixed icon set (favicon-style glyph on a dark-theme-safe color) from the merged design (sandbox issue #108 / PR #110). */
export const SECTION_ICONS = {
  'door-open': { glyph: '🚪', color: '#38bdf8' },
  zap: { glyph: '⚡', color: '#fbbf24' },
  masks: { glyph: '🎭', color: '#a78bfa' },
  sliders: { glyph: '🎛️', color: '#f472b6' },
  bell: { glyph: '🔔', color: '#34d399' },
  video: { glyph: '🎬', color: '#22d3ee' },
  compass: { glyph: '🗺️', color: '#818cf8' },
  flask: { glyph: '🧪', color: '#a3e635' },
} as const
export type SectionIcon = keyof typeof SECTION_ICONS
export const SECTION_ICON_NAMES = Object.keys(SECTION_ICONS) as [SectionIcon, ...SectionIcon[]]
export const MAX_SECTIONS = 12, MAX_MEMBERS = 500

/** Failure with an HTTP-style status so routes can surface it as a validation (400) or conflict (409) error. */
export class SectionError extends Error { constructor(readonly status: 400 | 404 | 409, message: string) { super(message) } }

const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed')
export const ProjectId = text(400)
export const SessionRef = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/, 'Not a valid session id')
export const MemberSchema = z.object({ kind: z.enum(['ticket', 'session']), id: z.string().trim().min(1).max(200) }).strict()
export type Member = z.infer<typeof MemberSchema>
export const SectionDraftSchema = z.object({
  name: text(60), icon: z.enum(SECTION_ICON_NAMES), goal: z.string().trim().max(500).optional(),
  members: z.array(MemberSchema).max(MAX_MEMBERS).default([]),
}).strict()
export type SectionDraft = z.infer<typeof SectionDraftSchema>
export const ProposalInputSchema = z.object({ project: ProjectId, sections: z.array(SectionDraftSchema).min(1).max(MAX_SECTIONS) }).strict()
export const SectionPatchSchema = z.object({ name: text(60).optional(), icon: z.enum(SECTION_ICON_NAMES).optional(), goal: z.string().trim().max(500).optional() })
  .strict().refine(value => Object.keys(value).length > 0, 'Nothing to update')

/** A section as stored: its identity is the immutable `id`; the name and icon may change without changing membership. */
export interface Section {
  id: string; project: string; position: number; name: string; icon: SectionIcon; goal: string
  baseThread?: string; createdAt: string; updatedAt: string
}
export interface SectionWithMembers extends Section { members: Member[] }
export interface Proposal {
  id: string; project: string; status: 'pending' | 'approved' | 'rejected' | 'superseded'; proposedAt: string
  decidedAt?: string; sections: SectionDraft[]
}
export interface SectionEvent { seq: number; at: string; project: string; kind: string; detail: Record<string, unknown> }

/** Existence check for a referenced task; `ticket` references must resolve to a stored Ticket. */
export type KnownMember = (member: Member) => boolean
const key = (member: Member) => `${member.kind}:${member.id}`
const lower = (name: string) => name.trim().toLowerCase()

export class SectionStore {
  constructor(readonly db: DatabaseSync, private readonly now: () => string = () => new Date().toISOString()) {
    db.exec(`CREATE TABLE IF NOT EXISTS section(id TEXT PRIMARY KEY, project TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS section_project ON section(project, position);
      CREATE TABLE IF NOT EXISTS section_member(project TEXT NOT NULL, kind TEXT NOT NULL, member TEXT NOT NULL, section TEXT NOT NULL,
        PRIMARY KEY(project, kind, member));
      CREATE INDEX IF NOT EXISTS section_member_section ON section_member(section);
      CREATE TABLE IF NOT EXISTS section_proposal(id TEXT PRIMARY KEY, project TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS section_proposal_project ON section_proposal(project);
      CREATE TABLE IF NOT EXISTS section_event(seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, value TEXT NOT NULL);`)
  }

  /** Runs `work` in a savepoint so a failed validation leaves no partial write. */
  private atomic<T>(work: () => T): T {
    const name = `section_${randomUUID().replace(/-/g, '')}`
    this.db.exec(`SAVEPOINT ${name}`)
    try { const value = work(); this.db.exec(`RELEASE ${name}`); return value }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`); throw error }
  }
  private log(project: string, kind: string, detail: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO section_event(project, value) VALUES (?,?)').run(project, JSON.stringify({ at: this.now(), project, kind, detail }))
  }
  events(project: string, limit = 50): SectionEvent[] {
    return this.db.prepare('SELECT seq, value FROM section_event WHERE project=? ORDER BY seq DESC LIMIT ?').all(project, limit)
      .map(row => ({ seq: Number(row.seq), ...JSON.parse(String(row.value)) }) as SectionEvent)
  }

  private sectionRow(id: string): Section | undefined {
    const row = this.db.prepare('SELECT value FROM section WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) as Section : undefined
  }
  get(id: string): Section | undefined { return this.sectionRow(id) }
  list(project: string): SectionWithMembers[] {
    const sections = this.db.prepare('SELECT value FROM section WHERE project=? ORDER BY position, id').all(project).map(row => JSON.parse(String(row.value)) as Section)
    const members = this.db.prepare('SELECT kind, member, section FROM section_member WHERE project=? ORDER BY rowid').all(project)
    return sections.map(section => ({ ...section, members: members.filter(row => row.section === section.id)
      .map(row => ({ kind: String(row.kind) as Member['kind'], id: String(row.member) })) }))
  }
  /** Section holding `member` in `project`, if any. */
  sectionOf(project: string, member: Member): string | undefined {
    const row = this.db.prepare('SELECT section FROM section_member WHERE project=? AND kind=? AND member=?').get(project, member.kind, member.id)
    return row ? String(row.section) : undefined
  }
  pending(project: string): Proposal | undefined {
    return this.db.prepare('SELECT value FROM section_proposal WHERE project=?').all(project).map(row => JSON.parse(String(row.value)) as Proposal)
      .filter(proposal => proposal.status === 'pending').sort((a, b) => b.proposedAt.localeCompare(a.proposedAt))[0]
  }
  proposal(id: string): Proposal | undefined {
    const row = this.db.prepare('SELECT value FROM section_proposal WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) as Proposal : undefined
  }
  private saveProposal(proposal: Proposal): void {
    this.db.prepare('INSERT INTO section_proposal(id, project, value) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(proposal.id, proposal.project, JSON.stringify(proposal))
  }

  private validateMember(member: Member, known: KnownMember): void {
    if (member.kind === 'session' && !SessionRef.safeParse(member.id).success) throw new SectionError(400, `Invalid session id: ${member.id}`)
    if (!known(member)) throw new SectionError(404, `${member.kind === 'ticket' ? 'Ticket' : 'Session'} not found: ${member.id}`)
  }
  private validateDrafts(drafts: SectionDraft[], known: KnownMember): void {
    const names = new Set<string>(), seen = new Set<string>()
    for (const draft of drafts) {
      if (names.has(lower(draft.name))) throw new SectionError(409, `Duplicate section name: ${draft.name}`)
      names.add(lower(draft.name))
      for (const member of draft.members) {
        if (seen.has(key(member))) throw new SectionError(409, `${member.kind} ${member.id} is placed in more than one section`)
        seen.add(key(member))
        this.validateMember(member, known)
      }
    }
  }

  /** Records a taxonomy proposal for one-time operator approval. Changes no section and moves no task. */
  propose(input: z.input<typeof ProposalInputSchema>, known: KnownMember): Proposal {
    const { project, sections } = ProposalInputSchema.parse(input)
    return this.atomic(() => {
      if (this.list(project).length) throw new SectionError(409, 'This project already has an approved section structure')
      this.validateDrafts(sections, known)
      for (const old of this.db.prepare('SELECT value FROM section_proposal WHERE project=?').all(project).map(row => JSON.parse(String(row.value)) as Proposal)) {
        if (old.status === 'pending') this.saveProposal({ ...old, status: 'superseded', decidedAt: this.now() })
      }
      const proposal: Proposal = { id: `prop_${randomUUID().slice(0, 12)}`, project, status: 'pending', proposedAt: this.now(), sections }
      this.saveProposal(proposal)
      this.log(project, 'proposed', { proposal: proposal.id, sections: sections.length })
      return proposal
    })
  }
  /** The one-time approval: materializes exactly the pending proposal named by `proposalId`, or fails and changes nothing. */
  approve(project: string, proposalId: string, known: KnownMember): SectionWithMembers[] {
    return this.atomic(() => {
      const proposal = this.proposal(proposalId)
      if (!proposal || proposal.project !== project) throw new SectionError(404, 'Proposal not found for this project')
      if (proposal.status !== 'pending') throw new SectionError(409, `Proposal is already ${proposal.status}`)
      if (this.list(project).length) throw new SectionError(409, 'This project already has an approved section structure')
      this.validateDrafts(proposal.sections, known)
      const at = this.now()
      proposal.sections.forEach((draft, position) => {
        const section: Section = { id: `sec_${randomUUID().slice(0, 12)}`, project, position, name: draft.name, icon: draft.icon,
          goal: draft.goal ?? '', createdAt: at, updatedAt: at }
        this.db.prepare('INSERT INTO section(id, project, position, value) VALUES (?,?,?,?)').run(section.id, project, position, JSON.stringify(section))
        for (const member of draft.members) this.db.prepare('INSERT INTO section_member(project, kind, member, section) VALUES (?,?,?,?)').run(project, member.kind, member.id, section.id)
      })
      this.saveProposal({ ...proposal, status: 'approved', decidedAt: at })
      this.log(project, 'approved', { proposal: proposalId, sections: proposal.sections.length })
      return this.list(project)
    })
  }
  reject(project: string, proposalId: string): Proposal {
    return this.atomic(() => {
      const proposal = this.proposal(proposalId)
      if (!proposal || proposal.project !== project) throw new SectionError(404, 'Proposal not found for this project')
      if (proposal.status !== 'pending') throw new SectionError(409, `Proposal is already ${proposal.status}`)
      const rejected: Proposal = { ...proposal, status: 'rejected', decidedAt: this.now() }
      this.saveProposal(rejected)
      this.log(project, 'rejected', { proposal: proposalId })
      return rejected
    })
  }

  private required(id: string): Section {
    const section = this.sectionRow(id)
    if (!section) throw new SectionError(404, 'Section not found')
    return section
  }
  private write(section: Section): void {
    this.db.prepare('UPDATE section SET value=? WHERE id=?').run(JSON.stringify(section), section.id)
  }
  /** Renames, re-icons or re-words a section; its identity and membership are untouched. */
  update(id: string, input: z.input<typeof SectionPatchSchema>): Section {
    const patch = SectionPatchSchema.parse(input)
    return this.atomic(() => {
      const section = this.required(id)
      if (patch.name && this.list(section.project).some(other => other.id !== id && lower(other.name) === lower(patch.name!))) {
        throw new SectionError(409, `Duplicate section name: ${patch.name}`)
      }
      const next: Section = { ...section, ...patch.name ? { name: patch.name } : {}, ...patch.icon ? { icon: patch.icon } : {},
        ...patch.goal !== undefined ? { goal: patch.goal } : {}, updatedAt: this.now() }
      this.write(next)
      this.log(section.project, 'updated', { section: id, fields: Object.keys(patch) })
      return next
    })
  }
  /** Relates a section to an existing DSH Session as its base thread (or clears it). Creates, starts and messages no Session. */
  setBaseThread(id: string, sessionId: string | null): Section {
    return this.atomic(() => {
      const section = this.required(id)
      const next: Section = { ...section, updatedAt: this.now() }
      if (sessionId === null) delete next.baseThread
      else {
        const parsed = SessionRef.safeParse(sessionId)
        if (!parsed.success) throw new SectionError(400, 'Invalid session id')
        const taken = this.list(section.project).find(other => other.id !== id && other.baseThread === sessionId)
        if (taken) throw new SectionError(409, `That session is already the base thread of "${taken.name}"`)
        next.baseThread = sessionId
      }
      this.write(next)
      this.log(section.project, 'base-thread', { section: id, sessionId })
      return next
    })
  }
  /** Moves one task to another section of the same project, or out of every section (`to` is `null`). Idempotent. */
  move(project: string, member: Member, to: string | null, known: KnownMember): SectionWithMembers[] {
    const parsed = MemberSchema.parse(member)
    return this.atomic(() => {
      this.validateMember(parsed, known)
      if (to !== null) {
        const target = this.required(to)
        if (target.project !== project) throw new SectionError(409, 'The target section belongs to another project')
      }
      const from = this.sectionOf(project, parsed)
      if (from === undefined && to === null) return this.list(project)
      if (from !== to) {
        this.db.prepare('DELETE FROM section_member WHERE project=? AND kind=? AND member=?').run(project, parsed.kind, parsed.id)
        if (to !== null) {
          const count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM section_member WHERE section=?').get(to)?.n ?? 0)
          if (count >= MAX_MEMBERS) throw new SectionError(409, 'The section is full')
          this.db.prepare('INSERT INTO section_member(project, kind, member, section) VALUES (?,?,?,?)').run(project, parsed.kind, parsed.id, to)
        }
        this.log(project, 'moved', { member: parsed, from: from ?? null, to })
      }
      return this.list(project)
    })
  }
}

/** Progress buckets for the overview; `unknown` counts tasks whose record cannot be resolved (for example a Session not listed). */
export interface TaskState { stage: 'working' | 'person' | 'idle' | 'ended' | 'unknown' }
export interface SectionProgress { total: number; working: number; person: number; idle: number; ended: number; unknown: number; percent: number }
export function progressOf(states: readonly TaskState[]): SectionProgress {
  const count = (stage: TaskState['stage']) => states.filter(state => state.stage === stage).length
  const total = states.length, ended = count('ended')
  return { total, working: count('working'), person: count('person'), idle: count('idle'), ended, unknown: count('unknown'),
    percent: total ? Math.round(ended / total * 100) : 0 }
}

export interface Steering<A extends string> {
  action: A; state: 'preview'; execution_authorized: false; section: string
  /** Why nothing ran, stated plainly for the operator. */
  note: string
}
/** Per-ticket facts a steering preview reports; `retryable` is the existing per-ticket retry control's own eligibility rule. */
export interface TaskInfo { stage: TaskState['stage']; retryable: boolean }
/**
 * "Press forward" is a preview only: it reports which tasks an existing per-ticket control (retry) could act on and which
 * wait for a person. It starts nothing, so it can never run a whole section at once or pass an approval gate.
 */
export function pressForwardPreview(section: SectionWithMembers, info: Map<string, TaskInfo>): Steering<'press-forward'> & {
  retryable: Member[]; waitingOnPerson: Member[]; running: number
} {
  const of = (member: Member) => member.kind === 'ticket' ? info.get(member.id) : undefined
  return { action: 'press-forward', state: 'preview', execution_authorized: false, section: section.id,
    retryable: section.members.filter(member => of(member)?.retryable), waitingOnPerson: section.members.filter(member => of(member)?.stage === 'person'),
    running: section.members.filter(member => of(member)?.stage === 'working').length,
    note: 'Preview only. Advancing a task stays with its own ticket controls and approval gates; no task was started, retried or messaged.' }
}
export const MakeBetterInput = z.object({ instruction: z.string().trim().min(1).max(1000) }).strict()
export function makeBetterPreview(section: SectionWithMembers, instruction: string): Steering<'make-better'> & { instruction: string; targets: Member[] } {
  return { action: 'make-better', state: 'preview', execution_authorized: false, section: section.id, instruction,
    targets: section.members,
    note: 'Preview only. The instruction was not stored or delivered; send it to a task through its own ticket or session so it stays within that task\'s original authority.' }
}
