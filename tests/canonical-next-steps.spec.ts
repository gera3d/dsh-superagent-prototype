import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { captureAdvisorTask, DecisionInbox } from '../src/app/decision-inbox.ts'
import { apply } from '../../dsh-next-steps/src/index.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const dbs: DatabaseSync[] = []
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(dispose => dispose()); dbs.splice(0).forEach(db => db.close()) })
const history = (id = 'm1', text = 'If you want, I can add focused regression tests next.') => [
  { type: 'user/message', seq: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement the parser' }] } },
  { type: 'request/header', seq: 1, data: { header: { config: { provider: 'mock', model: 'advisor' } } } },
  { type: 'turn/start', seq: 2, data: { turn: 1 } },
  { type: 'assistant/message', seq: 3, data: { turn: 1, message: { id, role: 'assistant', content: [{ type: 'text', text }] } } },
  { type: 'turn/end', seq: 4, time: 100, data: { turn: 1, reason: { kind: 'completed' } } },
]
const answer = { recommended: 0, options: [
  { label: 'Add regression tests', prompt: 'Add focused regression tests for the parser, then run them and report any failures.', why: 'Verify the completed parser against edge cases.' },
  { label: 'Review the patch', prompt: 'Review the parser patch for correctness before making any further changes.', why: 'Inspect implementation risks first.' },
] }
function fixture(count = 1, startupLimit = 0, text?: string) {
  const db = new DatabaseSync(':memory:'); dbs.push(db)
  const inbox = new DecisionInbox(db)
  const histories = new Map(Array.from({ length: count }, (_, i) => [`s${i}`, history(`m${i}`, text)]))
  for (const [id, events] of histories) inbox.capture(id, events as unknown as SessionEvent[])
  let handler: any; let listener: any; let active = 0; let maximum = 0
  const prepare = vi.fn(async () => ({ config: {}, async *stream() { active++; maximum = Math.max(maximum, active)
    try { await Promise.resolve(); yield { type: 'text-delta', text: JSON.stringify(answer) }; yield { type: 'finish', reason: { kind: 'completed' } } } finally { active-- } } }))
  const ctx = {
    decisionInbox: { ready: Promise.resolve(), list: () => inbox.list(), get: (id: string) => inbox.get(id),
      findSource: (source: any) => inbox.findSource(source), publishAdvisor: (input: any) => inbox.publishAdvisor(input), advisorState: (id: string, state: any) => inbox.advisorState(id, state) },
    sessionPersistence: { flush: async () => {}, list: async () => [...histories.keys()].map(id => ({ header: { id } })),
      open: async (id: string) => ({ read: async () => ({ events: histories.get(id)! }), close: async () => {} }) },
    llm: { prepareCall: prepare }, logger: () => ({ info: () => {}, warn: () => {} }), provide: () => () => {},
    on: (_event: string, fn: any) => { listener = fn; return () => {} },
    effect: (effect: () => (() => void)) => { cleanups.push(effect()) },
    webServer: { host: '127.0.0.1', port: 3082, register: (route: any) => { handler = route.handler; return () => {} } },
  }
  apply(ctx as any, { startupLimit })
  const request = async (sessionId: string, force = false) => {
    let status = 0; let body: any
    await handler({ method: 'POST', url: '/next-steps/api/suggest', headers: { 'x-next-steps-request': '1' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId, force })) } },
    { writeHead: (code: number) => { status = code }, end: (text: string) => { body = JSON.parse(text) } })
    return { status, body }
  }
  return { db, inbox, histories, prepare, request, ctx, listener: () => listener, maximum: () => maximum }
}

it('lists all cold completed human tasks without any model calls, and skips internal follow-on turns', () => {
  const db = new DatabaseSync(':memory:'); dbs.push(db)
  const inbox = new DecisionInbox(db)
  for (let index = 0; index < 7; index++) {
    const events = history(`complete-${index}`, 'Implementation is complete and the focused checks passed.') as unknown as SessionEvent[]
    inbox.capture(`task-${index}`, events)
    captureAdvisorTask(inbox, `task-${index}`, events)
    captureAdvisorTask(inbox, `task-${index}`, events)
  }
  expect(inbox.list()).toHaveLength(7)
  expect(inbox.list().every(item => item.advisor?.status === 'pending' && item.choices.length === 0 && !item.recommendation.recommendedValue)).toBe(true)
  const internal = history('internal', 'Automatic background continuation is finished.')
  internal.splice(3, 0, { type: 'turn/end', seq: 2.5, time: 99, data: { turn: 0, reason: { kind: 'completed' } } } as any)
  captureAdvisorTask(inbox, 'internal', internal as unknown as SessionEvent[])
  expect(inbox.list()).toHaveLength(7)
})

