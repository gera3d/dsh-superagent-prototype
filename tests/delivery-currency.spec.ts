import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { DeliveryStore } from '../src/app/feature-delivery.ts'
import { DecisionInbox } from '../src/app/decision-inbox.ts'
import { projectDeliveries, reconcileInboxCurrency } from '../src/app/delivery-runtime.ts'
import { deriveDeliveryWork, readDeliveryWorkers } from '../src/app/delivery-currency.ts'
import type { Ticket, Trigger } from '../src/core/model.ts'

it('retires the same synthetic advice after automatic unbound progress becomes a ready review handoff', () => {
  const path = mkdtempSync(join(tmpdir(), 'delivery-ready-currency-')), store = new Store(join(path, 'test.sqlite'))
  try {
    const deliveries = new DeliveryStore(store.db), inbox = new DecisionInbox(store.db)
    const ticket: Ticket = { id: 'ready-worker', title: 'Issue171', mandate: { strength: 'explicit' } as Ticket['mandate'], decisionId: 'decision',
      createdAt: '2026-11-06T17:40:26Z', updatedAt: '2026-11-06T18:00:00Z', origin: { triggerId: 'source', triggerIds: ['source'] }, channels: [], inputs: [], undelivered: [],
      assignments: [{ id: 'same-native-assignment', state: 'running', createdAt: '2026-11-06T17:40:26Z', idleAt: '2026-11-06T18:00:00Z', report: { state: 'progress', summary: 'Collecting the existing serial test results.', at: '2026-11-06T18:00:00Z' } }] }
    store.tickets.save(ticket)
    let delivery = deliveries.trackUnbound({ ticketId: ticket.id, triggerId: 'source', title: ticket.title, owner: 'release-owner', repository: 'org/repo', sourceIssue: 171 })
    expect(deriveDeliveryWork(deliveries.list(), readDeliveryWorkers(store.db)).get(ticket.id)?.state).toBe('owned')
    const options = [{ id: 'tests', label: 'Run regression tests', prompt: 'Run tests', why: 'Verify', recommended: true }, { id: 'diff', label: 'Inspect diff', prompt: 'Inspect', why: 'Verify', recommended: false }]
    let turn = 0
    const advice = (context = '') => inbox.publishAdvisor({ sessionId: `worker-${ticket.id}`, sourceMessageId: `${++turn}`, sourceTurn: turn, sourceSeq: turn, key: `${turn}`, createdAt: Date.now(), question: context || 'Choose the next step for this thread', context, title: 'Advice', model: 'advisor', options })
    const sameRow = advice(), question = advice('Which acceptance evidence do you need?'), staged = advice()
    inbox.stage(staged.id, { choiceId: 'tests', attemptId: '123e4567-e89b-42d3-a456-426614174000', draftText: 'Run tests' })
    // Simulate deployment only after the same native assignment has reported ready and synchronized to review.
    ticket.assignments[0]!.report = { state: 'ready', summary: 'Implementation reported ready with collected serial test evidence; release review remains.', at: '2026-11-06T18:10:00Z' }
    store.tickets.save(ticket)
    delivery = deliveries.compareAndSwap(delivery.id, delivery.revision, d => { d.stage = 'review'; d.state = 'blocked' })
    const immutable = JSON.stringify({ ticket: store.tickets.get(ticket.id), delivery: deliveries.get(delivery.id) })
    reconcileInboxCurrency(inbox, deliveries)
    expect(inbox.get(sameRow.id)?.status).toBe('stale')
    expect(inbox.findSource({ sessionId: sameRow.sessionId!, sourceMessageId: sameRow.sourceMessageId })?.status).toBe('stale')
    expect(() => inbox.stage(sameRow.id, { choiceId: 'tests', attemptId: '123e4567-e89b-42d3-a456-426614174001', draftText: 'Run tests' })).toThrow('stale')
    expect(inbox.get(question.id)?.status).toBe('pending'); expect(inbox.get(staged.id)?.staging).toBeDefined()
    const work = projectDeliveries(deliveries, inbox.list()).find(item => item.ticketId === ticket.id)?.delivery?.work
    expect(work).toMatchObject({ state: 'owned', owner: 'release-owner', progress: ticket.assignments[0]!.report!.summary })
    expect(work?.nextStep).toContain('Implementation reported ready'); expect(work?.nextStep).toContain('no duplicate implementation run is requested')
    expect(work?.nextStep).not.toContain('review is running')
    expect(JSON.stringify({ ticket: store.tickets.get(ticket.id), delivery: deliveries.get(delivery.id) })).toBe(immutable)
    const records = readDeliveryWorkers(store.db)
    expect(deriveDeliveryWork([{ ...delivery, scopeBinding: undefined }], records).has(ticket.id)).toBe(false)
    expect(deriveDeliveryWork([{ ...delivery, state: 'accepted' }], records).has(ticket.id)).toBe(false)
    ticket.attention = { id: 'real-question', question: 'Need an answer' }
    expect(deriveDeliveryWork([delivery], { tickets: [ticket], triggers: [] }).has(ticket.id)).toBe(false)
    delete ticket.attention; ticket.ended = { by: 'executor', outcome: 'completed', at: '2026-11-06T18:20:00Z' }
    expect(deriveDeliveryWork([delivery], { tickets: [ticket], triggers: [] }).has(ticket.id)).toBe(false)
  } finally { store.close(); rmSync(path, { recursive: true, force: true }) }
})

