import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createPublicationRunner, type PublicationRunnerConfig, type RunnerCommand } from '../src/infra/publication-runner.ts'
import { loadLifecyclePublication } from '../src/app/publication-context.ts'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))
function setup() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'delivery-publication-scope-'))); directories.push(cwd)
  const asset = (name: string, text: string) => { const path = join(cwd, name); writeFileSync(path, text); return { path, sha256: createHash('sha256').update(text).digest('hex') } }
  const patch = asset('release.patch', 'fixture reviewed patch')
  const pins = { repository: 'owner/backend', prNumber: 159, headSha: 'a'.repeat(40), patchSha256: patch.sha256 }
  const refs = [{ repository: pins.repository, pr: pins.prNumber, headSha: pins.headSha, baseSha: 'b'.repeat(40) }, { repository: 'owner/plugins', pr: 160, headSha: 'c'.repeat(40), baseSha: 'd'.repeat(40) }]
  const config: PublicationRunnerConfig = { version: 1, cwd, ghPath: '/usr/local/bin/gh', pins, patch,
    deliveryScope: { environment: 'fixture-desktop', refs, components: ['backend', 'plugins'], effects: ['Rebuild backend and plugin bundles', 'Restart the configured desktop host'] },
    scripts: { apply: asset('apply.sh', 'echo apply'), build: asset('build.sh', 'echo build'), restart: asset('restart.sh', 'echo restart'), verify: asset('verify.sh', 'echo verify'), rollback: asset('rollback.sh', 'echo rollback') } }
  const remote = structuredClone(refs)
  const execute = vi.fn(async (command: RunnerCommand) => {
    if (command.executable === '/bin/bash') return ''
    if (command.args[1] === 'merge') return ''
    const ref = remote.find(r => r.repository === command.args[4] && String(r.pr) === command.args[2])!
    return JSON.stringify({ headRefOid: ref.headSha, baseRefOid: ref.baseSha, state: 'OPEN', reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] })
  })
  return { cwd, config, pins, remote, execute, runner: createPublicationRunner(config, execute) }
}

it('exposes only trusted exact multi-repository target scope and hashes the whole validated manifest', () => {
  const { runner, config } = setup()
  const scope = runner.scopeFor('owner/backend', 159)!
  expect(scope).toMatchObject(config.deliveryScope!)
  expect(scope.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(runner.scopeFor('owner/plugins', 160)).toBeUndefined()
  const changed = createPublicationRunner({ ...config, deliveryScope: { ...config.deliveryScope!, effects: ['Different host restart'] } })
  expect(changed.scopeFor('owner/backend', 159)!.manifestSha256).not.toBe(scope.manifestSha256)
  const changedScript = { ...config, scripts: { ...config.scripts, build: { ...config.scripts.build, sha256: 'e'.repeat(64) } } }
  expect(createPublicationRunner(changedScript).scopeFor('owner/backend', 159)!.manifestSha256).not.toBe(scope.manifestSha256)
  scope.refs[0]!.headSha = 'e'.repeat(40)
  expect(runner.scopeFor('owner/backend', 159)!.refs[0]!.headSha).toBe(config.pins.headSha)
})

it('forwards operator scope through lifecycle integration without creating publication work', () => {
  const { cwd, config } = setup()
  writeFileSync(join(cwd, 'publication-runner.json'), JSON.stringify(config))
  expect(loadLifecyclePublication(cwd).scopeFor!('owner/backend', 159)).toMatchObject({ environment: 'fixture-desktop', components: ['backend', 'plugins'], refs: config.deliveryScope!.refs })
})

it('keeps older manifests usable but never invents feature-delivery scope', async () => {
  const { config, execute, pins } = setup()
  const { deliveryScope: _, ...legacy } = config
  const runner = createPublicationRunner(legacy, execute)
  expect(runner.scopeFor('owner/backend', 159)).toBeUndefined()
  await runner.perform('merge', pins, 'legacy-operation')
  expect(execute).toHaveBeenCalledOnce()
  expect(execute.mock.calls[0]![0].args[1]).toBe('merge')
})

it('checks every repository head and base before evidence and every non-restoration phase', async () => {
  const { runner, pins, execute } = setup()
  await expect(runner.evidence(pins)).resolves.toMatchObject({ checks: 'passed' })
  for (const phase of ['merge', 'apply', 'build', 'restart', 'verify'] as const) {
    execute.mockClear()
    await runner.perform(phase, pins, `operation-${phase}`)
    expect(execute.mock.calls.slice(0, 2).map(([c]) => c.args)).toEqual([
      ['pr', 'view', '159', '--repo', 'owner/backend', '--json', 'headRefOid,baseRefOid'],
      ['pr', 'view', '160', '--repo', 'owner/plugins', '--json', 'headRefOid,baseRefOid'],
    ])
    if (phase !== 'merge') expect(execute.mock.calls[2]![0].env).toMatchObject({ PUBLICATION_MANIFEST_SHA256: runner.scopeFor('owner/backend', 159)!.manifestSha256, PUBLICATION_DELIVERY_SCOPE: expect.stringContaining('fixture-desktop') })
  }
})

it('blocks stale secondary heads before any script or merge but preserves restoration', async () => {
  const { runner, remote, pins, execute } = setup()
  remote[1]!.headSha = 'e'.repeat(40)
  await expect(runner.evidence(pins)).rejects.toThrow('scope changed: owner/plugins#160')
  for (const phase of ['merge', 'apply', 'build', 'restart', 'verify'] as const) {
    execute.mockClear()
    await expect(runner.perform(phase, pins, `operation-${phase}`)).rejects.toThrow('scope changed')
    expect(execute.mock.calls.every(([c]) => c.executable !== '/bin/bash' && c.args[1] !== 'merge')).toBe(true)
  }
  execute.mockClear()
  await runner.perform('rollback', pins, 'restore')
  expect(execute).toHaveBeenCalledOnce()
  expect(execute.mock.calls[0]![0].input).toBe('echo rollback')
})

it('blocks moved secondary base even when head remains unchanged', async () => {
  const { runner, remote, pins, execute } = setup()
  remote[1]!.baseSha = 'e'.repeat(40)
  await expect(runner.perform('apply', pins, 'apply')).rejects.toThrow('scope changed')
  expect(execute.mock.calls.every(([c]) => c.executable !== '/bin/bash')).toBe(true)
})

it('rejects duplicate, unbound and executable scope payloads rather than falling back', () => {
  const { config } = setup()
  expect(() => createPublicationRunner({ ...config, deliveryScope: { ...config.deliveryScope!, refs: [config.deliveryScope!.refs[0]!, config.deliveryScope!.refs[0]!] } })).toThrow('Duplicate')
  expect(() => createPublicationRunner({ ...config, deliveryScope: { ...config.deliveryScope!, refs: [config.deliveryScope!.refs[1]!] } })).toThrow('exact primary')
  expect(() => createPublicationRunner({ ...config, deliveryScope: { ...config.deliveryScope!, command: 'anything' } } as PublicationRunnerConfig)).toThrow()
})