it('publishes advisor full prompts onto the captured canonical row and shares immutable resolution', async () => {
  const view = fixture(); const original = view.inbox.list()[0]!
  const [one, concurrent] = await Promise.all([view.request('s0'), view.request('s0', true)])
  expect(one.status).toBe(200); expect(concurrent.body.decisionId).toBe(original.id)
  expect(view.prepare).toHaveBeenCalledTimes(1)
  expect(one.body).toMatchObject({ status: 'ready', decisionStatus: 'pending', decisionId: original.id, model: 'mock/advisor' })
  const canonical = view.inbox.get(original.id)!
  expect(view.inbox.list()).toHaveLength(1)
  expect(canonical.choices[0]?.prompt).toBe(answer.options[0]!.prompt)
  expect(canonical.advisor).toMatchObject({ status: 'ready', key: '4' })
  expect(canonical.recommendation).toMatchObject({ recommendedValue: canonical.choices[0]!.id, confidence: 0, distribution: [] })
  const attemptId = randomUUID(), draftText = canonical.choices[0]!.prompt!
  view.inbox.stage(original.id, { attemptId, choiceId: canonical.choices[0]!.id, draftText })
  view.inbox.bindSubmission(original.id, { attemptId, submissionId: 'native-send' }, view.histories.get('s0')! as unknown as SessionEvent[])
  view.inbox.capture('s0', [...view.histories.get('s0')!, { type: 'user/message', seq: 5, time: 200, data: { id: 'submitted', source: { kind: 'user', rpcId: 'native-send' }, content: [{ type: 'text', text: draftText }] } }] as unknown as SessionEvent[])
  const resolution = view.inbox.resolve(original.id, canonical.choices[0]!.id)
  expect(resolution.draft.text).toBe(answer.options[0]!.prompt)
  const closed = await view.request('s0', true)
  expect(closed.body).toMatchObject({ decisionId: original.id, decisionStatus: 'resolved', resolvedChoice: canonical.choices[0]!.id })
  expect(view.prepare).toHaveBeenCalledTimes(1)
  view.inbox.publishAdvisor({ sessionId: 's0', sourceMessageId: 'different', sourceTurn: 1, key: '4', question: '', context: '', createdAt: 100,
    model: 'other', options: answer.options.map((option, i) => ({ ...option, id: `new${i}`, recommended: i === 0 })) })
  expect(view.inbox.list()).toHaveLength(1); expect(view.inbox.get(original.id)?.status).toBe('resolved')
})

it('recovers the checkpoint-covered restart after host remount even when its original source differs from the latest completed response', async () => {
  const view = fixture(), first = await view.request('s0')
  expect(first.status).toBe(200)
  const parent = view.inbox.get(first.body.decisionId)!, attemptId = randomUUID(), selected = parent.choices[0]!
  view.inbox.stage(parent.id, { attemptId, choiceId: selected.id, draftText: selected.prompt! })
  view.inbox.bindSubmission(parent.id, { attemptId, submissionId: 'parent-send' }, view.histories.get('s0')! as unknown as SessionEvent[])
  const latest = [...view.histories.get('s0')!,
    { type: 'user/message', seq: 5, time: 200, data: { id: 'parent-submitted', source: { kind: 'user', rpcId: 'parent-send' }, content: [{ type: 'text', text: selected.prompt! }] } },
    { type: 'turn/start', seq: 6, time: 201, data: { turn: 2 } },
    { type: 'assistant/message', seq: 7, time: 202, data: { turn: 2, message: { id: 'newer-completed-source', role: 'assistant', content: [{ type: 'text', text: 'The regression tests completed successfully and all focused checks passed.' }] } } },
    { type: 'turn/end', seq: 8, time: 203, data: { turn: 2, reason: { kind: 'completed' } } },
  ] as any
  view.histories.set('s0', latest)
  view.inbox.capture('s0', latest as SessionEvent[])
  captureAdvisorTask(view.inbox, 's0', latest as SessionEvent[])
  expect(view.inbox.get(parent.id)).toMatchObject({ status: 'resolved', submissionId: 'parent-send' })
  const child = view.inbox.startNewDecision(parent.id, latest as SessionEvent[])
  expect(child).toMatchObject({ status: 'pending', parentDecisionId: parent.id, restartAfterSeq: 8, sourceMessageId: 'm0', choices: parent.choices })
  expect(view.inbox.findSource({ sessionId: 's0', sourceMessageId: 'newer-completed-source' })?.id).not.toBe(child.id)
  const originalChoices = structuredClone(child.choices), parentSnapshot = view.inbox.get(parent.id)
  // New host instance has no remembered selection; it must recover from the shared durable inbox.
  apply(view.ctx as any, { startupLimit: 0 })
  for (const force of [false, true]) {
    const result = await view.request('s0', force)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ status: 'ready', decisionId: child.id, decisionStatus: 'pending' })
    expect(result.body.options.map((option: any) => ({ id: option.id, label: option.label, prompt: option.prompt }))).toEqual(originalChoices.map(choice => ({ id: choice.id, label: choice.label, prompt: choice.prompt })))
    expect(view.prepare).toHaveBeenCalledTimes(1)
    expect(view.inbox.get(child.id)?.choices).toEqual(originalChoices)
    expect(view.inbox.get(parent.id)).toEqual(parentSnapshot)
  }
})

