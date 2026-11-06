/** Narrow, deterministic eligibility for fallback/status-only idle recovery. */
import { latestAssignment, latestReport, type Ticket, type TicketInput } from './model.ts'

export function stallSignal(input: TicketInput): boolean {
  return (input.kind === 'note' || input.kind === 'text') &&
    (/^(?:Your last turn failed[\s\S]*?Fell back to|Fell back to)/i.test(input.text) || /This is a status-only request: do not resume implementation/i.test(input.text))
}
export function stallCandidate(ticket: Ticket): boolean {
  const assignment = latestAssignment(ticket)
  const report = latestReport(ticket)
  return !ticket.ended && !ticket.attention && !ticket.delivery &&
    !ticket.follows?.some(follow => follow.thread.startsWith('github:')) &&
    !!assignment && assignment.state === 'running' && !!assignment.idleAt &&
    (!assignment.deliveredAt || assignment.deliveredAt <= assignment.idleAt) && !ticket.undelivered.length &&
    !['ready', 'dropped', 'blocked', 'failed'].includes(report?.state ?? '') &&
    ticket.inputs.some(input => input.at >= assignment.createdAt && stallSignal(input))
}
export function isStallGuardStuck(ticket: Ticket): boolean {
  const guard = ticket.stallGuard
  return !!guard && stallCandidate(ticket) && guard.assignmentId === latestAssignment(ticket)?.id &&
    !!guard.stuckAt && (latestAssignment(ticket)?.report?.state !== 'progress' ||
      (latestAssignment(ticket)?.report?.at ?? '') <= (guard.progressAt ?? guard.wokeAt))
}
