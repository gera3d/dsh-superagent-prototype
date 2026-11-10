/**
 * Thread-native review/test/release preparation for a finding job's committed artifact.
 *
 * One protected local click turns the finding's current dispatched job into the canonical delivery lineage: it verifies the
 * worker's local committed branch against git facts, opens (or reuses) the source PR through fixed argv commands under the
 * existing gh login, writes the exact per-PR publication manifest from a trusted fixed project profile, and binds the
 * delivery so the durable coordinator really runs independent review and verification. Nothing here publishes, merges,
 * deploys or accepts, and no worker- or model-supplied text ever becomes a command, path, target or permission.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, symlinkSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'
import { z } from 'zod'
import type { Ticket } from '../core/model.ts'
import { createPublicationRunner, executePublicationCommand, type PublicationExecutor, type PublicationRunnerConfig } from '../infra/publication-runner.ts'
import { DeliveryConflict, deliveryFingerprint, type Delivery, type DeliveryCreate, type DeliveryStore } from './feature-delivery.ts'
import type { Finding } from './finding.ts'

const absolute = z.string().refine(isAbsolute, 'Expected absolute path')
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const asset = z.object({ path: absolute, sha256: digest }).strict()
const script = asset.extend({ dependencies: z.array(asset).default([]) }).strict()
const repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/)
/**
 * Fixed trusted per-task packaging preset. Every executable, script, target path and hash is operator-authored; a candidate's
 * metadata and test paths are only data validated against fixed patterns and passed as argv, never as shell text.
 */
export const ReleasePresetSchema = z.object({
  pythonPath: absolute, pnpmPath: absolute, targetPath: absolute, releaseRoot: absolute, dependencyRoot: absolute,
  companions: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9_-]+$/), path: absolute }).strict()).max(5).default([]),
  /** Pinned scripts/publication/prepare.py; dependencies pin its sibling runner.py, phase wrappers and helpers. */
  prepareScript: script, restartScript: asset,
  verifyUrl: z.string().regex(/^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}\/[\w./{}-]*$/),
  /** Must contain {head} or {patch}; expanded with the exact reviewed head / patch digest. */
  verifyContainsTemplate: z.string().min(1).max(500).refine(t => t.includes('{head}') || t.includes('{patch}'), 'Marker must bind the exact head or patch'),
  maxTestFiles: z.number().int().min(1).max(50).default(30),
  checkTimeoutMs: z.number().int().min(10000).max(900000).default(600000),
}).strict()
export type ReleasePreset = z.infer<typeof ReleasePresetSchema>
/** Trusted operator-authored fixed project preset: `<stateDir>/release-profile.json`. Never written by workers or models. */
export const ReleaseProfileSchema = z.object({
  version: z.literal(1),
  /** Source repository and branch that finding workers' commits are based on. */
  source: z.object({ repository: repo, baseBranch: z.string().regex(/^[\w./-]{1,100}$/), checkoutPath: absolute, remoteUrl: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/), workspaceSubdir: z.string().regex(/^[\w.-]{1,60}$/).default('work'),
    /** Trusted extra parents under which a worker may have committed its result at `<root>/<ticket id>`; validated by git facts, never by prose paths. */
    artifactRoots: z.array(absolute).max(10).default([]) }).strict(),
  ghPath: absolute, gitPath: absolute, cwd: absolute, patchDir: absolute,
  environment: z.string().min(1).max(200), components: z.array(z.string().min(1).max(200)).min(1).max(50), effects: z.array(z.string().min(1).max(1000)).min(1).max(50),
  timeoutMs: z.number().int().min(1000).max(900000).default(90000),
  localEvidence: asset.optional(), localEvidenceMaxAgeMs: z.number().int().min(1000).max(86400000).optional(),
  /** Legacy static per-PR scripts; absent when a per-task preset generates each release package. */
  scripts: z.object({ apply: script, build: script, restart: script, verify: script, rollback: script }).strict().optional(),
  preset: ReleasePresetSchema.optional(),
}).strict().refine(p => !!p.scripts || !!p.preset, 'Profile needs scripts or a preset')
export type ReleaseProfile = z.infer<typeof ReleaseProfileSchema>
export const PRESET_FIELDS = 'release-profile.json: preset.{pythonPath,pnpmPath,targetPath,releaseRoot,dependencyRoot,prepareScript,restartScript,verifyUrl,verifyContainsTemplate}'
/** Exact profile field names an operator must set; shown in-thread when absent. */
export const PROFILE_FIELDS = 'release-profile.json: source.{repository,baseBranch,checkoutPath,remoteUrl}, ghPath, gitPath, cwd, patchDir, environment, components, effects, scripts.{apply,build,restart,verify,rollback}'

