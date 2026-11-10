import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it as base } from 'vitest'
const it = (n: string, f: () => unknown) => base(n, f, 60000)
import { DeliveryStore } from '../src/app/feature-delivery.ts'
import { FindingRelease, ReleaseBlocked, busyPublication, loadReleaseProfile, type ReleaseProfile } from '../src/app/finding-release.ts'
import { executePublicationCommand, loadPublicationRunner, type PublicationExecutor } from '../src/infra/publication-runner.ts'
import type { Finding } from '../src/app/finding.ts'
import type { Ticket } from '../src/core/model.ts'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()
const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')

function fixture(opts: { commit?: boolean; ready?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rel-')))
  const state = join(root, 'state'); mkdirSync(state)
  const source = join(root, 'source'); mkdirSync(source); sh(source, 'init', '-q', '-b', 'main'); writeFileSync(join(source, 'a.txt'), 'one\n'); sh(source, 'add', '.'); sh(source, 'commit', '-qm', 'base')
  const ticketDir = join(root, 'ticket'); mkdirSync(ticketDir)
  sh(ticketDir, 'clone', '-q', source, 'work')
  const work = join(ticketDir, 'work')
  if (opts.commit !== false) { writeFileSync(join(work, 'a.txt'), 'one\ntwo\n'); sh(work, 'commit', '-qam', 'change') }
  const scripts = Object.fromEntries(['apply', 'build', 'restart', 'verify', 'rollback'].map(name => {
    const path = join(root, `${name}.sh`); const text = `echo ${name}\n`; writeFileSync(path, text); return [name, { path, sha256: sha256(text), dependencies: [] }]
  })) as unknown as ReleaseProfile['scripts']
  const profile: ReleaseProfile = { version: 1, source: { repository: 'org/proj', baseBranch: 'main', checkoutPath: source, remoteUrl: 'https://github.com/org/proj.git', workspaceSubdir: 'work', artifactRoots: [] },
    ghPath: '/usr/bin/gh', gitPath: execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), cwd: root, patchDir: join(root, 'patches'), environment: 'local harness', components: ['app'], effects: ['restart'], timeoutMs: 30000, scripts }
  const ticket = { id: 't1', title: 'T', origin: { triggerId: 'trig1', triggerIds: ['trig1'] }, execution: { name: 'finding-task-t1', directory: ticketDir, assignment: '' },
    assignments: [{ id: 'a1', state: 'ended', createdAt: '', report: { state: opts.ready === false ? 'blocked' : 'ready', summary: 's', at: '2026-01-01T00:00:00Z' } }] } as unknown as Ticket
  const finding = { id: 'f1', revision: 3, title: 'Fix thing', requirements: ['works live'], job: { id: 'job1', ticketId: 'worker-t1', assignmentId: 'a1' }, state: 'blocked',
    reports: [{ jobId: 'job1', state: 'ready', reference: 'r', evidence: 'e', nextDecision: 'n', at: '' }] } as unknown as Finding
  const calls: string[] = []
  let pr = 0; let open = false
  const exec: PublicationExecutor = async c => {
    if (c.executable === profile.ghPath) {
      calls.push(`gh ${c.args.slice(0, 2).join(' ')}`)
      if (c.args[1] === 'list') return JSON.stringify(open ? [{ number: pr, headRefOid: sh(work, 'rev-parse', 'HEAD'), baseRefName: 'main' }] : [])
      if (c.args[1] === 'create') { pr = 7; open = true; return 'https://github.com/org/proj/pull/7\n' }
    }
    if (c.args.includes('push')) { calls.push('push'); return '' }
    return executePublicationCommand(c)
  }
  const store = new DeliveryStore(':memory:')
  let busy: string | undefined
  const release = new FindingRelease({ stateDir: state, profile: () => profile, store, ticket: id => id === 't1' ? ticket : undefined, publicationBusy: () => busy, exec, now: () => '2026-01-01T00:00:00Z' })
  return { root, state, work, profile, ticket, finding, release, store, calls, setBusy: (v?: string) => { busy = v } }
}

it('prepares the exact committed artifact: PR, per-PR manifest and bound delivery lineage, without publishing', async () => {
  const f = fixture()
  const delivery = await f.release.prepare(f.finding, { revision: 3 }, 'ref')
  expect(f.calls).toEqual(['gh pr list', 'push', 'gh pr create', 'gh pr list'])
  const head = sh(f.work, 'rev-parse', 'HEAD')
  expect(delivery).toMatchObject({ id: 'auto-t1', stage: 'implementation', release: { findingId: 'f1', jobId: 'job1', ticketId: 't1', prNumber: 7, headSha: head }, delegatedActions: ['review', 'fix', 'verify'], authorities: ['local-operator'], requirements: ['works live'] })
  expect(delivery.scopeBinding).toBeUndefined()
  expect(delivery.bindings.refs).toEqual([expect.objectContaining({ repository: 'org/proj', pr: 7, headSha: head })])
  const runner = loadPublicationRunner(join(f.state, 'publication-runner.json'))!
  expect(runner.pinsFor('org/proj', 7)).toMatchObject({ headSha: head, patchSha256: delivery.release!.patchSha256 })
  expect(runner.scopeFor('org/proj', 7)!.refs[0]).toMatchObject({ headSha: head })
  expect(readdirSync(f.profile.patchDir)).toHaveLength(1)
  expect(delivery.evidence).toEqual([]); expect(delivery.acceptance).toBeUndefined()
})

