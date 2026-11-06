import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PublicationService, type PublicationEvidence } from '../src/app/publication.ts'
import { FilePublicationPersistence } from '../src/app/publication-persistence.ts'
import { publicationAction, publicationChoices, publicationConversation } from '../src/app/lifecycle-publication.ts'
import type { PendingDecisionItem } from '../src/core/decision.ts'

const pins = { repository: 'owner/repo', prNumber: 12, headSha: 'a'.repeat(40), patchSha256: 'b'.repeat(64) }
function fixture() {
  const item = { id: 'life-ticket-assignment', ticketId: 'ticket', sessionId: 'conversation', lifecycle: { kind: 'done', assignmentId: 'assignment', prNumber: 12 } } as PendingDecisionItem
  let state: PublicationEvidence['state'] = 'open'
  const stages: string[] = []
  const service = new PublicationService({ store: new FilePublicationPersistence(join(mkdtempSync(join(tmpdir(), 'publication-bridge-')), 'state.json')),
    adapter: { evidence: async () => ({ ...pins, observedAt: new Date().toISOString(), checks: 'passed', review: 'approved', mergeable: true, state }),
      perform: async stage => { stages.push(stage); if (stage === 'merge') state = 'merged'; return { detail: `${stage} fixture` } } } })
  const enqueue: import('../src/app/lifecycle-publication.ts').LifecyclePublication['enqueue'] = async (input, authority) => {
    const current = await service.snapshot(input.ticketId)
    if (input.action === 'publish' && current?.evidence?.state === 'open') {
      const merged = await service.act({ ...input, action: 'merge', requestId: `${input.requestId}:merge` }, { ...authority, action: 'merge' })
      if (merged.status !== 'merged') return merged
    }
    return service.act(input, authority)
  }
  return { item, stages, host: { service, pinsFor: () => pins, enqueue } }
}
describe('canonical lifecycle publication bridge', () => {
  it('one bound approval merges then deploys with truthful separate outcomes and deduplicates repeated clicks', async () => {
    const { item, stages, host } = fixture()
    const prepared = await publicationAction(host, item, pins.repository, 'prepare_publication', undefined, undefined, () => true)
    expect(publicationChoices(prepared).map(c => c.actionKind)).toContain('publish')
    const approval = { publicationId: prepared.id, requestId: 'click-1' }
    const result = await publicationAction(host, item, pins.repository, 'publish', approval, 'local-operator', () => true)
    expect(result.status).toBe('published')
    expect(stages).toEqual(['merge', 'apply', 'build', 'restart', 'verify'])
    await publicationAction(host, item, pins.repository, 'publish', approval, 'local-operator', () => true)
    expect(stages).toHaveLength(5)
    expect(result.conversationId).toBe(publicationConversation(item))
  })
  it('rejects unauthenticated/autonomous approval before effects', async () => {
    const { item, stages, host } = fixture()
    const prepared = await publicationAction(host, item, pins.repository, 'prepare_publication', undefined, undefined, () => true)
    await expect(publicationAction(host, item, pins.repository, 'publish', { publicationId: prepared.id, requestId: 'click' }, undefined, () => true)).rejects.toMatchObject({ status: 403 })
    expect(stages).toEqual([])
  })
  it('rejects changed PR, assignment, repository, conversation, and manifest', async () => {
    const { item, stages, host } = fixture()
    const prepared = await publicationAction(host, item, pins.repository, 'prepare_publication', undefined, undefined, () => true)
    const approval = { publicationId: prepared.id, requestId: 'click' }
    const variants = [ { ...item, id: 'new-assignment' }, { ...item, sessionId: 'other-conversation' },
      { ...item, lifecycle: { ...item.lifecycle!, prNumber: 13 } } ]
    for (const other of variants) await expect(publicationAction(host, other, pins.repository, 'publish', approval, 'local-operator', () => true)).rejects.toMatchObject({ status: 409 })
    await expect(publicationAction(host, item, 'other/repo', 'publish', approval, 'local-operator', () => true)).rejects.toMatchObject({ status: 409 })
    await expect(publicationAction({ ...host, pinsFor: () => ({ ...pins, headSha: 'c'.repeat(40) }) }, item, pins.repository, 'publish', approval, 'local-operator', () => true)).rejects.toMatchObject({ status: 409 })
    expect(stages).toEqual([])
  })
  it('stops before deployment when canonical ticket changes during merge', async () => {
    const { item, host, stages } = fixture()
    const prepared = await publicationAction(host, item, pins.repository, 'prepare_publication', undefined, undefined, () => true)
    const result = await publicationAction(host, item, pins.repository, 'publish', { publicationId: prepared.id, requestId: 'click' }, 'local-operator', () => stages.length === 0)
    expect(result.status).toBe('blocked')
    expect(stages).toEqual(['merge'])
  })
})