export class ReleaseBlocked extends DeliveryConflict {
  constructor(readonly missing: { field: string; owner: string; detail: string }[]) { super(`Release preparation cannot start: ${missing.map(m => `${m.field}: ${m.detail}`).join(' | ')}`) }
}
export interface ReleaseCandidate { ticketId: string; assignmentId: string; reportAt: string; dir: string; branch: string; headSha: string; baseSha: string; patchSha256: string; files: number; patch: Buffer }

const MAX_PATCH = 2 * 1024 * 1024
const sha = /^[a-f0-9]{40}$/

export function loadReleaseProfile(stateDir: string): ReleaseProfile | undefined {
  let text: string
  try { text = readFileSync(join(stateDir, 'release-profile.json'), 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  return ReleaseProfileSchema.parse(JSON.parse(text))
}

export interface ReleaseDeps {
  stateDir: string
  profile: () => ReleaseProfile | undefined
  store: DeliveryStore
  ticket: (id: string) => Ticket | undefined
  /** Non-empty reason while a publication for any PR is still in flight; the shared manifest must not move under it. */
  publicationBusy: () => string | undefined
  validateCurrent?: (delivery: Delivery) => void
  exec?: PublicationExecutor
  now?: () => string
}
export interface ReleaseRequest { revision: number }
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + sep)

/** Serialize concurrent clicks for one finding in-process; durable idempotency below covers restarts. */
export class FindingRelease {
  private readonly inflight = new Map<string, Promise<unknown>>()
  constructor(private readonly deps: ReleaseDeps) {}
  private exec(): PublicationExecutor { return this.deps.exec ?? executePublicationCommand }
  private async run(profile: ReleaseProfile, exe: string, args: string[], cwd: string, input?: string, extra: { timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal } = {}): Promise<string> {
    return this.exec()({ executable: exe, args, cwd, timeoutMs: extra.timeoutMs ?? profile.timeoutMs, ...(input ? { input } : {}), ...(extra.env ? { env: extra.env } : {}), ...(extra.signal ? { signal: extra.signal } : {}) })
  }

  /** Read-only git facts about the worker's local committed artifact; the worker directory is data, never authority. */
  async candidate(ticket: Ticket, profile: ReleaseProfile): Promise<ReleaseCandidate> {
    const assignment = ticket.assignments.at(-1)
    const root = ticket.execution?.directory
    if (!assignment || !root) throw new ReleaseBlocked([{ field: 'worker artifact', owner: `worker-${ticket.id}`, detail: 'The job ticket has no recorded assignment or workspace directory.' }])
    const base = realpathSync(root)
    const options: { parent: string; dir: string }[] = []
    for (const parent of [base, ...(profile.source.artifactRoots ?? []).map(r => { try { return realpathSync(r) } catch { return '' } }).filter(Boolean).map(r => r)]) {
      const sub = parent === base ? profile.source.workspaceSubdir : ticket.id
      try { options.push({ parent, dir: realpathSync(join(parent, sub)) }) } catch { /* try next */ }
    }
    const found = options.find(o => inside(o.parent, o.dir))
    if (!found) throw new ReleaseBlocked([{ field: 'worker artifact', owner: `worker-${ticket.id}`, detail: `No ${profile.source.workspaceSubdir}/ checkout exists in the job workspace or a trusted artifact root; commit the work in a clone of ${profile.source.repository} there.` }])
    const dir = found.dir
    const git = (...args: string[]) => this.run(profile, profile.gitPath, ['-C', dir, ...args], dir).then(out => out.trim())
    if (await git('rev-parse', '--show-toplevel') !== dir) throw new DeliveryConflict('Worker checkout is not the root of its own git repository')
    const origin = await git('remote', 'get-url', 'origin')
    if (origin !== profile.source.checkoutPath && (existsSync(origin) ? realpathSync(origin) : origin) !== profile.source.checkoutPath) throw new DeliveryConflict('Worker checkout is not a clone of the trusted project source')
    if (await git('status', '--porcelain', '--untracked-files=no')) throw new ReleaseBlocked([{ field: 'worker artifact', owner: `worker-${ticket.id}`, detail: 'The worker checkout has uncommitted changes; only committed work can be reviewed and published.' }])
    const headSha = await git('rev-parse', 'HEAD')
    const trustedBase = async () => {
      const local = await git('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${profile.source.baseBranch}`).catch(() => '')
      if (sha.test(local)) return local
      const remote = (await this.run(profile, profile.ghPath, ['api', `repos/${profile.source.repository}/branches/${profile.source.baseBranch}`, '--jq', '.commit.sha'], profile.cwd)).trim()
      if (!sha.test(remote)) throw new DeliveryConflict('Could not resolve the trusted base branch commit')
      await git('cat-file', '-e', `${remote}^{commit}`).catch(() => { throw new ReleaseBlocked([{ field: 'worker artifact', owner: `worker-${ticket.id}`, detail: 'The worker checkout does not contain the trusted base commit; rebase onto the project base.' }]) })
      return remote
    }
    const baseSha = await git('merge-base', 'HEAD', await trustedBase())
    if (!sha.test(headSha) || !sha.test(baseSha)) throw new DeliveryConflict('Worker checkout did not yield exact head and base commits')
    if (headSha === baseSha) throw new ReleaseBlocked([{ field: 'worker artifact', owner: `worker-${ticket.id}`, detail: 'The worker has no commit beyond the project base; there is nothing to review.' }])
    const patch = Buffer.from(await this.run(profile, profile.gitPath, ['-C', dir, 'diff', '--binary', baseSha, headSha], dir), 'utf8')
    if (!patch.length || patch.length > MAX_PATCH) throw new DeliveryConflict('Worker patch is empty or exceeds the bounded review size')
    const files = (await git('diff', '--name-only', baseSha, headSha)).split('\n').filter(Boolean).length
    const branch = `agent/${ticket.execution?.name ?? ticket.id}`
    if (!/^agent\/[\w.-]{1,100}$/.test(branch)) throw new DeliveryConflict('Job ticket name is not a safe branch name')
    return { ticketId: ticket.id, assignmentId: assignment.id, reportAt: assignment.report?.at ?? '', dir, branch, headSha, baseSha, patchSha256: hash(patch), files, patch }
  }

  /** Reuse the open source PR for this exact head, or push the exact commit and open one with fixed argv. */
  private async sourcePr(profile: ReleaseProfile, c: ReleaseCandidate, finding: Finding): Promise<number> {
    const R = profile.source.repository
    const find = async () => {
      const rows = JSON.parse(await this.run(profile, profile.ghPath, ['pr', 'list', '--repo', R, '--head', c.branch, '--state', 'open', '--json', 'number,headRefOid,baseRefName'], profile.cwd)) as { number: number; headRefOid: string; baseRefName: string }[]
      if (rows.length > 1) throw new DeliveryConflict(`More than one open PR uses ${c.branch}; resolve before preparing`)
      const row = rows[0]
      if (row && (row.headRefOid !== c.headSha || row.baseRefName !== profile.source.baseBranch)) throw new DeliveryConflict(`Open PR #${row.number} for ${c.branch} is not at the reviewed head or base; refusing to reuse a stale PR`)
      return row?.number
    }
    const existing = await find()
    if (existing) return existing
    await this.run(profile, profile.gitPath, ['-C', c.dir, '-c', `credential.helper=!${profile.ghPath} auth git-credential`, 'push', profile.source.remoteUrl, `${c.headSha}:refs/heads/${c.branch}`], c.dir)
    const title = finding.title.replace(/[\u0000-\u001f]/g, ' ').slice(0, 200)
    const body = `This is by an automated agent, not a human.\n\nSource finding \`${finding.id}\` revision ${finding.revision}, job \`${finding.job?.id}\`, worker ticket \`${c.ticketId}\`.\nHead \`${c.headSha}\`, base \`${c.baseSha}\`, patch sha256 \`${c.patchSha256}\`.\nReview, checks, publish and acceptance remain separate protected confirmations.`
    const url = (await this.run(profile, profile.ghPath, ['pr', 'create', '--repo', R, '--base', profile.source.baseBranch, '--head', c.branch, '--title', title, '--body', body], profile.cwd)).trim()
    const number = Number(/\/pull\/(\d+)\s*$/.exec(url)?.[1])
    if (!Number.isInteger(number) || number < 1) throw new DeliveryConflict('GitHub did not return a pull request number')
    const confirmed = await find()
    if (confirmed !== number) throw new DeliveryConflict('Created pull request does not match the exact reviewed head')
    return number
  }

  /** Legacy static profile: the shared manifest is written at click time from fixed per-profile scripts. */
  private writeManifest(profile: ReleaseProfile, c: ReleaseCandidate, pr: number): PublicationRunnerConfig {
    const scripts = profile.scripts
    if (!scripts) throw new ReleaseBlocked([{ field: 'scripts', owner: 'project release profile', detail: 'Profile has neither scripts nor a per-task preset.' }])
    const R = profile.source.repository
    mkdirSync(profile.patchDir, { recursive: true, mode: 0o700 })
    const patchPath = join(realpathSync(profile.patchDir), `${R.replace('/', '-')}-${pr}-${c.headSha}.patch`)
    writeFileSync(patchPath, c.patch, { mode: 0o600 })
    const config: PublicationRunnerConfig = { version: 1, pins: { repository: R, prNumber: pr, headSha: c.headSha, patchSha256: c.patchSha256 }, ghPath: profile.ghPath, cwd: profile.cwd,
      deliveryScope: { environment: profile.environment, refs: [{ repository: R, pr, headSha: c.headSha, baseSha: c.baseSha }], components: profile.components, effects: profile.effects },
      patch: { path: patchPath, sha256: c.patchSha256 }, timeoutMs: profile.timeoutMs, scripts,
      ...(profile.localEvidence ? { localEvidence: profile.localEvidence } : {}), ...(profile.localEvidenceMaxAgeMs ? { localEvidenceMaxAgeMs: profile.localEvidenceMaxAgeMs } : {}) }
    createPublicationRunner(config, async () => '')
    for (const item of [scripts.apply, scripts.build, scripts.restart, scripts.verify, scripts.rollback]) for (const file of [item, ...item.dependencies]) {
      if (realpathSync(file.path) !== file.path || !statSync(file.path).isFile() || hash(readFileSync(file.path)) !== file.sha256) throw new ReleaseBlocked([{ field: 'scripts', owner: 'project release profile', detail: `Pinned script ${file.path} is missing or changed; re-pin it in release-profile.json.` }])
    }
    return this.installManifest(config)
  }
  /** Atomically replace the shared manifest with the exact per-PR configuration, archiving the previous one. */
  private installManifest(config: PublicationRunnerConfig): PublicationRunnerConfig {
    const target = join(this.deps.stateDir, 'publication-runner.json')
    const text = JSON.stringify(config, null, 2)
    if (existsSync(target)) {
      if (readFileSync(target, 'utf8') === text) return config
      mkdirSync(join(this.deps.stateDir, 'publication-runner.history'), { recursive: true, mode: 0o700 })
      writeFileSync(join(this.deps.stateDir, 'publication-runner.history', `${hash(readFileSync(target))}.json`), readFileSync(target), { mode: 0o600 })
    }
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, target)
    return config
  }

  /**
   * Stage B: after the independent review passed for this exact delivery, build the per-task release package. Everything is derived
   * from stored facts and git/GitHub state: the changed spec files select targeted checks, the durable review verdict becomes the
   * independent attestation, and a fixed pinned prepare script writes the exact manifest. Idempotent; stale head/patch is refused.
   */
  async packageRelease(delivery: Delivery, signal?: AbortSignal): Promise<void> {
    const release = delivery.release, db = this.deps.store.db
    const profile = this.deps.profile(), preset = profile?.preset
    if (!release) throw new DeliveryConflict('Delivery has no release lineage')
    if (!profile || !preset) throw new ReleaseBlocked([{ field: 'release preset', owner: 'project release profile (one-time trusted setup)', detail: `No per-task release preset. Add ${PRESET_FIELDS}.` }])
    const ticket = this.deps.ticket(release.ticketId)
    if (!ticket) throw new DeliveryConflict('The release job ticket is missing')
    const run = <K>(key: string, work: () => Promise<K>) => { const prior = this.inflight.get(key); if (prior) return prior as Promise<K>; const p = work().finally(() => this.inflight.delete(key)); this.inflight.set(key, p); return p }
    return run(`package:${delivery.id}`, async () => {
      // Atomic cross-process ownership. A crashed lock is visible and requires explicit reconciliation, never guessed stale.
      const lock = join(this.deps.stateDir, 'release-package.lock')
      try { mkdirSync(lock, { mode: 0o700 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DeliveryConflict('Release packaging is owned by another or interrupted attempt; reconcile release-package.lock before retrying')
        throw error
      }
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ deliveryId: delivery.id, head: release.headSha, pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 })
      try { await this.packageOnce(delivery, release, profile, preset, ticket, signal) } finally { rmSync(lock, { recursive: true }) }
    })
  }
  private async packageOnce(delivery: Delivery, release: NonNullable<Delivery['release']>, profile: ReleaseProfile, preset: ReleasePreset, ticket: Ticket, signal?: AbortSignal): Promise<void> {
    const blocked = (field: string, owner: string, detail: string) => new ReleaseBlocked([{ field, owner, detail }])
    const scope = (d: Delivery) => deliveryFingerprint({ bindings: d.bindings, generation: d.generation, release: d.release, requirements: d.requirements, evidence: d.evidence, authorities: d.authorities, delegatedScope: d.delegatedScope })
    const original = scope(delivery), ticketHash = deliveryFingerprint(ticket)
    const current = () => {
      signal?.throwIfAborted()
      const d = this.deps.store.get(delivery.id)
      if (!d || scope(d) !== original || d.state !== 'awaiting_decision' || d.stage !== 'ready_to_publish' || deliveryFingerprint(this.deps.ticket(ticket.id)) !== ticketHash) throw new DeliveryConflict('Release source or scope changed during packaging; no manifest installed')
      if (deliveryFingerprint(this.deps.profile()) !== deliveryFingerprint(profile)) throw new DeliveryConflict('Trusted release profile changed during packaging')
      this.deps.validateCurrent?.(d)
      const other = this.deps.store.list().find(x => x.id !== d.id && x.preparedPublication && !x.historicalCompletion && !['accepted', 'cancelled', 'abandoned'].includes(x.state))
      if (other) throw new DeliveryConflict(`Release manifest is reserved by delivery ${other.id}; settle it before preparing another release`)
    }
    current()
    // 1. Exact passed independent review for the current bindings and generation.
    const fp = deliveryFingerprint(delivery.bindings)
    const review = delivery.evidence.findLast(e => e.kind === 'review' && e.outcome === 'passed' && (e.generation ?? 0) === delivery.generation && deliveryFingerprint(e.bindings) === fp)
    if (!review) throw blocked('independent review', 'Harness independent review', 'No passed independent review is recorded for the exact current head.')
    const reviewId = review.id.replace(/^independent-review:/, '')
    const row = this.deps.store.db.prepare('SELECT value FROM delivery_capability_review WHERE id=?').get(reviewId)
    const record = row ? JSON.parse(String(row.value)) as { lease?: { id: string; deliveryId: string; bindings: Delivery['bindings']; action: { kind: string } }; fingerprint?: string; bindingFingerprint?: string; verdict?: { verdict?: string; rationale?: string; findings?: unknown[] }; provider?: unknown } : undefined
    if (!record || record.verdict?.verdict !== 'passed' || !record.lease || record.lease.id !== reviewId || record.lease.deliveryId !== delivery.id || record.lease.action.kind !== 'review' || record.bindingFingerprint !== fp || deliveryFingerprint(record.lease.bindings) !== fp || record.fingerprint !== deliveryFingerprint({ action: record.lease.action, bindings: record.lease.bindings, deliveryId: delivery.id })) throw blocked('independent review', 'Harness independent review', 'The durable review verdict for the exact head is missing.')
    // 2. Exact artifact re-derived from git; a changed head or patch invalidates the package.
    const c = await this.candidate(ticket, profile)
    if (c.headSha !== release.headSha || c.patchSha256 !== release.patchSha256 || c.headSha !== delivery.bindings.headSha) throw new DeliveryConflict('The worker artifact changed after review; head or patch no longer matches the reviewed release')
    const R = profile.source.repository
    const conflict = this.deps.publicationBusy()
    if (conflict) throw new DeliveryConflict(`A publication is in flight (${conflict}); the shared release manifest cannot be replaced until it settles`)
    // 3. Fixed-path workspace under the trusted release root.
    mkdirSync(preset.releaseRoot, { recursive: true, mode: 0o700 })
    const root = realpathSync(preset.releaseRoot)
    const id = delivery.id.replace(/[^\w.-]/g, '_').slice(0, 80)
    const work = mkdtempSync(join(root, `${id}-${c.headSha.slice(0, 12)}-`))
    if (!inside(root, work) || work === root) throw new DeliveryConflict('Release workspace escapes the trusted root')
    const verifyContains = preset.verifyContainsTemplate.replaceAll('{head}', c.headSha).replaceAll('{patch}', c.patchSha256)
    const releaseDir = join(work, 'release'), manifestPath = join(releaseDir, 'publication-runner.json')
    const done = () => existsSync(manifestPath)
    if (!done()) {
      // Pinned prepare script and every declared dependency must be byte-identical to the operator pins.
      for (const file of [preset.prepareScript, ...preset.prepareScript.dependencies, preset.restartScript]) {
        if (realpathSync(file.path) !== file.path || !statSync(file.path).isFile() || hash(readFileSync(file.path)) !== file.sha256) throw blocked('release preset', 'project release profile', `Pinned file ${file.path} is missing or changed; re-pin it in release-profile.json.`)
      }
      const evidenceScript = join(preset.prepareScript.path, '..', 'record-evidence.py')
      if (!preset.prepareScript.dependencies.some(d => d.path === evidenceScript)) throw blocked('release preset', 'project release profile', `prepareScript.dependencies must pin ${evidenceScript}.`)
      const tests = (await this.run(profile, profile.gitPath, ['-C', c.dir, 'diff', '--name-only', '--diff-filter=AM', c.baseSha, c.headSha], c.dir)).split('\n')
        .filter(f => /^tests\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.spec\.tsx?$/.test(f) && !f.includes('..'))
      if (!tests.length) throw blocked('targeted tests', `worker-${ticket.id}`, 'The commit adds or changes no tests/*.spec.ts(x) file, so no targeted check can prove the change; add focused tests and report ready again.')
      if (tests.length > preset.maxTestFiles) throw blocked('targeted tests', `worker-${ticket.id}`, `The commit changes ${tests.length} spec files (limit ${preset.maxTestFiles}); narrow the change.`)
      // Each attempt keeps its immutable logs, including failed checks; never delete an earlier attempt.
      current()
      const wt = join(work, 'review-worktree'), evidenceDir = join(work, 'evidence'), patchPath = join(work, 'candidate.patch'), reportPath = join(work, 'independent-review.json')
      writeFileSync(patchPath, c.patch, { mode: 0o600 })
      writeFileSync(reportPath, JSON.stringify({ reviewer: 'harness-independent-review', evidence: review.reference, recordedAt: review.recordedAt, repository: R, headSha: c.headSha, patchSha256: c.patchSha256, verdict: record.verdict, provider: record.provider }, null, 2), { mode: 0o600 })
      await this.run(profile, profile.gitPath, ['-C', c.dir, 'worktree', 'add', '--detach', wt, c.headSha], c.dir)
      try {
        signal?.throwIfAborted()
        const nm = join(realpathSync(preset.dependencyRoot), 'node_modules')
        if (!existsSync(join(wt, 'node_modules')) && !(() => { try { return lstatSync(join(wt, 'node_modules')) } catch { return undefined } })()) symlinkSync(nm, join(wt, 'node_modules'))
        for (const companion of preset.companions) symlinkSync(realpathSync(companion.path), join(work, companion.name))
        // Existing dependencies only. A dependency graph change needs separate setup, never an unattended install.
        for (const name of ['package.json', 'pnpm-lock.yaml']) {
          const a = join(wt, name), b = join(preset.dependencyRoot, name)
          if (existsSync(a) && (!existsSync(b) || hash(readFileSync(a)) !== hash(readFileSync(b)))) throw blocked('dependencies', 'project release profile', `${name} differs from qualified dependencies; no install attempted.`)
        }
        current()
        const scriptDir = join(preset.prepareScript.path, '..')
        await this.run(profile, preset.pythonPath, [join(scriptDir, 'record-evidence.py'), '--repository', R, '--pr', String(release.prNumber), '--patch', patchPath, '--worktree', wt, '--gh', profile.ghPath, '--pnpm', preset.pnpmPath,
          '--review-report', reportPath, '--reviewer', 'harness-independent-review', '--author', `worker-${ticket.id}`, '--output-dir', evidenceDir, '--review-approved', '--review-completed-at', review.recordedAt,
          ...tests.flatMap(t => ['--targeted-test', t]), '--limitation', `Targeted checks only: ${tests.join(', ')}`], work, undefined, { timeoutMs: preset.checkTimeoutMs * 4, ...(signal ? { signal } : {}) })
        current()
        await this.run(profile, preset.pythonPath, [preset.prepareScript.path, '--repository', R, '--pr', String(release.prNumber), '--patch', patchPath, '--target', preset.targetPath, '--release-dir', releaseDir,
          '--gh', profile.ghPath, '--pnpm', preset.pnpmPath, '--restart-script', preset.restartScript.path, '--verify-url', preset.verifyUrl.replaceAll('{delivery}', encodeURIComponent(delivery.id)), '--verify-contains', verifyContains,
          '--local-evidence', join(evidenceDir, 'local-evidence.json'), '--timeout-ms', String(preset.checkTimeoutMs), ...tests.flatMap(t => ['--targeted-test', t])], work, undefined, { timeoutMs: preset.checkTimeoutMs, ...(signal ? { signal } : {}) })
      } finally {
        await this.run(profile, profile.gitPath, ['-C', c.dir, 'worktree', 'remove', '--force', wt], c.dir).catch(() => {})
        await this.run(profile, profile.gitPath, ['-C', c.dir, 'worktree', 'prune'], c.dir).catch(() => {})
      }
    }
    // 4. Install the exact generated manifest, scoped to the delivery's reviewed target, only if it still proves this head.
    const generated = JSON.parse(readFileSync(manifestPath, 'utf8')) as PublicationRunnerConfig & { pins: { repository: string; prNumber: number; headSha: string; patchSha256: string } }
    if (generated.pins.repository !== R || generated.pins.prNumber !== release.prNumber || generated.pins.headSha !== release.headSha || generated.pins.patchSha256 !== release.patchSha256) throw new DeliveryConflict('Generated release package does not match the reviewed head and patch')
    const config: PublicationRunnerConfig = { ...generated, ghPath: profile.ghPath,
      deliveryScope: { environment: delivery.bindings.environment ?? profile.environment, refs: [{ repository: R, pr: release.prNumber, headSha: c.headSha, baseSha: c.baseSha }], components: profile.components, effects: profile.effects },
      ...(profile.localEvidenceMaxAgeMs ? { localEvidenceMaxAgeMs: profile.localEvidenceMaxAgeMs } : {}) }
    createPublicationRunner(config, async () => '')
    current()
    if (this.deps.publicationBusy()) throw new DeliveryConflict('Publication started during packaging; no manifest installed')
    this.installManifest(config)
  }

  /** The protected click. Idempotent per finding job lineage; refuses stale revisions, foreign jobs and busy publications. */
  prepare(finding: Finding, request: ReleaseRequest, reference: string): Promise<Delivery> {
    const key = `${finding.id}:${finding.job?.id}`
    const pending = this.inflight.get(key)
    if (pending) return Promise.reject(new DeliveryConflict('Release preparation for this finding job is already running'))
    const work = this.prepareNow(finding, request, reference).finally(() => this.inflight.delete(key))
    this.inflight.set(key, work)
    return work
  }
  private async prepareNow(finding: Finding, request: ReleaseRequest, reference: string): Promise<Delivery> {
    const { store } = this.deps
    const job = finding.job
    if (finding.revision !== request.revision) throw new DeliveryConflict('Stale finding revision; refresh before preparing release')
    if (!job?.ticketId || !job.assignmentId) throw new DeliveryConflict('Finding has no current dispatched job to prepare')
    const ticketId = job.ticketId.replace(/^worker-/, '')
    const ticket = this.deps.ticket(ticketId)
    if (!ticket) throw new DeliveryConflict('The finding job ticket is not available')
    if (ticket.ended?.by === 'human') throw new DeliveryConflict('The finding job was ended by a person; its result cannot start a release')
    const assignment = ticket.assignments.at(-1)
    if (!assignment || assignment.id !== job.assignmentId) throw new DeliveryConflict('The ticket has a newer or different assignment than the finding job; refusing a foreign or superseded job')
    if (assignment.report?.state !== 'ready') throw new ReleaseBlocked([{ field: 'worker report', owner: `worker-${ticket.id}`, detail: 'The job has not recorded a structured ready report; prose is never treated as ready.' }])
    const latest = finding.reports.filter(r => r.jobId === job.id).at(-1)
    if (!latest || !['ready', 'verified'].includes(latest.state ?? '')) throw new DeliveryConflict('The finding has no current-job ready evidence')
    if (finding.state === 'resolved' || finding.state === 'deferred') throw new DeliveryConflict(`The finding is ${finding.state}; release preparation applies only to current unresolved work`)
    if (latest.state === 'verified') throw new DeliveryConflict('The finding job is already verified; nothing remains to prepare')
    // Exact approved requirements are kept verbatim (lossless); all immutable input is validated before any external effect.
    const requirements = finding.requirements.map(r => r.trim()).filter(Boolean)
    if (!requirements.length || requirements.length > 30 || requirements.some(r => r.length > 4000 || r.startsWith('intake:')) || new Set(requirements).size !== requirements.length) throw new DeliveryConflict('Finding requirements are not a bounded distinct list of acceptance criteria')
    const deliveryId = `auto-${ticket.id}`
    const prior = store.get(deliveryId)
    if (prior && !prior.scopeBinding) {
      if (prior.release?.findingId === finding.id && prior.release.jobId === job.id) return prior
      throw new DeliveryConflict('This ticket already has a delivery bound to another scope; open it from its own thread')
    }
    const profile = this.deps.profile()
    if (!profile) throw new ReleaseBlocked([{ field: 'release profile', owner: 'project release profile (one-time trusted setup)', detail: `No trusted release profile. Create ${PROFILE_FIELDS}.` }])
    // With a per-task preset the click only records the exact artifact/PR lineage; the shared manifest is generated after independent review.
    const busy = profile.preset ? undefined : this.deps.publicationBusy()
    if (busy) throw new DeliveryConflict(`A publication is in flight (${busy}); the shared release manifest cannot be replaced until it settles`)
    const c = await this.candidate(ticket, profile)
    const pr = await this.sourcePr(profile, c, finding)
    if (!profile.preset) this.writeManifest(profile, c, pr)
    const tracked = prior ?? store.trackUnbound({ ticketId: ticket.id, title: finding.title, owner: `worker:${ticket.id}`, repository: profile.source.repository, sourceIssue: 0, triggerId: ticket.origin.triggerId })
    const input: DeliveryCreate = { id: deliveryId, title: finding.title, owner: tracked.owner,
      bindings: { repository: profile.source.repository, sourceIssue: pr, baseSha: c.baseSha, headSha: c.headSha, environment: profile.environment, refs: [{ repository: profile.source.repository, pr, headSha: c.headSha, baseSha: c.baseSha }] },
      requirements, authorities: ['local-operator'], workers: [ticket.id], delegatedActions: ['review', 'fix', 'verify'] }
    const at = (this.deps.now ?? (() => new Date().toISOString()))()
    return store.bindScope(deliveryId, tracked.revision, input, { actor: 'local-operator', source: 'local_operator', reference, scope: deliveryFingerprint(input) },
      d => { d.release = { findingId: finding.id, findingRevision: finding.revision, jobId: job.id, ticketId: ticket.id, assignmentId: assignment.id, branch: c.branch, prNumber: pr, headSha: c.headSha, patchSha256: c.patchSha256, preparedAt: at } })
  }
}

/** Reason when a merge/deploy is in flight (merged but unsettled, or a running stage); a merely prepared publication is superseded by the new manifest. */
export function busyPublication(peek: () => { publications: Record<string, { status: string; prNumber: number; outcomes?: { status: string }[] }> }): string | undefined {
  const open = Object.values(peek().publications).find(p => p.status === 'merged' || (p.outcomes ?? []).some(o => o.status === 'running'))
  return open ? `PR #${open.prNumber} is ${open.status}` : undefined
}
