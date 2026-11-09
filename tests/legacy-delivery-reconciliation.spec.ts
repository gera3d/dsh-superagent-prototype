import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DeliveryStore,
  deliveryFingerprint,
  LEGACY_RECONCILIATION_MAP,
  type LegacyHistoricalReconciliationRecord,
  type DeliveryConfirmationAuthority,
} from '../src/app/feature-delivery.ts'
import { deliveryDecision, projectDeliveries, reconcileDeliveryAdvice } from '../src/app/delivery-runtime.ts'
import { decisionNeedsAttention, decisionInHistory } from '../src/core/publication-queue.ts'
import type { PendingDecisionItem } from '../src/core/decision.ts'

const VALID_RECORDS: LegacyHistoricalReconciliationRecord[] = [
  {
    deliveryId: 'auto-1aa9568a8df574db0cef146a58004c4b',
    revision: 3,
    sourceIssue: 184,
    originalWorkerId: '1aa9568a8df574db0cef146a58004c4b',
    releasePr: 33,
    releaseMergedSha: 'fb591843c3f9ff19965a49e45a4157ed195fc890',
    evidenceReference: 'https://github.com/gera3d/dsh-superagent-prototype/pull/33',
    attestation: 'Operator confirmed historical completion via verified later release PR #33; closed source issue #184. No typed acceptance or publication grant.',
  },
  {
    deliveryId: 'auto-71dc25902ccec92c851634c58cf365f0',
    revision: 3,
    sourceIssue: 188,
    originalWorkerId: '71dc25902ccec92c851634c58cf365f0',
    releasePr: 33,
    releaseMergedSha: 'fb591843c3f9ff19965a49e45a4157ed195fc890',
    evidenceReference: 'https://github.com/gera3d/dsh-superagent-prototype/pull/33',
    attestation: 'Operator confirmed historical completion via verified later release PR #33; closed source issue #188. No typed acceptance or publication grant.',
  },
  {
    deliveryId: 'auto-d65f3131a9ae77d9de524535e4a01a26',
    revision: 3,
    sourceIssue: 182,
    originalWorkerId: 'd65f3131a9ae77d9de524535e4a01a26',
    releasePr: 33,
    releaseMergedSha: 'fb591843c3f9ff19965a49e45a4157ed195fc890',
    evidenceReference: 'https://github.com/gera3d/dsh-superagent-prototype/pull/33',
    attestation: 'Operator confirmed historical completion via verified later release PR #33; closed source issue #182. No typed acceptance or publication grant.',
  },
]

function seedLegacyDeliveries(store: DeliveryStore) {
  for (const record of VALID_RECORDS) {
    const meta = LEGACY_RECONCILIATION_MAP[record.deliveryId]!
    const d = {
      id: record.deliveryId,
      title: meta.title,
      owner: `worker:${record.originalWorkerId}`,
      bindings: {
        repository: 'gera3d/superagent-sandbox',
        sourceIssue: record.sourceIssue,
        baseSha: '',
        headSha: '',
        refs: [],
      },
      requirements: ['intake:acceptance-requirements-unconfirmed'],
      authorities: [],
      delegatedActions: [],
      followFixHeads: false,
      authorizedFixScopes: [],
      generation: 0,
      workers: [record.originalWorkerId],
      revision: 3,
      stage: 'review',
      state: 'blocked',
      scopeBinding: {
        reason: 'Operator-confirmed delivery scope, target and acceptance requirements are missing',
        sourceTriggerId: `trigger-${record.originalWorkerId}`,
      },
      attempts: { review: 0, fix: 0, maxReview: 3, maxFix: 2 },
      evidence: [],
      audit: [
        {
          at: '2026-11-06T23:49:39.824Z',
          event: `tracked-unbound:trigger-${record.originalWorkerId}`,
          actor: `worker:${record.originalWorkerId}`,
        },
      ],
      blocker: 'Operator-confirmed delivery scope, target and acceptance requirements are missing',
    }
    store.db.prepare('INSERT OR REPLACE INTO feature_delivery VALUES(?,?,?)').run(d.id, d.revision, JSON.stringify(d))
  }
}

