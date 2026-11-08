import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DecisionInbox } from '../src/app/decision-inbox.ts'
import { DeliveryStore } from '../src/app/feature-delivery.ts'
import { reconcileInboxCurrency } from '../src/app/delivery-runtime.ts'
import { adviceContext } from '../src/app/advice-context.ts'
import { ProgressStore, type ProgressInput } from '../src/app/progress.ts'

const dbs: DatabaseSync[] = []
afterEach(() => dbs.splice(0).forEach(db => db.close()))
const T0 = Date.parse('2026-11-07T20:00:00Z'), iso = (offset: number) => new Date(T0 + offset).toISOString()
const provenance = { source: 'operator' as const, reference: 'test:outside-progress', actor: 'local-operator' }
// Actual outside progress: Codex pushed this branch after the Sonnet quality worker returned its scored "Push branch" card.
// Bounded fixture only: the Sonnet task id is not known here, so a stand-in ticket is used; no work is sent and nothing is accepted.
const BASE = '7600848d8520496947d9752d25d871fd97c7b333', PUSHED = '52af0dfd320b57226669c363af0ba38a1823a4ad', MOVED = '9'.repeat(40)
const sonnet = { ticketId: 'sonnet-quality', repository: 'gera3d/dsh-superagent-prototype', branch: 'codex/bounded-sonnet-quality', baseSha: BASE, owner: 'Codex (outside the worker conversation)' }
const pushed = (over: Partial<ProgressInput> = {}): ProgressInput => ({ ...sonnet, kind: 'branch_pushed', commit: PUSHED, evidence: 'git ls-remote shows branch at 52af0df', observedAt: iso(1000), ...over })
const open = (over: Partial<ProgressInput> = {}) => pushed({ kind: 'pr_opened', pr: 77, evidence: 'gh pr view 77', observedAt: iso(2000), ...over })

const push = [{ id: 'push', label: 'Push branch', prompt: 'Push codex/bounded-sonnet-quality to origin and open the exact-base PR.', why: 'Publish the work', recommended: true },
  { id: 'inspect', label: 'Inspect diff', prompt: 'Inspect the diff first.', why: 'Review', recommended: false }]
const license = [{ id: 'mit', label: 'Use MIT license', prompt: 'Use the MIT license.', why: 'Permissive', recommended: true },
  { id: 'apache', label: 'Use Apache license', prompt: 'Use Apache 2.0.', why: 'Patent grant', recommended: false }]
