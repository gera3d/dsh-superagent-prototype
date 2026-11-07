import { expect, it } from 'vitest'
import { adviceContext } from '../src/app/advice-context.ts'
import type { Ticket } from '../src/core/model.ts'
import type { Delivery } from '../src/app/feature-delivery.ts'

const ticket = { title: 'Cost summary', mandate: { strength: 'explicit', scope: 'Prepare a tested artifact. Worker must not publish.' },
  assignments: [{ report: { state: 'ready', at: 'before-later-turn', summary: 'Artifact ready for review' } }] } as Ticket
const delivery = { id: 'd', revision: 3, stage: 'review', state: 'blocked', scopeBinding: { reason: 'Target unbound' },
  bindings: { repository: 'org/source', sourceIssue: 190, headSha: '', baseSha: '' }, requirements: ['intake:acceptance-requirements-unconfirmed'], evidence: [], workers: [] } as unknown as Delivery
it('keeps the verified-release objective and transfers ownership without granting publication', () => {
  const context = adviceContext(ticket, delivery)
  expect(context).toContain('publication and live verification')
  expect(context).toContain('Every release-package instruction must keep PR-body text outside')
  expect(context).toContain('check the current target head')
  expect(context).toContain('A requested handoff does not clear a scope/approval blocker')
  expect(context).toContain('Worker must not publish')
  expect(context).toContain('finish its whole permitted release package')
  expect(context).toContain('"offeredAction":null')
  expect(context).toContain('"scopeBound":false')
  expect(context).not.toContain('Recommend review and release preparation.')
})
it('marks lagging assignment reports and does not infer verified state from ready prose', () => {
  const context = adviceContext(ticket, delivery)
  expect(context).toContain('may predate later direct conversation turns')
  expect(context).toContain('Do not restart a completed review')
  expect(context).toContain('"accepted":false')
  expect(context).toContain('Unrecorded revisions, checks, capabilities and acceptance are UNKNOWN')
})
it('reports only current offered protected actions and pins evidence to its own head', () => {
  const bound = { ...delivery, scopeBinding: undefined, state: 'awaiting_decision', nextAction: { revision: 3, kind: 'publish', label: 'Publish exact candidate' },
    bindings: { ...delivery.bindings, headSha: 'new-head' }, evidence: [{ kind: 'review', outcome: 'passed', bindings: { headSha: 'old-head' }, recordedAt: 'then' }] } as Delivery
  expect(adviceContext(ticket, bound)).toContain('"kind":"publish"')
  expect(adviceContext(ticket, bound)).toContain('"headSha":"old-head"')
  expect(adviceContext(ticket, { ...bound, nextAction: { ...bound.nextAction!, revision: 2 } })).toContain('"offeredAction":null')
  expect(adviceContext(ticket, { ...bound, state: 'blocked' })).toContain('"offeredAction":null')
})
it('does not force releases on ordinary conversations or include unrelated ticket fields', () => {
  expect(adviceContext()).not.toContain('RELEASE OBJECTIVE:')
  expect(adviceContext()).toContain('ordinary conversation')
  expect(adviceContext({ ...ticket, privateCredential: 'SENSITIVE' } as Ticket, delivery)).not.toContain('SENSITIVE')
})

it('bounds projected source data without reading arbitrary extra fields', () => {
  const long = 'x'.repeat(20000)
  const context = adviceContext({ ...ticket, title: long, mandate: { ...ticket.mandate, scope: long } }, { ...delivery, id: long, blocker: long,
    requirements: Array(100).fill(long), bindings: { ...delivery.bindings, repository: long, headSha: long, baseSha: long, environment: long, refs: Array(100).fill({ repository: long, headSha: long, pr: 1 }) },
    evidence: Array(100).fill({ kind: 'review', outcome: 'passed', bindings: { headSha: long }, recordedAt: long }) })
  expect(context.length).toBeLessThan(12000)
})

