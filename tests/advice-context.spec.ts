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