it('force refresh returns the same staged pending record without changing prompts or reevaluating', async () => {
  const view = fixture(); const first = await view.request('s0')
  const item = view.inbox.get(first.body.decisionId)!, attemptId = randomUUID()
  const staged = view.inbox.stage(item.id, { attemptId, choiceId: item.choices[0]!.id, draftText: item.choices[0]!.prompt! })
  const refresh = await view.request('s0', true)
  expect(refresh.body).toMatchObject({ status: 'ready', decisionId: item.id, decisionStatus: 'pending', staging: { attemptId, choiceId: staged.staging.choiceId } })
  expect(refresh.body.options).toEqual(first.body.options)
  expect(view.inbox.get(item.id)?.staging).toEqual(staged.staging)
  expect(view.prepare).toHaveBeenCalledTimes(1)
})

it('generates at most four startup captured threads sequentially, leaving the rest visible pending', async () => {
  const view = fixture(6, 4)
  for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setImmediate(resolve))
  expect(view.prepare).toHaveBeenCalledTimes(4)
  expect(view.maximum()).toBe(1)
  expect(view.inbox.list().filter(item => item.advisor?.status === 'ready')).toHaveLength(4)
  expect(view.inbox.list().filter(item => item.advisor?.status === 'pending')).toHaveLength(2)
  const waiting = view.inbox.list().find(item => item.advisor?.status === 'pending')!.sessionId!
  view.listener()({ id: waiting, header: { origin: 'subagent', delegationDepth: 1 }, snapshotEvents: () => history() }, history().at(-1))
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(view.prepare).toHaveBeenCalledTimes(4)
  view.listener()({ id: waiting, header: {}, snapshotEvents: () => history() }, history().at(-1))
  for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve))
  expect(view.prepare).toHaveBeenCalledTimes(5)
})

it('keeps explicit assistant alternatives and stable choice ids while advising their full response prompts', async () => {
  const labelA = 'Run all of the focused parser regression tests before continuing the rollout'
  const labelB = 'Review the existing parser implementation before deciding on further changes'
  const view = fixture(1, 0, `Which path should we take?\nA) ${labelA}\nB) ${labelB}`)
  view.prepare.mockImplementationOnce(async () => ({ config: {}, async *stream() {
    yield { type: 'text-delta', text: JSON.stringify({ recommended: 0, options: [
      { label: labelB, prompt: 'Review the existing parser implementation and report risks before changing anything.', why: 'Find correctness risks first.' },
      { label: labelA, prompt: 'Run all focused parser tests before continuing rollout and report their results.', why: 'Validate the implementation.' },
    ] }) }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } }))
  const result = await view.request('s0')
  expect(result.body.options.map((option: any) => option.id)).toEqual(['option-b', 'option-a'])
  expect(result.body.options[0].label).toBe(labelB)
  const item = view.inbox.list()[0]!
  expect(item.recommendation.recommendedValue).toBe('option-b')
  expect(item.choices.find(choice => choice.id === 'option-b')?.prompt).toContain('report risks')
  expect(() => view.inbox.resolve(item.id, 'option-b')).toThrow('Linked native submission required')
})

it('recovers restarted legacy alternatives without model prompts or fabricated new choices', async () => {
  const view = fixture(), parent = view.inbox.list()[0]!
  // Seed a pre-existing legacy row, rather than bypassing the live resolution guard.
  view.db.prepare('DELETE FROM decision_inbox WHERE id=?').run(parent.id)
  view.inbox.put({ ...parent, status: 'resolved', resolvedChoice: parent.choices[0]!.id, resolutionBasis: 'legacy_staged' })
  const child = view.inbox.startNewDecision(parent.id, view.histories.get('s0')! as unknown as SessionEvent[])
  expect(child.choices.every(choice => !choice.prompt)).toBe(true)
  const response = await view.request('s0', true)
  expect(response.body).toMatchObject({ status: 'ready', decisionId: child.id, decisionStatus: 'pending' })
  expect(response.body.options.map((choice: any) => choice.label)).toEqual(parent.choices.map(choice => choice.label))
  expect(response.body.options.every((choice: any) => typeof choice.prompt === 'string' && choice.prompt.length)).toBe(true)
  expect(view.prepare).not.toHaveBeenCalled()
})

it('does not resurrect stale decisions or invent a recommendation after advisor failure', async () => {
  const view = fixture(); const item = view.inbox.list()[0]!
  view.prepare.mockRejectedValueOnce(new Error('Provider unavailable'))
  expect((await view.request('s0')).status).toBe(500)
  expect(view.inbox.get(item.id)).toMatchObject({ advisor: { status: 'error' }, recommendation: { recommendedValue: '' } })
  view.inbox.stale('s0', 'Human continued')
  const stale = await view.request('s0', true)
  expect(stale.body).toMatchObject({ status: 'not-ready', decisionStatus: 'stale' })
  expect(view.prepare).toHaveBeenCalledTimes(1)
})
