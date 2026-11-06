import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ticket } from '../src/core/index.ts'
import { ticketDecisions } from '../src/app/decision-inbox.ts'
import { publicationConversation } from '../src/app/lifecycle-publication.ts'
import type { PublicationSnapshot } from '../src/app/publication.ts'
import { capturePublicationTicket, capturePublicationTicketFence, publicationTicketCurrent, validatePublicationTicket } from '../src/app/publication-ticket.ts'

const at = '2026-11-05T10:00:00.000Z'
const mergeAt = '2026-11-05T10:01:00.000Z'
const closedAt = '2026-11-05T10:01:01.000Z'
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const ticket: Ticket = { id: 't1', title: 'Publication fixture', decisionId: 'd1', mandate: {} as Ticket['mandate'],
    assignments: [{ id: 'a1', state: 'running', createdAt: at, idleAt: at, report: { state: 'ready', at, summary: 'Ready' } }],
    follows: [{ thread: 'github:150', own: true }, { thread: 'feishu:context', own: false }], channels: [],
    inputs: [], undelivered: [], origin: { triggerId: 'origin', triggerIds: ['origin'] }, createdAt: at, updatedAt: at }
  const item = ticketDecisions([ticket])[0]!
  const publication: PublicationSnapshot = { id: '00000000-0000-0000-0000-000000000001', ticketId: ticket.id,
    conversationId: publicationConversation(item), repository: 'owner/repo', prNumber: 150, headSha: 'a'.repeat(40), patchSha256: 'b'.repeat(64),
    status: 'prepared', createdAt: at, updatedAt: at, outcomes: [], requests: {}, audit: [] }
  const fence = capturePublicationTicketFence(ticket, item)
  return { ticket, item, publication, fence }
}
function merged(f: ReturnType<typeof fixture>, end = true) {
  f.publication.outcomes.push({ stage: 'merge', status: 'succeeded', operationId: `${f.publication.id}:merge`, startedAt: mergeAt, finishedAt: closedAt })
  f.publication.status = 'merged'
  f.ticket.follows![0]!.closed = { at: closedAt, outcome: 'merged' }
  if (end) {
    f.ticket.ended = { by: 'executor', outcome: 'merged', at: closedAt }
    f.ticket.assignments[0]!.state = 'ended'
    f.ticket.assignments[0]!.endedAt = closedAt
  }
}

