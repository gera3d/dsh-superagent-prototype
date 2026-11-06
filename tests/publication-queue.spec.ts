import { expect, it } from 'vitest'
import { decisionNeedsAttention, decisionInHistory, publicationCompleted } from '../src/core/publication-queue.ts'
import type { PendingDecisionItem } from '../src/core/decision.ts'
import type { PublicationSnapshot } from '../src/app/publication.ts'
function fixture(status: PublicationSnapshot['status'], original: PendingDecisionItem['status'] = 'stale'): PendingDecisionItem {
  const stage = status === 'rolled_back' ? 'rollback' : 'verify'
  return { id: 'life-example', status: original, lifecycle: { kind: 'done', assignmentId: 'a', recovery: true,
    publication: { id: 'publication', status, outcomes: [{ stage, status: 'succeeded' }] } as PublicationSnapshot } } as PendingDecisionItem
}
for (const original of ['pending', 'stale'] as const) for (const status of ['published', 'rolled_back'] as const) {
  it(`retires ${status} from ${original} into operational history without rewriting native proof`, () => {
    const item = fixture(status, original), before = structuredClone(item)
    expect(publicationCompleted(item)).toBe(true)
    expect(decisionNeedsAttention(item)).toBe(false)
    expect(decisionInHistory(item)).toBe(true)
    expect(item).toEqual(before)
    expect(item.resolutionBasis).toBeUndefined()
    expect(item.submittedMessageId).toBeUndefined()
  })
}
for (const status of ['prepared', 'merged', 'blocked', 'failed', 'interrupted'] as const) it(`retains genuine ${status} recovery in attention`, () => {
  const item = fixture(status)
  expect(publicationCompleted(item)).toBe(false)
  expect(decisionNeedsAttention(item)).toBe(true)
  expect(decisionInHistory(item)).toBe(false)
})
it('does not retire unverified, failed, or still-running terminal claims', () => {
  for (const change of [
    (p: PublicationSnapshot) => { p.outcomes = [] },
    (p: PublicationSnapshot) => { p.outcomes[0]!.status = 'failed' },
    (p: PublicationSnapshot) => { p.outcomes.push({ ...p.outcomes[0]!, status: 'running' }) },
    (p: PublicationSnapshot) => { p.coordination = { grantId: 'g', status: 'running', createdAt: '', updatedAt: '' } },
  ]) { const item = fixture('published'); change(item.lifecycle!.publication!); expect(decisionNeedsAttention(item)).toBe(true) }
})
it('keeps ordinary decision status semantics unchanged', () => {
  for (const status of ['pending', 'resolved', 'stale'] as const) {
    const item = { status } as PendingDecisionItem
    expect(decisionNeedsAttention(item)).toBe(status === 'pending')
    expect(decisionInHistory(item)).toBe(status === 'resolved')
  }
})