function fixture() {
  const db = new DatabaseSync(':memory:'); dbs.push(db)
  const inbox = new DecisionInbox(db), deliveries = new DeliveryStore(db), progress = new ProgressStore(db)
  let n = 0
  const advice = (time: number, sessionId = 'worker-sonnet-quality', options = push, text = 'Ready for review.') => {
    const message = `m${++n}`, source = { sessionId, sourceMessageId: message, sourceTurn: n, sourceSeq: 4 * n - 2, draftRevision: `rev-${message}` }
    const events = [
      { type: 'user/message', seq: 4 * n - 4, time: time - 2, data: { id: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Do the work.' }] } },
      { type: 'turn/start', seq: 4 * n - 3, time: time - 1, data: { turn: n } },
      { type: 'assistant/message', seq: 4 * n - 2, time, data: { turn: n, message: { id: message, content: [{ type: 'text', text }] } } },
      { type: 'turn/end', seq: 4 * n - 1, time: time + 1, data: { turn: n, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]
    const claim = inbox.claimCanonical({ ...source, owner: 'helper' }, events)
    return inbox.publishCanonical({ ...source, leaseToken: claim.leaseToken!, model: 'actual-helper', options }, events).item
  }
  const reconcile = () => reconcileInboxCurrency(inbox, deliveries, undefined, undefined, progress)
  return { db, inbox, deliveries, progress, advice, reconcile }
}

it('retires the Sonnet "Push branch" card after the branch was pushed outside the worker, without authority or deleting choices', () => {
  const f = fixture()
  const card = f.advice(T0), next = f.advice(T0 + 10, 'worker-sonnet-quality', [{ ...push[0]!, id: 'pr', label: 'Open exact-base PR', prompt: 'Open the exact-base PR.' }, push[1]!])
  const unrelated = f.advice(T0, 'worker-someone-else')
  const later = f.advice(T0 + 60_000, 'worker-sonnet-quality', license, 'Which license should the repo use?')
  const delivery = JSON.stringify(f.deliveries.list())
  const { observation, duplicate } = f.progress.observe(pushed(), provenance, T0 + 30_000)
  expect(duplicate).toBe(false); expect(observation).toMatchObject({ authority: 'none', commit: PUSHED, baseSha: BASE, provenance })
  f.reconcile()
  const retired = f.inbox.get(card.id)!
  expect(retired).toMatchObject({ status: 'stale', choices: card.choices, recommendation: card.recommendation })
  expect(retired.staleReason).toContain('branch_pushed'); expect(retired.staleReason).toContain('Open an exact-base pull request')
  expect(() => f.inbox.stage(card.id, { choiceId: 'push', attemptId: '123e4567-e89b-42d3-a456-426614174000', draftText: push[0]!.prompt })).toThrow('stale')
  // The next step (open the PR) is still current, a newer unrelated question and other sessions are untouched.
  for (const id of [next.id, unrelated.id, later.id]) expect(f.inbox.get(id)?.status).toBe('pending')
  expect(JSON.stringify(f.deliveries.list())).toBe(delivery)
  const before = JSON.stringify(f.inbox.list()); f.reconcile(); expect(JSON.stringify(f.inbox.list())).toBe(before)
  const context = adviceContext(undefined, undefined, f.progress.current('worker-sonnet-quality'))
  expect(context).toContain('EXTERNAL PROGRESS'); expect(context).toContain('branch_pushed is already done'); expect(context).toContain('52af0dfd320b')
  expect(context).toContain('not authority to execute, publish, merge, deploy or accept'); expect(context).toContain('"authority":"none"')
  expect(adviceContext(undefined, undefined, undefined)).not.toContain('EXTERNAL PROGRESS')
})

it('stages a stale selection only if it is still current, keeping an unsent staged draft as history when retired', () => {
  const f = fixture(), card = f.advice(T0)
  const staged = f.inbox.stage(card.id, { choiceId: 'push', attemptId: '123e4567-e89b-42d3-a456-426614174001', draftText: push[0]!.prompt }).item
  f.progress.observe(pushed(), provenance, T0 + 5000); f.reconcile()
  expect(f.inbox.get(card.id)).toMatchObject({ status: 'stale', staging: staged.staging, sourceMessageId: card.sourceMessageId })
  expect(f.inbox.get(card.id)?.resolvedChoice).toBeUndefined()
  // Submission of the retired staged draft is refused before anything is sent.
  expect(() => f.inbox.linkSubmission(card.id, { attemptId: staged.staging!.attemptId, submissionId: 'native-1' } as never)).toThrow('stale or closed')
})

it('folds branch-pushed, PR-opened, checks and review progress, ignoring duplicates and out-of-order reports', () => {
  const f = fixture(), p = f.progress
  const first = p.observe(open(), provenance, T0 + 3000)
  expect(p.current('sonnet-quality')).toMatchObject({ kind: 'pr_opened', pr: 77, revision: first.observation.seq })
  // Late older push report: kept as history, never regresses the stage.
  p.observe(pushed(), provenance, T0 + 3100)
  expect(p.current('worker-sonnet-quality')).toMatchObject({ kind: 'pr_opened', observations: 2, revision: first.observation.seq })
  const dup = p.observe(open({ evidence: 'repeated', observedAt: iso(9000) }), provenance, T0 + 4000)
  expect(dup).toMatchObject({ duplicate: true }); expect(dup.observation.seq).toBe(first.observation.seq); expect(p.history('sonnet-quality')).toHaveLength(2)
  p.observe(pushed({ kind: 'checks', pr: 77, outcome: 'pending', observedAt: iso(3000) }), provenance, T0 + 5000)
  expect(p.current('sonnet-quality')).toMatchObject({ kind: 'checks', outcome: 'pending' })
  expect(p.current('sonnet-quality')!.remaining).toContain('rerun')
  p.observe(pushed({ kind: 'checks', pr: 77, outcome: 'passed', observedAt: iso(4000) }), provenance, T0 + 6000)
  expect(p.current('sonnet-quality')).toMatchObject({ kind: 'checks', outcome: 'passed', remaining: 'Source review' })
  p.observe(pushed({ kind: 'review', pr: 77, observedAt: iso(5000), evidence: 'approved at head' }), provenance, T0 + 7000)
  const done = p.current('sonnet-quality')!
  expect(done).toMatchObject({ kind: 'review', authority: 'none', observations: 5 }); expect(done.remaining).toContain('grants neither')
  expect(p.history('sonnet-quality').map(o => o.kind)).toEqual(['pr_opened', 'branch_pushed', 'checks', 'checks', 'review'])
  expect(p.current('other-ticket')).toBeUndefined()
})

it('requires exact source identity and the evidence each stage needs', () => {
  const p = fixture().progress
  expect(() => p.observe(pushed({ commit: '52af0df' }), provenance)).toThrow()
  expect(() => p.observe(pushed({ kind: 'pr_opened' }), provenance)).toThrow('pull request')
  expect(() => p.observe(pushed({ kind: 'checks', pr: 1 }), provenance)).toThrow('outcome')
  expect(() => p.observe({ ...pushed(), execute: true } as never, provenance)).toThrow()
  expect(p.history('sonnet-quality')).toHaveLength(0)
})

it('supersedes advice for a changed head, while a late report for the old head cannot take over', () => {
  const f = fixture(), p = f.progress
  p.observe(pushed(), provenance, T0 + 1000)
  const old = f.advice(T0 + 2000, 'worker-sonnet-quality', [{ id: 'review', label: 'Check candidate 52af0df', prompt: 'Verify 52af0df exactly.', why: 'Pinned head', recommended: true }, push[1]!])
  const fresh = f.advice(T0 + 9_000_000, 'worker-sonnet-quality', license, 'Which license?')
  p.observe(pushed({ commit: MOVED, observedAt: iso(500_000) }), provenance, T0 + 600_000); f.reconcile()
  expect(p.current('sonnet-quality')).toMatchObject({ commit: MOVED, supersededCommits: [PUSHED], revision: 2 })
  expect(f.inbox.get(old.id)).toMatchObject({ status: 'stale', choices: old.choices }); expect(f.inbox.get(old.id)?.staleReason).toContain('superseded head')
  expect(f.inbox.get(fresh.id)?.status).toBe('pending')
  p.observe(open({ observedAt: iso(2000), pr: 5 }), provenance, T0 + 700_000)
  expect(p.current('sonnet-quality')).toMatchObject({ commit: MOVED, kind: 'branch_pushed', observations: 3 })
  expect(p.history('sonnet-quality')).toHaveLength(3)
})

it('does not let progress reopen or retire work covered by an accepted delivery, nor new-scope advice', () => {
  const f = fixture()
  const d = f.deliveries.create({ id: 'feature', title: 'feature', owner: 'release operator', authorities: ['local-operator'], workers: ['sonnet-quality'], requirements: ['x'], bindings: { repository: sonnet.repository, sourceIssue: 1, baseSha: BASE, headSha: PUSHED, environment: 'test' } })
  const done = f.deliveries.compareAndSwap(d.id, d.revision, v => { v.state = 'awaiting_decision'; v.stage = 'verifying'; v.evidence = [
    { id: 'published', kind: 'publication', bindings: v.bindings, recordedAt: iso(0), reference: 'test:published', outcome: 'passed' },
    { id: 'native', kind: 'verification', bindings: v.bindings, recordedAt: iso(0), reference: 'test:native', outcome: 'passed', requirements: v.requirements }] })
  const accepted = f.deliveries.confirm(d.id, { revision: done.revision, actionId: done.nextAction!.id }, { actor: 'local-operator', source: 'local_operator', reference: 'test:acceptance', scope: done.nextAction!.fingerprint })
  const at = Date.parse(accepted.acceptance!.at)
  const newScope = f.advice(at + 1000)
  f.progress.observe(pushed({ observedAt: new Date(at - 60_000).toISOString() }), provenance, at + 5000); f.reconcile()
  expect(f.inbox.get(newScope.id)?.status).toBe('pending')
  expect(f.deliveries.get('feature')).toEqual(accepted)
  const context = adviceContext(undefined, accepted, f.progress.current('sonnet-quality'))
  expect(context).toContain('RELEASE COMPLETE'); expect(context).not.toContain('EXTERNAL PROGRESS'); expect(context).toContain('"progress":null')
  // Genuinely newer outside progress after acceptance is still plain data: the delivery stays accepted and unchanged.
  f.progress.observe(open({ observedAt: new Date(at + 60_000).toISOString() }), provenance, at + 90_000); f.reconcile()
  expect(f.deliveries.get('feature')).toEqual(accepted)
})