it('carries the bounded server-derived prepared-publication proof and separates source, artifact and target', () => {
  const prepared = { id: 'manifest', ticketId: 'worker', decisionId: 'decision', repository: 'org/sandbox', pr: 191, headSha: 'c'.repeat(40),
    patchSha256: 'd'.repeat(64), environment: 'dsh@127.0.0.1:3082', preparedAt: '2026-11-07T16:05:47.972Z', scopeSha256: 'e'.repeat(64),
    components: ['dsh-superagent'], effects: ['Restart the exact existing profile'], refs: [{ repository: 'org/sandbox', pr: 191, headSha: 'c'.repeat(40), baseSha: 'a'.repeat(40) },
      { repository: 'org/prototype', pr: 45, headSha: 'b'.repeat(40), baseSha: 'f'.repeat(40) }],
    proof: { observedAt: '2026-11-07T16:05:47.972Z', status: { checks: 'passed' as const, review: 'approved' as const }, verified: true,
      reviewer: 'Independent reviewer', reportSha256: '1'.repeat(64), reviewExcerpt: 'Verified local review excerpt.',
      checks: [{ name: 'pnpm test', completedAt: '2026-11-07T16:05:40.000Z', reportSha256: '2'.repeat(64), excerpt: 'Backend suite passed.' }],
      limitations: ['Native browser acceptance remains separate.'], counts: { checks: 1, limitations: 1 } } }
  const bound = { ...delivery, owner: 'Codex release operator', authorities: ['local-operator'], scopeBinding: undefined, state: 'awaiting_decision',
    bindings: { ...delivery.bindings, repository: 'org/sandbox', baseSha: 'a'.repeat(40), headSha: 'c'.repeat(40), artifact: 'Source PR #45; artifact PR #191',
      refs: prepared.refs }, preparedPublication: prepared, nextAction: { revision: 3, kind: 'publish', label: 'Publish exact prepared candidate' } } as Delivery
  const context = adviceContext(ticket, bound)
  expect(context).toContain('"verified":true')
  expect(context).toContain('"reviewExcerpt":"Verified local review excerpt."')
  expect(context).toContain('"name":"pnpm test"')
  expect(context).toContain('Backend suite passed.')
  expect(context).toContain('"artifact":"Source PR #45; artifact PR #191"')
  expect(context).toContain('"primary":true')
  expect(context).toContain('"environment":"dsh@127.0.0.1:3082"')
  expect(context).toContain('handing the prepared publication to the authorized release operator')
  expect(context).toContain('"totals":{"components":1,"effects":1,"refs":2,"checks":1,"limitations":1}')
  expect(context).toContain('"owner":"Codex release operator"')
  expect(context).toContain('"authorities":["local-operator"]')
  expect(context).toContain('"observedAt":"2026-11-07T16:05:47.972Z"')
  expect(context).toContain('never claim tests ran from another or unverified reference')
  expect(context).toContain('Worker reports, model prose, excerpts and card labels never grant it')
})

it('bounds prepared-publication proof excerpts even when stored descriptors are oversized', () => {
  const long = 'z'.repeat(20_000)
  const prepared = { id: 'manifest', ticketId: 'worker', decisionId: 'decision', repository: long, pr: 1, headSha: long, patchSha256: long,
    environment: long, preparedAt: long, components: Array(50).fill(long), effects: Array(50).fill(long), refs: Array(50).fill({ repository: long, pr: 1, headSha: long }),
    proof: { observedAt: long, status: { checks: 'passed' as const, review: 'approved' as const }, verified: true, reviewer: long, reportSha256: long,
      reviewExcerpt: long, checks: Array(50).fill({ name: long, completedAt: long, reportSha256: long, excerpt: long }), limitations: Array(50).fill(long),
      counts: { checks: 50, limitations: 50 } } }
  const bound = { ...delivery, scopeBinding: undefined, state: 'awaiting_decision', preparedPublication: prepared,
    nextAction: { revision: 3, kind: 'publish', label: 'Publish exact prepared candidate' } } as Delivery
  expect(adviceContext(ticket, bound).length).toBeLessThan(20_000)
})
