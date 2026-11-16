import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilePublicationPersistence } from '../src/app/publication-persistence.ts'
import { PublicationService, sanitizeDiagnosticMessage, classifyPublicationError, type PublicationAdapter, type PublicationAuthority, type PublicationPins, type PublicationSnapshot, type PublicationStage } from '../src/app/publication.ts'
import { PublicationCoordinator } from '../src/app/publication-worker.ts'
import { DeliveryStore } from '../src/app/feature-delivery.ts'
import { deliveryPublicationCapabilities } from '../src/app/delivery-publication.ts'
import { ticketDecisions } from '../src/app/decision-inbox.ts'
import { publicationConversation, type LifecyclePublication } from '../src/app/lifecycle-publication.ts'
import type { Ticket } from '../src/core/model.ts'

const directories: string[] = []
const dbs: DatabaseSync[] = []
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const db of dbs.splice(0)) db.close()
})

const pins: PublicationPins & { ticketId: string; conversationId: string } = {
  ticketId: 'worker-ticket-1',
  conversationId: 'worker-ticket-1:decision:canonical',
  repository: 'test-org/repo',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  patchSha256: 'b'.repeat(64),
}
const manifest = 'c'.repeat(64)

function createFixture(options: { captureBinding?: (p: PublicationSnapshot) => unknown; launch?: (id: string) => Promise<void> } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'pub-diag-test-'))
  directories.push(stateDir)
  const store = new FilePublicationPersistence(join(stateDir, 'publication-state.json'))
  const stagesExecuted: PublicationStage[] = []
  let prState: 'open' | 'merged' = 'open'

  const adapter: PublicationAdapter = {
    evidence: async () => ({
      ...pins,
      observedAt: new Date().toISOString(),
      checks: 'passed',
      review: 'approved',
      mergeable: true,
      state: prState,
    }),
    perform: async (stage: PublicationStage) => {
      stagesExecuted.push(stage)
      if (stage === 'merge') prState = 'merged'
      return { detail: `${stage} succeeded` }
    },
  }

  const service = new PublicationService({ store, adapter })
  const coordinator = new PublicationCoordinator({
    stateDir,
    store,
    service,
    manifestSha256: manifest,
    launch: options.launch ?? (async () => {}),
    captureBinding: options.captureBinding ?? (p => ({ ticketId: p.ticketId, conversationId: p.conversationId })),
  })

  const authority = (p: PublicationSnapshot, action: 'publish' | 'rollback' = 'publish', overrides: Partial<PublicationAuthority> = {}): PublicationAuthority => ({
    kind: 'human_click',
    actorId: 'operator-1',
    authorized: true,
    ticketId: p.ticketId,
    conversationId: p.conversationId,
    publicationId: p.id,
    action,
    isCurrent: () => true,
    ...overrides,
  })

  const input = (p: PublicationSnapshot, requestId = 'req-1', action: 'publish' | 'rollback' = 'publish') => ({
    ticketId: p.ticketId,
    conversationId: p.conversationId,
    publicationId: p.id,
    requestId,
    action,
  })

  return { stateDir, store, adapter, service, coordinator, authority, input, stagesExecuted }
}

