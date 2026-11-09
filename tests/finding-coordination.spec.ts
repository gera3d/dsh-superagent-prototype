import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { FindingRuntime } from '../src/app/finding-runtime.ts'
import { Engine } from '../src/core/engine.ts'
import type { EngineOptions } from '../src/core/part.ts'
import type { Commands } from '../src/infra/commands.ts'
import { FindingError } from '../src/app/finding.ts'
import { registerHttp, type HttpHost } from '../src/app/http.ts'
import {
  coordinateFinding,
  readFindingCoordinationInstruction,
  type FindingCoordinationInstruction,
} from '../src/app/finding-coordination.ts'
import { coordinateFindingCli } from '../scripts/finding-coordinate.ts'

const cleanup: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const done of cleanup.splice(0).reverse()) done()
})

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'finding-coord-spec-')))
  const store = new Store(join(directory, 'db.sqlite'))
  cleanup.push(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  store.saveSettings({ executor: { model: { provider: 'configured', model: 'executor' }, maxWorkers: 3 } })

  const start = vi.fn()
  const engine = new Engine({
    repo: store,
    policy: () => ({ version: 'p1', paused: false }),
    executor: { start, deliver: vi.fn(), stop: vi.fn() },
  } as unknown as EngineOptions)

  const ctx = {
    llm: { resolveCallConfig: vi.fn(), stream: vi.fn() },
    get: vi.fn(),
  } as unknown as Context
  const commands = { gh: vi.fn() } as unknown as Commands
  const deps = { store, engine, ctx, commands, lifetime: new AbortController().signal }
  const runtime = new FindingRuntime(deps)
  cleanup.push(() => runtime.stop())

  const observe = (dedupKey = 'coord-task') =>
    runtime.store.observe({
      dedupKey,
      title: 'Coordination task',
      problem: 'Unattended advancement required',
      scope: 'Headless coordination path only',
      owner: 'team',
      kind: 'fix',
      requirements: ['Advance already-approved work without browser headers', 'Preserve revision guards and audit attribution'],
      repository: 'org/repo',
      occurrence: { id: dedupKey, reference: 'issue/195', evidence: 'Unattended screen dependency observed' },
    })

  const confirmLocal = (id: string, choiceId: 'fix_now' | 'queue_next' = 'fix_now') =>
    runtime.store.confirm(id, { revision: runtime.store.get(id)!.revision, choiceId }, 'local-operator')

  const makeInstruction = (
    findingId: string,
    revision: number,
    action: 'retry_scope' | 'confirm' | 'defer',
    choiceId?: 'fix_now' | 'queue_next' | 'defer',
    actorId = 'codex-coordinator',
    now = Date.now(),
  ): { instruction: FindingCoordinationInstruction; filePath: string } => {
    const instruction: FindingCoordinationInstruction = {
      version: 1,
      authority: 'explicit_operator_coordination',
      findingId,
      revision,
      action,
      ...(choiceId ? { choiceId } : {}),
      actorId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 600_000).toISOString(),
      source: {
        reference: 'runbook/hourly-coordination-20261108',
        reason: 'Advance already approved finding after review feedback without browser GUI automation.',
      },
    }
    const filePath = join(directory, `instruction-${action}-${revision}.json`)
    writeFileSync(filePath, JSON.stringify(instruction), { mode: 0o600 })
    return { instruction, filePath }
  }

  return { directory, store, engine, runtime, observe, confirmLocal, makeInstruction }
}

