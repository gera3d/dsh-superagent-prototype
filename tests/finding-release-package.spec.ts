import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it as base } from 'vitest'
import { DeliveryStore, deliveryFingerprint, type DeliveryCreate } from '../src/app/feature-delivery.ts'
import { FindingRelease, ReleaseBlocked, type ReleaseProfile } from '../src/app/finding-release.ts'
import { loadPublicationRunner } from '../src/infra/publication-runner.ts'
import type { Ticket } from '../src/core/model.ts'

const it = (n: string, f: () => unknown) => base(n, f, 120000)
const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()
const d256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
const asset = (path: string) => ({ path, sha256: d256(readFileSync(path)) })

/** Real git, real prepare.py/record-evidence.py/runner plan; only gh, pnpm and restart are deterministic stubs. */
function fixture(opts: { spec?: boolean; failTests?: boolean; noReview?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pkg-')))
  const state = join(root, 'state'); mkdirSync(state)
  const source = join(root, 'source'); mkdirSync(source); sh(source, 'init', '-q', '-b', 'main'); writeFileSync(join(source, 'a.txt'), 'one\n'); sh(source, 'add', '.'); sh(source, 'commit', '-qm', 'base')
  const ticketDir = join(root, 'ticket'); mkdirSync(ticketDir); sh(ticketDir, 'clone', '-q', source, 'work')
  const work = join(ticketDir, 'work')
  writeFileSync(join(work, 'a.txt'), 'one\ntwo\n')
  if (opts.spec !== false) { mkdirSync(join(work, 'tests')); writeFileSync(join(work, 'tests', 'x.spec.ts'), 'export {}\n') }
  sh(work, 'add', '.'); sh(work, 'commit', '-qm', 'change')
  const head = sh(work, 'rev-parse', 'HEAD'), base = sh(work, 'merge-base', 'HEAD', 'origin/main')
  const patch = execFileSync('git', ['-C', work, 'diff', '--binary', base, head])
  const bin = join(root, 'bin'); mkdirSync(bin)
  const gh = join(bin, 'gh'); writeFileSync(gh, `#!/bin/sh\necho '{"headRefOid":"${head}","state":"OPEN"}'\n`); chmodSync(gh, 0o755)
  const pnpm = join(bin, 'pnpm'); writeFileSync(pnpm, `#!/bin/sh\n${opts.failTests ? 'case "$*" in *vitest*) echo FAILED; exit 1;; esac\n' : ''}echo ok "$@"\n`); chmodSync(pnpm, 0o755)
  const restart = join(bin, 'restart.sh'); writeFileSync(restart, '#!/bin/sh\nexit 0\n'); chmodSync(restart, 0o755)
  const dir = join(root, 'pub'); mkdirSync(dir)
  for (const f of ['prepare.py', 'runner.py', 'record-evidence.py', 'baseline.py', 'errors-reporter.cjs', 'apply.sh', 'build.sh', 'restart.sh', 'verify.sh', 'rollback.sh']) copyFileSync(join(process.cwd(), 'scripts/publication', f), join(dir, f))
  mkdirSync(join(root, 'deps', 'node_modules'), { recursive: true }); mkdirSync(join(root, 'target'))
  const profile: ReleaseProfile = { version: 1, source: { repository: 'org/proj', baseBranch: 'main', checkoutPath: source, remoteUrl: 'https://github.com/org/proj.git', workspaceSubdir: 'work', artifactRoots: [] },
    ghPath: gh, gitPath: execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), cwd: root, patchDir: join(root, 'patches'), environment: 'local harness', components: ['app'], effects: ['restart'], timeoutMs: 60000,
    preset: { pythonPath: '/usr/bin/python3', pnpmPath: pnpm, targetPath: join(root, 'target'), releaseRoot: join(root, 'releases'), dependencyRoot: join(root, 'deps'), prepareScript: { ...asset(join(dir, 'prepare.py')), dependencies: ['runner.py', 'record-evidence.py', 'baseline.py', 'errors-reporter.cjs', 'apply.sh', 'build.sh', 'restart.sh', 'verify.sh', 'rollback.sh'].map(f => asset(join(dir, f))) },
      restartScript: asset(restart), verifyUrl: 'http://127.0.0.1:3082/health', verifyContainsTemplate: 'release {head}', maxTestFiles: 30, checkTimeoutMs: 120000 } }
  const ticket = { id: 't1', execution: { name: 'finding-task-t1', directory: ticketDir }, assignments: [{ id: 'a1', state: 'ended', report: { state: 'ready', summary: 's', at: '2026-01-01T00:00:00Z' } }] } as unknown as Ticket
  const store = new DeliveryStore(':memory:')
  const t = store.trackUnbound({ ticketId: 't1', title: 'T', owner: 'o', repository: 'org/proj', sourceIssue: 0, triggerId: 'tr' })
  const input: DeliveryCreate = { id: 'auto-t1', title: 'T', owner: 'o', bindings: { repository: 'org/proj', sourceIssue: 7, baseSha: base, headSha: head, environment: 'local harness', refs: [{ repository: 'org/proj', pr: 7, headSha: head, baseSha: base }] },
    requirements: ['r'], authorities: ['local-operator'], workers: ['t1'], delegatedActions: ['review', 'fix', 'verify'] }
  const d = store.bindScope('auto-t1', t.revision, input, { actor: 'local-operator', source: 'local_operator', reference: 'r', scope: deliveryFingerprint(input) },
    x => { x.release = { findingId: 'f1', findingRevision: 1, jobId: 'j1', ticketId: 't1', assignmentId: 'a1', branch: 'agent/x', prNumber: 7, headSha: head, patchSha256: d256(patch), preparedAt: '' } })
  store.db.exec('CREATE TABLE IF NOT EXISTS delivery_capability_review(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, value TEXT NOT NULL)')
  store.db.prepare('INSERT INTO delivery_capability_review(id,fingerprint,value) VALUES(?,?,?)').run('L1', 'f', JSON.stringify({ verdict: { verdict: 'passed', rationale: 'ok', findings: [] }, provider: 'p' }))
  if (!opts.noReview) store.compareAndSwap('auto-t1', d.revision, x => { x.evidence.push({ id: 'independent-review:L1', kind: 'review', bindings: x.bindings, recordedAt: new Date().toISOString(), reference: 'sqlite:delivery_capability_review/L1', outcome: 'passed', generation: x.generation }) })
  let busy: string | undefined
  const rel = new FindingRelease({ stateDir: state, profile: () => profile, store, ticket: id => id === 't1' ? ticket : undefined, publicationBusy: () => busy })
  return { root, state, work, head, patch, store, rel, setBusy: (v?: string) => { busy = v }, get: () => store.get('auto-t1')! }
}

