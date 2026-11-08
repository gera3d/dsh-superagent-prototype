import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DecisionInbox, captureAdvisorTask } from '../src/app/decision-inbox.ts'
import { DeliveryStore } from '../src/app/feature-delivery.ts'
import { reconcileInboxCurrency } from '../src/app/delivery-runtime.ts'
import { adviceContext } from '../src/app/advice-context.ts'
import { isCloseoutTexts, isConversationCloseoutEvents, stripQuotedText, CONVERSATION_CLOSED_REASON } from '../src/app/conversation-closeout.ts'

const dbs: DatabaseSync[] = []
afterEach(() => dbs.splice(0).forEach(db => db.close()))
const options = [{ id: 'accept', label: 'Hand off for acceptance', prompt: 'Hand off to the release operator for native acceptance.', why: 'Finish release', recommended: true }, { id: 'check', label: 'Check deployed source', prompt: 'Check deployed source pins.', why: 'Check release', recommended: false }]
function fixture() {
  const db = new DatabaseSync(':memory:'); dbs.push(db)
  const inbox = new DecisionInbox(db), deliveries = new DeliveryStore(db)
  const create = (id = 'feature', worker = 'ticket') => deliveries.create({ id, title: id, owner: 'release operator', authorities: ['local-operator'], workers: [worker], requirements: ['native UI'], bindings: { repository: 'org/repo', sourceIssue: 1, baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), environment: 'test' } })
  create()
  const accept = () => {
    let d = deliveries.get('feature')!
    d = deliveries.compareAndSwap(d.id, d.revision, value => { value.state = 'awaiting_decision'; value.stage = 'verifying'; value.evidence = [
      { id: 'published', kind: 'publication', bindings: value.bindings, recordedAt: new Date().toISOString(), reference: 'test:published', outcome: 'passed' },
      { id: 'native', kind: 'verification', bindings: value.bindings, recordedAt: new Date().toISOString(), reference: 'test:native', outcome: 'passed', requirements: value.requirements },
    ] })
    expect(d.nextAction!.kind).toBe('accept')
    return deliveries.confirm(d.id, { revision: d.revision, actionId: d.nextAction!.id }, { actor: 'local-operator', source: 'local_operator', reference: 'test:actual-acceptance', scope: d.nextAction!.fingerprint })
  }
  const advice = (time = Date.now() - 10000, sessionId = 'worker-ticket', message = 'finished') => {
    const source = { sessionId, sourceMessageId: message, sourceTurn: 1, sourceSeq: 2, draftRevision: `rev-${message}` }
    const events = [
      { type: 'user/message', seq: 0, time: time - 2, data: { id: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Finish this release.' }] } },
      { type: 'turn/start', seq: 1, time: time - 1, data: { turn: 1 } },
      { type: 'assistant/message', seq: 2, time, data: { turn: 1, message: { id: message, content: [{ type: 'text', text: 'Ready for review; hand off for acceptance.' }] } } },
      { type: 'turn/end', seq: 3, time: time + 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]
    const claim = inbox.claimCanonical({ ...source, owner: 'helper' }, events)
    const write = { ...source, leaseToken: claim.leaseToken! }
    const item = inbox.publishCanonical({ ...write, model: 'actual-helper', options }, events).item
    return { source, events, write, item }
  }
  return { db, inbox, deliveries, create, accept, advice }
}
it('retires tailored pre-acceptance recommendations and prevents claim, refresh, publication, scoring and staging replay', () => {
  const f = fixture(), a = f.advice()
  const accepted = f.accept(), before = JSON.stringify(accepted)
  reconcileInboxCurrency(f.inbox, f.deliveries)
  const retired = f.inbox.get(a.item.id)!
  expect(retired.status).toBe('stale'); expect(retired.invalidation?.reason).toContain('No further release action')
  expect(retired.choices).toEqual(a.item.choices); expect(retired.recommendation).toEqual(a.item.recommendation)
  expect(() => f.inbox.claimCanonical({ ...a.source, owner: 'refresh' }, a.events)).toThrow('stale')
  expect(() => f.inbox.publishCanonical({ ...a.write, model: 'helper', options }, a.events)).toThrow('stale')
  expect(() => f.inbox.scoreCanonical({ ...a.write, evaluation: a.item.recommendation }, a.events)).toThrow('stale')
  expect(() => f.inbox.stage(a.item.id, { choiceId: 'accept', attemptId: 'attempt', draftText: options[0]!.prompt })).toThrow('stale')
  const once = JSON.stringify(retired); reconcileInboxCurrency(f.inbox, f.deliveries)
  expect(JSON.stringify(f.inbox.get(a.item.id))).toBe(once)
  expect(JSON.stringify(f.deliveries.get(accepted.id))).toBe(before)
})
it('preserves a staged draft and its source/proof while retiring its now-obsolete recommendation', () => {
  const f = fixture(), a = f.advice()
  const staged = f.inbox.stage(a.item.id, { choiceId: 'accept', attemptId: '123e4567-e89b-42d3-a456-426614174001', draftText: options[0]!.prompt }).item
  f.accept(); reconcileInboxCurrency(f.inbox, f.deliveries)
  expect(f.inbox.get(a.item.id)).toMatchObject({ status: 'stale', staging: staged.staging, sourceMessageId: a.source.sourceMessageId, choices: a.item.choices })
  expect(f.inbox.get(a.item.id)?.resolutionBasis).toBeUndefined()
})
it('retires an old source first claimed after acceptance, without needing a new worker conversation turn', () => {
  const f = fixture(); f.accept(); const a = f.advice()
  reconcileInboxCurrency(f.inbox, f.deliveries)
  expect(f.inbox.get(a.item.id)?.status).toBe('stale')
})
it('preserves genuinely later conversations and unrelated sessions', () => {
  const f = fixture(), accepted = f.accept()
  const later = f.advice(Date.parse(accepted.acceptance!.at) + 1000, 'worker-ticket', 'later-user-question')
  const unrelated = f.advice(Date.now() - 10000, 'worker-someone-else', 'unrelated')
  reconcileInboxCurrency(f.inbox, f.deliveries)
  expect(f.inbox.get(later.item.id)?.status).toBe('pending')
  expect(f.inbox.get(unrelated.item.id)?.status).toBe('pending')
})
it('does not confuse worker completion, review, publication or pending acceptance with accepted work', () => {
  const f = fixture(), a = f.advice()
  f.deliveries.compareAndSwap('feature', 1, d => { d.stage = 'verifying'; d.state = 'awaiting_decision' })
  reconcileInboxCurrency(f.inbox, f.deliveries)
  expect(f.inbox.get(a.item.id)?.status).toBe('pending')
})
it('does not let an older accepted scope suppress a newly active delivery in the same worker conversation', () => {
  const f = fixture(), a = f.advice(); f.accept(); f.create('new-feature')
  reconcileInboxCurrency(f.inbox, f.deliveries)
  expect(f.inbox.get(a.item.id)?.status).toBe('pending')
})
it('gives drafting and ranking explicit authoritative completion instead of another release handoff', () => {
  const f = fixture(), d = f.accept(), context = adviceContext(undefined, d)
  expect(context).toContain('RELEASE COMPLETE:')
  expect(context).toContain('"noFurtherReleaseAction":true')
  expect(context).toContain(d.acceptance!.at)
  expect(context).not.toContain('RELEASE OBJECTIVE:')
  expect(context).not.toContain('recommend handing the prepared publication')
  expect(context).toContain('"offeredAction":null')
  expect(adviceContext(undefined, { ...d, acceptance: undefined })).not.toContain('RELEASE COMPLETE:')
})

// Full real native turn 7 choice next-1 user prompt and turn 8 canonical context assistant response:
const TURN8_HUMAN = 'Treat the one-sentence confirmation as final and take no further action this turn. Do not call tools, edit files, change settings or connect services. If a later message asks for live Cloudflare data, state plainly that cloudflare.docs.read and cloudflare.account.read are unavailable in this profile and that advice comes only from the pinned Cloudflare Skills and MCP references.'
const TURN8_ASST = 'Final confirmation stands: this profile is advice-only and Cloudflare access is unavailable; no tools, files, settings, or connections were touched.\n\nIf live Cloudflare data is requested later, I\'ll state plainly that `cloudflare.docs.read` and `cloudflare.account.read` are unavailable here, and advice comes only from the pinned Cloudflare Skills and MCP references.'
const SHORT_TURN8_HUMAN = 'Treat the one-sentence confirmation as final and take no further action this turn. Do not call tools, edit files, change settings or connect to Cloudflare.'
const SHORT_TURN8_ASST = 'Final confirmation stands: this profile is advice-only and Cloudflare access is unavailable; no tools, files, settings, or connections were touched.'
const turnEvents = (human: string, asst: string, extra: unknown[] = []) => [
  { type: 'user/message', seq: 104, time: 1000, data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: human }] } },
  { type: 'turn/start', seq: 105, time: 1001, data: { turn: 8 } },
  ...extra,
  { type: 'assistant/message', seq: 106, time: 1002, data: { turn: 8, message: { id: 'a1', content: [{ type: 'text', text: asst }] } } },
  { type: 'turn/end', seq: 108, time: 1003, data: { turn: 8, reason: { kind: 'completed' } } },
] as unknown as SessionEvent[]