describe('headless coordination for already-approved bounded work', () => {
  it('advances an approved finding from blocked through retry_scope and confirm fix_now without GUI automation', async () => {
    const h = fixture()
    const finding = h.observe('task-advance')
    // 1. Initial operator approval
    h.confirmLocal(finding.id, 'fix_now')
    await h.runtime.request()

    const dispatched = h.runtime.store.get(finding.id)!
    expect(dispatched.state).toBe('running')
    expect(dispatched.job?.id).toBe(`finding:${finding.id}:r1`)

    // 2. Worker reports a blocked state (e.g. failed review replay)
    h.runtime.store.markReview(finding.id, {
      reference: `ticket/${dispatched.job!.ticketId}/report/assign-1`,
      summary: 'Review replay failed; conditional statement was treated as open work',
      recordedAt: new Date().toISOString(),
      state: 'blocked',
    })

    const blocked = h.runtime.store.get(finding.id)!
    expect(blocked.state).toBe('blocked')
    expect(blocked.revision).toBe(2)

    // 3. Headless coordinator issues retry_scope instruction
    const { filePath: retryPath } = h.makeInstruction(finding.id, blocked.revision, 'retry_scope', undefined, 'codex-coordinator')
    const retryResult = await coordinateFinding(h.runtime, blocked.id, retryPath)
    expect(retryResult.finding.state).toBe('awaiting_decision')
    expect(retryResult.finding.revision).toBe(3)
    expect(retryResult.finding.priorJobs).toHaveLength(1)
    expect(retryResult.finding.priorJobs![0]?.id).toBe(`finding:${finding.id}:r1`)

    // Check audit trail for headless retry attribution
    const retryAudit = retryResult.finding.audit.find(a => a.event === 'reviewed')
    expect(retryAudit).toBeTruthy()
    expect(retryAudit?.actor).toBe('codex-coordinator')

    // 4. Headless coordinator confirms fix_now on the reopened scope
    const { filePath: confirmPath } = h.makeInstruction(finding.id, retryResult.finding.revision, 'confirm', 'fix_now', 'codex-coordinator')
    const confirmResult = await coordinateFinding(h.runtime, retryResult.finding.id, confirmPath)
    expect(confirmResult.finding.state).toBe('queued')
    expect(confirmResult.finding.confirmation?.actor).toBe('codex-coordinator')

    await h.runtime.request()
    const running = h.runtime.store.get(finding.id)!
    expect(running.state).toBe('running')
    expect(running.job?.id).toBe(`finding:${finding.id}:r3`)

    // Check audit trail for headless confirmation attribution
    const confirmAudits = running.audit.filter(a => a.event === 'confirmed')
    expect(confirmAudits.at(-1)?.actor).toBe('codex-coordinator')
    expect(confirmAudits.at(-1)?.detail).toBe('fix_now')
  })

  it('rejects stale revisions with 409', async () => {
    const h = fixture()
    const finding = h.observe('task-stale')
    h.confirmLocal(finding.id, 'fix_now')
    await h.runtime.request()

    const dispatched = h.runtime.store.get(finding.id)!
    h.runtime.store.markReview(finding.id, {
      reference: 'test-ref',
      summary: 'Blocked report',
      recordedAt: new Date().toISOString(),
      state: 'blocked',
    })
    const blocked = h.runtime.store.get(finding.id)!
    expect(blocked.revision).toBe(2)

    // Send instruction with stale revision 1 instead of current revision 2
    const { filePath } = h.makeInstruction(finding.id, 1, 'retry_scope', undefined, 'codex-coordinator')
    await expect(coordinateFinding(h.runtime, blocked.id, filePath)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('stale'),
    })
  })

  it('rejects unapproved new findings with 403 (unauthorized scope)', async () => {
    const h = fixture()
    // Brand new finding, never approved by local-operator
    const finding = h.observe('task-unapproved')
    expect(finding.state).toBe('awaiting_decision')
    expect(finding.confirmation).toBeUndefined()
    expect(finding.priorJobs).toBeUndefined()

    // Headless coordinator attempts to confirm new scope
    const { filePath } = h.makeInstruction(finding.id, finding.revision, 'confirm', 'fix_now', 'codex-coordinator')
    await expect(coordinateFinding(h.runtime, finding.id, filePath)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('existing explicitly approved bounded work'),
    })
  })

  it('prohibits headless acceptance of evidence', async () => {
    const h = fixture()
    const finding = h.observe('task-acceptance')
    h.confirmLocal(finding.id, 'fix_now')
    await h.runtime.request()
    const dispatched = h.runtime.store.get(finding.id)!

    h.runtime.store.markReview(finding.id, {
      reference: 'ready-report',
      summary: 'Ready report',
      recordedAt: new Date().toISOString(),
      state: 'ready',
    })

    // Store review directly called with non-local-operator for accept_evidence must throw 403
    expect(() =>
      h.runtime.store.review(
        finding.id,
        {
          revision: h.runtime.store.get(finding.id)!.revision,
          decision: 'accept_evidence',
          evidenceReference: 'ready-report',
          requirements: finding.requirements,
        },
        'codex-coordinator',
      ),
    ).toThrowError(/Only local-operator may review and accept finding evidence/)
  })

  it('preserves replay idempotency on confirmation', async () => {
    const h = fixture()
    const finding = h.observe('task-idempotent')
    h.confirmLocal(finding.id, 'fix_now')
    await h.runtime.request()

    const dispatched = h.runtime.store.get(finding.id)!
    h.runtime.store.markReview(finding.id, {
      reference: 'blocked-ref',
      summary: 'Blocked report',
      recordedAt: new Date().toISOString(),
      state: 'blocked',
    })
    const blocked = h.runtime.store.get(finding.id)!

    // Retry scope
    const { filePath: retryPath } = h.makeInstruction(finding.id, blocked.revision, 'retry_scope')
    const retried = await coordinateFinding(h.runtime, blocked.id, retryPath)

    // Confirm once
    const { filePath: confirmPath } = h.makeInstruction(finding.id, retried.finding.revision, 'confirm', 'fix_now')
    const first = await coordinateFinding(h.runtime, retried.finding.id, confirmPath)
    expect(first.finding.state).toBe('queued')

    // Replay exact same confirmation instruction: idempotent return without error or duplicate dispatch
    const second = await coordinateFinding(h.runtime, retried.finding.id, confirmPath)
    expect(second.finding.job?.id).toBe(first.finding.job?.id)
  })

  it('rejects retry while a productive worker is actively running', async () => {
    const h = fixture()
    const finding = h.observe('task-productive')
    h.confirmLocal(finding.id, 'fix_now')
    await h.runtime.request()

    const running = h.runtime.store.get(finding.id)!
    expect(running.state).toBe('running')

    // While worker is still running (not blocked), retry must throw 409
    const { filePath } = h.makeInstruction(finding.id, running.revision, 'retry_scope')
    await expect(coordinateFinding(h.runtime, running.id, filePath)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Only blocked findings awaiting evidence review may be retried'),
    })
  })

  it('enforces file permissions, validity window, canonical path and matching targets', async () => {
    const h = fixture()
    const finding = h.observe('task-security')
    h.confirmLocal(finding.id, 'fix_now')
    await h.runtime.request()

    const dispatched = h.runtime.store.get(finding.id)!
    h.runtime.store.markReview(finding.id, {
      reference: 'blocked-ref',
      summary: 'Blocked',
      recordedAt: new Date().toISOString(),
      state: 'blocked',
    })
    const blocked = h.runtime.store.get(finding.id)!
    const now = Date.now()

    // 1. Loose permissions (0o644) rejected
    const { filePath: loosePath } = h.makeInstruction(finding.id, blocked.revision, 'retry_scope')
    chmodSync(loosePath, 0o644)
    expect(() => readFindingCoordinationInstruction(loosePath, blocked, now)).toThrow('mode0600')

    // 2. Symlink rejected
    chmodSync(loosePath, 0o600)
    const symlinkPath = join(h.directory, 'symlink-instruction.json')
    symlinkSync(loosePath, symlinkPath)
    expect(() => readFindingCoordinationInstruction(symlinkPath, blocked, now)).toThrow('canonical')

    // 3. Expired instruction rejected
    const { filePath: expiredPath } = h.makeInstruction(finding.id, blocked.revision, 'retry_scope', undefined, 'codex', now - 1_000_000)
    expect(() => readFindingCoordinationInstruction(expiredPath, blocked, now)).toThrow(/expired/)

    // 4. Mismatched finding ID rejected
    const otherFinding = h.observe('task-other')
    expect(() => readFindingCoordinationInstruction(loosePath, otherFinding, now)).toThrow('finding ID does not match')
  })

  it('CLI executes real loopback HTTP coordination without browser approval headers', async () => {
    const h = fixture()
    const finding = h.observe('task-cli')
    h.confirmLocal(finding.id, 'fix_now')
    await h.runtime.request()

    const dispatched = h.runtime.store.get(finding.id)!
    h.runtime.store.markReview(finding.id, {
      reference: 'blocked-ref',
      summary: 'Blocked',
      recordedAt: new Date().toISOString(),
      state: 'blocked',
    })
    const blocked = h.runtime.store.get(finding.id)!

    const calls: { path?: string; method?: string; headers: Record<string, unknown>; body: string }[] = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      calls.push({ path: req.url, method: req.method, headers: req.headers, body })

      try {
        const match = req.url?.match(/\/orchestrator\/api\/findings\/([^/]+)\/coordinate/)
        const targetFindingId = match && match[1] ? decodeURIComponent(match[1]) : ''
        const { instructionFile } = JSON.parse(body)
        const result = await coordinateFinding(h.runtime, targetFindingId, instructionFile)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        const status = err instanceof FindingError ? err.status : 500
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      }
    })

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))

    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server')
    const url = `http://127.0.0.1:${address.port}`

    const cliResult = await coordinateFindingCli([
      '--url',
      url,
      '--finding-id',
      finding.id,
      '--revision',
      String(blocked.revision),
      '--action',
      'retry_scope',
      '--actor',
      'hourly-coordinator',
      '--reference',
      'milestone/hourly-pass',
      '--reason',
      'Advance approved completion correction without UI automation',
    ])

    expect(cliResult).toMatchObject({
      finding: expect.objectContaining({ state: 'awaiting_decision', revision: 3 }),
    })

    // Verify loopback HTTP headers: x-orchestrator-request is 1, NO Origin or sec-fetch-site headers
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers['x-orchestrator-request']).toBe('1')
    expect(calls[0]!.headers.origin).toBeUndefined()
    expect(calls[0]!.headers['sec-fetch-site']).toBeUndefined()
    expect(calls[0]!.headers['sec-fetch-dest']).toBeUndefined()
  })

  it('enforces target URL binding and rejects instruction file targeting another finding', async () => {
    const h = fixture()
    const finding1 = h.observe('task-bind-1')
    h.confirmLocal(finding1.id, 'fix_now')
    await h.runtime.request()
    h.runtime.store.markReview(finding1.id, {
      reference: 'blocked-1',
      summary: 'Blocked 1',
      recordedAt: new Date().toISOString(),
      state: 'blocked',
    })
    const blocked1 = h.runtime.store.get(finding1.id)!

    const finding2 = h.observe('task-bind-2')
    h.confirmLocal(finding2.id, 'fix_now')
    await h.runtime.request()
    h.runtime.store.markReview(finding2.id, {
      reference: 'blocked-2',
      summary: 'Blocked 2',
      recordedAt: new Date().toISOString(),
      state: 'blocked',
    })
    const blocked2 = h.runtime.store.get(finding2.id)!

    // Instruction file is created for finding1
    const { filePath } = h.makeInstruction(finding1.id, blocked1.revision, 'retry_scope')

    // Calling coordinateFinding with finding2's ID but finding1's instruction file must reject with 403
    await expect(coordinateFinding(h.runtime, blocked2.id, filePath)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('Explicit instruction finding ID does not match target finding'),
    })

    // Calling coordinateFinding with invalid UUID must reject with 400
    await expect(coordinateFinding(h.runtime, 'not-a-uuid', filePath)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('Target finding ID must be a valid UUID'),
    })
  })

  it('strictly verifies local-operator audit confirmation before permitting headless coordination', async () => {
    const h = fixture()
    // Observe a finding but do NOT call confirmLocal. Simulate a finding that has priorJobs or non-operator confirmation
    const finding = h.observe('task-audit-strict')

    // Artificially populate priorJobs without any local-operator confirmed audit event
    const record = h.runtime.store.get(finding.id)!
    record.priorJobs = [{ id: `finding:${finding.id}:r1` }]
    record.state = 'blocked'
    record.revision = 2
    h.store.db.prepare('UPDATE finding SET value=? WHERE id=?').run(JSON.stringify(record), finding.id)

    const blocked = h.runtime.store.get(finding.id)!
    expect(blocked.audit.some(e => e.event === 'confirmed' && e.actor === 'local-operator')).toBe(false)

    // Attempt headless retry_scope: must be rejected because local-operator confirmed event is absent from audit trail
    const { filePath } = h.makeInstruction(finding.id, blocked.revision, 'retry_scope')
    await expect(coordinateFinding(h.runtime, blocked.id, filePath)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('Headless coordination is only supported for existing explicitly approved bounded work'),
    })
  })

  it('enforces default-off gate on HTTP endpoint', async () => {
    const h = fixture()
    const finding = h.observe('task-default-off')
    h.confirmLocal(finding.id, 'fix_now')
    await h.runtime.request()
    h.runtime.store.markReview(finding.id, {
      reference: 'blocked-off',
      summary: 'Blocked off',
      recordedAt: new Date().toISOString(),
      state: 'blocked',
    })
    const blocked = h.runtime.store.get(finding.id)!
    const { filePath } = h.makeInstruction(finding.id, blocked.revision, 'retry_scope')

    let handler: (req: unknown, res: unknown) => Promise<void> = async () => {}
    const ctx = {
      on: () => () => {},
      sessionPersistence: { flush: async () => {}, list: async () => [] },
      logger: { error: () => {}, warn: () => {} },
      webServer: {
        host: '127.0.0.1',
        port: 3082,
        register: (route: { handler: typeof handler }) => {
          handler = route.handler
          return () => {}
        },
      },
    }

    const host = {
      ready: Promise.resolve(),
      configured: () => true,
      findings: h.runtime,
      store: h.store,
      settings: {} as never,
      sources: { instances: () => [] } as never,
      sourceLinks: { entries: () => new Map<string, string>().entries() },
      prompts: {} as never,
      sessions: {} as never,
      engine: {} as never,
      executor: { activeCount: () => 0 },
      usage: {} as never,
      health: {},
      machine: {} as never,
      masterId: 'test-master',
      deployment: {} as never,
    } as unknown as HttpHost

    registerHttp(ctx as never, host)

    const callHttp = async (targetId: string, path: string) => {
      let status = 0
      let text = ''
      const body = JSON.stringify({ instructionFile: path })
      const req = {
        method: 'POST',
        url: `/orchestrator/api/findings/${targetId}/coordinate`,
        headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(body)
        },
      }
      await handler(req, {
        writeHead: (code: number) => {
          status = code
        },
        end: (data?: string) => {
          if (data) text = data
        },
      })
      let parsed: unknown
      try {
        parsed = text ? JSON.parse(text) : undefined
      } catch {
        parsed = text
      }
      return { status, body: parsed }
    }

    // 1. By default, coordination.enabled is false -> 403 Headless coordination is disabled
    expect(h.store.settings().coordination?.enabled).toBe(false)
    const disabledResponse = await callHttp(blocked.id, filePath)
    expect(disabledResponse.status).toBe(403)
    expect(disabledResponse.body).toMatchObject({ error: expect.stringContaining('Headless coordination is disabled') })

    // 2. Explicitly enable coordination setting
    h.store.saveSettings({ coordination: { enabled: true } })
    expect(h.store.settings().coordination.enabled).toBe(true)

    // 3. Retry coordination now succeeds
    const enabledResponse = await callHttp(blocked.id, filePath)
    expect(enabledResponse.status).toBe(200)
    expect(enabledResponse.body).toMatchObject({
      finding: expect.objectContaining({ state: 'awaiting_decision', revision: 3 }),
    })
  })
})
