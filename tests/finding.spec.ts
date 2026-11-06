import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FindingCard } from '../src/client/finding-card.tsx'
import type { Delivery } from '../src/app/feature-delivery.ts'
import type { PendingDecisionItem } from '../src/core/decision.ts'
import { FindingStore, FindingIntakeSchema, FindingConfirmSchema, findingDecision, projectFindings, type FindingIntake } from '../src/app/finding.ts'

const open: DatabaseSync[] = []
const directories: string[] = []
afterEach(() => { for (const db of open.splice(0)) db.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture(path = ':memory:') { const db = new DatabaseSync(path); open.push(db); return new FindingStore(db) }
function intake(key = 'finding', occurrence = 'observation'): FindingIntake {
  return { dedupKey: key, title: 'Broken bounded behavior', problem: 'Observed incorrect ordering', scope: 'Only the ordering function', owner: 'backend',
    kind: 'fix', requirements: ['Preserve ordering across restart'], repository: 'org/repo',
    occurrence: { id: occurrence, reference: 'session:message:42', evidence: 'Second item ran first' } }
}
function confirm(store: FindingStore, id: string, choiceId: 'fix_now' | 'queue_next' | 'defer' = 'queue_next') {
  return store.confirm(id, { revision: store.get(id)!.revision, choiceId })
}

it('replaces generic current/prior finding-job lifecycle cards while preserving publication history and real questions', () => {
  const store = fixture()
  const finding = store.observe({ ...intake(), kind: 'verification', existingDeliveryId: 'auto-5ee3dda6e61420b3b927164ed5f4b98a' })
  confirm(store, finding.id)
  store.markDispatched(finding.id, 'prior-verification-ticket', 'prior-assignment')
  let current = store.markReview(finding.id, { reference: 'prior-report', summary: 'Further verification needed', recordedAt: new Date().toISOString(), state: 'blocked' })
  store.review(finding.id, { revision: current.revision, decision: 'retry_scope' })
  confirm(store, finding.id)
  store.markDispatched(finding.id, 'f1169468a82e551dd2804f270f3d12bf', 'current-assignment')
  current = store.markReview(finding.id, { reference: 'ticket/f1169468a82e551dd2804f270f3d12bf/report/current-assignment', summary: 'History verification ready; review evidence', recordedAt: new Date().toISOString(), state: 'ready' })
  const generic: PendingDecisionItem = { ...findingDecision(current), finding: undefined, id: 'generic-done', actionMode: 'ticket_lifecycle',
    lifecycle: { kind: 'done', assignmentId: 'current-assignment', prNumber: 173, docsOnly: false }, choices: [{ id: 'prepare_publication', label: 'Inspect publication' }] }
  const prior: PendingDecisionItem = { ...generic, id: 'generic-prior-stuck', ticketId: 'worker-prior-verification-ticket', lifecycle: { kind: 'stuck', assignmentId: 'prior-assignment' } }
  const publication: NonNullable<NonNullable<PendingDecisionItem['lifecycle']>['publication']> = {
    id: 'real-publication', status: 'rolled_back', repository: 'org/repo', prNumber: 173, headSha: 'a'.repeat(40), patchSha256: 'b'.repeat(64),
    ticketId: generic.ticketId!, conversationId: `worker-${generic.ticketId}`, createdAt: current.createdAt, updatedAt: current.updatedAt, outcomes: [], audit: [], requests: {},
  }
  const rollback: PendingDecisionItem = { ...generic, id: 'real-rollback', lifecycle: { ...generic.lifecycle!, publication, recovery: true } }
  const prepared: PendingDecisionItem = { ...rollback, id: 'real-prepared', lifecycle: { ...rollback.lifecycle!, publication: { ...publication, status: 'prepared' } } }
  const question: PendingDecisionItem = { ...generic, id: 'real-question', lifecycle: undefined, actionMode: 'stage_response', question: 'Which screenshot confirms History?', choices: [{ id: 'respond', label: 'Draft a response' }] }
  const unrelated: PendingDecisionItem = { ...generic, id: 'unrelated-done', ticketId: 'original-delivery-owner' }
  const items = [generic, prior, rollback, prepared, question, unrelated], before = JSON.stringify({ items, finding: store.get(finding.id) })
  const projected = projectFindings(store, items)
  expect(projected.map(item => item.id)).toEqual([rollback.id, prepared.id, question.id, unrelated.id, `finding-${finding.id}`])
  expect(projected.at(-1)?.finding).toMatchObject({ existingDeliveryId: current.existingDeliveryId, state: 'blocked', job: current.job, priorJobs: current.priorJobs })
  expect(JSON.stringify({ items, finding: store.get(finding.id) })).toBe(before)
})

it('deduplicates durable observations and refuses scope, evidence identity, and delivery identity changes', () => {
  const store = fixture(); const input = { ...intake(), existingDeliveryId: 'delivery-original' }
  const first = store.observe(input)
  expect(store.observe(input)).toEqual(first)
  expect(store.observe({ ...input, occurrence: { ...input.occurrence, id: 'second' } }).occurrences).toHaveLength(2)
  expect(store.list()).toHaveLength(1)
  for (const change of [{ scope: 'expanded' }, { existingDeliveryId: 'replacement' }, { requirements: ['Extra scope'] }])
    expect(() => store.observe({ ...input, ...change })).toThrow('different bounded finding')
  expect(() => store.observe({ ...input, occurrence: { ...input.occurrence, evidence: 'Changed evidence' } })).toThrow('different evidence')
  expect(store.get(first.id)?.existingDeliveryId).toBe('delivery-original')
})

it('records trusted observer provenance separately from strict intake and never turns model advice into human approval', () => {
  const store = fixture()
  const external = store.observe(intake())
  expect(external.audit[0]).toMatchObject({ source: 'external', actor: 'external:unattributed-observer', reference: 'session:message:42' })
  const observed = store.observe(intake('finding', 'model-observation'), { source: 'model', actor: 'ticket-worker:42', reference: 'ticket/42/assignment/1' })
  expect(observed.audit.at(-1)).toMatchObject({ source: 'model', actor: 'model:ticket-worker:42', reference: 'ticket/42/assignment/1' })
  const operator = store.observe(intake('operator'), { source: 'operator', reference: 'http:local-operator' })
  expect(operator.audit[0]?.actor).toBe('local-operator')
  expect(() => store.observe({ ...intake('forged'), provenance: { source: 'operator', reference: 'forged' } } as FindingIntake)).toThrow()
  store.setRecommendation(observed.id, observed.revision, { choiceId: 'queue_next', provider: 'configured-model', rationale: 'Preserve FIFO' })
  expect(store.get(observed.id)?.audit.at(-1)?.actor).toBe('model:configured-model')
  store.recommendationFailed(observed.id, observed.revision, 'Unavailable')
  expect(store.get(observed.id)?.audit.at(-1)?.actor).toBe('model-service')
  expect(confirm(store, observed.id).audit.at(-1)?.actor).toBe('local-operator')
})

it.each([16_385, 100_000])('bounds a valid %i-character native report excerpt without stalling FIFO and deduplicates by full summary hash', length => {
  const store = fixture(); const first = confirm(store, store.observe(intake('first')).id)
  const second = confirm(store, store.observe(intake('second')).id)
  store.markDispatched(first.id, 'ticket', 'assignment')
  const summary = 'x'.repeat(length - 1) + 'A'
  const native = { reference: 'ticket/ticket/report/assignment', summary, recordedAt: new Date().toISOString(), state: 'ready' as const }
  const reviewed = store.markReview(first.id, native)
  expect(reviewed.state).toBe('blocked'); expect(store.nextQueued()?.id).toBe(second.id)
  expect(reviewed.reports[0]).toMatchObject({ reference: native.reference, summaryTruncated: true, originalLength: length,
    reportSummarySha256: createHash('sha256').update(summary).digest('hex') })
  expect(reviewed.reports[0]?.evidence).toHaveLength(16_384)
  expect(native.summary).toBe(summary)
  expect(store.markReview(first.id, native)).toEqual(reviewed)
  const changed = store.markReview(first.id, { ...native, summary: summary.slice(0, -1) + 'B' })
  expect(changed.reports).toHaveLength(2)
  expect(changed.reports[0]?.evidence).toBe(changed.reports[1]?.evidence)
  expect(changed.reports[0]?.reportSummarySha256).not.toBe(changed.reports[1]?.reportSummarySha256)
  expect(changed.revision).toBe(reviewed.revision + 1)
  expect(changed.audit.at(-1)?.actor).toBe('worker:ticket')
  expect(() => store.observe({ ...intake('oversized-scope'), scope: 'x'.repeat(16_385) })).toThrow()
})

it('stores and renders Run verification rather than a fabricated repair action for verification findings', () => {
  const store = fixture(); const record = store.observe({ ...intake(), kind: 'verification' })
  expect(record.choices.find(choice => choice.id === 'fix_now')?.label).toBe('Run verification')
  expect(store.get(record.id)?.choices.find(choice => choice.id === 'fix_now')?.label).toBe('Run verification')
  const markup = renderToStaticMarkup(createElement(FindingCard, { item: findingDecision(record) }))
  expect(markup).toMatch(/<button[^>]*>Run verification<\/button>/)
  expect(markup).not.toMatch(/<button[^>]*>Fix now<\/button>/)
  const fix = store.observe(intake('actual-fix'))
  expect(fix.choices.find(choice => choice.id === 'fix_now')?.label).toBe('Fix now')
})

it('keeps recommendations real, revision-bound and unavailable until actually recorded', () => {
  const store = fixture(); const first = store.observe(intake())
  expect(findingDecision(first).recommendation.recommendedValue).toBe('')
  const rec = { choiceId: 'queue_next' as const, rationale: 'Existing work should finish first', provider: 'configured-model' }
  store.setRecommendation(first.id, first.revision, rec)
  expect(findingDecision(store.get(first.id)!).recommendation).toMatchObject({ recommendedValue: 'queue_next', provider: 'configured-model' })
  const changed = store.observe(intake('finding', 'new-evidence'))
  expect(changed.revision).toBe(2)
  expect(changed.recommendation).toBeUndefined()
  expect(() => store.setRecommendation(first.id, 1, rec)).toThrow('changed')
  store.recommendationFailed(first.id, 2, 'Model unavailable')
  expect(findingDecision(store.get(first.id)!).recommendation).toMatchObject({ recommendedValue: '', rationale: 'Model unavailable' })
})

it('rejects unknown authority, pins, injected choices and stale/conflicting confirmation', () => {
  expect(FindingIntakeSchema.safeParse({ ...intake(), pins: ['fabricated'] }).success).toBe(false)
  expect(FindingIntakeSchema.safeParse({ ...intake(), actor: 'admin' }).success).toBe(false)
  expect(FindingConfirmSchema.safeParse({ revision: 1, choiceId: 'merge' }).success).toBe(false)
  const store = fixture(); const first = store.observe(intake())
  expect(() => store.confirm(first.id, { revision: 1, choiceId: 'fix_now' }, 'autopilot')).toThrow('local-operator')
  const current = store.observe(intake('finding', 'second'))
  expect(() => store.confirm(first.id, { revision: 1, choiceId: 'fix_now' })).toThrow('stale')
  const confirmed = confirm(store, first.id, 'fix_now')
  expect(store.confirm(first.id, { revision: current.revision, choiceId: 'fix_now' })).toEqual(confirmed)
  expect(() => confirm(store, first.id, 'defer')).toThrow('conflicts')
})

it('serializes fix-now and queue-next FIFO and preserves one job through connection restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'finding-test-')); directories.push(directory)
  const path = join(directory, 'db.sqlite'); let store = fixture(path)
  const first = confirm(store, store.observe(intake('first')).id)
  const second = confirm(store, store.observe(intake('second')).id, 'fix_now')
  expect(store.nextQueued()?.id).toBe(first.id)
  expect(findingDecision(first)).toMatchObject({ status: 'pending', choices: [] })
  expect(() => store.markDispatched(second.id, 'ticket-2', 'assignment-2')).toThrow('next dispatchable')
  store.markDispatched(first.id, 'ticket-1', 'assignment-1')
  expect(findingDecision(store.get(first.id)!)).toMatchObject({ status: 'pending', choices: [] })
  expect(findingDecision(store.get(first.id)!).resolvedAt).toBeUndefined()
  expect(store.nextQueued()).toBeUndefined()
  expect(store.markDispatched(first.id, 'ticket-1', 'assignment-1').job?.id).toBe(first.job?.id)
  expect(() => store.markDispatched(first.id, 'replacement', 'replacement')).toThrow('already bound')
  open.pop()!.close(); store = fixture(path)
  expect(store.nextQueued()).toBeUndefined()
  expect(confirm(store, first.id).job?.id).toBe(first.job?.id)
  store.markReview(first.id, { reference: 'report:1', summary: 'Work ended; inspect the diff', recordedAt: new Date().toISOString(), state: 'ready' })
  expect(store.get(first.id)?.state).toBe('blocked')
  expect(store.get(first.id)?.job?.ticketId).toBe('ticket-1')
  expect(store.nextQueued()?.id).toBe(second.id)
})

it('commits native dispatch and binding together, rolling both back on failure', () => {
  const store = fixture(); const first = confirm(store, store.observe(intake()).id)
  store.db.exec('CREATE TABLE native_ticket (id TEXT PRIMARY KEY); SAVEPOINT owner_atomic')
  store.db.prepare('INSERT INTO native_ticket VALUES(?)').run('native-ticket')
  store.markDispatched(first.id, 'native-ticket', 'assignment')
  store.db.exec('ROLLBACK TO owner_atomic; RELEASE owner_atomic')
  expect(store.get(first.id)?.state).toBe('queued')
  expect(store.get(first.id)?.job?.ticketId).toBeUndefined()
  expect(store.db.prepare('SELECT * FROM native_ticket').all()).toHaveLength(0)
  expect(store.nextQueued()?.id).toBe(first.id)
})

it('supports two database owners without duplicate confirmation or rebinding', () => {
  const directory = mkdtempSync(join(tmpdir(), 'finding-concurrent-')); directories.push(directory)
  const path = join(directory, 'db.sqlite'); const a = fixture(path); const b = fixture(path)
  const first = a.observe(intake()); expect(b.observe(intake()).id).toBe(first.id)
  a.db.exec('BEGIN IMMEDIATE')
  const job = confirm(a, first.id).job
  // The second writer must fail rather than manufacture another durable job from its old snapshot.
  expect(() => confirm(b, first.id)).toThrow(/locked|busy/i)
  a.db.exec('COMMIT')
  expect(confirm(b, first.id).job).toEqual(job)
  a.markDispatched(first.id, 'ticket', 'assignment')
  expect(b.nextQueued()).toBeUndefined()
  expect(b.markDispatched(first.id, 'ticket', 'assignment').job).toMatchObject(job!)
  expect(() => b.markDispatched(first.id, 'other', 'assignment')).toThrow('already bound')
  expect(a.db.prepare('SELECT * FROM finding_queue').all()).toHaveLength(1)
})

it('defers without work, only reopens explicitly, and does not revive accepted resolved repeats', () => {
  const store = fixture(); const first = store.observe(intake()); const deferred = confirm(store, first.id, 'defer')
  expect(deferred.job).toBeUndefined(); expect(store.nextQueued()).toBeUndefined()
  expect(store.observe(intake('finding', 'later')).state).toBe('deferred')
  const revisited = store.revisit(first.id); expect(revisited.revision).toBe(2)
  expect(() => store.confirm(first.id, { revision: 1, choiceId: 'defer' })).toThrow('stale')
  confirm(store, first.id); store.markDispatched(first.id, 'ticket', 'assignment')
  store.markBlocked(first.id, 'Evidence review required')
  expect(store.get(first.id)?.audit.at(-1)?.actor).toBe('finding-runtime')
  expect(() => store.resolve(first.id, 'unknown', first.requirements)).toThrow('linked report evidence')
  store.reportEvidence(first.id, { reference: 'test:passed', evidence: 'Regression test passes', nextDecision: 'Accept the verified fix', verified: true })
  expect(store.get(first.id)?.state).toBe('blocked')
  store.resolve(first.id, 'test:passed', first.requirements)
  const repeated = store.observe(intake('finding', 'after-resolution'))
  expect(repeated.state).toBe('resolved'); expect(repeated.job?.ticketId).toBe('ticket')
  expect(repeated.occurrences).toHaveLength(3)
})

it.each(['ready', 'blocked', 'failed', 'dropped'] as const)('keeps %s reports linked and reviewable without treating them as resolution', state => {
  const store = fixture(); const record = confirm(store, store.observe(intake()).id)
  store.markDispatched(record.id, 'ticket', 'assignment')
  const report = { reference: 'ticket/ticket/report/assignment', summary: 'Concrete report evidence', recordedAt: new Date().toISOString(), state }
  const reviewed = store.markReview(record.id, report)
  expect(reviewed.state).toBe('blocked')
  expect(findingDecision(reviewed)).toMatchObject({ status: 'pending', choices: [] })
  expect(findingDecision(reviewed).resolvedChoice).toBeUndefined()
  expect(reviewed.job).toMatchObject({ id: record.job!.id, ticketId: 'ticket', assignmentId: 'assignment' })
  expect(reviewed.reports[0]).toMatchObject({ reference: report.reference, evidence: report.summary, at: report.recordedAt })
  expect(reviewed.reports[0]!.nextDecision).toMatch(/review|Inspect/i)
  expect(store.markReview(record.id, report).reports).toHaveLength(1)
})

it('requires explicit complete requirements acceptance and rejects stale or nonlocal reviews', () => {
  const store = fixture(); const first = confirm(store, store.observe({ ...intake(), requirements: ['Test behavior', 'Preserve scope'] }).id)
  store.markDispatched(first.id, 'ticket', 'assignment')
  store.markReview(first.id, { reference: 'report', summary: 'Tests passed', recordedAt: new Date().toISOString(), state: 'ready' })
  const request = { revision: store.get(first.id)!.revision, decision: 'accept_evidence' as const, evidenceReference: 'report', requirements: first.requirements }
  expect(() => store.review(first.id, request, 'autopilot')).toThrow('local-operator')
  expect(() => store.review(first.id, { ...request, revision: 99 })).toThrow('stale')
  expect(() => store.review(first.id, { ...request, requirements: undefined })).toThrow('full requirements')
  expect(() => store.review(first.id, { ...request, requirements: ['Test behavior'] })).toThrow('full requirements')
  expect(() => store.review(first.id, { ...request, requirements: ['Test behavior', 'Test behavior'] })).toThrow('full requirements')
  expect(() => store.review(first.id, { ...request, evidenceReference: 'unknown' })).toThrow('linked report')
  expect(store.review(first.id, request).state).toBe('resolved')
  expect(() => store.review(first.id, request)).toThrow('stale')
})

it.each(['retry_scope', 'defer'] as const)('archives old work and permits a fresh FIFO job after blocked %s', decision => {
  const store = fixture(); const first = confirm(store, store.observe(intake()).id)
  store.markDispatched(first.id, 'ticket-old', 'assignment-old')
  store.markReview(first.id, { reference: 'report-old', summary: 'More verification needed', recordedAt: new Date().toISOString(), state: 'blocked' })
  const reviewRevision = store.get(first.id)!.revision
  let reopened = store.review(first.id, { revision: reviewRevision, decision })
  if (decision === 'defer') {
    expect(reopened.state).toBe('deferred'); expect(reopened.job?.ticketId).toBe('ticket-old')
    reopened = store.revisit(first.id)
  }
  expect(reopened.state).toBe('awaiting_decision')
  expect(reopened.revision).toBe(reviewRevision + 1)
  expect(reopened.job).toBeUndefined(); expect(reopened.confirmation).toBeUndefined()
  expect(reopened.priorJobs).toEqual([{ ...first.job, ticketId: 'ticket-old', assignmentId: 'assignment-old' }])
  expect(reopened.reports).toHaveLength(1)
  expect(store.db.prepare('SELECT * FROM finding_queue').all()).toHaveLength(0)
  const fresh = confirm(store, first.id)
  expect(fresh.job?.id).not.toBe(first.job?.id)
  store.markDispatched(first.id, 'ticket-new', 'assignment-new')
  expect(store.get(first.id)?.priorJobs?.[0]?.ticketId).toBe('ticket-old')
  expect(() => store.confirm(first.id, { revision: first.revision, choiceId: 'queue_next' })).toThrow('stale')
})

it('fences stale review and cannot accept historic or failed work after retry', () => {
  const store = fixture(); const first = confirm(store, store.observe(intake()).id)
  store.markDispatched(first.id, 'job1-ticket', 'job1-assignment')
  store.markReview(first.id, { reference: 'job1-failed', summary: 'Not fixed', recordedAt: new Date().toISOString(), state: 'failed' })
  const failedRevision = store.get(first.id)!.revision
  expect(() => store.review(first.id, { revision: failedRevision, decision: 'accept_evidence', evidenceReference: 'job1-failed', requirements: first.requirements })).toThrow('current-job')
  store.review(first.id, { revision: failedRevision, decision: 'retry_scope' })
  confirm(store, first.id); store.markDispatched(first.id, 'job2-ticket', 'job2-assignment')
  store.markReview(first.id, { reference: 'job2-blocked', summary: 'Still blocked', recordedAt: new Date().toISOString(), state: 'blocked' })
  const job2Revision = store.get(first.id)!.revision
  expect(() => store.review(first.id, { revision: job2Revision, decision: 'accept_evidence', evidenceReference: 'job1-failed', requirements: first.requirements })).toThrow('current-job')
  store.reportEvidence(first.id, { reference: 'job2-verified', evidence: 'Operator verified regression passes', nextDecision: 'Accept', verified: true })
  expect(() => store.review(first.id, { revision: job2Revision, decision: 'accept_evidence', evidenceReference: 'job2-verified', requirements: first.requirements })).toThrow('stale')
  store.markReview(first.id, { reference: 'job2-later-failure', summary: 'A later regression failed', recordedAt: new Date().toISOString(), state: 'failed' })
  expect(() => store.review(first.id, { revision: store.get(first.id)!.revision, decision: 'accept_evidence', evidenceReference: 'job2-verified', requirements: first.requirements })).toThrow('latest current-job')
  store.reportEvidence(first.id, { reference: 'job2-final-verified', evidence: 'Both regressions now pass', nextDecision: 'Accept', verified: true })
  expect(store.review(first.id, { revision: store.get(first.id)!.revision, decision: 'accept_evidence', evidenceReference: 'job2-final-verified', requirements: first.requirements }).state).toBe('resolved')
})

it('derives a blocked delivery acceptance projection until all attached findings resolve, without changing delivery identity', () => {
  const store = fixture(); const finding = store.observe({ ...intake(), existingDeliveryId: 'delivery-original' })
  const delivery: Delivery = { id: 'delivery-original', title: 'Original delivery', revision: 3, stage: 'verifying', state: 'awaiting_decision', owner: 'backend',
    bindings: { repository: 'org/repo', sourceIssue: 171, baseSha: 'base', headSha: 'head' }, requirements: ['Regression verified'],
    attempts: { review: 0, fix: 0, maxReview: 3, maxFix: 3 }, evidence: [], workers: [], audit: [], authorities: ['local-operator'], generation: 0,
    nextAction: { id: 'accept-action', kind: 'accept', label: 'Accept', revision: 3, fingerprint: 'original-fingerprint' } }
  const item = { ...findingDecision(finding), id: 'delivery-decision', actionMode: 'feature_delivery' as const, delivery }
  const blocked = projectFindings(store, [item]).find(candidate => candidate.id === item.id)!
  expect(blocked.delivery).toMatchObject({ id: delivery.id, state: 'blocked', blocker: 'Linked finding evidence review remains outstanding' })
  expect(blocked.delivery?.nextAction).toBeUndefined(); expect(blocked.choices).toEqual([])
  expect(delivery.nextAction?.kind).toBe('accept'); expect(delivery.state).toBe('awaiting_decision')
  confirm(store, finding.id); store.markDispatched(finding.id, 'ticket', 'assignment')
  store.markReview(finding.id, { reference: 'ready', summary: 'Verified', recordedAt: new Date().toISOString(), state: 'ready' })
  store.review(finding.id, { revision: store.get(finding.id)!.revision, decision: 'accept_evidence', evidenceReference: 'ready', requirements: finding.requirements })
  expect(projectFindings(store, [item]).find(candidate => candidate.id === item.id)?.delivery?.nextAction?.kind).toBe('accept')
})

it('records no-repair-needed verification without inventing a fix or erasing the original observation', () => {
  const store = fixture(); const first = confirm(store, store.observe({ ...intake(), kind: 'verification' }).id)
  store.markDispatched(first.id, 'verification-ticket', 'verification-assignment')
  store.markReview(first.id, { reference: 'correction', summary: 'Original empty accessibility snapshot was misleading; History visually renders', recordedAt: new Date().toISOString(), state: 'ready' })
  const resolved = store.review(first.id, { revision: store.get(first.id)!.revision, decision: 'accept_evidence', outcome: 'no_repair_needed', evidenceReference: 'correction', requirements: first.requirements })
  expect(resolved.resolution).toMatchObject({ outcome: 'no_repair_needed', evidenceReference: 'correction', requirements: first.requirements, actor: 'local-operator', jobId: first.job!.id })
  expect(resolved.audit.some(event => event.event === 'no_repair_needed')).toBe(true)
  expect(resolved.occurrences).toEqual(first.occurrences)
  expect(resolved.reports[0]?.evidence).toContain('History visually renders')
  expect(resolved.state).toBe('resolved')
})

it('invalidates stale readiness for newer native work and accepts only a fresh ready report with explicit human review', () => {
  const store = fixture(); const first = confirm(store, store.observe(intake()).id)
  const second = confirm(store, store.observe(intake('second')).id)
  store.markDispatched(first.id, 'ticket', 'assignment')
  const oldReady = { reference: 'report:ready-old', summary: 'Ready before human review', recordedAt: '2026-11-06T17:00:00.000Z', state: 'ready' as const }
  const ready = store.markReview(first.id, oldReady)
  const working = store.markWorking(first.id, { reference: 'ticket/ticket/input/human-42', evidence: 'New human change request delivered; CI pending', at: '2026-11-06T17:01:00.000Z', token: 'input:human-42' })
  expect(working.state).toBe('running'); expect(working.revision).toBe(ready.revision + 1)
  expect(working.job).toEqual(ready.job); expect(working.blocker).toBeUndefined()
  expect(working.reports).toHaveLength(2)
  expect(working.reports.at(-1)).toMatchObject({ state: 'evidence', jobId: first.job!.id, currencyToken: 'input:human-42' })
  expect(store.nextQueued()).toBeUndefined()
  const accept = { revision: ready.revision, decision: 'accept_evidence' as const, evidenceReference: oldReady.reference, requirements: first.requirements }
  expect(() => store.review(first.id, accept)).toThrow('stale')
  expect(() => store.review(first.id, { ...accept, revision: working.revision })).toThrow('stale')
  expect(store.markReview(first.id, oldReady)).toEqual(working)
  const fresh = store.markReview(first.id, { ...oldReady, reference: 'report:ready-fresh', summary: 'Human request addressed and CI passed', recordedAt: '2026-11-06T17:02:00.000Z' })
  expect(fresh.state).toBe('blocked'); expect(fresh.reports).toHaveLength(3)
  expect(() => store.review(first.id, { ...accept, revision: fresh.revision })).toThrow('latest current-job')
  expect(() => store.review(first.id, { ...accept, revision: fresh.revision, evidenceReference: 'report:ready-fresh' }, 'model')).toThrow('local-operator')
  const accepted = store.review(first.id, { ...accept, revision: fresh.revision, evidenceReference: 'report:ready-fresh' })
  expect(accepted.state).toBe('resolved'); expect(accepted.resolution?.actor).toBe('local-operator')
  expect(store.nextQueued()?.id).toBe(second.id)
})

it('deduplicates working tokens durably per native job without reopening deferred or resolved findings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'finding-working-')); directories.push(directory)
  const path = join(directory, 'db.sqlite'); let store = fixture(path)
  const first = confirm(store, store.observe(intake()).id)
  const signal = { reference: 'ci:run:42', evidence: 'Current CI run pending', at: '2026-11-06T17:01:00.000Z', token: 'ci:42:pending' }
  expect(() => store.markWorking(first.id, signal)).toThrow('active dispatched')
  store.markDispatched(first.id, 'ticket-1', 'assignment-1')
  const working = store.markWorking(first.id, signal)
  expect(store.markWorking(first.id, signal)).toEqual(working)
  open.pop()!.close(); store = fixture(path)
  expect(store.markWorking(first.id, signal)).toEqual(working)
  store.markBlocked(first.id, 'Further work required')
  store.review(first.id, { revision: store.get(first.id)!.revision, decision: 'retry_scope' })
  confirm(store, first.id); store.markDispatched(first.id, 'ticket-2', 'assignment-2')
  const nextJob = store.markWorking(first.id, signal)
  expect(nextJob.reports.filter(report => report.currencyToken === signal.token)).toHaveLength(2)
  expect(nextJob.job?.id).not.toBe(first.job?.id)
  store.markReview(first.id, { reference: 'ready', summary: 'CI passed', recordedAt: '2026-11-06T17:02:00.000Z', state: 'ready' })
  const deferred = store.review(first.id, { revision: store.get(first.id)!.revision, decision: 'defer' })
  expect(() => store.markWorking(first.id, signal)).toThrow('active dispatched')
  expect(store.get(first.id)).toEqual(deferred)
  const other = confirm(store, store.observe(intake('resolved')).id)
  store.markDispatched(other.id, 'ticket-3', 'assignment-3')
  store.markReview(other.id, { reference: 'ready', summary: 'Verified', recordedAt: '2026-11-06T17:02:00.000Z', state: 'ready' })
  store.review(other.id, { revision: store.get(other.id)!.revision, decision: 'accept_evidence', evidenceReference: 'ready', requirements: other.requirements })
  expect(() => store.markWorking(other.id, signal)).toThrow('active dispatched')
})

it('canonical projection replaces its own identity without duplicating or staging findings', () => {
  const store = fixture(); const first = store.observe(intake())
  const decision = findingDecision(first)
  const projected = projectFindings(store, [decision])
  expect(projected).toHaveLength(1)
  expect(projected[0]).toMatchObject({ id: `finding-${first.id}`, actionMode: 'finding_triage', status: 'pending', finding: { scope: first.scope } })
  confirm(store, first.id, 'defer')
  expect(projectFindings(store, projected)[0]).toMatchObject({ status: 'resolved', resolvedChoice: 'defer' })
})