it('projects unique same-source replacement and idle native ownership; persists only synthetic advice retirement', async () => {
  const path = mkdtempSync(join(tmpdir(), 'delivery-currency-')), store = new Store(join(path, 'test.sqlite'))
  try {
    const deliveries = new DeliveryStore(store.db), inbox = new DecisionInbox(store.db)
    const ticket = (id: string, inferred = false): Ticket => ({ id, title: 'Same title', mandate: { strength: inferred ? 'inferred' : 'explicit', scope: 'Implement bounded issue171 finding triage workflow' } as Ticket['mandate'], decisionId: id,
      createdAt: inferred ? '2026-11-06T10:00:00Z' : '2026-11-06T10:02:00Z', updatedAt: '2026-11-06T10:03:00Z', origin: { triggerId: id, triggerIds: [id] }, channels: [], inputs: [], undelivered: [],
      assignments: [{ id: `a-${id}`, state: inferred ? 'ended' : 'running', createdAt: '2026-11-06T10:02:00Z', idleAt: '2026-11-06T10:03:00Z', report: { state: inferred ? 'dropped' : 'progress', summary: inferred ? 'Restricted inferred scope' : 'Serial regression process is already running; worker owns collection.', at: '2026-11-06T10:03:00Z' } }],
      ...(inferred ? { ended: { by: 'executor' as const, outcome: 'dropped' as const, at: '2026-11-06T10:01:00Z' } } : {}) })
    const source = (id: string, thread = 'org/repo/issue/171') => store.triggers.save({ id, source: 'github', at: '2026-11-06T10:00:00Z', meta: {}, threads: [{ source: 'github', id: thread }] } as Trigger)
    const old = ticket('old', true), active = ticket('active')
    for (const t of [old, active]) { store.tickets.save(t); source(t.id); deliveries.trackUnbound({ ticketId: t.id, triggerId: t.id, title: t.title, owner: t.id, repository: 'org/repo', sourceIssue: 171 }) }
    const originals = JSON.stringify(store.tickets.list())
    const options = [{ id: 'tests', label: 'Run regression tests', prompt: 'Run tests', why: 'Verify', recommended: true }, { id: 'diff', label: 'Inspect diff', prompt: 'Inspect', why: 'Verify', recommended: false }]
    let turn = 0
    const advice = (sessionId: string, context = '') => inbox.publishAdvisor({ sessionId, sourceMessageId: `${++turn}`, sourceTurn: turn, sourceSeq: turn, key: `${turn}`, createdAt: Date.now(), question: context || 'Choose the next step for this thread', context, title: 'Advice', model: 'advisor', options })
    const generated = [advice('worker-active'), advice('old')], question = advice('worker-active', 'Which requirement needs clarification?'), staged = advice('worker-active'), unrelated = advice('unrelated')
    inbox.stage(staged.id, { choiceId: 'tests', attemptId: '123e4567-e89b-42d3-a456-426614174000', draftText: 'Run tests' })
    reconcileInboxCurrency(inbox, deliveries)
    generated.forEach(item => { expect(inbox.findSource({ sessionId: item.sessionId!, sourceMessageId: item.sourceMessageId })?.status).toBe('stale'); expect(() => inbox.stage(item.id, { choiceId: 'tests', attemptId: '123e4567-e89b-42d3-a456-426614174001', draftText: 'Run tests' })).toThrow('stale') })
    expect(inbox.get(question.id)?.status).toBe('pending'); expect(inbox.get(staged.id)?.staging).toBeDefined(); expect(inbox.get(unrelated.id)?.status).toBe('pending')
    const projected = projectDeliveries(deliveries, inbox.list())
    expect(projected.find(i => i.ticketId === 'active')?.delivery?.work).toMatchObject({ state: 'owned', owner: 'worker-active', progress: active.assignments[0]!.report!.summary, replaces: ['old'] })
    expect(projected.find(i => i.ticketId === 'old')).toMatchObject({ status: 'stale', delivery: { work: { state: 'superseded', supersededBy: 'active' } } })
    const { createElement } = await import('react'), { renderToStaticMarkup } = await import('react-dom/server'), { DeliveryCard } = await import('../src/client/delivery-card.tsx')
    const markup = projected.filter(item => item.delivery).map(item => renderToStaticMarkup(createElement(DeliveryCard, { item, onConfirm: async () => {} }))).join('')
    expect(markup).toContain('Latest worker report:'); expect(markup).toContain('Serial regression process is already running')
    expect(markup).toContain('Superseded history'); expect(markup).toContain('no new user confirmation is needed')
    expect(markup).not.toContain('<button')
    expect(JSON.stringify(store.tickets.list())).toBe(originals)
    // Actual issue171 chronology: explicit creation precedes a later revival/drop of the old inferred worker.
    old.assignments[0]!.report!.at = '2026-11-06T17:39:00Z'
    old.ended!.at = '2026-11-06T18:03:40Z'; active.createdAt = '2026-11-06T17:40:26Z'
    store.tickets.save(old); store.tickets.save(active)
    expect(deriveDeliveryWork(deliveries.list(), readDeliveryWorkers(store.db)).get('old')?.supersededBy).toBe('active')
    active.mandate.scope = 'Turn discovered findings into actionable Senior Developer decisions before work starts'; store.tickets.save(active)
    expect(deriveDeliveryWork(deliveries.list(), readDeliveryWorkers(store.db)).get('old')?.supersededBy).toBe('active')
    // Root-provided actual pair: old scope is a supplied prefix, not reconstructed full live text.
    const actualOld = structuredClone(old), actualNew = structuredClone(active)
    actualOld.id = 'b69f469019a353ca5e0cd0747f3cbcbf'; actualNew.id = '5ee3dda6e61420b3b927164ed5f4b98a'
    actualOld.mandate.scope = 'In an isolated checkout, add a durable pre-work triage...'
    actualOld.origin = { triggerId: 'actual-old-origin', triggerIds: ['actual-old-origin'] }
    actualNew.origin = { triggerId: 'actual-new-origin', triggerIds: ['actual-new-origin'] }
    const actualRecords = { tickets: [actualOld, actualNew], triggers: [actualOld, actualNew].map(t => ({ id: t.origin.triggerId, source: 'github', threads: [{ source: 'github', id: '171' }] } as Trigger)) }
    const actualBefore = JSON.stringify(actualRecords)
    expect(deriveDeliveryWork([], actualRecords).get(actualOld.id)?.supersededBy).toBe(actualNew.id)
    expect(JSON.stringify(actualRecords)).toBe(actualBefore)
    actualNew.ended = { at: '2026-11-06T19:00:00Z', by: 'executor', outcome: 'merged' }
    expect(deriveDeliveryWork([], actualRecords).get(actualOld.id)?.supersededBy).toBe(actualNew.id)
    actualOld.ended!.outcome = 'completed'
    expect(deriveDeliveryWork([], actualRecords).has(actualOld.id)).toBe(false)
    // Same title on another immutable source cannot prove a replacement.
    source('active', 'org/repo/issue/172')
    expect(deriveDeliveryWork(deliveries.list(), readDeliveryWorkers(store.db)).has('old')).toBe(false)
    source('active'); const second = ticket('second'); second.createdAt = '2026-11-06T18:00:00Z'; store.tickets.save(second); source('second')
    expect(deriveDeliveryWork(deliveries.list(), readDeliveryWorkers(store.db)).has('old')).toBe(false)
    active.attention = { id: 'question', question: 'Need a real answer' }; store.tickets.save(active)
    expect(deriveDeliveryWork(deliveries.list(), readDeliveryWorkers(store.db)).has('active')).toBe(false)
    delete active.attention
    for (const state of ['ready', 'blocked', 'failed', 'dropped', 'waiting'] as const) {
      active.assignments[0]!.report!.state = state; store.tickets.save(active)
      expect(deriveDeliveryWork(deliveries.list(), readDeliveryWorkers(store.db)).has('active')).toBe(false)
    }
    active.assignments[0]!.report!.state = 'progress'; store.tickets.save(active)
    old.ended!.by = 'human'; store.tickets.save(old)
    expect(deriveDeliveryWork(deliveries.list(), { tickets: [old, active], triggers: readDeliveryWorkers(store.db).triggers }).has('old')).toBe(false)
    old.ended!.by = 'executor'
    active.ended = { at: '2026-11-06T11:00:00Z', by: 'executor', outcome: 'merged' }
    const completed = deriveDeliveryWork(deliveries.list(), { tickets: [old, active], triggers: readDeliveryWorkers(store.db).triggers })
    expect(completed.get('old')).toMatchObject({ state: 'superseded', supersededBy: 'active' })
    expect(completed.has('active')).toBe(false)
    expect(deriveDeliveryWork(deliveries.list(), { tickets: [old, active], triggers: [] }).has('old')).toBe(false)
  } finally { store.close(); rmSync(path, { recursive: true, force: true }) }
})
