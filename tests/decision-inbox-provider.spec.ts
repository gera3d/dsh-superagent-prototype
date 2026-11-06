import { expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, revalidateCapturedDecisions } from '../src/app/decision-inbox-provider.ts'
import { DecisionInbox } from '../src/app/decision-inbox.ts'
import type { PendingDecisionItem } from '../src/core/decision.ts'

it('independent provider persists staged choices without sending or retrying and enforces origin/errors', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-provider-'))
  const database = join(directory, 'orchestrator.sqlite')
  const db = new DatabaseSync(database); db.exec('CREATE TABLE ticket(id TEXT PRIMARY KEY,value TEXT NOT NULL)'); db.close()
  let dispose: (() => Promise<void>) | undefined
  const registrations = new Map<string, any>()
  let sessionEvent: any
  const histories = new Map<string, any[]>([['session', [
    { type: 'assistant/message', seq: 1, time: 100, data: { turn: 1, message: { id: 'message', content: [{ type: 'text', text: 'Which?' }] } } },
    { type: 'turn/end', seq: 2, time: 101, data: { turn: 1, reason: { kind: 'completed' } } },
  ]]])
  const ctx = { on: (_name: string, listener: any) => { sessionEvent = listener; return () => { sessionEvent = undefined } },  logger: { error: () => {}, warn: () => {} },
    effect: (effect: () => any) => { dispose = effect() },
    sessionPersistence: { flush: async () => {}, list: async () => [], open: async (id: string) => ({ read: async (offset: number) => ({ events: offset ? [] : histories.get(id) ?? [] }), [Symbol.asyncDispose]: async () => {} }) },
    webServer: { host: '127.0.0.1', port: 3082, register: (route: any) => {
      expect(route.kind).toBe('exact')
      expect(registrations.has(route.path)).toBe(false)
      registrations.set(route.path, route.handler)
      return () => { registrations.delete(route.path) }
    } } }
  async function call(method: string, path: string, body?: unknown, origin = 'http://127.0.0.1:3082') {
    let status = 0; let text = ''
    const handler = registrations.get(`/orchestrator/api/decisions/${path}`)
    if (!handler) return { status: 404, body: { error: 'No route; original management handler retains ownership' } }
    await handler({ method, url: `/orchestrator/api/decisions/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1', origin },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) } },
    { writeHead: (code: number) => { status = code }, end: (value: string) => { text = value } })
    return { status, body: JSON.parse(text) }
  }
  try {
    apply(ctx as any, { database })
    expect([...registrations.keys()]).toEqual(['/orchestrator/api/decisions/inbox', ...['claim', 'publish', 'score', 'fail'].map(operation => `/orchestrator/api/decisions/canonical/${operation}`)])
    histories.set('canonical-session', histories.get('session')!.map(event => structuredClone(event)))
    const source = { sessionId: 'canonical-session', sourceMessageId: 'message', sourceSeq: 1, sourceTurn: 1, draftRevision: 'revision-hash' }
    expect(await call('POST', 'canonical/claim', { ...source, owner: 'tab-a' }, 'http://evil.example')).toMatchObject({ status: 403 })
    const claim = await call('POST', 'canonical/claim', { ...source, owner: 'tab-a' })
    expect(claim).toMatchObject({ status: 200, body: { claimed: true, item: { choices: [], canonical: { phase: 'pending' } } } })
    expect(await call('POST', 'canonical/claim', { ...source, owner: 'tab-b' })).toMatchObject({ status: 200, body: { claimed: false } })
    const write = { ...source, leaseToken: claim.body.leaseToken }
    const options = [{ id: 'first', label: 'First', prompt: 'Complete first continuation', why: 'First reason', recommended: false }, { id: 'second', label: 'Second', prompt: 'Complete second continuation', why: 'Second reason', recommended: true }]
    const published = await call('POST', 'canonical/publish', { ...write, model: 'helper', options })
    expect(published).toMatchObject({ status: 200, body: { item: { choices: options.map(({ id, label, prompt, why }) => ({ id, label, prompt, description: why })), canonical: { phase: 'ready' } } } })
    const evaluation = { recommendedValue: 'first', confidence: 0.6, rationale: 'Scored rationale', distribution: [{ id: 'first', probability: 0.6 }, { id: 'second', probability: 0.4 }], provider: 'ranker', latencyMs: 10 }
    const scored = await call('POST', 'canonical/score', { ...write, evaluation })
    expect(scored).toMatchObject({ status: 200, body: { item: { recommendation: evaluation, canonical: { phase: 'scored' } } } })
    const projection = await call('GET', 'inbox')
    expect(projection.body.items.find((item: PendingDecisionItem) => item.id === claim.body.item.id)).toEqual(scored.body.item)
    const item = { id: 'inline:source:decision', sessionId: 'session', sourceMessageId: 'message', sourceSeq: 1, sourceTurn: 1, ticketTitle: 'Chat', trigger: 'Choose',
      status: 'pending', urgency: 'low', createdAt: 100, context: 'Context', question: 'Which?',
      choices: [{ id: 'a', label: 'Do A' }, { id: 'b', label: 'Do B' }], recommendation: { recommendedValue: '', confidence: 0,
        rationale: 'Not evaluated', distribution: [], provider: 'Not evaluated', latencyMs: 0 } }
    expect(await call('POST', 'inbox', item, 'http://evil.example')).toMatchObject({ status: 403 })
    expect(await call('POST', 'inbox', 'bad JSON')).toMatchObject({ status: 400 })
    expect(await call('POST', 'inbox', { ...item, choices: [item.choices[0], item.choices[0]] })).toMatchObject({ status: 400 })
    expect(await call('POST', 'inbox', item)).toMatchObject({ status: 200, body: { id: item.id } })
    expect(await call('POST', 'missing/resolve', { choiceId: 'a' })).toMatchObject({ status: 404 })
    expect(await call('POST', `${item.id}/resolve`, { choiceId: 'bad' })).toMatchObject({ status: 400 })
    expect(await call('POST', `${item.id}/resolve`, { choiceId: 'a' })).toMatchObject({ status: 409 })
    const attemptId = randomUUID(), draftText = 'Existing draft\nDo A'
    expect(await call('POST', `${item.id}/stage`, { choiceId: 'a', attemptId: 'invalid', draftText })).toMatchObject({ status: 400 })
    expect(await call('POST', `${item.id}/stage`, { choiceId: 'a', attemptId, draftText })).toMatchObject({ status: 200, body: { item: { status: 'pending' }, execution: 'not_executed' } })
    expect(await call('POST', `${item.id}/submission`, { attemptId, submissionId: 'native-send' })).toMatchObject({ status: 200, body: { item: { status: 'pending' } } })
    const admitted = { type: 'user/message', seq: 3, time: 103, data: { id: 'native-message', source: { kind: 'user', rpcId: 'native-send' }, content: [{ type: 'text', text: draftText }] } }
    histories.get('session')!.push(admitted)
    await sessionEvent({ id: 'session', header: {}, snapshotEvents: () => histories.get('session') }, admitted)
    const result = await call('POST', `${item.id}/resolve`, { choiceId: 'a' })
    expect(result).toMatchObject({ status: 200, body: { resolved: true, execution: 'not_executed', draft: { sessionId: 'session', text: 'Do A' } } })
    expect(await call('POST', `${item.id}/resolve`, { choiceId: 'a' })).toEqual(result)
    expect(await call('POST', `${item.id}/resolve`, { choiceId: 'b' })).toMatchObject({ status: 409 })
    expect(registrations.has(`/orchestrator/api/decisions/${encodeURIComponent(item.id)}/resolve`)).toBe(true)
    // Restart preserves the parent and exposes the child routes in this provider too.
    histories.get('session')!.push(
      { type: 'turn/start', seq: 4, time: 104, data: { turn: 2 } },
      { type: 'assistant/message', seq: 5, time: 105, data: { turn: 2, message: { id: 'follow-up', content: [{ type: 'text', text: 'The previous action completed.' }] } } },
      { type: 'turn/end', seq: 6, time: 106, data: { turn: 2, reason: { kind: 'completed' } } },
    )
    expect(await call('POST', `${item.id}/restart`, { sessionId: 'session' }, 'http://evil.example')).toMatchObject({ status: 403 })
    expect(await call('POST', `${item.id}/restart`, { sessionId: 'session', restartAfterSeq: 0 })).toMatchObject({ status: 400 })
    expect(await call('POST', `${item.id}/restart`, { sessionId: 'other' })).toMatchObject({ status: 409 })
    const restarted = await call('POST', `${item.id}/restart`, { sessionId: 'session' })
    expect(restarted).toMatchObject({ status: 200, body: { execution: 'not_executed', item: { status: 'pending', parentDecisionId: item.id, restartAfterSeq: 6 } } })
    const childId = restarted.body.item.id
    expect((await call('POST', `${item.id}/restart`, { sessionId: 'session' })).body.item.id).toBe(childId)
    expect(registrations.has(`/orchestrator/api/decisions/${childId}/stage`)).toBe(true)
    expect(await call('POST', `${childId}/restart`, { sessionId: 'session' })).toMatchObject({ status: 409 })
    expect(await call('POST', `${childId}/stage`, { choiceId: 'b', attemptId: randomUUID(), draftText: 'Do B' })).toMatchObject({ status: 200, body: { item: { status: 'pending' } } })
    expect((await call('GET', 'inbox')).body.items.find((entry: any) => entry.id === item.id)).toMatchObject({ status: 'resolved', resolvedChoice: 'a', submissionId: 'native-send' })
    // The regular runtime may write the same database before this provider sees the event.
    const external = new DatabaseSync(database)
    new DecisionInbox(external).put({ ...item, id: 'other-runtime', sourceMessageId: 'external-message' } as PendingDecisionItem)
    external.close()
    expect(registrations.has('/orchestrator/api/decisions/other-runtime/resolve')).toBe(false)
    await call('GET', 'inbox')
    expect(registrations.has('/orchestrator/api/decisions/other-runtime/resolve')).toBe(true)
    const liveEvents = [{ type: 'assistant/message', seq: 0, time: 200, data: { turn: 1, step: 1, stream: [],
      message: { id: 'live-message', role: 'assistant', content: [{ type: 'text', text: 'Should I add tests?' }] } } },
      { type: 'turn/end', seq: 1, time: 201, data: { turn: 1, reason: { kind: 'completed' } } }]
    histories.set('unmounted-live', liveEvents)
    await sessionEvent({ id: 'unmounted-live', header: {}, snapshotEvents: () => liveEvents }, liveEvents[1])
    const liveResult = await call('GET', 'inbox')
    const live = liveResult.body.items.find((entry: any) => entry.sessionId === 'unmounted-live')
    expect(live).toBeDefined()
    expect(registrations.has(`/orchestrator/api/decisions/${live.id}/resolve`)).toBe(true)
    expect(registrations.has('/orchestrator/api/decisions')).toBe(false)
    expect(registrations.has('/orchestrator/api/decisions/evaluate')).toBe(false)
    expect([...registrations.keys()].some(path => path.endsWith('/dismiss'))).toBe(false)
    await dispose!(); dispose = undefined
    expect(registrations.size).toBe(0)
    apply(ctx as any, { database })
    expect(registrations.has(`/orchestrator/api/decisions/${encodeURIComponent(item.id)}/resolve`)).toBe(true)
    const reopened = await call('GET', 'inbox')
    expect(reopened.status).toBe(200)
    expect(reopened.body.items.find((entry: any) => entry.id === item.id)).toMatchObject({ status: 'resolved', resolvedChoice: 'a', resolutionBasis: 'submitted', submissionId: 'native-send' })
  } finally { await dispose?.(); rmSync(directory, { recursive: true }) }
})

it('retires persisted false positives without touching valid questions, recorded choices or capture cursors', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const inbox = new DecisionInbox(db)
    const base: PendingDecisionItem = { id: 'chat-invalid', sessionId: 'source', sourceMessageId: 'invalid', ticketTitle: 'Test',
      trigger: 'Explicit chat follow-up', status: 'pending', urgency: 'low', createdAt: 1,
      context: 'When DSH prints `http://127.0.0.1:3082/?token=...`, it issues a session cookie.', question: 'Old false positive',
      choices: [{ id: 'respond', label: 'Draft a response' }, { id: 'discuss', label: 'Ask for clarification' }],
      recommendation: { recommendedValue: '', confidence: 0, rationale: 'Not evaluated', distribution: [], provider: 'Not evaluated', latencyMs: 0 } }
    inbox.put(base)
    inbox.put({ ...base, id: 'chat-valid', sourceMessageId: 'valid', context: 'Should I deploy `production`?' })
    inbox.put({ ...base, id: 'chat-choice', sourceMessageId: 'choice', context: 'Which approach?\nA) Test first\nB) Review first' })
    inbox.put({ ...base, id: 'chat-recorded', sourceMessageId: 'recorded', status: 'resolved', resolvedChoice: 'respond', draftResponse: 'Saved answer' })
    inbox.put({ ...base, id: 'inline-legacy', sourceMessageId: 'legacy' })
    db.prepare('INSERT INTO decision_inbox_cursor(session,seq) VALUES (?,?)').run('source', 42)
    expect(revalidateCapturedDecisions(db, inbox)).toBe(1)
    expect(inbox.get('chat-invalid')).toMatchObject({ status: 'stale', staleReason: expect.stringContaining('excluding') })
    expect(inbox.get('chat-valid')?.status).toBe('pending')
    expect(inbox.get('chat-choice')?.status).toBe('pending')
    expect(inbox.get('chat-recorded')).toMatchObject({ status: 'resolved', resolvedChoice: 'respond', draftResponse: 'Saved answer' })
    expect(inbox.get('inline-legacy')?.status).toBe('pending')
    expect(db.prepare('SELECT seq FROM decision_inbox_cursor WHERE session=?').get('source')?.seq).toBe(42)
    expect(revalidateCapturedDecisions(db, inbox)).toBe(0)
    for (const id of ['chat-native-discarded', 'chat-native-active']) {
      inbox.put({ ...base, id, sourceMessageId: id, sourceSeq: 1, sourceTurn: 1 })
      const attemptId = randomUUID()
      inbox.stage(id, { attemptId, choiceId: 'discuss', draftText: `Before proceeding, please clarify:\n${base.question}` })
      if (id.endsWith('discarded')) inbox.discardStaging(id, attemptId)
    }
    const discardedRevision = inbox.get('chat-native-discarded')!.resolutionRevision!
    expect(revalidateCapturedDecisions(db, inbox)).toBe(1)
    expect(inbox.get('chat-native-discarded')).toMatchObject({ status: 'stale', invalidation: { reason: expect.stringContaining('excluding') }, resolutionRevision: discardedRevision + 1 })
    expect(inbox.get('chat-native-active')).toMatchObject({ status: 'pending', staging: { choiceId: 'discuss' } })
  } finally { db.close() }
})

