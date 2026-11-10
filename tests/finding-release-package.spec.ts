import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it as base } from 'vitest'
import { ReleaseBlocked } from '../src/app/finding-release.ts'
import { fixture } from './fixtures/release-package.ts'
import { loadPublicationRunner } from '../src/infra/publication-runner.ts'
import type { Ticket } from '../src/core/model.ts'

const it = (n: string, f: () => unknown) => base(n, f, 120000)
const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()
const d256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')

it('packages the reviewed head: real targeted check evidence, exact manifest, no publication', async () => {
  const f = fixture()
  await f.rel.packageRelease(f.get())
  const runner = loadPublicationRunner(join(f.state, 'publication-runner.json'))!
  expect(runner.pinsFor('org/proj', 7)).toMatchObject({ headSha: f.head, patchSha256: d256(f.patch) })
  expect(runner.scopeFor('org/proj', 7)!.refs[0]).toMatchObject({ headSha: f.head })
  const rel = join(f.root, 'releases', readdirSync(join(f.root, 'releases'))[0]!)
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

 it('rejects a foreign review even when the visible evidence says passed', async () => {
  const f = fixture()
  const row = f.store.db.prepare('SELECT value FROM delivery_capability_review WHERE id=?').get('L1')!
  const r = JSON.parse(String(row.value)); r.lease.deliveryId = 'another-delivery'
  f.store.db.prepare('UPDATE delivery_capability_review SET value=? WHERE id=?').run(JSON.stringify(r), 'L1')
  await expect(f.rel.packageRelease(f.get())).rejects.toThrow(/durable review verdict/)
  expect(existsSync(join(f.state, 'publication-runner.json'))).toBe(false)
})
it('preserves failed attempt logs and refuses a cross-process packaging lock', async () => {
  const f = fixture({ failTests: true })
  await expect(f.rel.packageRelease(f.get())).rejects.toThrow()
  const before = readdirSync(join(f.root, 'releases'))
  await expect(f.rel.packageRelease(f.get())).rejects.toThrow()
  expect(readdirSync(join(f.root, 'releases'))).toHaveLength(2)
  expect(existsSync(join(f.root, 'releases', before[0]!, 'evidence', 'tests.log'))).toBe(true)
  mkdirSync(join(f.state, 'release-package.lock'))
  await expect(f.rel.packageRelease(f.get())).rejects.toThrow(/interrupted attempt/)
})

it('rechecks canonical finding currency after checks and never installs a stale package', async () => {
  const f = fixture()
  let count = 0
  f.deps.validateCurrent = () => { if (++count >= 4) throw new Error('Source finding revision changed') }
  await expect(f.rel.packageRelease(f.get())).rejects.toThrow(/revision changed/)
  expect(count).toBe(4)
  expect(existsSync(join(f.state, 'publication-runner.json'))).toBe(false)
  expect(readdirSync(join(f.root, 'releases'))).toHaveLength(1)
})
