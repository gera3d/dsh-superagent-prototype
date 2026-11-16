/** Detached, durable, single-use approval handoff. The hosting web process never executes restart. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import lockfile from 'proper-lockfile'
import { publicationProcessIdentity, publicationProcessState } from './publication-process.ts'
import { PublicationError, PublicationService, type PublicationActInput, type PublicationAdapter, type PublicationAuthority, type PublicationDocument, type PublicationPersistence, type PublicationPins, type PublicationSnapshot, type PublicationWorkerGrant, type PublicationFailureCategory, type PublicationFailureCause, classifyPublicationError } from './publication.ts'

const samePins = (a: PublicationPins, b: PublicationPins) => a.repository === b.repository && a.prNumber === b.prNumber && a.headSha === b.headSha && a.patchSha256 === b.patchSha256
const clone = <T>(value: T): T => structuredClone(value)
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const ownerMayBeLive = (g: PublicationWorkerGrant) => ['same', 'unknown'].includes(publicationProcessState(g.ownerPid, g.ownerIdentity))
export const publicationManifestSha256 = (stateDir: string) => createHash('sha256').update(readFileSync(join(stateDir, 'publication-runner.json'))).digest('hex')
export type PublicationWorkerLaunch = (grantId: string) => Promise<void>
/** Fixed Node entry and state directory only; no request-provided executable, argv, shell, or environment. */
export function detachedPublicationLauncher(entryPath: string, stateDir: string): PublicationWorkerLaunch {
  if (!isAbsolute(entryPath) || !isAbsolute(stateDir)) throw new Error('Worker entry and state directory must be absolute paths')
  const entry = realpathSync(entryPath), directory = realpathSync(stateDir)
  return grantId => new Promise((resolve, reject) => {
    if (!/^[a-f0-9-]{36}$/.test(grantId)) { reject(new Error('Invalid worker grant id')); return }
    const child = spawn(process.execPath, [entry, directory, grantId], {
      detached: true, stdio: 'ignore', shell: false,
      env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
    })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
function executionTarget(stateDir: string): string {
  const target = join(stateDir, 'publication-worker-execution.guard')
  const fd = openSync(target, 'a', 0o600); closeSync(fd)
  return target
}
function update(d: PublicationDocument, g: PublicationWorkerGrant, status: PublicationWorkerGrant['status'], at: string, detail: string): void {
  g.status = status; g.updatedAt = at; g.detail = detail
  if (!['queued', 'running'].includes(status)) g.finishedAt = at
  const p = d.publications[g.publicationId]
  if (!p) return
  p.coordination = { grantId: g.grantId, status, createdAt: g.createdAt, updatedAt: at, detail }
  p.updatedAt = at
  p.audit.push({ at, event: `worker_${status}`, detail, requestId: g.requestId, actorId: g.actorId, authorityKind: g.authorityKind })
}

/** Persists one-use operator grants and launches a process independent of the host being restarted. */
export class PublicationCoordinator {
  private readonly launch: PublicationWorkerLaunch
  private readonly now: () => number
  private readonly manifestSha256: string | undefined
  private readonly target: string
  constructor(private readonly options: {
    stateDir: string; entryPath?: string; store: PublicationPersistence; service: PublicationService
    captureBinding: (snapshot: PublicationSnapshot) => unknown
    manifestSha256?: string; launch?: PublicationWorkerLaunch; now?: () => number
  }) {
    this.now = options.now ?? Date.now
    this.manifestSha256 = options.manifestSha256
    if (this.manifestSha256 !== undefined && !/^[a-f0-9]{64}$/.test(this.manifestSha256)) throw new Error('Invalid release manifest digest')
    if (!options.launch && !options.entryPath) throw new Error('Detached worker entry is required')
    // Read-only polling must remain available if configuration/built worker is temporarily absent.
    this.launch = options.launch ?? (grantId => detachedPublicationLauncher(options.entryPath!, options.stateDir)(grantId))
    this.target = executionTarget(options.stateDir)
  }
  private at() { return new Date(this.now()).toISOString() }
  private async reconcile(d: PublicationDocument): Promise<boolean> {
    let changed = false
    for (const g of Object.values(d.workerGrants ?? {})) {
      if (g.status === 'queued' && Date.parse(g.expiresAt) < this.now()) {
        update(d, g, 'expired', this.at(), 'Worker did not claim approval before expiry; no automatic launch/replay')
        changed = true
      } else if (g.status === 'running' && !ownerMayBeLive(g) && !await lockfile.check(this.target, { stale: 30_000 })) {
        update(d, g, 'interrupted', this.at(), 'Detached coordinator was interrupted; consumed grant will never be replayed')
        const p = d.publications[g.publicationId]
        if (p) p.status = 'interrupted'
        changed = true
      }
    }
    return changed
  }
  async snapshot(ticketId: string): Promise<PublicationSnapshot | undefined> {
    try {
      await this.options.store.exclusive(async () => {
        const d = this.options.store.load()
        if (await this.reconcile(d)) this.options.store.save(d)
      })
    } catch (error) { if (!(error instanceof PublicationError && error.status === 409)) throw error }
    return this.options.service.snapshot(ticketId)
  }
  /** No effects: records an explicit operator's external confirmation that unknown processes were inspected and settled. */
  async acknowledgeInterruption(grantId: string, authority: PublicationAuthority, confirmation: { processesSettled: true; detail: string }): Promise<void> {
    await this.options.store.exclusive(async () => {
      const d = this.options.store.load(), g = d.workerGrants?.[grantId]
      if (!g || g.status !== 'interrupted') throw new PublicationError(409, 'No interrupted grant to reconcile')
      if (!authority || authority.kind !== 'operator_instruction' || authority.authorized !== true || !authority.actorId || authority.action !== 'rollback'
        || authority.ticketId !== g.ticketId || authority.conversationId !== g.conversationId || authority.publicationId !== g.publicationId) throw new PublicationError(403, 'Bound explicit operator instruction required for process reconciliation')
      if (ownerMayBeLive(g) || await lockfile.check(this.target, { stale: 30_000 })) throw new PublicationError(409, 'Coordinator owner is still live; refusing takeover')
      if (confirmation.processesSettled !== true || typeof confirmation.detail !== 'string' || confirmation.detail.trim().length < 10) throw new PublicationError(400, 'Explicit process-settlement evidence is required')
      g.settledAt = this.at(); g.reconciliation = { at: this.at(), actorId: authority.actorId, detail: confirmation.detail, ...(authority.sourceProof ? { sourceProof: clone(authority.sourceProof) } : {}) }
      for (const group of g.processGroups ?? []) group.settledAt ??= this.at()
      update(d, g, 'failed', this.at(), `Operator reconciled unknown descendants: ${confirmation.detail}${authority.sourceProof ? `; source ${authority.sourceProof.reference}; instruction sha256 ${authority.sourceProof.recordSha256}` : ''}`)
      this.options.store.save(d)
    })
  }
  async enqueue(input: PublicationActInput, authority: PublicationAuthority): Promise<PublicationSnapshot> {
    if (!['publish', 'rollback'].includes(input.action) || !input.requestId || input.requestId.length > 450 || Object.hasOwn(Object.prototype, input.requestId) || input.requestId === 'prototype') throw new PublicationError(400, 'Invalid worker publication action/request')
    const manifestSha256 = this.manifestSha256 ?? publicationManifestSha256(this.options.stateDir)
    let launchId: string | undefined
    const queued = await this.options.store.exclusive(async () => {
      const d = this.options.store.load()
      const reconciled = await this.reconcile(d)
      if (reconciled) this.options.store.save(d)
      const p = d.publications[input.publicationId]
      if (!p || d.tickets[input.ticketId] !== p.id) throw new PublicationError(404, 'Publication not found')
      const reject = (status: number, message: string, category: PublicationFailureCategory, cause: PublicationFailureCause) => {
        p.audit.push({
          at: this.at(),
          event: 'before_effect_rejection',
          detail: `pre_enqueue_rejected:${category} [req=${input.requestId}]`,
          requestId: input.requestId,
          phase: 'enqueue',
          category,
          cause,
        })
        this.options.store.save(d)
        throw new PublicationError(status, message)
      }
      if (p.ticketId !== input.ticketId || p.conversationId !== input.conversationId) {
        reject(403, 'Publication conversation binding mismatch', 'authority_mismatch', 'authority_missing_or_mismatched')
      }
      if (!authority || authority.authorized !== true || !['human_click', 'operator_instruction'].includes(authority.kind) || !authority.actorId
        || authority.action !== input.action || authority.publicationId !== p.id || authority.ticketId !== p.ticketId || authority.conversationId !== p.conversationId) {
        reject(403, 'Explicit bound human/operator approval required', 'authority_mismatch', 'authority_missing_or_mismatched')
      }
      const previous = Object.values(d.workerGrants ?? {}).find(g => g.publicationId === p.id && g.requestId === input.requestId)
      if (previous) {
        if (previous.action !== input.action || previous.actorId !== authority.actorId || previous.authorityKind !== authority.kind || previous.sourceProof?.recordSha256 !== authority.sourceProof?.recordSha256) {
          reject(409, 'Worker idempotency key reused for another authority/action/instruction', 'idempotency_conflict', 'idempotency_key_reused')
        }
        return clone(p) // Including queued grants: an uncertain launch is NEVER blindly repeated.
      }
      if (Object.values(d.workerGrants ?? {}).some(g => g.status === 'interrupted' && !g.settledAt)) {
        reject(409, 'Interrupted coordinator may have unknown descendants; operator reconciliation is required before ANY effects', 'concurrency_blocked', 'interrupted_grant_pending_reconciliation')
      }
      if (Object.values(d.workerGrants ?? {}).some(g => ['queued', 'running'].includes(g.status))) {
        reject(409, 'Another approved detached publication is in progress', 'concurrency_blocked', 'concurrency_grant_active')
      }
      if (authority.isCurrent && !authority.isCurrent()) {
        reject(409, 'Canonical decision changed before handoff', 'canonical_ticket_changed', 'canonical_ticket_or_decision_changed')
      }
      if (input.action === 'publish' && (p.status === 'interrupted' || p.outcomes.some(o => ['failed', 'interrupted'].includes(o.status)))) {
        reject(409, 'Uncertain publication requires explicit recovery, not another publish', 'before_effect_rejection', 'before_effect_rejected')
      }
      if (input.action === 'rollback' && (!p.outcomes.length || p.outcomes.some(o => o.stage === 'rollback'))) {
        reject(409, 'No recoverable unattempted rollback remains', 'before_effect_rejection', 'before_effect_rejected')
      }
      let binding: unknown
      try {
        binding = input.action === 'rollback' ? null : JSON.parse(JSON.stringify(this.options.captureBinding(clone(p)))) as unknown
      } catch (error) {
        reject(500, 'Pre-enqueue binding serialization failed', 'pre_enqueue_binding_failed', 'pre_enqueue_binding_serialization_failed')
      }
      const g: PublicationWorkerGrant = {
        grantId: randomUUID(), publicationId: p.id, ticketId: p.ticketId, conversationId: p.conversationId, requestId: input.requestId,
        action: input.action as 'publish' | 'rollback', pins: { repository: p.repository, prNumber: p.prNumber, headSha: p.headSha, patchSha256: p.patchSha256 },
        actorId: authority.actorId, authorityKind: authority.kind, manifestSha256, ticketBinding: binding,
        ...(authority.sourceProof ? { sourceProof: clone(authority.sourceProof) } : {}),
        status: 'queued', createdAt: this.at(), updatedAt: this.at(), expiresAt: new Date(this.now() + 120_000).toISOString(),
      }
      ;(d.workerGrants ??= {})[g.grantId] = g
      update(d, g, 'queued', this.at(), `Explicit approval durably handed to a detached coordinator; host performs no publication operations${g.sourceProof ? `; source ${g.sourceProof.reference}; instruction sha256 ${g.sourceProof.recordSha256}` : ''}`)
      this.options.store.save(d)
      launchId = g.grantId
      return clone(p)
    })
    if (launchId) {
      try { await this.launch(launchId) } catch (error) {
        await this.options.store.exclusive(async () => {
          const d = this.options.store.load(), g = d.workerGrants?.[launchId!]
          if (g?.status === 'queued') {
            update(d, g, 'failed', this.at(), `Worker launch failed: worker_launch_process_failed [grant=${launchId}]`)
            const pub = d.publications[g.publicationId]
            if (pub) {
              pub.audit.push({
                at: this.at(),
                event: 'worker_failed',
                detail: `worker_launch_failed [grant=${launchId}]`,
                requestId: g.requestId,
                phase: 'enqueue',
                category: 'worker_launch_failed',
                cause: 'worker_launch_process_failed',
              })
            }
            this.options.store.save(d)
          }
        })
        throw new PublicationError(500, 'Worker launch failed: worker_launch_process_failed; no automatic replay')
      }
    }
    return queued
  }
}

/** Standalone worker core; the CLI supplies a pinned adapter and read-only canonical-ticket validator. */
export async function runPublicationWorker(options: {
  stateDir: string; grantId: string; store: PublicationPersistence; adapter: PublicationAdapter; manifestSha256: string
  isCurrent: (grant: PublicationWorkerGrant, snapshot: PublicationSnapshot) => boolean; now?: () => number
}): Promise<void> {
  const now = options.now ?? Date.now, at = () => new Date(now()).toISOString(), target = executionTarget(options.stateDir)
  let compromised: Error | undefined
  const abort = new AbortController()
  const compromise = (error: Error) => { compromised = error; abort.abort(error) }
  const unsubscribe = options.store.onCompromised?.(compromise)
  let release: (() => Promise<void>) | undefined
  try {
    try { release = await lockfile.lock(target, { retries: 0, stale: 30_000, update: 5_000, onCompromised: compromise }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return; throw error }
    let claimed: PublicationWorkerGrant | undefined
    await options.store.exclusive(async () => {
      const d = options.store.load(), g = d.workerGrants?.[options.grantId]
      if (!g || g.status !== 'queued') return // consumed grants cannot be replayed, even by duplicate worker processes
      if (Date.parse(g.expiresAt) < now()) { update(d, g, 'expired', at(), 'Approval expired before detached worker claim'); options.store.save(d); return }
      const p = d.publications[g.publicationId]
      if (g.manifestSha256 !== options.manifestSha256 || !p || d.tickets[g.ticketId] !== g.publicationId || !samePins(p, g.pins) || p.conversationId !== g.conversationId) {
        update(d, g, 'failed', at(), 'Pinned manifest or immutable publication binding changed before claim'); options.store.save(d); return
      }
      // Consume durably BEFORE any effect. Death after this point is never resumed/replayed.
      const ownerIdentity = publicationProcessIdentity(process.pid)
      if (!ownerIdentity) { update(d, g, 'failed', at(), 'Cannot identify detached coordinator OS start identity; no effects allowed'); options.store.save(d); return }
      g.claimedAt = at(); g.ownerPid = process.pid; g.ownerIdentity = ownerIdentity
      update(d, g, 'running', at(), 'Detached coordinator owns approval across hosting-process restart')
      options.store.save(d); claimed = clone(g)
    })
    if (!claimed) return
    const grant = claimed as PublicationWorkerGrant
    const service = new PublicationService({ store: options.store, adapter: options.adapter, now, signal: abort.signal, workerGrantId: grant.grantId })
    const input = { ticketId: grant.ticketId, conversationId: grant.conversationId, publicationId: grant.publicationId, requestId: grant.requestId, action: grant.action }
    const authority = (action: PublicationAuthority['action']): PublicationAuthority => ({
      kind: grant.authorityKind, actorId: grant.actorId, authorized: true, ticketId: grant.ticketId, conversationId: grant.conversationId,
      publicationId: grant.publicationId, action, workerGrantId: grant.grantId, sourceProof: grant.sourceProof,
      isCurrent: () => {
        if (compromised) return false
        if (grant.action === 'rollback') return true // Recovery remains available after canonical ticket invalidation.
        const d = options.store.load(), p = d.publications[grant.publicationId]
        return !!p && options.isCurrent(grant, clone(p))
      },
    })
    try {
      let result = await service.snapshot(grant.ticketId)
      if (!result || result.id !== grant.publicationId) throw new Error('Publication disappeared after worker claim')
      if (grant.action === 'publish' && result.evidence?.state === 'open' && !result.outcomes.some(o => o.stage === 'merge' && o.status === 'succeeded')) {
        result = await service.act({ ...input, action: 'merge', requestId: `${grant.requestId}:merge` }, authority('merge'))
        if (compromised) throw compromised
        if (result.status !== 'merged') {
          await finish('completed', `Worker stopped at ${result.status}; no deployment was started`)
          return
        }
      }
      result = await service.act(input, authority(grant.action))
      if (compromised) throw compromised
      await finish('completed', `Detached publication finished with ${result.status}; inspect individual stage outcomes`)
    } catch (error) {
      await finish('failed', `Detached publication stopped: ${errorText(error)}; no replay`)
      throw error
    }
    async function finish(status: 'completed' | 'failed', detail: string): Promise<void> {
      await options.store.exclusive(async () => {
        const d = options.store.load(), g = d.workerGrants?.[grant.grantId]
        if (g?.status === 'running') {
          const unknownProcesses = !!compromised || g.processGroups?.some(group => !group.settledAt)
          if (!unknownProcesses) g.settledAt = at()
          update(d, g, unknownProcesses ? 'interrupted' : status, at(), unknownProcesses ? `${detail}; process ownership requires operator reconciliation` : detail)
          options.store.save(d)
        }
      })
    }
  } finally { unsubscribe?.(); await release?.() }
}