it('packages the reviewed head: real targeted check evidence, exact manifest, no publication', async () => {
  const f = fixture()
  await f.rel.packageRelease(f.get())
  const runner = loadPublicationRunner(join(f.state, 'publication-runner.json'))!
  expect(runner.pinsFor('org/proj', 7)).toMatchObject({ headSha: f.head, patchSha256: d256(f.patch) })
  expect(runner.scopeFor('org/proj', 7)!.refs[0]).toMatchObject({ headSha: f.head })
  const rel = join(f.root, 'releases', `auto-t1-${f.head.slice(0, 12)}`)
  const plan = JSON.parse(readFileSync(join(rel, 'release', 'publication-plan.json'), 'utf8'))
  expect(plan.targetedTests).toEqual(['tests/x.spec.ts']); expect(plan.verifyContains).toBe(`release ${f.head}`)
  const ev = JSON.parse(readFileSync(join(rel, 'evidence', 'local-evidence.json'), 'utf8'))
  expect(ev.reviewer.name).toBe('harness-independent-review'); expect(ev.checks.map((c: { name: string }) => c.name).join()).toContain('targeted: tests/x.spec.ts')
  expect(sh(f.work, 'worktree', 'list').split('\n')).toHaveLength(1)
  await f.rel.packageRelease(f.get()) // idempotent
})

it('blocks with a concrete owner when no spec changed, checks fail, review missing, head moved, or publication busy', async () => {
  const none = fixture({ spec: false })
  await expect(none.rel.packageRelease(none.get())).rejects.toThrow(/no tests\/\*\.spec/)
  expect(existsSync(join(none.state, 'publication-runner.json'))).toBe(false)
  const bad = fixture({ failTests: true })
  await expect(bad.rel.packageRelease(bad.get())).rejects.toThrow()
  expect(existsSync(join(bad.state, 'publication-runner.json'))).toBe(false)
  expect(sh(bad.work, 'worktree', 'list').split('\n')).toHaveLength(1)
  const noReview = fixture({ noReview: true })
  await expect(noReview.rel.packageRelease(noReview.get())).rejects.toBeInstanceOf(ReleaseBlocked)
  const moved = fixture(); writeFileSync(join(moved.work, 'a.txt'), 'three\n'); sh(moved.work, 'commit', '-qam', 'later')
  await expect(moved.rel.packageRelease(moved.get())).rejects.toThrow(/changed after review/)
  const busy = fixture(); busy.setBusy('PR #9 is merged')
  await expect(busy.rel.packageRelease(busy.get())).rejects.toThrow(/in flight/)
})