it('detects explicit conversation close-out from human and assistant text', () => {
  expect(isCloseoutTexts(TURN8_HUMAN, TURN8_ASST)).toBe(true)
  expect(isCloseoutTexts(SHORT_TURN8_HUMAN, SHORT_TURN8_ASST)).toBe(true)
  expect(isCloseoutTexts(TURN8_HUMAN, SHORT_TURN8_ASST)).toBe(true)
  expect(isCloseoutTexts(SHORT_TURN8_HUMAN, TURN8_ASST)).toBe(true)
  expect(isCloseoutTexts("Thanks, that's all for now.", 'Confirmed. Taking no further action.')).toBe(true)
  expect(isCloseoutTexts("Don't call tools, that's all.", TURN8_ASST)).toBe(true)
  expect(isCloseoutTexts('Stop here. Treat this as final.', 'Stopping here; I will take no further action.')).toBe(true)
  // Conditional statements about future turns/requests stay complete; immediate promises, failures or questions stay open.
  expect(isCloseoutTexts(TURN8_HUMAN, 'Final confirmation stands: this profile is advice-only. If live data is requested later, I will state the limitations.')).toBe(true)
  expect(isCloseoutTexts(TURN8_HUMAN, 'Final confirmation stands. I will fix the regression now. If live data is requested later, I\'ll state plainly that access is unavailable.')).toBe(false)
  // Contrast clauses with immediate work or blockers stay open (bounded hypothetical clause).
  const closeoutHuman = 'This is final; take no further action.'
  expect(isCloseoutTexts(closeoutHuman, 'Final confirmation stands. If you ask later I can help, but I will fix the failing tests now.')).toBe(false)
  expect(isCloseoutTexts(closeoutHuman, 'Final confirmation stands. If you ask later I can help, but the deployment is blocked pending your approval.')).toBe(false)

  // Negation and "keep working" stay open (root regression 1).
  expect(isCloseoutTexts('Do not treat this as final; keep working.', 'Understood. The fix is not complete.')).toBe(false)
  expect(isCloseoutTexts('Do not treat this as final; keep working.', TURN8_ASST)).toBe(false)
  expect(isCloseoutTexts('We are not done yet, please continue.', TURN8_ASST)).toBe(false)
  expect(isCloseoutTexts('Do not stop here.', TURN8_ASST)).toBe(false)
  expect(isCloseoutTexts("It's not final, take no further action on the old plan but keep going.", TURN8_ASST)).toBe(false)

  // Mixed close-out + continuing work stays open (root regression 2).
  const mixed = 'Please close out the investigation notes, then fix the unresolved regression and run tests.'
  expect(isCloseoutTexts(mixed, 'Understood. I will fix the regression and run tests next.')).toBe(false)
  expect(isCloseoutTexts(mixed, TURN8_ASST)).toBe(false)
  expect(isCloseoutTexts('Please close out the investigation notes.', TURN8_ASST)).toBe(false)
  expect(isCloseoutTexts('Take no further action, but first run the tests.', TURN8_ASST)).toBe(false)
  expect(isCloseoutTexts('Do not call tools, fix the bug. That is all.', TURN8_ASST)).toBe(false)

  // A bare acknowledgement is not finality; promised work, blockers and unanswered questions stay open.
  expect(isCloseoutTexts("Thanks, that's all for now.", 'Understood.')).toBe(false)
  expect(isCloseoutTexts(TURN8_HUMAN, 'Final confirmation stands. I will now run the tests next.')).toBe(false)
  expect(isCloseoutTexts(TURN8_HUMAN, 'Final confirmation stands, but the deploy failed.')).toBe(false)
  expect(isCloseoutTexts(TURN8_HUMAN, 'Understood. Which environment should we target next: staging or production?')).toBe(false)

  // Quoted or code text is data, not an instruction.
  expect(stripQuotedText('> take no further action this turn\nPlease help me configure Wrangler.')).not.toContain('take no further action')
  expect(isCloseoutTexts('> take no further action this turn\nPlease help me configure Wrangler.', TURN8_ASST)).toBe(false)
  expect(isCloseoutTexts('The user previously said "take no further action", but now I need help.', TURN8_ASST)).toBe(false)
  expect(isCloseoutTexts('Run `that is all` through the parser.', TURN8_ASST)).toBe(false)
})

