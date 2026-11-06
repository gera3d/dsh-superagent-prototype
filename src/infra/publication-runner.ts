/** Operator-configured publication adapter. Never accepts commands from HTTP/card input. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { stripVTControlCharacters } from 'node:util'
import type { PublicationAdapter, PublicationEvidence, PublicationPins, PublicationStage } from '../app/publication.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const absolute = z.string().refine(isAbsolute, 'Expected absolute path')
const asset = z.object({ path: absolute, sha256: digest }).strict()
const pinsSchema = z.object({ repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), prNumber: z.number().int().positive(), headSha: z.string().regex(/^[a-f0-9]{40}$/), patchSha256: digest }).strict()
const script = asset.extend({ dependencies: z.array(asset).default([]) }).strict()
const localAttestationSchema = z.object({
  version: z.literal(1), pins: pinsSchema, author: z.string().min(1).max(200),
  reviewer: z.object({ name: z.string().min(1).max(200), role: z.literal('independent') }).strict(),
  review: z.object({ verdict: z.literal('approved'), completedAt: z.iso.datetime(), report: asset }).strict(),
  checks: z.array(z.object({ name: z.string().min(1).max(200), exitCode: z.literal(0), completedAt: z.iso.datetime(), report: asset }).strict()).min(1).max(100),
  limitations: z.array(z.string().max(2000)).max(30),
}).strict()
const configSchema = z.object({
  version: z.literal(1), pins: pinsSchema, ghPath: absolute, cwd: absolute,
  patch: asset, timeoutMs: z.number().int().min(1000).max(900000).default(90000),
  localEvidence: asset.optional(), localEvidenceMaxAgeMs: z.number().int().min(1000).max(86400000).default(3600000),
  scripts: z.object({ apply: script, build: script, restart: script, verify: script, rollback: script }).strict(),
}).strict()
export type PublicationRunnerConfig = z.input<typeof configSchema>
export interface RunnerCommand { executable: string; args: string[]; cwd: string; timeoutMs: number; input?: string; env?: Record<string, string>; signal?: AbortSignal; onSpawn?: (pid: number) => void }
export type PublicationExecutor = (command: RunnerCommand) => Promise<string>

/** Bounded, shell-free subprocess transport; only configured script bytes enter bash stdin. */
export const executePublicationCommand: PublicationExecutor = command => new Promise((resolve, reject) => {
  if (command.signal?.aborted) { reject(new Error('Publication command aborted before spawn')); return }
  // A fixed stdin gate prevents even gh from mutating before synchronous PGID journaling.
  const child = spawn('/bin/bash', ['-c', 'IFS= read -r gate; [ "$gate" = "DSH_GO" ] || exit 125; exec "$@"', 'publication-gate', command.executable, ...command.args], {
    cwd: command.cwd, shell: false, detached: true,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin', HOME: process.env.HOME,
      GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', ...command.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = '', size = 0, failure: Error | undefined, cleanup: Promise<void> | undefined
  const groupSignal = (signal: NodeJS.Signals) => {
    if (!child.pid) return
    try { process.kill(-child.pid, signal) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= new Error('Cannot terminate publication process group; operator reconciliation required')
    }
  }
  // Detached POSIX group includes descendants. Do not return/release service lock
  // until SIGKILL escalation has run, including after a parent exits early.
  const stopGroup = () => cleanup ??= new Promise<void>(done => {
    groupSignal('SIGTERM')
    setTimeout(() => { groupSignal('SIGKILL'); done() }, 250)
  })
  const stop = (message: string) => { failure ??= new Error(message); void stopGroup() }
  const abort = () => stop('Publication command aborted; process group settled before returning')
  command.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => stop('Publication command timed out; reconcile before retry'), command.timeoutMs)
  const collect = (data: Buffer) => {
    size += data.length
    if (size > 1024 * 1024) stop('Publication command output limit exceeded')
    else output += data.toString('utf8')
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', data => { size += data.length; if (size > 1024 * 1024) stop('Publication command output limit exceeded') })
  child.on('error', error => { clearTimeout(timer); command.signal?.removeEventListener('abort', abort); reject(error) })
  child.on('close', async (code, signal) => {
    clearTimeout(timer)
    command.signal?.removeEventListener('abort', abort)
    await stopGroup()
    if (failure || code !== 0) reject(failure ?? new Error(`Publication command failed (${code ?? signal}); reconcile before retry`))
    else resolve(output)
  })
  child.stdin.on('error', () => { /* early exit is handled by close */ })
  try {
    if (child.pid) command.onSpawn?.(child.pid)
    if (command.signal?.aborted) abort()
    if (failure) child.stdin.end()
    else child.stdin.end(`DSH_GO\n${command.input ?? ''}`)
  } catch { stop('Publication process-group journal failed before execution'); child.stdin.end() }
})

function checkedFile(item: { path: string; sha256: string }): Buffer {
  if (realpathSync(item.path) !== item.path || !statSync(item.path).isFile()) throw new Error('Pinned asset must be a regular canonical absolute file')
  const bytes = readFileSync(item.path)
  if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('Pinned publication asset changed')
  return bytes
}
function reportExcerpt(bytes: Buffer, limit: number): string {
  return stripVTControlCharacters(bytes.toString('utf8')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '').slice(0, limit)
}
function samePins(a: PublicationPins, b: PublicationPins): boolean {
  return a.repository === b.repository && a.prNumber === b.prNumber && a.headSha === b.headSha && a.patchSha256 === b.patchSha256
}
export interface ConfiguredPublicationAdapter extends PublicationAdapter {
  pinsFor(repository: string, prNumber: number): PublicationPins | undefined
}

export function createPublicationRunner(input: PublicationRunnerConfig, execute: PublicationExecutor = executePublicationCommand): ConfiguredPublicationAdapter {
  const config = configSchema.parse(input)
  if (config.patch.sha256 !== config.pins.patchSha256) throw new Error('Patch digest must match release pins')
  if (realpathSync(config.cwd) !== config.cwd || !statSync(config.cwd).isDirectory()) throw new Error('Runner cwd must be a canonical directory')
  const phases = Object.values(config.scripts)
  if (new Set(phases.map(value => value.path)).size !== phases.length) throw new Error('Each publication phase requires a distinct script')
  const validate = (pins: PublicationPins, rollback = false) => {
    pinsSchema.parse(pins)
    if (!samePins(pins, config.pins)) throw new Error('Publication pins do not match configured release')
    if (!rollback) checkedFile(config.patch)
    for (const phase of rollback ? [config.scripts.rollback] : phases) { checkedFile(phase); phase.dependencies.forEach(checkedFile) }
  }
  const gh = (args: string[], signal?: AbortSignal, onSpawn?: (pid: number) => void) => execute({ executable: config.ghPath, args, cwd: config.cwd, timeoutMs: config.timeoutMs, signal, onSpawn })
  return {
    pinsFor(repository, prNumber) { return repository === config.pins.repository && prNumber === config.pins.prNumber ? { ...config.pins } : undefined },
    async evidence(pins: PublicationPins, signal?: AbortSignal, onSpawn?: (pid: number) => void): Promise<PublicationEvidence> {
      validate(pins)
      const data = JSON.parse(await gh(['pr', 'view', String(pins.prNumber), '--repo', pins.repository, '--json', 'headRefOid,state,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup'], signal, onSpawn)) as Record<string, unknown>
      if (data.headRefOid !== pins.headSha) throw new Error('GitHub head changed from configured release')
      const checks = Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup as Record<string, unknown>[] : []
      const passed = (check: Record<string, unknown>) => check.state === 'SUCCESS' || (check.status === 'COMPLETED' && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(String(check.conclusion)))
      const failed = checks.some(check => ['FAILURE', 'ERROR'].includes(String(check.state)) || ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(String(check.conclusion)))
      if (!['OPEN', 'MERGED', 'CLOSED'].includes(String(data.state))) throw new Error('Invalid GitHub PR state')
      let local: PublicationEvidence['local']
      const hostedReviewAbsent = data.reviewDecision === '' || data.reviewDecision === null || data.reviewDecision === undefined
      if (config.localEvidence && (!checks.length || hostedReviewAbsent)) {
        const proof = localAttestationSchema.parse(JSON.parse(checkedFile(config.localEvidence).toString('utf8')))
        if (!samePins(proof.pins, pins) || proof.reviewer.name === proof.author) throw new Error('Local evidence binding or independent reviewer mismatch')
        const verifiedReports = [proof.review, ...proof.checks].map(record => {
          const age = Date.now() - Date.parse(record.completedAt)
          if (age < -1000 || age > config.localEvidenceMaxAgeMs) throw new Error('Local evidence is stale')
          return checkedFile(record.report)
        })
        local = { reviewer: proof.reviewer.name, reportSha256: proof.review.report.sha256, reviewExcerpt: reportExcerpt(verifiedReports[0]!, 6000),
          checks: proof.checks.map((check, index) => ({ name: check.name, reportSha256: check.report.sha256, completedAt: check.completedAt, outputExcerpt: reportExcerpt(verifiedReports[index + 1]!, 2000) })), limitations: proof.limitations }
      }
      return { ...pins, observedAt: new Date().toISOString(), checks: failed ? 'failed' : checks.length ? checks.every(passed) ? 'passed' : 'pending' : local ? 'passed' : 'pending',
        review: data.reviewDecision === 'APPROVED' ? 'approved' : data.reviewDecision === 'CHANGES_REQUESTED' ? 'changes_requested' : hostedReviewAbsent && local ? 'approved' : 'required',
        mergeable: data.mergeable === 'MERGEABLE' && data.mergeStateStatus === 'CLEAN', state: String(data.state).toLowerCase() as PublicationEvidence['state'], ...(local ? { local } : {}) }
    },
    async perform(stage: PublicationStage, pins: PublicationPins, operationId: string, signal?: AbortSignal, onSpawn?: (pid: number) => void) {
      validate(pins, stage === 'rollback')
      if (!/^[\w:.-]{1,200}$/.test(operationId)) throw new Error('Invalid publication operation identity')
      if (stage === 'merge') {
        await gh(['pr', 'merge', String(pins.prNumber), '--repo', pins.repository, '--squash', '--match-head-commit', pins.headSha], signal, onSpawn)
      } else {
        if (!Object.hasOwn(config.scripts, stage)) throw new Error('Unknown publication stage')
        const phase = config.scripts[stage as keyof typeof config.scripts]
        const bytes = checkedFile(phase)
        await execute({ executable: '/bin/bash', args: ['-s', '--'], input: bytes.toString('utf8'), cwd: config.cwd, timeoutMs: config.timeoutMs, signal, onSpawn,
          env: { PUBLICATION_ASSET_SHA256: JSON.stringify(Object.fromEntries(phase.dependencies.map(item => [item.path, item.sha256]))), PUBLICATION_OPERATION_ID: operationId, PUBLICATION_STAGE: stage, PUBLICATION_REPOSITORY: pins.repository,
            PUBLICATION_PR_NUMBER: String(pins.prNumber), PUBLICATION_HEAD_SHA: pins.headSha, PUBLICATION_PATCH_SHA256: pins.patchSha256, PUBLICATION_PATCH_PATH: config.patch.path } })
      }
      const scope = stage === 'verify' ? '; configured HTTP release verification only, browser acceptance not performed' : stage === 'rollback' ? '; source/artifact restoration script completed, restored live service not independently verified' : ''
      return { detail: `${stage} completed for pinned head ${pins.headSha}${scope}` }
    },
  }
}

/** Missing config disables publication. Invalid/present config is an error, never a permissive fallback. */
export function loadPublicationRunner(configPath: string): ConfiguredPublicationAdapter | undefined {
  let text: string
  try { text = readFileSync(configPath, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  return createPublicationRunner(JSON.parse(text) as PublicationRunnerConfig)
}
