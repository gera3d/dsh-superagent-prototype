import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PublicationService, type PublicationAction, type PublicationAdapter, type PublicationAuthority, type PublicationEvidence, type PublicationPrepareInput, type PublicationSnapshot, type PublicationStage } from '../src/app/publication.ts'
import { FilePublicationPersistence } from '../src/app/publication-persistence.ts'
import { snapshotProof } from '../src/app/publication-proof.ts'

const now = Date.parse('2026-11-06T00:00:00Z')
const pins: PublicationPrepareInput = { ticketId: 'ticket-1', conversationId: 'conversation-1', repository: 'owner/repo', prNumber: 159, headSha: 'a'.repeat(40), patchSha256: 'b'.repeat(64) }
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'publication-test-')); directories.push(directory)
  const path = join(directory, 'publication.json')
  let evidence: PublicationEvidence = { ...pins, observedAt: new Date(now).toISOString(), checks: 'passed', review: 'approved', mergeable: true, state: 'open' }
  const calls: PublicationStage[] = []
  const adapter: PublicationAdapter = {
    evidence: async () => structuredClone(evidence),
    perform: async stage => { calls.push(stage); if (stage === 'merge') evidence.state = 'merged'; return { detail: `${stage} complete` } },
  }
  const store = new FilePublicationPersistence(path)
  const service = new PublicationService({ store, adapter, now: () => now, evidenceRetryDelayMs: 0 })
  const authority = (p: PublicationSnapshot, action: PublicationAction): PublicationAuthority => ({ kind: 'human_click', actorId: 'operator', authorized: true, ticketId: p.ticketId, conversationId: p.conversationId, publicationId: p.id, action })
  const act = (p: PublicationSnapshot, action: PublicationAction, requestId: string = action) => service.act({ ticketId: p.ticketId, conversationId: p.conversationId, publicationId: p.id, requestId, action }, authority(p, action))
  return { path, store, service, calls, adapter, authority, act, evidence }
}

