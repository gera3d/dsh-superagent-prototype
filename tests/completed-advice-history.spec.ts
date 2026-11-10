import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { FindingStore, projectFindings } from '../src/app/finding.ts'
import { DecisionInbox } from '../src/app/decision-inbox.ts'
import { ProgressStore } from '../src/app/progress.ts'
import { adviceContext } from '../src/app/advice-context.ts'
import { decisionNeedsAttention, decisionInHistory, findingCompleted } from '../src/core/publication-queue.ts'
import type { PendingDecisionItem, DecisionChoice, DecisionEvaluationResult } from '../src/core/decision.ts'

const dbs: DatabaseSync[] = []
afterEach(() => dbs.splice(0).forEach(db => db.close()))

function setupFixture() {
  const db = new DatabaseSync(':memory:')
  dbs.push(db)
  const findings = new FindingStore(db)
  const inbox = new DecisionInbox(db)
  return { db, findings, inbox }
}

const SAMPLE_CHOICES: DecisionChoice[] = [
  { id: 'next-1', label: 'Coordinator live-UI evidence check', prompt: 'Handoff prompt 1' },
  { id: 'next-2', label: 'Reconcile deployed head vs evidence', prompt: 'Handoff prompt 2' },
  { id: 'next-3', label: 'Verify preserved-behavior controls live', prompt: 'Handoff prompt 3' },
]

const SAMPLE_RECOMMENDATION: DecisionEvaluationResult = {
  recommendedValue: 'next-1',
  confidence: 0.6,
  rationale: 'Coordinator check covers the necessary verification fixtures.',
  distribution: [{ id: 'next-1', probability: 0.6 }, { id: 'next-2', probability: 0.16 }, { id: 'next-3', probability: 0.24 }],
  provider: 'anthropic / claude-sonnet-5-5',
  latencyMs: 4370,
}