it('detects conversation closeout in session events and respects reopening, failed tools and mixed turns', () => {
  const closed = turnEvents(TURN8_HUMAN, TURN8_ASST)
  expect(isConversationCloseoutEvents(closed, 8)).toBe(true)

  expect(isConversationCloseoutEvents([...closed,
    { type: 'turn/start', seq: 109, time: 2000, data: { turn: 9 } },
    { type: 'user/message', seq: 110, time: 2001, data: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'Actually, let us review Wrangler configs now.' }] } },
  ] as unknown as SessionEvent[], 8)).toBe(false)
  expect(isConversationCloseoutEvents([...closed,
    { type: 'user/message', seq: 109, time: 2001, data: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'One more thing.' }] } },
  ] as unknown as SessionEvent[], 8)).toBe(false)

  // Failed tool / blocker in the same turn.
  expect(isConversationCloseoutEvents(turnEvents(TURN8_HUMAN, TURN8_ASST, [{ type: 'tool/result', seq: 107, time: 1002, data: { message: { isError: true } } }]), 8)).toBe(false)
  // Both root-reproduced mixed conversations, through the durable event path.
  expect(isConversationCloseoutEvents(turnEvents('Do not treat this as final; keep working.', 'Understood. The fix is not complete.'), 8)).toBe(false)
  expect(isConversationCloseoutEvents(turnEvents('Please close out the investigation notes, then fix the unresolved regression and run tests.', 'Understood. I will fix the regression and run tests next.'), 8)).toBe(false)
  // A steering message inside the turn that asks for more work keeps it open.
  expect(isConversationCloseoutEvents(turnEvents(TURN8_HUMAN, TURN8_ASST, [{ type: 'user/message', seq: 105.5, time: 1001, data: { id: 'u1b', source: { kind: 'user' }, content: [{ type: 'text', text: 'Also keep working on the regression.' }] } }]), 8)).toBe(false)
  // Only the human message of THIS turn counts, not an earlier turn's.
  expect(isConversationCloseoutEvents([
    { type: 'user/message', seq: 1, time: 1, data: { id: 'e', source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix the regression and run tests.' }] } },
    { type: 'turn/start', seq: 2, time: 2, data: { turn: 7 } },
    { type: 'assistant/message', seq: 3, time: 3, data: { turn: 7, message: { id: 'a0', content: [{ type: 'text', text: 'Done; all tests pass.' }] } } },
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 7, reason: { kind: 'completed' } } },
    ...turnEvents(TURN8_HUMAN, TURN8_ASST),
  ] as unknown as SessionEvent[], 8)).toBe(true)
})