it('serves the persisted inbox and validated canonical writes while historical recovery is deferred', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-recovery-'))
  const database = join(directory, 'orchestrator.sqlite')
  const persisted: PendingDecisionItem = { id: 'inline:persisted:decision', sessionId: 'persisted-session', sourceMessageId: 'persisted-message',
    sourceSeq: 1, sourceTurn: 1, ticketTitle: 'Chat', trigger: 'Choose', status: 'pending', urgency: 'low', createdAt: 100,
    context: 'Context', question: 'Which?', choices: [{ id: 'a', label: 'Do A' }, { id: 'b', label: 'Do B' }],
    recommendation: { recommendedValue: '', confidence: 0, rationale: 'Not evaluated', distribution: [], provider: 'Not evaluated', latencyMs: 0 } }
  const seed = new DatabaseSync(database)
  seed.exec('CREATE TABLE ticket(id TEXT PRIMARY KEY,value TEXT NOT NULL)')
  new DecisionInbox(seed).put(persisted)
  seed.close()
  let dispose: (() => Promise<void>) | undefined
  const registrations = new Map<string, any>()
  const services = new Map<string, any>()
  const histories = new Map<string, any[]>()
  const turn = (question: string) => ([
    { type: 'assistant/message', seq: 1, time: 100, data: { turn: 1, message: { id: 'message', content: [{ type: 'text', text: question }] } } },
    { type: 'turn/end', seq: 2, time: 101, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  histories.set('fresh-session', turn('Which fresh option?'))
  histories.set('fail-session', turn('Which failing option?'))
  histories.set('old-session', turn('Which old option?'))
  let releaseRecovery!: () => void
  const recoveryGate = new Promise<void>(resolve => { releaseRecovery = resolve })
  let recoveryStarted!: () => void
  const started = new Promise<void>(resolve => { recoveryStarted = resolve })
  const ctx = { on: () => () => {}, logger: { error: () => {}, warn: () => {} },
    effect: (effect: () => any) => { dispose = effect() },
    provide: (name: string, value: any) => { services.set(name, value); return () => { services.delete(name) } },
    sessionPersistence: { flush: async () => {}, list: async () => { recoveryStarted(); await recoveryGate; return [{ header: { id: 'old-session', origin: 'human' } }] },
      open: async (id: string) => ({ read: async (offset: number) => ({ events: offset ? [] : histories.get(id) ?? [] }), [Symbol.asyncDispose]: async () => {} }) },
    webServer: { host: '127.0.0.1', port: 3082, register: (route: any) => {
      registrations.set(route.path, route.handler); return () => { registrations.delete(route.path) }
    } } }
  async function call(method: string, path: string, body?: unknown) {
    let status = 0; let text = ''
    const handler = registrations.get(`/orchestrator/api/decisions/${path}`)
    if (!handler) return { status: 404, body: { error: 'No route' } }
    await handler({ method, url: `/orchestrator/api/decisions/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1', origin: 'http://127.0.0.1:3082' },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } },
    { writeHead: (code: number) => { status = code }, end: (value: string) => { text = value } })
    return { status, body: JSON.parse(text) }
  }
  async function within<T>(value: Promise<T>, ms: number): Promise<T | 'timeout'> {
    return Promise.race([value, new Promise<'timeout'>(resolve => { setTimeout(() => resolve('timeout'), ms).unref?.() })])
  }
  try {
    apply(ctx as any, { database })
    await started
    // The persisted inbox is readable immediately, and the response admits history is not fully scanned yet.
    const first = await within(call('GET', 'inbox'), 1000)
    expect(first).not.toBe('timeout')
    expect(first).toMatchObject({ status: 200, body: { recovery: { pending: true } } })
    expect((first as any).body.items.find((entry: any) => entry.id === persisted.id)).toMatchObject({ status: 'pending' })
    // Only mutations that can close or rewrite item state wait for the scan.
    expect(await within(call('POST', `${persisted.id}/stage`, { choiceId: 'a', attemptId: randomUUID(), draftText: 'Do A' }), 200)).toBe('timeout')
    // Canonical writes still reject a source that is not the current durable completed turn.
    const source = { sourceMessageId: 'wrong-message', sourceSeq: 1, sourceTurn: 1, draftRevision: 'revision-hash' }
    expect(await call('POST', 'canonical/claim', { ...source, sessionId: 'fresh-session', owner: 'tab-a' }))
      .toMatchObject({ status: 409, body: { error: expect.stringContaining('current durable completed turn') } })
    // Fresh canonical claim/publish/score succeeds while the old-session scan is still deferred.
    const claim = await within(call('POST', 'canonical/claim', { ...source, sourceMessageId: 'message', sessionId: 'fresh-session', owner: 'tab-a' }), 1000)
    expect(claim).toMatchObject({ status: 200, body: { claimed: true, item: { canonical: { phase: 'pending' } } } })
    const write = { sessionId: 'fresh-session', sourceMessageId: 'message', sourceSeq: 1, sourceTurn: 1, draftRevision: 'revision-hash', leaseToken: (claim as any).body.leaseToken }
    const options = [{ id: 'first', label: 'First', prompt: 'Complete first continuation', why: 'First reason', recommended: true },
      { id: 'second', label: 'Second', prompt: 'Complete second continuation', why: 'Second reason', recommended: false }]
    expect(await call('POST', 'canonical/publish', { ...write, model: 'helper', options })).toMatchObject({ status: 200, body: { item: { canonical: { phase: 'ready' } } } })
    const evaluation = { recommendedValue: 'first', confidence: 0.6, rationale: 'Scored rationale', distribution: [{ id: 'first', probability: 0.6 }, { id: 'second', probability: 0.4 }], provider: 'ranker', latencyMs: 10 }
    expect(await call('POST', 'canonical/score', { ...write, evaluation })).toMatchObject({ status: 200, body: { item: { canonical: { phase: 'scored' } } } })
    const failedClaim = await call('POST', 'canonical/claim', { ...source, sourceMessageId: 'message', sessionId: 'fail-session', owner: 'tab-a' })
    expect(await call('POST', 'canonical/fail', { ...source, sourceMessageId: 'message', sessionId: 'fail-session', leaseToken: failedClaim.body.leaseToken, error: 'helper unavailable' }))
      .toMatchObject({ status: 200, body: { item: { canonical: { error: 'helper unavailable' } } } })
    const claimedId = (claim as any).body.item.id
    expect(await within(call('GET', 'inbox'), 1000)).toMatchObject({ status: 200, body: { recovery: { pending: true } } })
    // Recovery finishes, the old session's question appears, and the fresh canonical item keeps its state.
    releaseRecovery()
    await services.get('decisionInbox').ready
    const completed = await call('GET', 'inbox')
    expect(completed.body.recovery).toEqual({ pending: false })
    expect(completed.body.items.find((entry: any) => entry.sessionId === 'old-session')).toMatchObject({ status: 'pending' })
    expect(completed.body.items.find((entry: any) => entry.id === claimedId)).toMatchObject({ canonical: { phase: 'scored' } })
    // Gated mutations are processed, not dropped, once recovery has finished.
    expect(await within(call('POST', `${persisted.id}/stage`, { choiceId: 'a', attemptId: randomUUID(), draftText: 'Do A' }), 1000))
      .toMatchObject({ status: 409 })
  } finally { releaseRecovery(); await dispose?.(); rmSync(directory, { recursive: true }) }
})