describe('publication canonical ticket fence', () => {
  it('round trips unchanged ticket/fence and tolerates storage property order and updatedAt only', () => {
    const f = fixture()
    f.ticket.updatedAt = closedAt
    const reordered = Object.fromEntries(Object.entries(f.ticket).reverse()) as unknown as Ticket
    expect(publicationTicketCurrent(reordered, JSON.parse(JSON.stringify(f.fence)), f.publication)).toBe(true)
  })
  it('continues through only its successfully recorded PR merge and executor end', () => {
    for (const end of [false, true]) {
      const f = fixture(); merged(f, end)
      expect(ticketDecisions([f.ticket]).some(item => item.id === f.item.id)).toBe(false)
      expect(publicationTicketCurrent(f.ticket, f.fence, f.publication)).toBe(true)
    }
  })
  it('accounts only for GitHub whole-second precision after exact durable own-merge proof', () => {
    const f = fixture(); merged(f)
    f.publication.outcomes[0]!.startedAt = '2026-11-05T10:01:01.100Z'
    // GitHub reports .000 for a merge that happened after the local .100 start.
    expect(publicationTicketCurrent(f.ticket, f.fence, f.publication)).toBe(true)
    const earlierSecond = '2026-11-05T10:01:00.999Z'
    f.ticket.follows![0]!.closed!.at = earlierSecond
    f.ticket.ended!.at = earlierSecond
    f.ticket.assignments[0]!.endedAt = earlierSecond
    expect(publicationTicketCurrent(f.ticket, f.fence, f.publication)).toBe(false)
    f.ticket.follows![0]!.closed!.at = closedAt
    f.ticket.ended!.at = closedAt
    f.ticket.assignments[0]!.endedAt = closedAt
    f.publication.outcomes[0]!.status = 'running'
    expect(publicationTicketCurrent(f.ticket, f.fence, f.publication)).toBe(false)
    f.publication.outcomes[0]!.status = 'succeeded'
    f.publication.outcomes[0]!.operationId = 'foreign:merge'
    expect(publicationTicketCurrent(f.ticket, f.fence, f.publication)).toBe(false)
  })
  it('does not infer merge authority from a closed ticket, another operation, or uncertain result', () => {
    for (const change of [
      (p: PublicationSnapshot) => { p.outcomes = [] },
      (p: PublicationSnapshot) => { p.outcomes[0]!.status = 'running' },
      (p: PublicationSnapshot) => { p.outcomes[0]!.status = 'failed' },
      (p: PublicationSnapshot) => { p.outcomes[0]!.status = 'interrupted' },
      (p: PublicationSnapshot) => { p.outcomes[0]!.operationId = 'another-publication:merge' },
      (p: PublicationSnapshot) => { p.outcomes[0]!.startedAt = '2026-11-05T10:02:00.000Z' },
    ]) {
      const f = fixture(); merged(f); change(f.publication)
      expect(publicationTicketCurrent(f.ticket, f.fence, f.publication)).toBe(false)
    }
  })
  it('rejects explicit stops, nonmerged closures, altered end timestamps and assignment end metadata', () => {
    const changes: ((ticket: Ticket) => void)[] = [
      t => { t.ended!.by = 'human' }, t => { t.ended!.outcome = 'closed' }, t => { t.ended!.outcome = 'stopped' },
      t => { t.ended!.reason = 'stop' }, t => { t.ended!.at = at }, t => { t.assignments[0]!.endedAt = at },
      t => { t.assignments[0]!.endedReason = 'superseded' }, t => { t.follows![0]!.closed!.outcome = 'closed' },
      t => { t.follows![0]!.closed!.at = at },
    ]
    for (const change of changes) {
      const f = fixture(); merged(f); change(f.ticket)
      expect(publicationTicketCurrent(f.ticket, f.fence, f.publication)).toBe(false)
    }
  })
  it('rejects any newer work, policy, other-follow or assignment changes before or after merge', () => {
    const changes: ((ticket: Ticket) => void)[] = [
      t => { t.inputs.push({ id: 'new', kind: 'note', text: 'New context', at: closedAt }) },
      t => { t.undelivered.push('new') }, t => { t.attention = { id: 'new', question: 'Question' } },
      t => { t.delivery = { error: 'pending', at: closedAt } }, t => { t.decisionId = 'new' },
      t => { t.assignments.push({ id: 'a2', createdAt: closedAt, state: 'pending' }) },
      t => { t.assignments[0]!.report!.at = closedAt }, t => { t.assignments[0]!.report!.summary = 'New result' },
      t => { t.assignments[0]!.idleAt = closedAt }, t => { t.assignments[0]!.deliveredAt = closedAt },
      t => { t.follows![1]!.closed = { at: closedAt, outcome: 'merged' } },
      t => { t.follows!.push({ thread: 'github:151', own: true }) },
      t => { t.mandate = { ...t.mandate, changed: true } as Ticket['mandate'] },
    ]
    for (const end of [false, true]) for (const change of changes) {
      const f = fixture(); if (end) merged(f); change(f.ticket)
      expect(publicationTicketCurrent(f.ticket, f.fence, f.publication)).toBe(false)
    }
  })
  it('rejects stale, invalidated, foreign-conversation and caller-invented capture cards', () => {
    const f = fixture()
    for (const item of [{ ...f.item, status: 'stale' as const }, { ...f.item, invalidation: { at: 1, reason: 'stale' } },
      { ...f.item, id: 'invented' }, { ...f.item, sessionId: 'other' }, { ...f.item, ticketId: 'other' }]) {
      expect(() => capturePublicationTicketFence(f.ticket, item)).toThrow('current canonical')
    }
    expect(publicationTicketCurrent(undefined, f.fence, f.publication)).toBe(false)
    expect(publicationTicketCurrent(f.ticket, f.fence, { ...f.publication, conversationId: 'other' })).toBe(false)
    expect(publicationTicketCurrent(f.ticket, f.fence, { ...f.publication, prNumber: 151 })).toBe(false)
  })
  it('reads SQLite without writes and binds external-coordinator fences to immutable publication pins', () => {
    const f = fixture()
    const directory = mkdtempSync(join(tmpdir(), 'publication-fence-')); directories.push(directory)
    const path = join(directory, 'orchestrator.sqlite')
    const db = new DatabaseSync(path)
    try {
      db.exec('CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
      const save = () => db.prepare('INSERT OR REPLACE INTO ticket VALUES (?, ?)').run(f.ticket.id, JSON.stringify(f.ticket))
      save()
      const fence = capturePublicationTicket(path, f.publication)
      expect(validatePublicationTicket(path, f.publication, JSON.parse(JSON.stringify(fence)))).toBe(true)
      for (const changed of [{ ...f.publication, id: 'other' }, { ...f.publication, repository: 'other/repo' },
        { ...f.publication, headSha: 'c'.repeat(40) }, { ...f.publication, patchSha256: 'd'.repeat(64) }]) {
        expect(validatePublicationTicket(path, changed, fence)).toBe(false)
      }
      merged(f); save()
      expect(validatePublicationTicket(path, f.publication, fence)).toBe(true)
      expect(() => capturePublicationTicket(path, f.publication)).toThrow('no longer has')
      f.ticket.inputs.push({ id: 'new', kind: 'text', text: 'Stop', at: closedAt }); save()
      expect(validatePublicationTicket(path, f.publication, fence)).toBe(false)
      db.prepare('UPDATE ticket SET value = ?').run('invalid JSON')
      expect(validatePublicationTicket(path, f.publication, fence)).toBe(false)
    } finally { db.close() }
    expect(validatePublicationTicket(join(directory, 'absent.sqlite'), f.publication, f.fence)).toBe(false)
  })
})