function closedItem(f: ReturnType<typeof fixture>, sessionId: string) {
  const item = f.inbox.ensureAdvisor({ sessionId, sourceMessageId: 'a1', sourceTurn: 8, sourceSeq: 106, key: 'rev-turn8',
    question: 'Choose the next step for this thread', context: TURN8_ASST, title: TURN8_HUMAN.slice(0, 120), createdAt: 1003 })
  ;(f.inbox as any).save({ ...item, choices: [
    { id: 'next-1', label: 'Start real Cloudflare guidance', prompt: 'prompt 1', description: 'desc 1' },
    { id: 'next-2', label: 'Review wrangler config', prompt: 'prompt 2', description: 'desc 2' },
  ], recommendation: { recommendedValue: 'next-1', confidence: 0.48, rationale: 'Advice-only next step',
    distribution: [{ id: 'next-1', probability: 0.48 }, { id: 'next-2', probability: 0.52 }], provider: 'test-model', latencyMs: 100 } }, item)
  return item
}

it('retires pending decisions from the durable close-out turn, keeping choices and history, and refuses new advice as complete', () => {
  const f = fixture()
  const sessionId = 'session-closeout'
  const events = turnEvents(TURN8_HUMAN, TURN8_ASST)
  const source = { sessionId, sourceMessageId: 'a1', sourceTurn: 8, sourceSeq: 106, draftRevision: 'rev-turn8' }
  const item = closedItem(f, sessionId)

  // The truncated ticketTitle/context text alone must never retire anything (no durable source involved).
  reconcileInboxCurrency(f.inbox, f.deliveries)
  expect(f.inbox.get(item.id)!.status).toBe('pending')

  // Claiming on the current durable close-out source retires it and refuses with the "complete" wording.
  expect(() => f.inbox.claimCanonical({ ...source, owner: 'plugin' }, events)).toThrow('Conversation complete: no further action requested')
  const retired = f.inbox.get(item.id)!
  expect(retired.status).toBe('stale')
  expect(retired.invalidation?.reason).toContain('Conversation complete')
  expect(retired.invalidation?.reason).not.toMatch(/error|fail/i)
  expect(retired.choices.map(c => c.id)).toEqual(['next-1', 'next-2'])
  expect(retired.recommendation.recommendedValue).toBe('next-1')
  expect(retired.recommendation.distribution).toEqual([{ id: 'next-1', probability: 0.48 }, { id: 'next-2', probability: 0.52 }])

  // Capture (the chat path) must not create advice for a closed-out turn, and the same wording is used when it retires.
  const emptyDb = new DatabaseSync(':memory:'); dbs.push(emptyDb)
  const emptyInbox = new DecisionInbox(emptyDb)
  captureAdvisorTask(emptyInbox, sessionId, events)
  emptyInbox.capture(sessionId, events)
  expect(emptyInbox.list().length).toBe(0)
})

