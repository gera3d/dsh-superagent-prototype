/** Read-only work currency: source identity and native assignment ownership, never authority. */
import type { DatabaseSync } from 'node:sqlite'
import type { Ticket, Trigger } from '../core/model.ts'
import type { Delivery } from './feature-delivery.ts'

export interface DeliveryWork {
  state: 'owned' | 'awaiting_direction' | 'superseded'
  owner: string
  nextStep: string
  progress?: string
  supersededBy?: string
  replaces?: string[]
}
export interface DeliveryWorkerRecords { tickets: Ticket[]; triggers: Trigger[] }
export function readDeliveryWorkers(db: DatabaseSync): DeliveryWorkerRecords {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)))
  return {
    tickets: tables.has('ticket') ? db.prepare('SELECT value FROM ticket').all().map(row => JSON.parse(String(row.value)) as Ticket) : [],
    triggers: tables.has('trigger') ? db.prepare('SELECT value FROM trigger').all().map(row => JSON.parse(String(row.value)) as Trigger) : [],
  }
}
export const workerTicket = (id: string): string => id.replace(/^worker-/, '')
export function deriveDeliveryWork(deliveries: Delivery[], records: DeliveryWorkerRecords): Map<string, DeliveryWork> {
  const result = new Map<string, DeliveryWork>()
  const triggers = new Map(records.triggers.map(trigger => [trigger.id, trigger]))
  // Only immutable primary source thread identity counts, never a mutable title, follow, or note.
  const source = (ticket: Ticket) => {
    const trigger = triggers.get(ticket.origin.triggerId), thread = trigger?.threads[0]
    return trigger && thread?.source === trigger.source && thread.id ? JSON.stringify([thread.source, thread.id]) : undefined
  }
  const owned = records.tickets.filter(ticket => !ticket.ended && !ticket.attention
    && ticket.assignments.at(-1)?.state === 'running'
    && !['ready', 'blocked', 'failed', 'dropped', 'waiting'].includes(ticket.assignments.at(-1)?.report?.state ?? ''))
  const linked = new Set(deliveries.filter(d => d.stage === 'implementation' && !['accepted', 'cancelled', 'abandoned'].includes(d.state)).flatMap(d => d.workers.map(workerTicket)))
  for (const ticket of owned) {
    if (!linked.has(ticket.id)) continue
    const report = ticket.assignments.at(-1)?.report
    result.set(ticket.id, { state: 'owned', owner: `worker-${ticket.id}`,
      ...(report ? { progress: report.summary } : {}),
      nextStep: 'The assigned worker continues the current implementation and reports its result; no new user confirmation is needed.' })
  }
  // Automatic unbound tracking still owns the ready handoff, not a new implementation run.
  // Restrict to that non-actionable review boundary; bound publication/review actions keep their own currency.
  for (const delivery of deliveries) {
    if (!delivery.scopeBinding || delivery.stage !== 'review' || ['accepted', 'cancelled', 'abandoned'].includes(delivery.state)) continue
    for (const worker of delivery.workers) {
      const ticket = records.tickets.find(t => t.id === workerTicket(worker)), assignment = ticket?.assignments.at(-1)
      if (!ticket || ticket.ended || ticket.attention || assignment?.state !== 'running' || assignment.report?.state !== 'ready') continue
      result.set(ticket.id, { state: 'awaiting_direction', owner: 'user', progress: assignment.report.summary,
        nextStep: 'Implementation reported ready. Choose a Senior Developer next step in the worker conversation to review the artifact and prepare a release candidate, target and acceptance checks. No deployment is prepared yet; no duplicate implementation run is requested.' })
    }
  }
  for (const old of records.tickets) {
    if (old.mandate.strength !== 'inferred' || old.ended?.outcome !== 'dropped' || old.ended.by !== 'executor') continue
    const identity = source(old)
    const droppedAt = Math.min(...[...old.assignments.filter(a => a.report?.state === 'dropped').map(a => Date.parse(a.report!.at)), Date.parse(old.ended.at)].filter(Number.isFinite))
    if (!identity || !Number.isFinite(droppedAt)) continue
    // Earliest recorded drop survives later resumption/drop; latest ended.at is not replacement chronology.
    // UI continuation only, not scope/authority equivalence: generated mandate scopes may differ.
    // More than one later explicit ticket is ambiguous, even if only one is currently active.
    const replacements = records.tickets.filter(ticket => ticket.mandate.strength === 'explicit'
      && source(ticket) === identity && Date.parse(ticket.createdAt) >= droppedAt)
    if (replacements.length !== 1) continue
    const replacement = replacements[0]!, current = result.get(replacement.id)
    result.set(old.id, { state: 'superseded', owner: `worker-${replacement.id}`, supersededBy: replacement.id,
      nextStep: `Follow worker-${replacement.id} for the replacement outcome; this dropped inferred worker remains history under its original mandate.` })
    if (current) current.replaces = [...(current.replaces ?? []), old.id]
  }
  return result
}