describe('publication state machine', () => {
  it('prepares without operating, separates merge from every publish outcome and explicit rollback', async () => {
    const f = fixture(), p = await f.service.prepare(pins)
    expect(p.status).toBe('prepared'); expect(f.calls).toEqual([])
    const early = await f.act(p, 'publish', 'too-early')
    expect(early.status).toBe('blocked'); expect(f.calls).toEqual([])
    expect((await f.act(p, 'merge')).status).toBe('merged')
    const result = await f.act(p, 'publish')
    expect(result.status).toBe('published')
    expect(result.outcomes.map(o => [o.stage, o.status])).toEqual(['merge', 'apply', 'build', 'restart', 'verify'].map(s => [s, 'succeeded']))
    expect((await f.act(p, 'rollback')).status).toBe('rolled_back')
    expect(f.calls).toEqual(['merge', 'apply', 'build', 'restart', 'verify', 'rollback'])
    expect(result.audit.some(a => a.event === 'authorized' && a.actorId === 'operator')).toBe(true)
  })
  it('retries only pure transient post-merge evidence without replaying successful effects', async () => {
    for (const transient of ['open', 'pending', 'error'] as const) {
      const f = fixture(), p = await f.service.prepare(pins)
      await f.act(p, 'merge')
      let reads = 0
      f.adapter.evidence = async () => {
        reads++
        if (reads === 1) {
          if (transient === 'error') throw new Error('GitHub briefly unavailable')
          return { ...f.evidence, state: transient === 'open' ? 'open' : 'merged', checks: transient === 'pending' ? 'pending' : 'passed' }
        }
        return structuredClone(f.evidence)
      }
      const published = await f.act(p, 'publish')
      expect(published.status).toBe('published'); expect(published.audit.some(a => a.event === 'evidence_retry')).toBe(true)
      expect(f.calls).toEqual(['merge', 'apply', 'build', 'restart', 'verify'])
    }
  })
  it('refreshes a merged blocked release with same pins and resumes only remaining successful-safe stages', async () => {
    const f = fixture(), p = await f.service.prepare(pins)
    await f.act(p, 'merge')
    f.evidence.checks = 'failed'
    expect((await f.act(p, 'publish', 'blocked')).status).toBe('blocked')
    f.evidence.checks = 'passed'
    const refreshed = await f.service.prepare(pins)
    expect(refreshed.id).toBe(p.id); expect(refreshed.status).toBe('merged')
    expect(f.calls).toEqual(['merge'])
    expect((await f.act(p, 'publish', 'resume')).status).toBe('published')
    expect(f.calls.filter(stage => stage === 'merge')).toHaveLength(1)
  })
  it('fails closed when head or patch changes after prepare', async () => {
    for (const field of ['headSha', 'patchSha256'] as const) {
      const f = fixture(), p = await f.service.prepare(pins)
      f.evidence[field] = 'c'.repeat(field === 'headSha' ? 40 : 64)
      expect((await f.act(p, 'merge')).status).toBe('blocked')
      expect(f.calls).toEqual([])
    }
  })
  it('requires fresh successful checks, approved review, open mergeable PR and exact repository/PR', async () => {
    const changes: Partial<PublicationEvidence>[] = [
      { checks: 'failed' }, { checks: 'pending' }, { review: 'required' }, { review: 'changes_requested' },
      { mergeable: false }, { observedAt: new Date(now - 60_001).toISOString() }, { observedAt: 'invalid' },
      { state: 'closed' }, { repository: 'other/repo' }, { prNumber: 160 },
    ]
    for (const change of changes) {
      const f = fixture(), p = await f.service.prepare(pins)
      Object.assign(f.evidence, change)
      expect((await f.act(p, 'merge')).status).toBe('blocked')
      expect(f.calls).toEqual([])
    }
  })
  it('does not reuse preparation evidence and rechecks between deployment stages', async () => {
    const f = fixture(), p = await f.service.prepare(pins)
    await f.act(p, 'merge')
    f.adapter.perform = async stage => { f.calls.push(stage); if (stage === 'apply') f.evidence.checks = 'failed'; return { detail: stage } }
    const result = await f.act(p, 'publish')
    expect(result.status).toBe('blocked'); expect(f.calls).toEqual(['merge', 'apply'])
    expect(result.outcomes.find(o => o.stage === 'apply')?.status).toBe('succeeded')
  })
  it('revalidates trusted canonical authority after async gates and before every stage', async () => {
    const f = fixture(), p = await f.service.prepare(pins)
    let current = true
    f.adapter.evidence = async () => { current = false; return structuredClone(f.evidence) }
    const input = { ticketId: p.ticketId, conversationId: p.conversationId, publicationId: p.id, action: 'merge' as const, requestId: 'gate-race' }
    const blocked = await f.service.act(input, { ...f.authority(p, 'merge'), isCurrent: () => current })
    expect(blocked.status).toBe('blocked'); expect(f.calls).toEqual([])
    expect(blocked.audit.at(-1)?.event).toBe('authority_invalidated')
    f.adapter.evidence = async () => structuredClone(f.evidence)
    current = true
    await f.act(p, 'merge')
    f.adapter.perform = async stage => { f.calls.push(stage); current = false; return { detail: stage } }
    const partial = await f.service.act({ ...input, action: 'publish', requestId: 'stage-race' }, { ...f.authority(p, 'publish'), isCurrent: () => current })
    expect(partial.status).toBe('blocked'); expect(f.calls).toEqual(['merge', 'apply'])
  })
  it('rejects missing, autopilot and mismatched authority; accepts explicit operator instruction', async () => {
    const f = fixture(), p = await f.service.prepare(pins)
    const input = { ticketId: p.ticketId, conversationId: p.conversationId, publicationId: p.id, action: 'merge' as const, requestId: 'click' }
    for (const authority of [undefined, { ...f.authority(p, 'merge'), kind: 'autopilot' }, { ...f.authority(p, 'merge'), authorized: false }, { ...f.authority(p, 'merge'), action: 'publish' }, { ...f.authority(p, 'merge'), conversationId: 'other' }]) {
      await expect(f.service.act(input, authority as PublicationAuthority)).rejects.toMatchObject({ status: 403 })
    }
    expect(f.calls).toEqual([])
    await f.service.act(input, { ...f.authority(p, 'merge'), kind: 'operator_instruction' })
    expect(f.calls).toEqual(['merge'])
  })
  it('rejects cross-conversation binding, repinning side effects and outdated publication ids', async () => {
    const f = fixture(), p = await f.service.prepare(pins)
    await expect(f.service.act({ ticketId: p.ticketId, conversationId: 'other', publicationId: p.id, requestId: 'x', action: 'merge' }, f.authority(p, 'merge'))).rejects.toMatchObject({ status: 403 })
    const p2 = await f.service.prepare({ ...pins, headSha: 'c'.repeat(40) })
    await expect(f.act(p, 'merge')).rejects.toMatchObject({ status: 404 })
    f.evidence.headSha = p2.headSha
    await f.act(p2, 'merge')
    await expect(f.service.prepare(pins)).rejects.toMatchObject({ status: 409 })
  })
  it('archives effect-free old decisions and completed releases with new immutable binding ids', async () => {
    const f = fixture(), old = await f.service.prepare(pins)
    const next = await f.service.prepare({ ...pins, conversationId: 'next-decision' })
    expect(next.id).not.toBe(old.id)
    await expect(f.act(old, 'merge')).rejects.toMatchObject({ status: 404 })
    await f.act(next, 'merge'); await f.act(next, 'publish')
    const release = await f.service.prepare({ ...pins, conversationId: 'third-decision' })
    expect(release.id).not.toBe(next.id)
    await f.store.exclusive(async () => {
      const d = f.store.load()
      expect(d.publications[old.id]?.audit[0]?.event).toBe('prepared')
      expect(d.publications[next.id]?.status).toBe('published')
      expect(Object.keys(d.publications)).toHaveLength(3)
    })
  })
  it('makes repeated clicks durable and refuses idempotency key reuse', async () => {
    const f = fixture(), p = await f.service.prepare(pins)
    await f.act(p, 'merge', 'same-click')
    await f.act(p, 'merge', 'same-click'); await f.act(p, 'merge', 'new-click')
    const restarted = new PublicationService({ store: new FilePublicationPersistence(f.path), adapter: f.adapter, now: () => now })
    await restarted.act({ ticketId: p.ticketId, conversationId: p.conversationId, publicationId: p.id, requestId: 'same-click', action: 'merge' }, f.authority(p, 'merge'))
    expect(f.calls).toEqual(['merge'])
    await expect(f.act(p, 'publish', 'same-click')).rejects.toMatchObject({ status: 409 })
  })
  it('records partial failure, stops before restart and only explicit rollback proceeds', async () => {
    const f = fixture(), p = await f.service.prepare(pins)
    await f.act(p, 'merge')
    f.adapter.perform = async stage => { f.calls.push(stage); if (stage === 'build') throw new Error('Build failed'); return { detail: stage } }
    const result = await f.act(p, 'publish')
    expect(result.status).toBe('failed'); expect(f.calls).toEqual(['merge', 'apply', 'build'])
    expect(result.outcomes.at(-1)).toMatchObject({ stage: 'build', status: 'failed', detail: 'Build failed' })
    await expect(f.act(p, 'publish', 'retry')).rejects.toMatchObject({ status: 409 })
    expect((await f.act(p, 'rollback')).status).toBe('rolled_back')
    expect(f.calls.at(-1)).toBe('rollback')
  })
  it('recovers write-ahead interrupted state without retrying, including after another restart', async () => {
    const f = fixture(), p = await f.service.prepare(pins)
    await f.store.exclusive(async () => {
      const d = f.store.load(), stored = d.publications[p.id]!
      stored.outcomes.push({ stage: 'merge', operationId: `${p.id}:merge`, status: 'running', startedAt: new Date(now).toISOString() })
      f.store.save(d)
    })
    const restarted = new PublicationService({ store: new FilePublicationPersistence(f.path), adapter: f.adapter, now: () => now })
    const recovered = await restarted.snapshot(p.ticketId)
    expect(recovered?.status).toBe('interrupted'); expect(recovered?.outcomes[0]?.status).toBe('interrupted')
    expect(f.calls).toEqual([])
    await expect(f.act(p, 'merge')).rejects.toMatchObject({ status: 409 })
    expect((await f.service.snapshot(p.ticketId))?.audit.filter(a => a.event === 'interrupted')).toHaveLength(1)
    expect((await f.act(p, 'rollback')).status).toBe('rolled_back')
  })
  it('quarantines failed/partial releases globally until an explicit rollback resolves them', async () => {
    const f = fixture(), p = await f.service.prepare(pins)
    const p2 = await f.service.prepare({ ...pins, ticketId: 'ticket-2' })
    await f.act(p, 'merge')
    const originalPerform = f.adapter.perform
    f.adapter.perform = async (stage, binding, id) => { if (stage === 'build') throw new Error('Build failed'); return originalPerform(stage, binding, id) }
    expect((await f.act(p, 'publish')).status).toBe('failed')
    await expect(f.act(p2, 'publish')).rejects.toMatchObject({ status: 409 })
    await f.act(p, 'rollback')
    f.adapter.perform = originalPerform
    expect((await f.act(p2, 'publish')).status).toBe('published')
  })
  it('never invokes an adapter if the write-ahead commit reports a failure', async () => {
    const f = fixture(), p = await f.service.prepare(pins)
    const save = f.store.save.bind(f.store)
    f.store.save = document => { save(document); if (document.publications[p.id]?.outcomes.some(o => o.status === 'running')) throw new Error('Simulated fsync failure') }
    await expect(f.act(p, 'merge')).rejects.toThrow('Simulated fsync failure')
    expect(f.calls).toEqual([])
    const restarted = new PublicationService({ store: new FilePublicationPersistence(f.path), adapter: f.adapter, now: () => now })
    expect((await restarted.snapshot(p.ticketId))?.status).toBe('interrupted')
    expect(f.calls).toEqual([])
  })
  it('serializes across service instances and tickets while an operation is pending', async () => {
    const f = fixture(), p = await f.service.prepare(pins)
    const other = new PublicationService({ store: new FilePublicationPersistence(f.path), adapter: f.adapter, now: () => now })
    const p2 = await other.prepare({ ...pins, ticketId: 'ticket-2' })
    let release!: () => void, entered!: () => void
    const enteredPromise = new Promise<void>(r => { entered = r })
    const held = new Promise<void>(r => { release = r })
    f.adapter.perform = async stage => { f.calls.push(stage); entered(); await held; return { detail: stage } }
    const running = f.act(p, 'merge')
    await enteredPromise
    try {
      await expect(f.act(p, 'merge', 'duplicate')).rejects.toMatchObject({ status: 409 })
      await expect(other.act({ ticketId: p2.ticketId, conversationId: p2.conversationId, publicationId: p2.id, requestId: 'race', action: 'merge' }, f.authority(p2, 'merge'))).rejects.toMatchObject({ status: 409 })
      expect(f.calls).toEqual(['merge'])
      expect((await other.snapshot(p.ticketId))?.outcomes.at(-1)?.status).toBe('running')
      expect((await f.service.snapshot(p.ticketId))?.outcomes.at(-1)?.status).toBe('running')
    } finally { release(); await running }
  })
  it('distinguishes restart, verification and rollback failure without automatic retries', async () => {
    for (const failedStage of ['restart', 'verify', 'rollback'] as const) {
      const f = fixture(), p = await f.service.prepare(pins)
      await f.act(p, 'merge')
      f.adapter.perform = async stage => { f.calls.push(stage); if (stage === failedStage) throw new Error(`${stage} failed`); return { detail: stage } }
      const deployed = await f.act(p, 'publish')
      if (failedStage !== 'rollback') {
        expect(deployed.status).toBe('failed')
        expect(deployed.outcomes.at(-1)).toMatchObject({ stage: failedStage, status: 'failed' })
        expect(deployed.status).not.toBe('published')
      }
      f.evidence.checks = 'failed'; f.evidence.headSha = 'd'.repeat(40)
      const rolledBack = await f.act(p, 'rollback')
      expect(rolledBack.status).toBe(failedStage === 'rollback' ? 'failed' : 'rolled_back')
      if (failedStage === 'rollback') {
        await expect(f.act(p, 'rollback', 'try-again')).rejects.toMatchObject({ status: 409 })
        expect(f.calls.filter(s => s === 'rollback')).toHaveLength(1)
      }
    }
  })
  it('refreshes previously blocked preparation without granting authority', async () => {
    const f = fixture()
    f.evidence.checks = 'failed'
    const blocked = await f.service.prepare(pins)
    expect(blocked.status).toBe('blocked')
    f.evidence.checks = 'passed'
    const ready = await f.service.prepare(pins)
    expect(ready.id).toBe(blocked.id); expect(ready.status).toBe('prepared'); expect(f.calls).toEqual([])
  })
  it('records read-only evidence failures without operations and rejects invalid pins', async () => {
    const f = fixture()
    f.adapter.evidence = async () => { throw new Error('gh unavailable') }
    const p = await f.service.prepare(pins)
    expect(p.status).toBe('blocked'); expect(p.audit.at(-1)?.detail).toBe('gh unavailable'); expect(f.calls).toEqual([])
    await expect(f.service.prepare({ ...pins, headSha: 'main' })).rejects.toMatchObject({ status: 400 })
  })
})