describe('Legacy delivery historical completion reconciliation', () => {
  let tempDir: string
  let store: DeliveryStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'legacy-reconcile-test-'))
    store = new DeliveryStore(join(tempDir, 'test.sqlite'))
    seedLegacyDeliveries(store)
  })

  afterEach(() => {
    store.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('previewLegacyHistoricalReconciliation validates exact parameters without mutating store', () => {
    const preview = store.previewLegacyHistoricalReconciliation(VALID_RECORDS)
    expect(preview).toHaveLength(3)
    expect(preview[0]!.deliveryId).toBe('auto-1aa9568a8df574db0cef146a58004c4b')
    expect(preview[0]!.sourceIssue).toBe(184)
    expect(preview[0]!.status).toBe('stale')
    expect(preview[0]!.caption).toContain('Delivered by later release PR #33')

    // Store remains unmutated
    const d = store.get('auto-1aa9568a8df574db0cef146a58004c4b')!
    expect(d.revision).toBe(3)
    expect(d.historicalCompletion).toBeUndefined()
  })

  it('reconcileLegacyHistoricalCompletion updates deliveries to completed history and preserves empty pins', () => {
    const hash = deliveryFingerprint(VALID_RECORDS)
    const authority: DeliveryConfirmationAuthority = {
      source: 'local_operator',
      actor: 'local-operator',
      reference: 'finding:60b19ba2-1ff6-4f95-af39-098829779103:r1',
      scope: hash,
    }

    const reconciled = store.reconcileLegacyHistoricalCompletion(VALID_RECORDS, hash, authority)
    expect(reconciled).toHaveLength(3)

    for (const d of reconciled) {
      expect(d.revision).toBe(4) // incremented
      expect(d.state).toBe('blocked') // state remains blocked; not accepted
      expect(d.acceptance).toBeUndefined() // not accepted
      expect(d.bindings.baseSha).toBe('') // empty pins preserved
      expect(d.bindings.headSha).toBe('')
      expect(d.bindings.refs).toEqual([])
      expect(d.scopeBinding).toBeDefined() // scopeBinding preserved
      expect(d.historicalCompletion).toBeDefined()
      expect(d.historicalCompletion!.releasePr).toBe(33)
      expect(d.historicalCompletion!.releaseMergedSha).toBe('fb591843c3f9ff19965a49e45a4157ed195fc890')
      expect(d.historicalCompletion!.caption).toContain('Retained as completed/superseded history')
      expect(d.nextAction).toBeUndefined()
      expect(d.audit.at(-1)!.event).toContain('historical-reconciliation:')
    }
  })

  it('is idempotent on exact replay with same authority and hash', () => {
    const hash = deliveryFingerprint(VALID_RECORDS)
    const authority: DeliveryConfirmationAuthority = {
      source: 'local_operator',
      actor: 'local-operator',
      reference: 'finding:60b19ba2-1ff6-4f95-af39-098829779103:r1',
      scope: hash,
    }

    const first = store.reconcileLegacyHistoricalCompletion(VALID_RECORDS, hash, authority)
    const second = store.reconcileLegacyHistoricalCompletion(VALID_RECORDS, hash, authority)

    expect(second.map(d => d.revision)).toEqual([4, 4, 4])
    expect(second[0]!.audit).toEqual(first[0]!.audit)
  })

  it('rejects unsupported delivery ID', () => {
    const invalid = [{ ...VALID_RECORDS[0]!, deliveryId: 'auto-unsupported-id' }]
    expect(() => store.previewLegacyHistoricalReconciliation(invalid)).toThrow('Unsupported delivery ID')
  })

  it('rejects mismatched source issue', () => {
    const invalid = [{ ...VALID_RECORDS[0]!, sourceIssue: 999 }]
    expect(() => store.previewLegacyHistoricalReconciliation(invalid)).toThrow('Mismatched source issue')
  })

  it('rejects mismatched original worker ID', () => {
    const invalid = [{ ...VALID_RECORDS[0]!, originalWorkerId: 'wrong-worker' }]
    expect(() => store.previewLegacyHistoricalReconciliation(invalid)).toThrow('Mismatched original worker ID')
  })

  it('rejects stale delivery revision', () => {
    const hash = deliveryFingerprint(VALID_RECORDS)
    const authority: DeliveryConfirmationAuthority = {
      source: 'local_operator',
      actor: 'local-operator',
      reference: 'ref',
      scope: hash,
    }
    // Update store delivery to revision 4
    store.db.prepare("UPDATE feature_delivery SET revision=4 WHERE id='auto-1aa9568a8df574db0cef146a58004c4b'").run()

    expect(() => store.reconcileLegacyHistoricalCompletion(VALID_RECORDS, hash, authority)).toThrow('Stale delivery revision')
  })

  it('rejects non-local operator authority', () => {
    const hash = deliveryFingerprint(VALID_RECORDS)
    const authority = {
      source: 'github' as const,
      actor: 'local-operator',
      reference: 'ref',
      scope: hash,
    }
    expect(() => store.reconcileLegacyHistoricalCompletion(VALID_RECORDS, hash, authority as any)).toThrow('structured local operator authority required')
  })

  it('rejects if delivery is already bound to concrete SHAs', () => {
    // Tamper one delivery to have bound headSha
    store.db.prepare("UPDATE feature_delivery SET value=json_set(value, '$.bindings.headSha', 'abc') WHERE id='auto-1aa9568a8df574db0cef146a58004c4b'").run()
    const hash = deliveryFingerprint(VALID_RECORDS)
    const authority: DeliveryConfirmationAuthority = {
      source: 'local_operator',
      actor: 'local-operator',
      reference: 'ref',
      scope: hash,
    }
    expect(() => store.reconcileLegacyHistoricalCompletion(VALID_RECORDS, hash, authority)).toThrow('not in original unbound scope')
  })

  it('rejects if active outbox row exists for the delivery', () => {
    store.db.prepare("INSERT INTO feature_delivery_outbox(id, delivery_id, value, status) VALUES('outbox-1', 'auto-1aa9568a8df574db0cef146a58004c4b', '{}', 'pending')").run()
    const hash = deliveryFingerprint(VALID_RECORDS)
    const authority: DeliveryConfirmationAuthority = {
      source: 'local_operator',
      actor: 'local-operator',
      reference: 'ref',
      scope: hash,
    }
    expect(() => store.reconcileLegacyHistoricalCompletion(VALID_RECORDS, hash, authority)).toThrow('Outstanding handoff requires its own reconciliation')
  })

  it('rejects if active worker ticket is still running without ready report', () => {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO ticket VALUES('1aa9568a8df574db0cef146a58004c4b', '{"id":"1aa9568a8df574db0cef146a58004c4b","assignments":[{"state":"running"}]}');
    `)
    const hash = deliveryFingerprint(VALID_RECORDS)
    const authority: DeliveryConfirmationAuthority = {
      source: 'local_operator',
      actor: 'local-operator',
      reference: 'ref',
      scope: hash,
    }
    expect(() => store.reconcileLegacyHistoricalCompletion(VALID_RECORDS, hash, authority)).toThrow('Worker 1aa9568a8df574db0cef146a58004c4b still has active running assignment')
  })

  it('settled reconciled delivery is immutable to generic updates and actions', () => {
    const hash = deliveryFingerprint(VALID_RECORDS)
    const authority: DeliveryConfirmationAuthority = {
      source: 'local_operator',
      actor: 'local-operator',
      reference: 'ref',
      scope: hash,
    }
    const [reconciled] = store.reconcileLegacyHistoricalCompletion(VALID_RECORDS, hash, authority)

    expect(store.eligibleActions(reconciled!.id)).toEqual([])
    expect(() => store.confirm(reconciled!.id, { revision: 4, actionId: 'anything' }, authority)).toThrow('Stale or ineligible delivery action')
    expect(() => store.resume(reconciled!.id, 4, authority)).toThrow('Resume requires the current exact parked reconciliation action')
  })
})

describe('Decisions and Queue projections for reconciled historical delivery', () => {
  let tempDir: string
  let store: DeliveryStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'legacy-proj-test-'))
    store = new DeliveryStore(join(tempDir, 'test.sqlite'))
    seedLegacyDeliveries(store)
  })

  afterEach(() => {
    store.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('deliveryDecision projects stale status, no choices, low urgency and clear caption', () => {
    const hash = deliveryFingerprint(VALID_RECORDS)
    const authority: DeliveryConfirmationAuthority = {
      source: 'local_operator',
      actor: 'local-operator',
      reference: 'ref',
      scope: hash,
    }
    const [reconciled] = store.reconcileLegacyHistoricalCompletion(VALID_RECORDS, hash, authority)
    const decision = deliveryDecision(reconciled!)

    expect(decision.status).toBe('stale')
    expect(decision.staleReason).toContain('Delivered by later release PR #33')
    expect(decision.urgency).toBe('low')
    expect(decision.choices).toEqual([])
    expect(decision.recommendation?.recommendedValue).toBe('')
    expect(decision.recommendation?.rationale).toContain('Nonactionable completed history')
  })

  it('decisionNeedsAttention returns false and decisionInHistory returns true for reconciled delivery', () => {
    const hash = deliveryFingerprint(VALID_RECORDS)
    const authority: DeliveryConfirmationAuthority = {
      source: 'local_operator',
      actor: 'local-operator',
      reference: 'ref',
      scope: hash,
    }
    const [reconciled] = store.reconcileLegacyHistoricalCompletion(VALID_RECORDS, hash, authority)
    const decision = deliveryDecision(reconciled!)

    expect(decisionNeedsAttention(decision)).toBe(false)
    expect(decisionInHistory(decision)).toBe(true)
  })

  it('projectDeliveries and reconcileDeliveryAdvice retire associated worker advice', () => {
    const hash = deliveryFingerprint(VALID_RECORDS)
    const authority: DeliveryConfirmationAuthority = {
      source: 'local_operator',
      actor: 'local-operator',
      reference: 'ref',
      scope: hash,
    }
    store.reconcileLegacyHistoricalCompletion(VALID_RECORDS, hash, authority)

    const pendingItem: PendingDecisionItem = {
      id: 'chat-advice-1',
      sessionId: 'worker-1aa9568a8df574db0cef146a58004c4b',
      ticketId: '1aa9568a8df574db0cef146a58004c4b',
      ticketTitle: 'Older advice',
      trigger: 'conversation',
      status: 'pending',
      urgency: 'low',
      question: 'Choose the next step for this thread',
      context: '',
      createdAt: 1000,
      advisor: { key: 'advice' } as any,
      choices: [],
      recommendation: { recommendedValue: '', confidence: 0, rationale: '', distribution: [], provider: '', latencyMs: 0 },
    }

    const projected = projectDeliveries(store, [pendingItem])
    const retiredAdvice = projected.find(i => i.id === 'chat-advice-1')!
    expect(retiredAdvice.status).toBe('stale')
    expect(retiredAdvice.staleReason).toContain('Generated advice is superseded')
  })
})

describe('CLI delivery-legacy-reconcile tool', () => {
  let tempDir: string
  let inputPath: string
  let dbPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'legacy-cli-test-'))
    inputPath = join(tempDir, 'input.json')
    dbPath = join(tempDir, 'test.sqlite')
    writeFileSync(inputPath, JSON.stringify({ schemaVersion: 1, records: VALID_RECORDS }, null, 2))
    const s = new DeliveryStore(dbPath)
    seedLegacyDeliveries(s)
    s.close()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('executes preview mode deterministically without writing database', () => {
    const stdout = execFileSync('node', ['--experimental-transform-types', 'scripts/delivery-legacy-reconcile.ts', '--preview', inputPath], {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
    })
    const parsed = JSON.parse(stdout)
    expect(parsed.mode).toBe('preview')
    expect(parsed.readOnly).toBe(true)
    expect(parsed.recordsFingerprint).toBe(deliveryFingerprint(VALID_RECORDS))
    expect(parsed.preview).toHaveLength(3)

    // DB remains at revision 3
    const s = new DeliveryStore(dbPath)
    expect(s.get('auto-1aa9568a8df574db0cef146a58004c4b')!.revision).toBe(3)
    s.close()
  })

  it('executes apply mode and reconciles records, rejecting invalid hash', () => {
    const hash = deliveryFingerprint(VALID_RECORDS)
    // Wrong hash fails
    expect(() => execFileSync('node', [
      '--experimental-transform-types',
      'scripts/delivery-legacy-reconcile.ts',
      '--apply', inputPath,
      '--database', dbPath,
      '--expected-hash', '0'.repeat(64),
      '--actor', 'local-operator',
      '--reference', 'ref-1',
    ], { cwd: join(__dirname, '..'), encoding: 'utf8' })).toThrow()

    // Valid apply succeeds
    const stdout = execFileSync('node', [
      '--experimental-transform-types',
      'scripts/delivery-legacy-reconcile.ts',
      '--apply', inputPath,
      '--database', dbPath,
      '--expected-hash', hash,
      '--actor', 'local-operator',
      '--reference', 'ref-1',
    ], { cwd: join(__dirname, '..'), encoding: 'utf8' })

    const parsed = JSON.parse(stdout)
    expect(parsed.mode).toBe('apply')
    expect(parsed.readOnly).toBe(false)
    expect(parsed.deliveries).toHaveLength(3)
    expect(parsed.deliveries[0].revision).toBe(4)

    // DB has revision 4 with historicalCompletion
    const s = new DeliveryStore(dbPath)
    const d = s.get('auto-1aa9568a8df574db0cef146a58004c4b')!
    expect(d.revision).toBe(4)
    expect(d.historicalCompletion?.releasePr).toBe(33)
    s.close()
  })
})