it('is idempotent for the same lineage and replaces/archives the previous manifest', async () => {
  const f = fixture()
  mkdirSync(f.state, { recursive: true }); writeFileSync(join(f.state, 'publication-runner.json'), '{"old":true}')
  const first = await f.release.prepare(f.finding, { revision: 3 }, 'ref')
  const again = await f.release.prepare(f.finding, { revision: 3 }, 'ref')
  expect(again.revision).toBe(first.revision)
  expect(f.calls.filter(c => c === 'gh pr create')).toHaveLength(1)
  expect(readdirSync(join(f.state, 'publication-runner.history'))).toEqual([`${sha256('{"old":true}')}.json`])
})

it('rejects concurrent duplicate clicks while one is running', async () => {
  const f = fixture()
  const [a, b] = await Promise.allSettled([f.release.prepare(f.finding, { revision: 3 }, 'r'), f.release.prepare(f.finding, { revision: 3 }, 'r')])
  expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected'])
})

it('refuses stale revision, foreign/superseded job, unready or prose report, human-ended ticket and busy publication', async () => {
  const f = fixture()
  await expect(f.release.prepare(f.finding, { revision: 2 }, 'r')).rejects.toThrow('Stale finding revision')
  await expect(f.release.prepare({ ...f.finding, job: { ...f.finding.job!, assignmentId: 'other' } }, { revision: 3 }, 'r')).rejects.toThrow('foreign or superseded')
  await expect(f.release.prepare({ ...f.finding, job: { ...f.finding.job!, ticketId: 'worker-zzz' } }, { revision: 3 }, 'r')).rejects.toThrow('not available')
  await expect(f.release.prepare({ ...f.finding, reports: [] }, { revision: 3 }, 'r')).rejects.toThrow('ready evidence')
  f.setBusy('PR #5 is merged')
  await expect(f.release.prepare(f.finding, { revision: 3 }, 'r')).rejects.toThrow('in flight')
  f.setBusy(undefined)
  f.ticket.ended = { at: '', by: 'human', outcome: 'dropped' } as Ticket['ended']
  await expect(f.release.prepare(f.finding, { revision: 3 }, 'r')).rejects.toThrow('ended by a person')
  expect(f.calls).toEqual([]); expect(existsSync(join(f.state, 'publication-runner.json'))).toBe(false)
  const g = fixture({ ready: false })
  await expect(g.release.prepare(g.finding, { revision: 3 }, 'r')).rejects.toBeInstanceOf(ReleaseBlocked)
})

it('names a missing worker commit, dirty tree, foreign clone and absent profile concretely, with no GitHub effect', async () => {
  const none = fixture({ commit: false })
  await expect(none.release.prepare(none.finding, { revision: 3 }, 'r')).rejects.toThrow('nothing to review')
  const dirty = fixture(); writeFileSync(join(dirty.work, 'a.txt'), 'dirty\n')
  await expect(dirty.release.prepare(dirty.finding, { revision: 3 }, 'r')).rejects.toThrow('uncommitted')
  const foreign = fixture(); sh(foreign.work, 'remote', 'set-url', 'origin', '/tmp')
  await expect(foreign.release.prepare(foreign.finding, { revision: 3 }, 'r')).rejects.toThrow('not a clone of the trusted project source')
  const noProfile = fixture()
  const bare = new FindingRelease({ stateDir: noProfile.state, profile: () => undefined, store: noProfile.store, ticket: () => noProfile.ticket, publicationBusy: () => undefined, exec: async () => '' })
  await expect(bare.prepare(noProfile.finding, { revision: 3 }, 'r')).rejects.toThrow('release-profile.json')
  for (const x of [none, dirty, foreign]) expect(x.calls).toEqual([])
})

it('refuses to reuse an open PR at another head and a tampered pinned script', async () => {
  const f = fixture()
  const stale = new FindingRelease({ stateDir: f.state, profile: () => f.profile, store: f.store, ticket: () => f.ticket, publicationBusy: () => undefined,
    exec: async c => c.executable === f.profile.ghPath ? JSON.stringify([{ number: 3, headRefOid: 'f'.repeat(40), baseRefName: 'main' }]) : executePublicationCommand(c) })
  await expect(stale.prepare(f.finding, { revision: 3 }, 'r')).rejects.toThrow('not at the reviewed head')
  const g = fixture(); writeFileSync(g.profile.scripts!.verify.path, 'echo evil\n')
  await expect(g.release.prepare(g.finding, { revision: 3 }, 'r')).rejects.toThrow('missing or changed')
  expect(existsSync(join(g.state, 'publication-runner.json'))).toBe(false)
})

it('busyPublication only blocks a merged or running-stage publication, and the profile loads strictly', () => {
  expect(busyPublication(() => ({ publications: { a: { status: 'prepared', prNumber: 1 } } }))).toBeUndefined()
  expect(busyPublication(() => ({ publications: { a: { status: 'merged', prNumber: 1 } } }))).toContain('merged')
  expect(busyPublication(() => ({ publications: { a: { status: 'prepared', prNumber: 1, outcomes: [{ status: 'running' }] } } }))).toContain('PR #1')
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'prof-')))
  expect(loadReleaseProfile(dir)).toBeUndefined()
  writeFileSync(join(dir, 'release-profile.json'), JSON.stringify({ version: 1, extra: 1 }))
  expect(() => loadReleaseProfile(dir)).toThrow()
  expect(readFileSync(join(dir, 'release-profile.json'), 'utf8')).toContain('extra')
})