describe('pure advice peek', () => {
  it('reads a stored running outcome without recovery, save, audit or lease mutation', async () => {
    const f = fixture(), prepared = await f.service.prepare(pins)
    // A live owner has committed its write-ahead running outcome; only that owner may recover it.
    await f.store.exclusive(async () => {
      const document = f.store.load()
      document.publications[prepared.id]!.outcomes.push({ stage: 'merge', operationId: 'op-running', status: 'running', startedAt: new Date(now).toISOString() })
      f.store.save(document)
    })
    const committed = readFileSync(f.path, 'utf8')
    const save = vi.spyOn(f.store, 'save')
    const peeked = f.service.peek('ticket-1')
    expect(peeked?.outcomes.map(o => o.status)).toEqual(['running'])
    expect(save).not.toHaveBeenCalled()
    expect(readFileSync(f.path, 'utf8')).toBe(committed)
    // The advice read is a clone: mutating it cannot rewrite the journal or another caller's view.
    peeked!.status = 'interrupted'
    expect(f.store.peek().publications[prepared.id]!.status).toBe(prepared.status)
    expect(f.service.peek('ticket-1')?.status).toBe(prepared.status)
    const proof = await snapshotProof({ id: prepared.id, ticketId: prepared.ticketId, decisionId: 'decision', repository: prepared.repository,
      pr: prepared.prNumber, headSha: prepared.headSha, patchSha256: prepared.patchSha256, environment: 'isolated', preparedAt: prepared.updatedAt }, { service: f.service })
    expect(proof).toMatchObject({ verified: true, counts: { checks: 0, limitations: 0 } })
    expect(save).not.toHaveBeenCalled()
    expect(readFileSync(f.path, 'utf8')).toBe(committed)
  })
})
