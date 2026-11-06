/** Serializable canonical-ticket fence for publication coordinators. Reads never mutate the inbox or ticket. */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Ticket } from '../core/index.ts'
import type { PendingDecisionItem } from '../core/decision.ts'
import { ticketDecisions } from './decision-inbox.ts'
import { publicationConversation } from './lifecycle-publication.ts'
import { PublicationError, type PublicationSnapshot } from './publication.ts'

export interface PublicationTicketFence {
  version: 1
  ticketId: string
  conversationId: string
  decisionId: string
  assignmentId: string
  prNumber: number
  assignmentState: Ticket['assignments'][number]['state']
  assignmentEndedAt?: string
  ticketDigest: string
  mergedTicketDigest: string
  publication?: { id: string; repository: string; headSha: string; patchSha256: string }
}

// Stable across JSON serialization, object-property order and independent SQLite readers.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  return JSON.stringify(value)
}
function digest(ticket: Ticket, mergedPr?: number): string {
  const { updatedAt: _updatedAt, ...copy } = structuredClone(ticket)
  if (mergedPr !== undefined) {
    delete copy.ended
    const assignment = copy.assignments.at(-1)!
    // Separately checked against the only allowed executor-end transition below.
    const { state: _state, endedAt: _endedAt, ...rest } = assignment
    copy.assignments[copy.assignments.length - 1] = rest as typeof assignment
    const follow = copy.follows?.find(f => f.thread === `github:${mergedPr}`)
    if (follow) delete follow.closed
  }
  return createHash('sha256').update(stable(copy)).digest('hex')
}

/** Capture only a currently actionable, canonical done decision, never a caller-invented card. */
export function capturePublicationTicketFence(ticket: Ticket, item: PendingDecisionItem): PublicationTicketFence {
  const canonical = ticketDecisions([ticket]).find(candidate => candidate.id === item.id)
  if (item.status !== 'pending' || item.invalidation || !canonical || canonical.lifecycle?.kind !== 'done'
    || !canonical.lifecycle.prNumber || item.ticketId !== ticket.id
    || publicationConversation(canonical) !== publicationConversation(item)) {
    throw new PublicationError(409, 'Publication ticket is not the current canonical finished-work decision')
  }
  const assignment = ticket.assignments.at(-1)!
  return { version: 1, ticketId: ticket.id, conversationId: publicationConversation(canonical), decisionId: canonical.id,
    assignmentId: assignment.id, prNumber: canonical.lifecycle.prNumber, assignmentState: assignment.state,
    ...(assignment.endedAt ? { assignmentEndedAt: assignment.endedAt } : {}),
    ticketDigest: digest(ticket), mergedTicketDigest: digest(ticket, canonical.lifecycle.prNumber) }
}

/**
 * Accept unchanged canonical work, or ONLY the expected close/end caused by a recorded successful exact-bound merge.
 * New inputs, assignments, reports, idle episodes, mandates, follows and explicit stops always invalidate the fence.
 * The caller must additionally check actual executor/process activity; that fact is not represented by Ticket alone.
 */
export function publicationTicketCurrent(ticket: Ticket | undefined, fence: PublicationTicketFence, p: PublicationSnapshot): boolean {
  try {
    if (!ticket || fence.version !== 1 || ticket.id !== fence.ticketId || p.ticketId !== fence.ticketId
      || p.conversationId !== fence.conversationId || p.prNumber !== fence.prNumber
      || ticket.assignments.at(-1)?.id !== fence.assignmentId) return false
    if (fence.publication && (p.id !== fence.publication.id || p.repository !== fence.publication.repository
      || p.headSha !== fence.publication.headSha || p.patchSha256 !== fence.publication.patchSha256)) return false
    if (digest(ticket) === fence.ticketDigest) {
      return ticketDecisions([ticket]).some(item => item.id === fence.decisionId && publicationConversation(item) === fence.conversationId)
    }
    const merge = p.outcomes.find(o => o.stage === 'merge' && o.status === 'succeeded' && o.operationId === `${p.id}:merge`)
    const closed = ticket.follows?.find(f => f.thread === `github:${fence.prNumber}`)?.closed
    // GitHub merged_at has whole-second precision; compare at that precision only after exact durable merge proof.
    // A closure in any earlier second remains stale, even if less than 1000ms before the local start.
    if (!merge || !closed || closed.outcome !== 'merged' || !Number.isFinite(Date.parse(closed.at))
      || !Number.isFinite(Date.parse(merge.startedAt))
      || Math.floor(Date.parse(closed.at) / 1000) < Math.floor(Date.parse(merge.startedAt) / 1000)) return false
    if (ticket.ended && (ticket.ended.by !== 'executor' || ticket.ended.outcome !== 'merged'
      || ticket.ended.at !== closed.at || ticket.ended.reason !== undefined)) return false
    const assignment = ticket.assignments.at(-1)!
    const unchangedAssignmentState = assignment.state === fence.assignmentState && assignment.endedAt === fence.assignmentEndedAt
    const expectedAssignmentEnd = !!ticket.ended && assignment.state === 'ended' && assignment.endedAt === ticket.ended.at
    if (!unchangedAssignmentState && !expectedAssignmentEnd) return false
    return digest(ticket, fence.prNumber) === fence.mergedTicketDigest
  } catch { return false }
}

function readTicket(databasePath: string, ticketId: string): Ticket | undefined {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const row = db.prepare('SELECT value FROM ticket WHERE id = ?').get(ticketId)
    return row ? JSON.parse(String(row.value)) as Ticket : undefined
  } finally { db.close() }
}

/** External coordinator entry point: captures its fence from the shared authoritative SQLite ticket. */
export function capturePublicationTicket(databasePath: string, p: PublicationSnapshot): PublicationTicketFence {
  const ticket = readTicket(databasePath, p.ticketId)
  const item = ticket && ticketDecisions([ticket]).find(candidate => publicationConversation(candidate) === p.conversationId
    && candidate.lifecycle?.kind === 'done' && candidate.lifecycle.prNumber === p.prNumber)
  if (!ticket || !item) throw new PublicationError(409, 'Publication approval no longer has a canonical finished-work ticket')
  return { ...capturePublicationTicketFence(ticket, item),
    publication: { id: p.id, repository: p.repository, headSha: p.headSha, patchSha256: p.patchSha256 } }
}

/** Missing/unreadable/malformed ticket data fails closed; it never manufactures current authority. */
export function validatePublicationTicket(databasePath: string, p: PublicationSnapshot, fence: PublicationTicketFence): boolean {
  try { return publicationTicketCurrent(readTicket(databasePath, p.ticketId), fence, p) } catch { return false }
}