describe('Sanitized Publication Phase and Failure Diagnostics', () => {
  describe('Sanitization and Error Classification', () => {
    it('redacts tokens, credentials, and sensitive headers while preserving commit and patch sha256 digests', () => {
      const sensitive = `Failed to connect with token: ghp_1234567890abcdef1234567890 and Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID or https://user:supersecretpass@git.internal/repo at head ${pins.headSha} and patch ${pins.patchSha256}`
      const sanitized = sanitizeDiagnosticMessage(sensitive)

      expect(sanitized).not.toContain('ghp_1234567890abcdef1234567890')
      expect(sanitized).not.toContain('supersecretpass')
      expect(sanitized).toContain('[REDACTED_SECRET]')
      expect(sanitized).toContain('[REDACTED_CREDENTIALS]')
      expect(sanitized).toContain(pins.headSha)
      expect(sanitized).toContain(pins.patchSha256)
    })

    it('redacts space-containing quoted secrets without literal $1 output or suffix leakage', () => {
      const input = 'api_key="abc def ghi"'
      const sanitized = sanitizeDiagnosticMessage(input)

      expect(sanitized).not.toContain('$1')
      expect(sanitized).not.toContain('def ghi')
      expect(sanitized).toBe('api_key="[REDACTED]"')
    })

    it('redacts multiline quoted secrets without leaking suffix across linebreaks', () => {
      const input = 'api_key="abc\nnewline\ndef ghi"'
      const sanitized = sanitizeDiagnosticMessage(input)

      expect(sanitized).not.toContain('$1')
      expect(sanitized).not.toContain('newline')
      expect(sanitized).not.toContain('def ghi')
      expect(sanitized).toBe('api_key="[REDACTED]"')
    })

    it('redacts raw provider JSON payloads, customer emails, and private content without leaking payloads', () => {
      const input = 'raw provider response: {"customerEmail":"fixture@example.invalid","content":"PRIVATE_FIXTURE_CONTENT"}'
      const sanitized = sanitizeDiagnosticMessage(input)

      expect(sanitized).not.toContain('customerEmail')
      expect(sanitized).not.toContain('fixture@example.invalid')
      expect(sanitized).not.toContain('PRIVATE_FIXTURE_CONTENT')
      expect(sanitized).toContain('[REDACTED_PAYLOAD]')
    })

    it('classifies publication errors into standardized bounded failure categories and causes', () => {
      const stale = classifyPublicationError(new Error('Reviewed release configuration changed; approval is stale'))
      expect(stale.category).toBe('stale_pins')
      expect(stale.cause).toBe('stale_configuration_pins')
      expect(stale.message).toBe('stale_pins: stale_configuration_pins')
      expect(stale.message).not.toContain('Reviewed release configuration changed')

      const auth = classifyPublicationError(new Error('Missing explicit bound human/operator authority'))
      expect(auth.category).toBe('authority_mismatch')
      expect(auth.cause).toBe('authority_missing_or_mismatched')
      expect(auth.message).toBe('authority_mismatch: authority_missing_or_mismatched')
      expect(auth.message).not.toContain('Missing explicit bound')

      const idemp = classifyPublicationError(new Error('Worker idempotency key reused for another authority/action/instruction'))
      expect(idemp.category).toBe('idempotency_conflict')
      expect(idemp.cause).toBe('idempotency_key_reused')

      const bind = classifyPublicationError(new Error('Pre-enqueue binding capture failed'))
      expect(bind.category).toBe('pre_enqueue_binding_failed')
      expect(bind.cause).toBe('pre_enqueue_binding_serialization_failed')

      const ticket = classifyPublicationError(new Error('Canonical ticket changed before effect'))
      expect(ticket.category).toBe('canonical_ticket_changed')
      expect(ticket.cause).toBe('canonical_ticket_or_decision_changed')

      const concurrency = classifyPublicationError(new Error('Another approved detached publication is in progress'))
      expect(concurrency.category).toBe('concurrency_blocked')
      expect(concurrency.cause).toBe('concurrency_grant_active')

      const launch = classifyPublicationError(new Error('Worker launch failed'))
      expect(launch.category).toBe('worker_launch_failed')
      expect(launch.cause).toBe('worker_launch_process_failed')
    })
  })

  describe('Pre-Enqueue Failure Diagnostics & Before-Effect Rejection', () => {
    it('records before_effect_rejection with allowlisted category and cause when configuration pins are stale', async () => {
      const f = createFixture()

      const db = new DatabaseSync(':memory:')
      dbs.push(db)
      const deliveryStore = new DeliveryStore(db)

      const at = new Date().toISOString()
      const ticket: Ticket = {
        id: pins.ticketId,
        title: 'Task',
        decisionId: 'original',
        mandate: {} as never,
        origin: { triggerId: 'source', triggerIds: ['source'] },
        createdAt: at,
        updatedAt: at,
        channels: [],
        inputs: [],
        undelivered: [],
        follows: [{ thread: 'github:42', own: true }],
        assignments: [{ id: 'assignment', state: 'running', createdAt: at, idleAt: at, report: { state: 'ready', summary: 'Ready', at } }],
      }
      const item = ticketDecisions([ticket])[0]!
      const p = await f.service.prepare({ ...pins, conversationId: publicationConversation(item) })

      const scope = {
        environment: 'isolated-test',
        refs: [{ repository: pins.repository, pr: pins.prNumber, headSha: pins.headSha }],
        components: ['Component'],
        effects: ['apply', 'build', 'restart', 'verify'],
        manifestSha256: manifest,
      }

      let delivery = deliveryStore.create({
        id: 'del-1',
        title: 'Delivery Title',
        owner: 'reviewer',
        workers: [ticket.id],
        requirements: ['native-click'],
        authorities: ['operator'],
        bindings: {
          repository: pins.repository,
          sourceIssue: 100,
          baseSha: 'b'.repeat(40),
          headSha: pins.headSha,
          environment: 'isolated-test',
          refs: [{ repository: pins.repository, pr: pins.prNumber, headSha: pins.headSha }],
        },
      })

      delivery = deliveryStore.compareAndSwap(delivery.id, delivery.revision, value => {
        value.stage = 'ready_to_publish'
        value.preparedPublication = {
          id: p.id,
          ticketId: p.ticketId,
          decisionId: item.id,
          repository: p.repository,
          pr: p.prNumber,
          headSha: p.headSha,
          patchSha256: p.patchSha256,
          environment: 'isolated-test',
          preparedAt: at,
          scopeSha256: manifest,
        } as never
      })

      const lifecyclePublication: LifecyclePublication = {
        service: f.service,
        enqueue: (inp, auth) => f.coordinator.enqueue(inp, auth),
        pinsFor: () => ({ ...pins, headSha: 'f'.repeat(40) }), // stale headSha
        scopeFor: () => scope,
      }

      const request = { revision: delivery.revision, actionId: delivery.nextAction!.id }
      deliveryStore.confirm(delivery.id, request, {
        actor: 'operator',
        source: 'local_operator',
        reference: 'actual-http-confirmation',
        scope: delivery.nextAction!.fingerprint,
      })

      const lease = deliveryStore.claim('coordinator')!
      const capabilities = deliveryPublicationCapabilities(deliveryStore, { get: () => ticket } as never, lifecyclePublication)

      expect(capabilities.publish).toBeDefined()
      const res = await capabilities.publish!.execute(lease)
      expect(res.outcome).toBe('failed')
      expect(res.blocker).toBe(`Publication rejected before effect: stale_pins [req=${lease.id}]; zero mutations executed`)

      const doc = f.store.peek()
      expect(Object.keys(doc.workerGrants ?? {})).toHaveLength(0)
      expect(f.stagesExecuted).toHaveLength(0)
    })

    it('retains fail-closed uncertainty and never infers zero mutations when ticket index is lost while durable grant exists', async () => {
      const f = createFixture()

      const db = new DatabaseSync(':memory:')
      dbs.push(db)
      const deliveryStore = new DeliveryStore(db)

      const at = new Date().toISOString()
      const ticket: Ticket = {
        id: pins.ticketId,
        title: 'Task',
        decisionId: 'original',
        mandate: {} as never,
        origin: { triggerId: 'source', triggerIds: ['source'] },
        createdAt: at,
        updatedAt: at,
        channels: [],
        inputs: [],
        undelivered: [],
        follows: [{ thread: 'github:42', own: true }],
        assignments: [{ id: 'assignment', state: 'running', createdAt: at, idleAt: at, report: { state: 'ready', summary: 'Ready', at } }],
      }
      const item = ticketDecisions([ticket])[0]!
      const p = await f.service.prepare({ ...pins, conversationId: publicationConversation(item) })

      const scope = {
        environment: 'isolated-test',
        refs: [{ repository: pins.repository, pr: pins.prNumber, headSha: pins.headSha }],
        components: ['Component'],
        effects: ['apply', 'build', 'restart', 'verify'],
        manifestSha256: manifest,
      }

      let delivery = deliveryStore.create({
        id: 'del-probe',
        title: 'Delivery Probe',
        owner: 'reviewer',
        workers: [ticket.id],
        requirements: ['native-click'],
        authorities: ['operator'],
        bindings: {
          repository: pins.repository,
          sourceIssue: 100,
          baseSha: 'b'.repeat(40),
          headSha: pins.headSha,
          environment: 'isolated-test',
          refs: [{ repository: pins.repository, pr: pins.prNumber, headSha: pins.headSha }],
        },
      })

      delivery = deliveryStore.compareAndSwap(delivery.id, delivery.revision, value => {
        value.stage = 'ready_to_publish'
        value.preparedPublication = {
          id: p.id,
          ticketId: p.ticketId,
          decisionId: item.id,
          repository: p.repository,
          pr: p.prNumber,
          headSha: p.headSha,
          patchSha256: p.patchSha256,
          environment: 'isolated-test',
          preparedAt: at,
          scopeSha256: manifest,
        } as never
      })

      const request = { revision: delivery.revision, actionId: delivery.nextAction!.id }
      deliveryStore.confirm(delivery.id, request, {
        actor: 'operator',
        source: 'local_operator',
        reference: 'actual-http-confirmation',
        scope: delivery.nextAction!.fingerprint,
      })

      const lease = deliveryStore.claim('coordinator')!

      await f.store.exclusive(async () => {
        const d = f.store.load()
        const grantId = 'grant-probe-running'
        ;(d.workerGrants ??= {})[grantId] = {
          grantId,
          publicationId: p.id,
          ticketId: p.ticketId,
          conversationId: p.conversationId,
          requestId: lease.id,
          action: 'publish',
          pins: { repository: p.repository, prNumber: p.prNumber, headSha: p.headSha, patchSha256: p.patchSha256 },
          actorId: 'operator',
          authorityKind: 'human_click',
          manifestSha256: manifest,
          ticketBinding: {},
          status: 'running',
          createdAt: at,
          updatedAt: at,
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        }
        const pub = d.publications[p.id]!
        pub.coordination = { grantId, status: 'running', createdAt: at, updatedAt: at }
        pub.requests[lease.id] = { action: 'publish', actorId: 'operator' }
        f.store.save(d)
      })

      let snapshotCallCount = 0
      const originalSnapshot = f.service.snapshot.bind(f.service)
      const interceptedService = Object.create(f.service) as PublicationService
      interceptedService.snapshot = async (ticketId: string) => {
        snapshotCallCount++
        if (snapshotCallCount === 2) {
          await f.store.exclusive(async () => {
            const d = f.store.load()
            delete d.tickets[ticketId]
            f.store.save(d)
          })
        }
        return originalSnapshot(ticketId)
      }

      const lifecyclePublication: LifecyclePublication = {
        service: interceptedService,
        enqueue: (inp, auth) => f.coordinator.enqueue(inp, auth),
        pinsFor: () => pins,
        scopeFor: () => scope,
      }

      const capabilities = deliveryPublicationCapabilities(deliveryStore, { get: () => ticket } as never, lifecyclePublication)
      expect(capabilities.publish).toBeDefined()

      const res = await capabilities.publish!.execute(lease)

      expect(res.outcome).toBe('uncertain')
      expect(res.blocker).toContain('reconcil')
      expect(res.blocker).not.toContain('zero mutations executed')

      const doc = f.store.peek()
      expect(doc.workerGrants?.['grant-probe-running']?.status).toBe('running')
    })

    it('records pre_enqueue_binding_failed when binding capture fails prior to grant creation', async () => {
      const f = createFixture({
        captureBinding: () => {
          const circular: Record<string, unknown> = {}
          circular.self = circular
          return circular
        },
      })
      const p = await f.service.prepare(pins)

      await expect(f.coordinator.enqueue(f.input(p, 'req-bind-fail'), f.authority(p))).rejects.toThrow(
        /Pre-enqueue binding serialization failed/,
      )

      const doc = f.store.peek()
      expect(Object.keys(doc.workerGrants ?? {})).toHaveLength(0)

      const lastAudit = doc.publications[p.id]!.audit.at(-1)!
      expect(lastAudit).toMatchObject({
        event: 'before_effect_rejection',
        phase: 'enqueue',
        category: 'pre_enqueue_binding_failed',
        cause: 'pre_enqueue_binding_serialization_failed',
        requestId: 'req-bind-fail',
      })
      expect(lastAudit.detail).toBe('pre_enqueue_rejected:pre_enqueue_binding_failed [req=req-bind-fail]')
    })

    it('records idempotency_conflict without modifying grants or execution state', async () => {
      const f = createFixture()
      const p = await f.service.prepare(pins)

      await f.coordinator.enqueue(f.input(p, 'idempotent-key'), f.authority(p))

      await expect(
        f.coordinator.enqueue(
          f.input(p, 'idempotent-key'),
          f.authority(p, 'publish', { actorId: 'operator-different' }),
        ),
      ).rejects.toThrow(/Worker idempotency key reused/)

      const doc = f.store.peek()
      const lastAudit = doc.publications[p.id]!.audit.at(-1)!
      expect(lastAudit).toMatchObject({
        event: 'before_effect_rejection',
        phase: 'enqueue',
        category: 'idempotency_conflict',
        cause: 'idempotency_key_reused',
        requestId: 'idempotent-key',
      })
    })
  })

  describe('Interrupted Enqueue / Worker Launch Diagnostics', () => {
    it('records worker_failed with worker_launch_failed when detached worker launch fails after grant creation', async () => {
      const f = createFixture({
        launch: async () => {
          throw new Error('spawn ENOENT: /usr/local/bin/node not found')
        },
      })
      const p = await f.service.prepare(pins)

      await expect(f.coordinator.enqueue(f.input(p, 'req-launch-fail'), f.authority(p))).rejects.toThrow(
        /Worker launch failed/,
      )

      const doc = f.store.peek()
      const grants = Object.values(doc.workerGrants ?? {})
      expect(grants).toHaveLength(1)
      expect(grants[0]!.status).toBe('failed')
      expect(grants[0]!.detail).toContain('worker_launch_process_failed')

      const lastAudit = doc.publications[p.id]!.audit.at(-1)!
      expect(lastAudit).toMatchObject({
        event: 'worker_failed',
        phase: 'enqueue',
        category: 'worker_launch_failed',
        cause: 'worker_launch_process_failed',
        requestId: 'req-launch-fail',
      })
      expect(lastAudit.detail).toContain('worker_launch_failed')
    })
  })

  describe('Downstream Execution Stage Failure and Rollback Diagnostics', () => {
    it('records stage_failed with allowlisted cause and preserves explicit rollback capability', async () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'pub-downstream-'))
      directories.push(stateDir)
      const store = new FilePublicationPersistence(join(stateDir, 'publication-state.json'))

      let state: 'open' | 'merged' = 'open'
      const adapter: PublicationAdapter = {
        evidence: async () => ({
          ...pins,
          observedAt: new Date().toISOString(),
          checks: 'passed',
          review: 'approved',
          mergeable: true,
          state,
        }),
        perform: async (stage: PublicationStage) => {
          if (stage === 'merge') {
            state = 'merged'
            return { detail: 'merge succeeded' }
          }
          if (stage === 'apply') {
            return { detail: 'apply succeeded' }
          }
          if (stage === 'build') {
            throw new Error('Build error: typescript syntax compilation failed')
          }
          if (stage === 'rollback') {
            return { detail: 'rollback completed clean' }
          }
          return { detail: `${stage} succeeded` }
        },
      }

      const service = new PublicationService({ store, adapter })
      const p = await service.prepare(pins)

      // Merge succeeds
      await service.act(
        { ticketId: p.ticketId, conversationId: p.conversationId, publicationId: p.id, requestId: 'merge-req', action: 'merge' },
        { kind: 'human_click', actorId: 'operator', authorized: true, ticketId: p.ticketId, conversationId: p.conversationId, publicationId: p.id, action: 'merge' },
      )

      // Publish fails at build
      const failed = await service.act(
        { ticketId: p.ticketId, conversationId: p.conversationId, publicationId: p.id, requestId: 'pub-req', action: 'publish' },
        { kind: 'human_click', actorId: 'operator', authorized: true, ticketId: p.ticketId, conversationId: p.conversationId, publicationId: p.id, action: 'publish' },
      )

      expect(failed.status).toBe('failed')
      const buildOutcome = failed.outcomes.find(o => o.stage === 'build')!
      expect(buildOutcome.status).toBe('failed')
      expect(buildOutcome.category).toBe('stage_failed')
      expect(buildOutcome.detail).toBe(`build: failed (stage_failed) [op=${buildOutcome.operationId}]`)
      expect(buildOutcome.detail).not.toContain('Build error')
      expect(buildOutcome.detail).not.toContain('typescript syntax compilation failed')

      const buildAudit = failed.audit.find(a => a.event === 'stage_failed')!
      expect(buildAudit).toMatchObject({
        phase: 'execution',
        category: 'stage_failed',
        cause: 'stage_execution_failed',
      })
      expect(buildAudit.detail).toContain('build: failed')

      // Rollback succeeds
      const rolledBack = await service.act(
        { ticketId: p.ticketId, conversationId: p.conversationId, publicationId: p.id, requestId: 'rollback-req', action: 'rollback' },
        { kind: 'human_click', actorId: 'operator', authorized: true, ticketId: p.ticketId, conversationId: p.conversationId, publicationId: p.id, action: 'rollback' },
      )

      expect(rolledBack.status).toBe('rolled_back')
      const rollbackOutcome = rolledBack.outcomes.find(o => o.stage === 'rollback')!
      expect(rollbackOutcome.status).toBe('succeeded')
      expect(rollbackOutcome.category).toBe('rollback_outcome')
      expect(rollbackOutcome.detail).toBe('rollback completed clean')

      const rollbackAudit = rolledBack.audit.find(a => a.event === 'stage_succeeded' && a.detail.includes('rollback'))!
      expect(rollbackAudit).toMatchObject({
        phase: 'execution',
        category: 'rollback_outcome',
        cause: 'rollback_completed',
      })
    })

    it('persists strictly allowlisted diagnostic tokens in outcomes and store without leaking arbitrary adapter exception, secrets or private payloads', async () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'pub-privacy-probe-'))
      directories.push(stateDir)
      const store = new FilePublicationPersistence(join(stateDir, 'publication-state.json'))

      const privateErrorText = 'PRIVATE_FIXTURE_LINE_123 with api_key="abc\ndef ghi" and raw response: {"customerEmail":"victim@test.invalid","secret":"payload"}'
      const adapter: PublicationAdapter = {
        evidence: async () => ({
          ...pins,
          observedAt: new Date().toISOString(),
          checks: 'passed',
          review: 'approved',
          mergeable: true,
          state: 'open',
        }),
        perform: async (stage: PublicationStage) => {
          if (stage === 'merge') {
            throw new Error(privateErrorText)
          }
          return { detail: `${stage} succeeded` }
        },
      }

      const service = new PublicationService({ store, adapter })
      const p = await service.prepare(pins)

      const failed = await service.act(
        { ticketId: p.ticketId, conversationId: p.conversationId, publicationId: p.id, requestId: 'probe-req', action: 'merge' },
        { kind: 'human_click', actorId: 'operator', authorized: true, ticketId: p.ticketId, conversationId: p.conversationId, publicationId: p.id, action: 'merge' },
      )

      expect(failed.status).toBe('failed')
      expect(failed.outcomes[0]!.status).toBe('failed')
      expect(failed.outcomes[0]!.category).toBe('stage_failed')
      expect(failed.outcomes[0]!.detail).toBe(`merge: failed (stage_failed) [op=${failed.outcomes[0]!.operationId}]`)

      const persistedDoc = store.peek()
      const docSerialized = JSON.stringify(persistedDoc)

      expect(docSerialized).not.toContain('PRIVATE_FIXTURE_LINE_123')
      expect(docSerialized).not.toContain('abc\ndef ghi')
      expect(docSerialized).not.toContain('victim@test.invalid')
      expect(docSerialized).not.toContain('{"customerEmail"')
      expect(docSerialized).not.toContain('"payload"')
    })
  })
})