describe('Completed advice history projection', () => {
  it('projects completed finding recommendation cards as non-actionable history while preserving original choices and scores', () => {
    const { findings, inbox } = setupFixture()

    // 1. Create finding and dispatch job
    let f = findings.observe({
      dedupKey: 'rec-quality',
      title: 'Fix recommendation quality',
      problem: 'Options quality degraded',
      scope: 'Bounded fix',
      owner: 'team',
      kind: 'fix',
      requirements: ['Enforce option quality and truthful state'],
      repository: 'gera3d/superagent-sandbox',
      occurrence: { id: 'occ-1', reference: 'ref-1', evidence: 'bad option' },
    })
    findings.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' })
    f = findings.markDispatched(f.id, 'ticket-worker-1', 'assign-1')

    // 2. Publish worker recommendation card
    const cardTime = 1000
    const card = inbox.publishAdvisor({
      sessionId: 'worker-ticket-worker-1',
      sourceMessageId: 'msg-turn-1',
      sourceTurn: 1,
      sourceSeq: 10,
      key: 'draft-rev-1',
      createdAt: cardTime,
      question: 'Choose the next step for this thread',
      context: 'Candidate commit c3bb101 verified across test suites.',
      title: 'Conversation next steps',
      model: 'Senior Developer',
      options: SAMPLE_CHOICES.map(c => ({ ...c, prompt: c.prompt!, why: 'test', recommended: c.id === 'next-1' })),
    })

    // In SQLite, card is pending
    expect(inbox.get(card.id)!.status).toBe('pending')

    // 3. Worker records ready report -> state becomes blocked awaiting review
    const resolvedTime = cardTime + 1000
    f = findings.markReview(f.id, {
      reference: 'https://github.com/evidence.json',
      summary: 'all 16 suites pass',
      recordedAt: new Date(resolvedTime).toISOString(),
      state: 'ready',
    })
    f = findings.resolve(f.id, 'https://github.com/evidence.json', f.requirements)

    // 4. Run read-time projection
    const rawItems = inbox.list()
    const projected = projectFindings(findings, rawItems)

    const projectedCard = projected.find(item => item.id === card.id)!
    expect(projectedCard).toBeDefined()
    expect(projectedCard.status).toBe('stale')
    expect(projectedCard.staleReason).toContain(`parent finding ${f.id} was verified and accepted`)
    expect(projectedCard.parentFinding).toMatchObject({ id: f.id, state: 'resolved' })
    expect(projectedCard.choices).toEqual(card.choices)
    expect(projectedCard.recommendation.recommendedValue).toBe('next-1')
    expect(projectedCard.recommendation).toEqual(card.recommendation)

    // Publication queue classification: non-actionable history
    expect(findingCompleted(projectedCard)).toBe(true)
    expect(decisionNeedsAttention(projectedCard)).toBe(false)
    expect(decisionInHistory(projectedCard)).toBe(true)

    // Storage is NOT mutated: raw SQLite record remains pending
    const rawStored = inbox.get(card.id)!
    expect(rawStored.status).toBe('pending')
    expect(rawStored.invalidation).toBeUndefined()
  })

  it('preserves genuine newer human requests after finding resolution as active pending decisions', () => {
    const { findings, inbox } = setupFixture()

    let f = findings.observe({
      dedupKey: 'rec-quality-2',
      title: 'Fix recommendation quality 2',
      problem: 'Options quality degraded',
      scope: 'Bounded fix',
      owner: 'team',
      kind: 'fix',
      requirements: ['Enforce option quality'],
      repository: 'gera3d/superagent-sandbox',
      occurrence: { id: 'occ-2', reference: 'ref-2', evidence: 'bad option' },
    })
    findings.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' })
    f = findings.markDispatched(f.id, 'ticket-worker-2', 'assign-2')

    const resolvedTime = 2000
    f = findings.markReview(f.id, {
      reference: 'ref-2',
      summary: 'pass',
      recordedAt: new Date(resolvedTime).toISOString(),
      state: 'ready',
    })
    f = findings.resolve(f.id, 'ref-2', f.requirements)

    const resolutionTime = Date.parse(f.resolution!.at)

    // Pre-acceptance card from worker
    const oldCard = inbox.put({
      id: 'chat-old-worker-card',
      sessionId: 'worker-ticket-worker-2',
      sourceMessageId: 'msg-turn-1',
      sourceTurn: 1,
      sourceSeq: 10,
      createdAt: resolutionTime - 5000,
      ticketTitle: 'Old card',
      trigger: 'next steps',
      status: 'pending',
      urgency: 'low',
      question: 'Old step',
      choices: SAMPLE_CHOICES,
      recommendation: SAMPLE_RECOMMENDATION,
      context: 'Pre-resolution work',
    })

    // Now a newer human request arrives after resolution via native conversation events
    const newTime = resolutionTime + 5000
    const events: any[] = [
      { type: 'user/message', seq: 0, time: resolutionTime - 6000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Pre-resolution ask' }] } },
      { type: 'turn/end', seq: 1, time: resolutionTime - 5000, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'user/message', seq: 2, time: newTime, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'How should we configure the next follow-up milestone?' }] } },
      { type: 'turn/start', seq: 3, time: newTime + 10, data: { turn: 2 } },
      { type: 'assistant/message', seq: 4, time: newTime + 50, data: { turn: 2, message: { id: 'msg-turn-2', content: [{ type: 'text', text: 'Next milestone configuration options ready.' }] } } },
      { type: 'turn/end', seq: 5, time: newTime + 100, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    const source = { sessionId: 'worker-ticket-worker-2', sourceMessageId: 'msg-turn-2', sourceSeq: 4, sourceTurn: 2, draftRevision: 'draft-2' }
    const claim = inbox.claimCanonical({ ...source, owner: 'native-fallback' }, events)
    expect(claim.claimed).toBe(true)
    const newRequestCard = inbox.publishCanonical({
      ...source,
      leaseToken: claim.leaseToken!,
      model: 'Senior Developer',
      options: SAMPLE_CHOICES.map(c => ({ ...c, prompt: c.prompt!, why: 'test', recommended: c.id === 'next-1' })),
    }, events).item

    const projected = projectFindings(findings, inbox.list())
    const projectedOldCard = projected.find(item => item.id === oldCard.id)!
    const projectedNewCard = projected.find(item => item.id === newRequestCard.id)!

    // Old card is retired to history
    expect(projectedOldCard.status).toBe('stale')
    expect(decisionNeedsAttention(projectedOldCard)).toBe(false)
    expect(decisionInHistory(projectedOldCard)).toBe(true)

    // New card should remain active/pending because it's a newer human request after acceptance
    expect(projectedNewCard.status).toBe('pending')
    expect(findingCompleted(projectedNewCard)).toBe(false)
    expect(decisionNeedsAttention(projectedNewCard)).toBe(true)
    expect(decisionInHistory(projectedNewCard)).toBe(false)
  })

  it('projects delayed-capture worker advice to history when only createdAt is after resolution without human proof (root counterexample)', () => {
    const { findings, inbox } = setupFixture()

    let f = findings.observe({
      dedupKey: 'counterexample-parent',
      title: 'Fix recommendation quality',
      problem: 'Options quality degraded',
      scope: 'Bounded fix',
      owner: 'team',
      kind: 'fix',
      requirements: ['Option quality'],
      repository: 'gera3d/superagent-sandbox',
      occurrence: { id: 'occ-counter', reference: 'ref-counter', evidence: 'bad option' },
    })
    findings.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' })
    f = findings.markDispatched(f.id, 'b62c2f4207fd86b3cea3087aa71ec87a', 'assign-counter')

    const resolvedTime = 2000
    f = findings.markReview(f.id, {
      reference: 'ref-counter',
      summary: 'all tests pass',
      recordedAt: new Date(resolvedTime).toISOString(),
      state: 'ready',
    })
    f = findings.resolve(f.id, 'ref-counter', f.requirements)

    const resolutionTime = Date.parse(f.resolution!.at)

    // Controlled delayed-capture counterexample matching completed-advice-history-r1-root-audit.json:
    // Reuses pre-acceptance sourceTurn/sourceSeq, delayed createdAt only (+1000ms), without human evidence
    const delayedWorkerCard = inbox.put({
      id: 'chat-delayed-worker-closure',
      sessionId: 'worker-b62c2f4207fd86b3cea3087aa71ec87a',
      sourceMessageId: '4a1cfc5b-bab2-41a8-96fb-ebd43f197712',
      sourceTurn: 3,
      sourceSeq: 270,
      createdAt: resolutionTime + 1000,
      ticketTitle: 'Conversation next steps',
      trigger: 'Task-specific next steps',
      status: 'pending',
      urgency: 'low',
      question: 'Choose the next step for this thread',
      choices: SAMPLE_CHOICES,
      recommendation: SAMPLE_RECOMMENDATION,
      context: 'Delayed capture worker advice',
    })

    const projected = projectFindings(findings, [delayedWorkerCard])
    const result = projected[0]!

    // Expected: stale history, NOT active pending
    expect(result.status).toBe('stale')
    expect(result.parentFinding?.state).toBe('resolved')
    expect(findingCompleted(result)).toBe(true)
    expect(decisionNeedsAttention(result)).toBe(false)
    expect(decisionInHistory(result)).toBe(true)
  })

  it('preserves newer human request backed by authoritative database trigger arriving after resolution', () => {
    const { db, findings, inbox } = setupFixture()

    // Create trigger table in fixture DB
    db.exec(`CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);`)

    let f = findings.observe({
      dedupKey: 'db-trigger-parent',
      title: 'Database trigger test',
      problem: 'Test db triggers',
      scope: 'Bounded fix',
      owner: 'team',
      kind: 'fix',
      requirements: ['Trigger test'],
      repository: 'gera3d/superagent-sandbox',
      occurrence: { id: 'occ-trig', reference: 'ref-trig', evidence: 'trig' },
    })
    findings.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' })
    f = findings.markDispatched(f.id, 'ticket-worker-trig', 'assign-trig')

    const resolvedTime = 2000
    f = findings.markReview(f.id, {
      reference: 'ref-trig',
      summary: 'verified',
      recordedAt: new Date(resolvedTime).toISOString(),
      state: 'ready',
    })
    f = findings.resolve(f.id, 'ref-trig', f.requirements)
    const resolutionTime = Date.parse(f.resolution!.at)

    // Authoritative human trigger in database after resolution (+3000ms)
    const triggerId = 'trig-human-followup'
    const triggerAt = new Date(resolutionTime + 3000).toISOString()
    db.prepare('INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)').run(
      triggerId,
      JSON.stringify({
        id: triggerId,
        actor: { source: 'user', id: 'operator-1' },
        human: true,
        at: triggerAt,
        text: 'Please also configure the follow-up milestone',
      }),
      triggerAt,
    )

    const humanCard = inbox.put({
      id: 'chat-db-backed-human',
      sessionId: 'worker-ticket-worker-trig',
      sourceMessageId: triggerId,
      sourceTurn: 2,
      sourceSeq: 50,
      createdAt: resolutionTime + 3000,
      ticketTitle: 'Followup decision',
      trigger: 'Explicit user trigger',
      status: 'pending',
      urgency: 'low',
      question: 'Next step',
      choices: SAMPLE_CHOICES,
      recommendation: SAMPLE_RECOMMENDATION,
      context: 'Database-verified human trigger',
    })

    const projected = projectFindings(findings, [humanCard])
    const result = projected[0]!

    // Human trigger after resolution: remains active pending
    expect(result.status).toBe('pending')
    expect(findingCompleted(result)).toBe(false)
    expect(decisionNeedsAttention(result)).toBe(true)
    expect(decisionInHistory(result)).toBe(false)
  })

  it('projects delayed system/ci trigger card after resolution to history', () => {
    const { db, findings, inbox } = setupFixture()

    db.exec(`CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);`)

    let f = findings.observe({
      dedupKey: 'system-trigger-parent',
      title: 'System trigger test',
      problem: 'Test system triggers',
      scope: 'Bounded fix',
      owner: 'team',
      kind: 'fix',
      requirements: ['Trigger test'],
      repository: 'gera3d/superagent-sandbox',
      occurrence: { id: 'occ-sys', reference: 'ref-sys', evidence: 'sys' },
    })
    findings.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' })
    f = findings.markDispatched(f.id, 'ticket-worker-sys', 'assign-sys')

    const resolvedTime = 2000
    f = findings.markReview(f.id, {
      reference: 'ref-sys',
      summary: 'verified',
      recordedAt: new Date(resolvedTime).toISOString(),
      state: 'ready',
    })
    f = findings.resolve(f.id, 'ref-sys', f.requirements)
    const resolutionTime = Date.parse(f.resolution!.at)

    // System/CI trigger in database after resolution (+3000ms) with human = false
    const triggerId = 'trig-ci-build'
    const triggerAt = new Date(resolutionTime + 3000).toISOString()
    db.prepare('INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)').run(
      triggerId,
      JSON.stringify({
        id: triggerId,
        actor: { source: 'ci', id: '' },
        human: false,
        at: triggerAt,
        text: 'CI build finished',
      }),
      triggerAt,
    )

    const systemCard = inbox.put({
      id: 'chat-system-trigger',
      sessionId: 'worker-ticket-worker-sys',
      sourceMessageId: triggerId,
      sourceTurn: 2,
      sourceSeq: 50,
      createdAt: resolutionTime + 3000,
      ticketTitle: 'System trigger decision',
      trigger: 'CI notification',
      status: 'pending',
      urgency: 'low',
      question: 'Next step',
      choices: SAMPLE_CHOICES,
      recommendation: SAMPLE_RECOMMENDATION,
      context: 'Database-verified system trigger without human intent',
    })

    const projected = projectFindings(findings, [systemCard])
    const result = projected[0]!

    // System trigger: projects to history
    expect(result.status).toBe('stale')
    expect(findingCompleted(result)).toBe(true)
    expect(decisionNeedsAttention(result)).toBe(false)
    expect(decisionInHistory(result)).toBe(true)
  })

  it('projects superseded prior-job attempts as history while keeping active finding job advice pending', () => {
    const { findings, inbox } = setupFixture()

    let f = findings.observe({
      dedupKey: 'rec-multi-job',
      title: 'Multi-job finding',
      problem: 'Iterative fix',
      scope: 'Bounded fix',
      owner: 'team',
      kind: 'fix',
      requirements: ['Multi-job requirement'],
      repository: 'gera3d/superagent-sandbox',
      occurrence: { id: 'occ-3', reference: 'ref-3', evidence: 'iterative' },
    })
    findings.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' })

    // Revision 1 dispatched to ticket-r1
    f = findings.markDispatched(f.id, 'ticket-r1', 'assign-r1')
    const oldCard = inbox.publishAdvisor({
      sessionId: 'worker-ticket-r1',
      sourceMessageId: 'msg-r1',
      sourceTurn: 1,
      sourceSeq: 5,
      key: 'draft-r1',
      createdAt: 1000,
      question: 'Choose next step for r1',
      context: 'Attempt 1',
      title: 'Attempt 1 advice',
      model: 'Senior Developer',
      options: SAMPLE_CHOICES.map(c => ({ ...c, prompt: c.prompt!, why: 'test', recommended: c.id === 'next-1' })),
    })

    // Finding needs another revision: ticket-r1 becomes priorJob, active job is now ticket-r2
    f = findings.markReview(f.id, {
      reference: 'ref-r1',
      summary: 'retry needed',
      recordedAt: new Date(1500).toISOString(),
      state: 'ready',
    })
    f = findings.review(f.id, { revision: f.revision, decision: 'retry_scope' })
    findings.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' })
    f = findings.markDispatched(f.id, 'ticket-r2', 'assign-r2')

    // Current card for ticket-r2
    const currentCard = inbox.publishAdvisor({
      sessionId: 'worker-ticket-r2',
      sourceMessageId: 'msg-r2',
      sourceTurn: 1,
      sourceSeq: 5,
      key: 'draft-r2',
      createdAt: 2000,
      question: 'Choose next step for r2',
      context: 'Attempt 2 in progress',
      title: 'Attempt 2 advice',
      model: 'Senior Developer',
      options: SAMPLE_CHOICES.map(c => ({ ...c, prompt: c.prompt!, why: 'test', recommended: c.id === 'next-1' })),
    })

    const projected = projectFindings(findings, inbox.list())
    const projectedOld = projected.find(item => item.id === oldCard.id)!
    const projectedCurrent = projected.find(item => item.id === currentCard.id)!

    // Old attempt is projected as stale history
    expect(projectedOld.status).toBe('stale')
    expect(projectedOld.staleReason).toContain('Prior attempt superseded')
    expect(decisionNeedsAttention(projectedOld)).toBe(false)
    expect(decisionInHistory(projectedOld)).toBe(true)

    // Current attempt remains pending and actionable
    expect(projectedCurrent.status).toBe('pending')
    expect(decisionNeedsAttention(projectedCurrent)).toBe(true)
    expect(decisionInHistory(projectedCurrent)).toBe(false)
  })

  it('leaves ordinary user conversation decisions completely untouched and actionable', () => {
    const { findings, inbox } = setupFixture()

    const userCard = inbox.publishAdvisor({
      sessionId: 'session-user-chat-42',
      sourceMessageId: 'msg-user-1',
      sourceTurn: 1,
      sourceSeq: 1,
      key: 'draft-user-1',
      createdAt: 1500,
      question: 'Explain rollback in exactly five words.',
      context: 'User conversational question.',
      title: 'User conversation decision',
      model: 'Senior Developer',
      options: [
        { id: 'opt-1', label: 'Revert deployment safely immediately', prompt: 'Revert deployment safely immediately', why: 'Direct', recommended: true },
        { id: 'opt-2', label: 'Restore previous verified source build', prompt: 'Restore previous verified source build', why: 'Alternate', recommended: false },
      ],
    })

    const projected = projectFindings(findings, inbox.list())
    const projectedUser = projected.find(item => item.id === userCard.id)!

    expect(projectedUser.status).toBe('pending')
    expect(projectedUser.parentFinding).toBeUndefined()
    expect(findingCompleted(projectedUser)).toBe(false)
    expect(decisionNeedsAttention(projectedUser)).toBe(true)
    expect(decisionInHistory(projectedUser)).toBe(false)
  })

  it('leaves unbound typed delivery gates completely untouched', () => {
    const { findings, inbox } = setupFixture()

    const deliveryItem: PendingDecisionItem = {
      id: 'delivery-unbound-1',
      ticketTitle: 'Delivery: Unbound gate',
      trigger: 'delivery',
      status: 'pending',
      urgency: 'high',
      createdAt: 1000,
      context: 'Delivery missing target repo and requirements proof.',
      question: 'Accept this delivery?',
      choices: [],
      recommendation: { recommendedValue: '', confidence: 0, rationale: 'Missing bindings', distribution: [], provider: 'none', latencyMs: 0 },
      actionMode: 'feature_delivery',
      delivery: {
        id: 'del-1',
        title: 'Unbound feature delivery',
        owner: 'operator',
        authorities: ['local-operator'],
        workers: ['worker-1'],
        requirements: ['Verify production UI'],
        bindings: { repository: 'gera3d/superagent-sandbox', sourceIssue: 1, baseSha: '0'.repeat(40), headSha: '1'.repeat(40), environment: 'prod' },
        revision: 1,
        state: 'running',
        stage: 'implementation',
        evidence: [],
        attempts: { review: 0, fix: 0, maxReview: 3, maxFix: 3 },
        audit: [],
        generation: 1,
      },
    }

    const projected = projectFindings(findings, [deliveryItem])
    const projectedDel = projected.find(item => item.id === deliveryItem.id)!

    expect(projectedDel.status).toBe('pending')
    expect(projectedDel.delivery?.state).toBe('running')
    expect(decisionNeedsAttention(projectedDel)).toBe(true)
    expect(decisionInHistory(projectedDel)).toBe(false)
  })

  it('preserves finding with unresolved evidence review as active/blocked, not completed history', () => {
    const { findings, inbox } = setupFixture()

    let f = findings.observe({
      dedupKey: 'rec-unresolved-evidence',
      title: 'Blocked finding awaiting evidence',
      problem: 'Evidence not verified',
      scope: 'Bounded fix',
      owner: 'team',
      kind: 'fix',
      requirements: ['Pass all tests'],
      repository: 'gera3d/superagent-sandbox',
      occurrence: { id: 'occ-4', reference: 'ref-4', evidence: 'failed test' },
    })
    findings.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' })
    f = findings.markDispatched(f.id, 'ticket-worker-blocked', 'assign-blocked')

    const card = inbox.publishAdvisor({
      sessionId: 'worker-ticket-worker-blocked',
      sourceMessageId: 'msg-blocked',
      sourceTurn: 1,
      sourceSeq: 5,
      key: 'draft-blocked',
      createdAt: 1000,
      question: 'Choose next step',
      context: 'Blocked worker context',
      title: 'Blocked worker advice',
      model: 'Senior Developer',
      options: SAMPLE_CHOICES.map(c => ({ ...c, prompt: c.prompt!, why: 'test', recommended: c.id === 'next-1' })),
    })

    // Report worker report -> state becomes 'blocked'
    findings.markReview(f.id, {
      reference: 'ref-4',
      summary: 'evidence pending coordinator review',
      recordedAt: new Date(1500).toISOString(),
      state: 'ready',
    })

    const projected = projectFindings(findings, inbox.list())
    const projectedCard = projected.find(item => item.id === card.id)!

    // Finding is blocked, not resolved: card remains pending, NOT completed history
    expect(projectedCard.status).toBe('pending')
    expect(projectedCard.parentFinding?.state).toBe('blocked')
    expect(findingCompleted(projectedCard)).toBe(false)
    expect(decisionNeedsAttention(projectedCard)).toBe(true)
    expect(decisionInHistory(projectedCard)).toBe(false)
  })

  // Reads the operator's real database; only meaningful on the machine that has it.
  const liveDbPath = process.env.DSH_LIVE_ORCHESTRATOR_DB ?? '/Users/gerayeremin/Library/Application Support/dsh-desktop/harness/state/superagent/orchestrator.sqlite'
  it.skipIf(!existsSync(liveDbPath))('correctly projects live orchestrator.sqlite decisions: 12 completed cards become history, leaving 4 pending without mutating storage', () => {
    const db = new DatabaseSync(liveDbPath, { readOnly: true })
    dbs.push(db)

    const findings = new FindingStore(db)
    const inbox = new DecisionInbox(db)

    const rawList = inbox.list()
    const rawPending = rawList.filter(item => item.status === 'pending')
    // In raw SQLite, 17 decisions are pending (12 completed finding + superseded/active finding jobs + user decisions + deliveries)
    expect(rawPending.length).toBeGreaterThanOrEqual(14)

    // chat-55991230 is pending in SQLite
    const rawChat5599 = rawList.find(i => i.id === 'chat-55991230d8a233d12f328eec43ccc36f')!
    expect(rawChat5599).toBeDefined()
    expect(rawChat5599.status).toBe('pending')
    expect(rawChat5599.invalidation).toBeUndefined()

    // Run read-time projection
    const projected = projectFindings(findings, rawList)

    // Projected chat-55991230 is stale history with parent finding attribution
    const projChat5599 = projected.find(i => i.id === 'chat-55991230d8a233d12f328eec43ccc36f')!
    expect(projChat5599.status).toBe('stale')
    expect(projChat5599.staleReason).toContain('8d447429-65ee-4f5f-aa7b-354c0f349673')
    expect(projChat5599.parentFinding?.id).toBe('8d447429-65ee-4f5f-aa7b-354c0f349673')
    expect(projChat5599.parentFinding?.state).toBe('resolved')
    expect(findingCompleted(projChat5599)).toBe(true)
    expect(decisionNeedsAttention(projChat5599)).toBe(false)
    expect(decisionInHistory(projChat5599)).toBe(true)

    // All 12 completed finding cards are now non-actionable history
    const completedIds = [
      'chat-917a1a95b4ca62ade3ff9ab51f5f4511',
      'chat-b6913f776e0ff17c81b5a644625f22eb',
      'chat-eb937970f942747759f30c87b8476336',
      'chat-6f63c615b6048ded5cd2c534fe9540cf',
      'chat-73ef3245326f1665e339f404def676f1',
      'chat-232dc268b70284e055005e01c8f9ee17',
      'chat-a71ba8a1a0abcfc469fd1bcb06174d0f',
      'chat-6557f8abbb8003c73cfefec683a5c4cd',
      'chat-7d80df3b084ddfc8ba5f6bea9c655c7f',
      'chat-f96fc47a6722410ddcb1c105e3a7fcf3',
      'chat-94e77e2dc7bf4b94736ee247267c7e02',
      'chat-55991230d8a233d12f328eec43ccc36f',
    ]

    for (const id of completedIds) {
      const item = projected.find(i => i.id === id)!
      expect(item).toBeDefined()
      expect(item.status).toBe('stale')
      expect(decisionNeedsAttention(item)).toBe(false)
      expect(decisionInHistory(item)).toBe(true)
      expect(item.parentFinding?.state).toBe('resolved')
    }

    // Ordinary user decision remains active and pending
    const userCard = projected.find(i => i.id === 'chat-715d4bb2be0769a9aa7dbbe99f33c06d')!
    expect(userCard).toBeDefined()
    expect(userCard.status).toBe('pending')
    expect(decisionNeedsAttention(userCard)).toBe(true)
    expect(decisionInHistory(userCard)).toBe(false)

    // Only 1 non-finding decision is pending among the chat decisions
    const chatDecisionsNeedingAttention = projected.filter(i => i.id.startsWith('chat-') && decisionNeedsAttention(i))
    expect(chatDecisionsNeedingAttention.map(i => i.id)).toEqual(['chat-715d4bb2be0769a9aa7dbbe99f33c06d'])
  })

  it('native claim and publish with actual later human source survives history projection (root audit scenario)', () => {
    const { findings: fs, inbox } = setupFixture()
    let f = fs.observe({ dedupKey: 'root-native-reask', title: 'Reporting', problem: 'Report', scope: 'Verify reporting', owner: 'operator', kind: 'verification', repository: 'org/repo', requirements: ['Verified'], occurrence: { id: 'o', reference: 'ref', evidence: 'evidence' } })
    f = fs.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' }); f = fs.markDispatched(f.id, 'ticket-reask', 'assignment-reask')
    fs.markReview(f.id, { reference: 'report', summary: 'Ready report', recordedAt: new Date().toISOString(), state: 'ready' })
    fs.reportEvidence(f.id, { reference: 'proof', evidence: 'Verified', nextDecision: 'Accept', verified: true })
    f = fs.resolve(f.id, 'proof', ['Verified'])
    const at = Date.parse(f.resolution!.at), newTime = at + 5000
    const events: any[] = [
      { type: 'user/message', seq: 0, time: at - 300, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please verify reporting' }] } },
      { type: 'turn/end', seq: 1, time: at - 50, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'user/message', seq: 2, time: newTime, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Now please check the export latency.' }] } },
      { type: 'turn/start', seq: 3, time: newTime + 10, data: { turn: 2 } },
      { type: 'assistant/message', seq: 4, time: newTime + 50, data: { turn: 2, message: { id: 'msg-latency', content: [{ type: 'text', text: 'Export latency measured at 45ms.' }] } } },
      { type: 'turn/end', seq: 5, time: newTime + 100, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    const source = { sessionId: 'worker-ticket-reask', sourceMessageId: 'msg-latency', sourceSeq: 4, sourceTurn: 2, draftRevision: 'draft-latency' }
    const claim = inbox.claimCanonical({ ...source, owner: 'native-fallback' }, events)
    expect(claim.claimed).toBe(true)
    const result = inbox.publishCanonical({
      ...source,
      leaseToken: claim.leaseToken!,
      model: 'native-fallback',
      options: [
        { id: 'benchmark', label: 'Run multi-run benchmark', prompt: 'Execute 10-run latency benchmark to check p99.', why: 'Latency check', recommended: true },
        { id: 'summary', label: 'Summarize results', prompt: 'Report the 45ms measurement to user.', why: 'Summary', recommended: false },
      ],
    }, events)
    expect(result.item.status).toBe('pending')
    expect(result.item.human).toBe(true)
    expect(result.item.userSource).toEqual({ kind: 'user', time: newTime, seq: 2, turn: 2, messageId: undefined })

    const projected = projectFindings(fs, inbox.list()).find(x => x.id === result.item.id)!
    expect(projected.status).toBe('pending')
    expect(decisionNeedsAttention(projected)).toBe(true)
    expect(decisionInHistory(projected)).toBe(false)
  })

  it('keeps proof bound to source identity and parent state: newer activity cannot revive older completed cards', () => {
    const { findings, inbox } = setupFixture()

    // Finding A
    let fa = findings.observe({ dedupKey: 'fa', title: 'Task A', problem: 'Prob A', scope: 'Scope A', owner: 'team', kind: 'fix', requirements: ['Req A'], repository: 'org/repo', occurrence: { id: 'oa', reference: 'ra', evidence: 'ea' } })
    findings.confirm(fa.id, { revision: fa.revision, choiceId: 'fix_now' })
    fa = findings.markDispatched(fa.id, 'ticket-fa', 'assign-fa')
    findings.markReview(fa.id, { reference: 'rep-a', summary: 'Ready', recordedAt: new Date(1000).toISOString(), state: 'ready' })
    fa = findings.resolve(fa.id, 'rep-a', fa.requirements)
    const atA = Date.parse(fa.resolution!.at)

    // Pre-acceptance card for Finding A from Turn 1 (before resolution)
    const cardTurn1 = inbox.put({
      id: 'chat-turn-1-pre-acceptance',
      sessionId: 'worker-ticket-fa',
      sourceMessageId: 'msg-turn-1',
      sourceTurn: 1,
      sourceSeq: 2,
      userSource: { kind: 'user', time: atA - 500, seq: 0, turn: 1 },
      human: true,
      createdAt: atA - 200,
      ticketTitle: 'Task A steps',
      trigger: 'Task A steps',
      status: 'pending',
      urgency: 'low',
      question: 'Next step',
      choices: SAMPLE_CHOICES,
      recommendation: SAMPLE_RECOMMENDATION,
      context: 'Pre-acceptance Turn 1',
    })

    // Now Turn 2 happens with a later human message at atA + 3000
    const cardTurn2 = inbox.put({
      id: 'chat-turn-2-post-acceptance',
      sessionId: 'worker-ticket-fa',
      sourceMessageId: 'msg-turn-2',
      sourceTurn: 2,
      sourceSeq: 6,
      userSource: { kind: 'user', time: atA + 3000, seq: 4, turn: 2 },
      human: true,
      createdAt: atA + 3100,
      ticketTitle: 'Task A follow-up',
      trigger: 'Task A follow-up',
      status: 'pending',
      urgency: 'low',
      question: 'Follow-up step',
      choices: SAMPLE_CHOICES,
      recommendation: SAMPLE_RECOMMENDATION,
      context: 'Post-acceptance Turn 2',
    })

    const projected = projectFindings(findings, inbox.list())
    const projTurn1 = projected.find(i => i.id === cardTurn1.id)!
    const projTurn2 = projected.find(i => i.id === cardTurn2.id)!

    // Turn 1 remains stale history (NOT revived by Turn 2)
    expect(projTurn1.status).toBe('stale')
    expect(decisionNeedsAttention(projTurn1)).toBe(false)
    expect(decisionInHistory(projTurn1)).toBe(true)

    // Turn 2 remains active pending
    expect(projTurn2.status).toBe('pending')
    expect(decisionNeedsAttention(projTurn2)).toBe(true)
    expect(decisionInHistory(projTurn2)).toBe(false)
  })

  it('workflow progress triggers fresh generation, updates advice to remaining native verification with Codex owner, and rejects stale selection', async () => {
    const { db, findings, inbox } = setupFixture()
    const progress = new ProgressStore(db)

    const ticketId = '704a19544bd016b118746a4ea00d062a'
    const sessionId = `worker-${ticketId}`

    // 1. Observe active finding
    let f = findings.observe({
      dedupKey: 'r11-workflow-progress',
      title: 'Current progress freshness',
      problem: 'Stale advice after outside progress',
      scope: 'Bounded fix',
      owner: 'team',
      kind: 'fix',
      requirements: ['Update advice to native verification after merge/deploy'],
      repository: 'gera3d/superagent-sandbox',
      occurrence: { id: 'occ-1', reference: 'ref-1', evidence: 'r7 advice stale' },
    })
    findings.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' })
    f = findings.markDispatched(f.id, ticketId, 'assign-r11')

    // 2. Initial completed turn events
    const initialEvents: any[] = [
      { type: 'user/message', seq: 0, time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix the UI caption blocker' }] } },
      { type: 'turn/start', seq: 1, time: 1010, data: { turn: 1 } },
      { type: 'assistant/message', seq: 2, time: 1050, data: { turn: 1, message: { id: 'msg-turn-1', content: [{ type: 'text', text: 'Fixed the caption and verified tests pass.' }] } } },
      { type: 'turn/end', seq: 3, time: 1100, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const initialSource = { sessionId, sourceMessageId: 'msg-turn-1', sourceSeq: 2, sourceTurn: 1, draftRevision: 'rev-pre-progress' }

    // 3. Initial claim and publication (r7 candidate advice: pre-review checks & caption audit)
    const initialClaim = inbox.claimCanonical({ ...initialSource, owner: 'plugin-host' }, initialEvents)
    expect(initialClaim.claimed).toBe(true)
    const initialCard = inbox.publishCanonical({
      ...initialSource,
      leaseToken: initialClaim.leaseToken!,
      model: 'Senior Developer',
      options: [
        { id: 'next-2', label: 'Verify exact-head evidence before review', prompt: 'Inspect logs before coordinator review.', why: 'Evidence check', recommended: true },
        { id: 'next-3', label: 'Audit the caption revert for regressions', prompt: 'Audit caption revert in tests.', why: 'Audit regressions', recommended: false },
      ],
    }, initialEvents)
    expect(initialCard.item.status).toBe('pending')
    expect(initialCard.item.choices[0]!.id).toBe('next-2')

    // 4. Outside progress occurs: coordinator reviews, PR is merged, and feature is deployed
    const deployObs = progress.observe({
      ticketId,
      kind: 'deployed',
      repository: 'gera3d/superagent-sandbox',
      branch: 'codex/completed-advice-history-release-20261109',
      commit: 'd3bd7e7771cd2d5c87e319a7a6f7db05c1131a7e',
      pr: 77,
      outcome: 'passed',
      environment: 'local-superagent@127.0.0.1:3082',
      evidence: 'Root exact source/assets hashes, rollback and restart exit 0; PR77 deployed to local environment.',
      owner: 'Codex root release operator',
      observedAt: new Date(2000).toISOString(),
    }, { source: 'operator', reference: 'root:codex-release-20261109' }, 2050)
    expect(deployObs.observation.seq).toBeGreaterThan(0)

    // 5. Native claim after progress observation: triggers real generation and supersedes old item (unchanged draftRevision from session digest)
    const postProgressSource = { sessionId, sourceMessageId: 'msg-turn-1', sourceSeq: 2, sourceTurn: 1, draftRevision: 'rev-pre-progress' }
    const postProgressClaim = inbox.claimCanonical({ ...postProgressSource, owner: 'plugin-host' }, initialEvents)
    expect(postProgressClaim.claimed).toBe(true)
    expect(postProgressClaim.item.supersedesDecisionId).toBe(initialCard.item.id)
    expect(postProgressClaim.item.choices).toHaveLength(0)

    // Verify old card is now marked superseded in SQLite, preserving original choices
    const oldCardInDb = inbox.get(initialCard.item.id)!
    expect(oldCardInDb.status).toBe('stale')
    expect(oldCardInDb.invalidation?.reason).toContain('superseded')
    expect(oldCardInDb.choices).toHaveLength(2)
    expect(oldCardInDb.choices[0]!.id).toBe('next-2')

    // 6. Stale selection rejection: attempting to stage a choice from the superseded card fails
    const attemptId = '11111111-2222-4444-8888-999999999999'
    expect(() => inbox.stage(initialCard.item.id, {
      attemptId,
      choiceId: 'next-2',
      draftText: 'Inspect logs before coordinator review.',
    })).toThrowError(/stale/)

    // 7. Verify adviceContext reflects that review/tests/merge/deploy are done, and directs to native verification/acceptance with Codex owner
    const mockTicket: any = {
      id: ticketId,
      title: 'Workflow progress test',
      mandate: { strength: 'required', scope: 'Fix recommendation presentation' },
      assignments: [{ id: 'assign-r11', state: 'running' }],
      channels: [],
      undelivered: [],
    }
    const currentProgressView = progress.current(ticketId)!
    expect(currentProgressView.kind).toBe('deployed')
    const ctx = adviceContext(mockTicket, undefined, currentProgressView, f)
    expect(ctx).toContain('CANONICAL FINDING VERIFICATION AND ACCEPTANCE OBJECTIVE')
    expect(ctx).toContain('Independent checks, source review, PR merge, and deployment have already been completed')
    expect(ctx).toContain('The only remaining stage is native verification and final acceptance by the authorized coordinator (Codex reviewer and release coordinator / root operator')
    expect(ctx).toContain('Both offered choices must name only remaining native verification or acceptance with the Codex owner')

    // 8. Publish the fresh advice naming only remaining native verification/acceptance with Codex owner
    const freshPublished = inbox.publishCanonical({
      ...postProgressSource,
      leaseToken: postProgressClaim.leaseToken!,
      model: 'Senior Developer',
      options: [
        {
          id: 'verify-live',
          label: 'Verify deployed feature natively in live application',
          prompt: 'Live verification: verify the deployed feature natively in the running application with the Codex coordinator under existing approval.',
          why: 'Merge and deployment are recorded complete; verify live feature natively before final acceptance.',
          recommended: true,
        },
        {
          id: 'record-acceptance',
          label: 'Record coordinator acceptance for verified feature',
          prompt: 'Handoff to Codex coordinator to record final verification and acceptance for this finding.',
          why: 'If native verification is already confirmed, advance to final coordinator acceptance.',
          recommended: false,
        },
      ],
    }, initialEvents)
    expect(freshPublished.item.status).toBe('pending')
    expect(freshPublished.item.choices[0]!.id).toBe('verify-live')
    expect(freshPublished.item.choices[0]!.label).toContain('Verify deployed feature')

    // 9. Staging the new choice succeeds
    const stagingAttemptId = '22222222-3333-4444-8888-000000000000'
    const stageResult = inbox.stage(freshPublished.item.id, {
      attemptId: stagingAttemptId,
      choiceId: 'verify-live',
      draftText: 'Live verification: verify the deployed feature natively in the running application with the Codex coordinator under existing approval.',
    })
    expect(stageResult.staging?.choiceId).toBe('verify-live')

    // 10. Parent finding resolution: stops subsequent advice
    inbox.discardStaging(freshPublished.item.id, stagingAttemptId)
    findings.markReview(f.id, { reference: 'live-evidence', summary: 'Live verification confirmed', recordedAt: new Date(3000).toISOString(), state: 'ready' })
    f = findings.resolve(f.id, 'live-evidence', f.requirements)

    expect(() => inbox.claimCanonical({
      sessionId,
      sourceMessageId: 'msg-turn-1',
      sourceSeq: 2,
      sourceTurn: 1,
      draftRevision: 'rev-after-acceptance',
      owner: 'plugin-host',
    }, initialEvents)).toThrowError(/Scope is completed and resolved/)

    // Projection marks completed finding cards as non-actionable history
    const projected = projectFindings(findings, inbox.list())
    const projFresh = projected.find(i => i.id === freshPublished.item.id)!
    expect(projFresh.status).toBe('stale')
    expect(projFresh.staleReason).toContain('was verified and accepted')
  })
})