it('capture retires an unstaged item on a durable close-out but never touches staged work or a mixed turn', () => {
  const f = fixture()
  const item = closedItem(f, 'session-capture')
  f.inbox.capture('session-capture', turnEvents(TURN8_HUMAN, TURN8_ASST))
  expect(f.inbox.get(item.id)!.invalidation?.reason).toBe(CONVERSATION_CLOSED_REASON)

  const mixed = fixture(), keep = closedItem(mixed, 'session-mixed')
  mixed.inbox.capture('session-mixed', turnEvents('Please close out the investigation notes, then fix the unresolved regression and run tests.', 'Understood. I will fix the regression and run tests next.'))
  mixed.inbox.capture('session-mixed', turnEvents('Do not treat this as final; keep working.', 'Understood. The fix is not complete.'))
  expect(mixed.inbox.get(keep.id)!.status).toBe('pending')

  // Staged work keeps its own guards: close-out never retires it from under the native submission journal.
  const staged = fixture(), live = closedItem(staged, 'session-staged')
  staged.inbox.stage(live.id, { choiceId: 'next-1', attemptId: '00000000-0000-4000-8000-000000000001', draftText: 'prompt 1' })
  staged.inbox.capture('session-staged', turnEvents(TURN8_HUMAN, TURN8_ASST))
  expect(staged.inbox.get(live.id)!.status).toBe('pending')
  expect(staged.inbox.get(live.id)!.staging?.choiceId).toBe('next-1')
})

it('keeps a truncated close-out phrase from retiring active work through the text-only reconcile path', () => {
  const f = fixture()
  const { item } = f.advice()
  // Active, unaccepted work whose title merely starts with a close-out phrase.
  ;(f.inbox as any).save({ ...f.inbox.get(item.id)!, ticketTitle: 'Treat the one-sentence confirmation as final and take no further action this turn.' }, f.inbox.get(item.id)!)
  reconcileInboxCurrency(f.inbox, f.deliveries)
  expect(f.inbox.get(item.id)!.status).toBe('pending')
})
