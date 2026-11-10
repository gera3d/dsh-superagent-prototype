import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicationRunner, executePublicationCommand, loadPublicationRunner, type PublicationRunnerConfig, type RunnerCommand } from '../src/infra/publication-runner.ts'

const directories: string[] = []
afterEach(() => { directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })) })
function setup() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'publication-runner-'))); directories.push(cwd)
  const asset = (name: string, text: string) => { const path = join(cwd, name); writeFileSync(path, text); return { path, sha256: createHash('sha256').update(text).digest('hex') } }
  const patch = asset('release.patch', 'reviewed patch')
  const pins = { repository: 'owner/repo', prNumber: 159, headSha: 'a'.repeat(40), patchSha256: patch.sha256 }
  const config: PublicationRunnerConfig = { version: 1, cwd, ghPath: '/usr/local/bin/gh', pins, patch,
    scripts: { apply: asset('apply.sh', 'echo apply'), build: asset('build.sh', 'echo build'), restart: asset('restart.sh', 'echo restart'), verify: asset('verify.sh', 'echo verify'), rollback: asset('rollback.sh', 'echo rollback') } }
  const response = { headRefOid: pins.headSha, state: 'OPEN', reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }
  const execute = vi.fn(async (_command: RunnerCommand) => JSON.stringify(response))
  const runner = createPublicationRunner(config, execute)
  return { config, pins, execute, runner, response }
}
it('discovers trusted release pins and queries exact GitHub evidence without shell input', async () => {
  const { runner, pins, execute } = setup()
  expect(runner.pinsFor('owner/repo', 159)).toEqual(pins)
  expect(runner.pinsFor('other/repo', 159)).toBeUndefined()
  expect(await runner.evidence(pins)).toMatchObject({ ...pins, checks: 'passed', review: 'approved', mergeable: true, state: 'open' })
  expect(execute.mock.calls[0]![0].args).toEqual(['pr', 'view', '159', '--repo', 'owner/repo', '--json', 'headRefOid,state,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup'])
})
it('merges only the configured exact head, without admin or auto bypass', async () => {
  const { runner, pins, execute } = setup()
  await runner.perform('merge', pins, 'operation-1')
  expect(execute.mock.calls[0]![0].args).toEqual(['pr', 'merge', '159', '--repo', 'owner/repo', '--squash', '--match-head-commit', pins.headSha])
})
it('runs each distinct pinned phase and preserves rollback after apply script corruption', async () => {
  const { runner, pins, execute, config } = setup()
  for (const phase of ['apply', 'build', 'restart', 'verify', 'rollback'] as const) await runner.perform(phase, pins, 'operation-1')
  expect(execute.mock.calls.map(([command]) => command.input)).toEqual(['echo apply', 'echo build', 'echo restart', 'echo verify', 'echo rollback'])
  expect(execute.mock.calls[0]![0]).toMatchObject({ executable: '/bin/bash', args: ['-s', '--'], env: { PUBLICATION_STAGE: 'apply', PUBLICATION_HEAD_SHA: pins.headSha } })
  writeFileSync(config.scripts.apply.path, 'broken')
  await expect(runner.perform('rollback', pins, 'operation-rollback')).resolves.toMatchObject({ detail: expect.stringContaining('rollback completed') })
})
it('rejects changed patches/scripts, foreign pins and unsafe identities before executing', async () => {
  const { runner, config, pins, execute } = setup()
  await expect(runner.perform('merge', { ...pins, headSha: 'b'.repeat(40) }, 'op')).rejects.toThrow('configured release')
  await expect(runner.perform('apply', pins, '$(touch /tmp/unsafe)')).rejects.toThrow('identity')
  writeFileSync(config.scripts.build.path, 'unreviewed')
  await expect(runner.perform('apply', pins, 'op')).rejects.toThrow('asset changed')
  expect(execute).not.toHaveBeenCalled()
})
it('fails closed for missing checks, pending checks, failed checks, missing review and changed heads', async () => {
  const { runner, pins, response } = setup()
  response.statusCheckRollup = []
  expect((await runner.evidence(pins)).checks).toBe('pending')
  response.statusCheckRollup = [{ status: 'IN_PROGRESS', conclusion: '' }]
  expect((await runner.evidence(pins)).checks).toBe('pending')
  response.statusCheckRollup = [{ status: 'COMPLETED', conclusion: 'FAILURE' }]
  response.reviewDecision = ''
  expect(await runner.evidence(pins)).toMatchObject({ checks: 'failed', review: 'required' })
  response.headRefOid = 'b'.repeat(40)
  await expect(runner.evidence(pins)).rejects.toThrow('head changed')
})
it('disables only absent config and rejects arbitrary commands, relative paths and combined scripts', () => {
  const { config } = setup()
  expect(loadPublicationRunner(join(config.cwd, 'absent.json'))).toBeUndefined()
  expect(() => createPublicationRunner({ ...config, command: 'anything' } as PublicationRunnerConfig)).toThrow()
  expect(() => createPublicationRunner({ ...config, ghPath: 'gh' })).toThrow()
  expect(() => createPublicationRunner({ ...config, scripts: { ...config.scripts, build: config.scripts.apply } })).toThrow('distinct script')
})
it('propagates subprocess failures without automatically restarting or rolling back', async () => {
  const { config, pins } = setup()
  const execute = vi.fn(async () => { throw new Error('stub failure') })
  const runner = createPublicationRunner(config, execute)
  await expect(runner.perform('apply', pins, 'op')).rejects.toThrow('stub failure')
  expect(execute).toHaveBeenCalledTimes(1)
})

it('kills a timeout process group including descendants before returning', async () => {
  const { config } = setup()
  const marker = join(config.cwd, 'descendant-survived')
  const started = Date.now()
  await expect(executePublicationCommand({ executable: '/bin/bash', args: ['-s'], cwd: config.cwd, timeoutMs: 100,
    input: `trap '' TERM\n(sleep 0.6; printf unsafe > '${marker}') &\nwait\n` })).rejects.toThrow('timed out')
  expect(Date.now() - started).toBeGreaterThanOrEqual(300)
  // A second harmless command provides the late-write observation interval.
  await executePublicationCommand({ executable: '/bin/bash', args: ['-c', 'sleep 0.4'], cwd: config.cwd, timeoutMs: 2000 })
  expect(existsSync(marker)).toBe(false)
})

it('journals process group before releasing command and rejects journal failure without mutation', async () => {
  const { config } = setup()
  const marker = join(config.cwd, 'must-not-execute')
  let observedPid = 0
  await expect(executePublicationCommand({ executable: '/bin/bash', args: ['-c', `printf unsafe > '${marker}'`], cwd: config.cwd, timeoutMs: 2000,
    onSpawn(pid) { observedPid = pid; expect(existsSync(marker)).toBe(false); throw new Error('durable journal unavailable') } })).rejects.toThrow('journal failed')
  expect(observedPid).toBeGreaterThan(0)
  expect(existsSync(marker)).toBe(false)
})
it('honors pre-abort without spawning and settles an aborted descendant group', async () => {
  const { config } = setup()
  const preaborted = new AbortController(); preaborted.abort()
  const onSpawn = vi.fn()
  await expect(executePublicationCommand({ executable: '/bin/echo', args: ['unused'], cwd: config.cwd, timeoutMs: 2000, signal: preaborted.signal, onSpawn })).rejects.toThrow('before spawn')
  expect(onSpawn).not.toHaveBeenCalled()
  const controller = new AbortController()
  const marker = join(config.cwd, 'aborted-descendant-survived')
  const timer = setTimeout(() => controller.abort(), 100)
  try {
    await expect(executePublicationCommand({ executable: '/bin/bash', args: ['-s'], cwd: config.cwd, timeoutMs: 3000, signal: controller.signal,
      input: `trap '' TERM\n(sleep 0.6; printf unsafe > '${marker}') &\nwait\n` })).rejects.toThrow('aborted')
  } finally { clearTimeout(timer) }
  await executePublicationCommand({ executable: '/bin/bash', args: ['-c', 'sleep 0.4'], cwd: config.cwd, timeoutMs: 2000 })
  expect(existsSync(marker)).toBe(false)
})

function localProofFixture() {
  const fixture = setup()
  const reportPath = join(fixture.config.cwd, 'independent-review.log')
  writeFileSync(reportPath, 'Actual fixture review evidence: approved after inspecting fixture diff. Not a production review.')
  const report = { path: reportPath, sha256: createHash('sha256').update(readFileSync(reportPath)).digest('hex') }
  const proof = { version: 1, pins: { ...fixture.pins }, author: 'fixture-worker', reviewer: { name: 'fixture-independent-reviewer', role: 'independent' },
    review: { verdict: 'approved', completedAt: new Date().toISOString(), report },
    checks: [{ name: 'fixture-check', exitCode: 0, completedAt: new Date().toISOString(), report }], limitations: ['Fixture only; not deployment acceptance'] }
  const path = join(fixture.config.cwd, 'local-evidence.json')
  const runner = () => {
    writeFileSync(path, JSON.stringify(proof))
    fixture.config.localEvidence = { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
    return createPublicationRunner(fixture.config, fixture.execute)
  }
  return { ...fixture, proof, reportPath, runner }
}
it('uses pinned independent local proof only when hosted checks/review are absent', async () => {
  const fixture = localProofFixture()
  fixture.response.statusCheckRollup = []
  fixture.response.reviewDecision = ''
  expect(await fixture.runner().evidence(fixture.pins)).toMatchObject({ checks: 'passed', review: 'approved', local: {
    reviewer: 'fixture-independent-reviewer', reportSha256: fixture.proof.review.report.sha256,
    checks: [{ name: 'fixture-check' }], limitations: ['Fixture only; not deployment acceptance'] } })
})
it('exposes bounded sanitized excerpts from the same hash-verified review and check bytes', async () => {
  const fixture = localProofFixture()
  fixture.response.statusCheckRollup = []; fixture.response.reviewDecision = ''
  const rawReview = '\u001b[31mActual fixture review: inspected diff, no blocker.\u001b[0m\u0000\n' + 'r'.repeat(7000)
  const rawCheck = '\u001b[32mActual fixture check output: tests passed.\u001b[0m\n' + 'c'.repeat(3000)
  writeFileSync(fixture.reportPath, rawReview)
  fixture.proof.review.report.sha256 = createHash('sha256').update(rawReview).digest('hex')
  const checkPath = join(fixture.config.cwd, 'check-output.log'); writeFileSync(checkPath, rawCheck)
  fixture.proof.checks[0]!.report = { path: checkPath, sha256: createHash('sha256').update(rawCheck).digest('hex') }
  const local = (await fixture.runner().evidence(fixture.pins)).local!
  expect(local.reportSha256).toBe(createHash('sha256').update(rawReview).digest('hex'))
  expect(local.reviewExcerpt).toBe(('Actual fixture review: inspected diff, no blocker.\n' + 'r'.repeat(7000)).slice(0, 6000))
  expect(local.reviewExcerpt).toHaveLength(6000)
  expect(local.checks[0]).toMatchObject({ reportSha256: createHash('sha256').update(rawCheck).digest('hex'), outputExcerpt: ('Actual fixture check output: tests passed.\n' + 'c'.repeat(3000)).slice(0, 2000) })
  expect(local.checks[0]!.outputExcerpt).toHaveLength(2000)
  expect(local.reviewExcerpt).not.toMatch(/[\u001b\u0000]/)
  expect(local.checks[0]!.outputExcerpt).not.toContain('\u001b')
})
it('never lets local proof override failed or pending hosted checks or requested changes', async () => {
  const fixture = localProofFixture()
  fixture.response.reviewDecision = ''
  fixture.response.statusCheckRollup = [{ status: 'COMPLETED', conclusion: 'FAILURE' }]
  expect((await fixture.runner().evidence(fixture.pins)).checks).toBe('failed')
  fixture.response.statusCheckRollup = [{ status: 'IN_PROGRESS', conclusion: '' }]
  expect((await fixture.runner().evidence(fixture.pins)).checks).toBe('pending')
  fixture.response.statusCheckRollup = []
  fixture.response.reviewDecision = 'CHANGES_REQUESTED'
  expect((await fixture.runner().evidence(fixture.pins)).review).toBe('changes_requested')
})
it('rejects stale, nonindependent, mismatched and tampered local evidence', async () => {
  const fixture = localProofFixture()
  fixture.response.reviewDecision = ''
  const original = fixture.proof.review.completedAt
  fixture.proof.review.completedAt = new Date(Date.now() - 86400001).toISOString()
  await expect(fixture.runner().evidence(fixture.pins)).rejects.toThrow('stale')
  fixture.proof.review.completedAt = original
  fixture.proof.reviewer.name = fixture.proof.author
  await expect(fixture.runner().evidence(fixture.pins)).rejects.toThrow('reviewer mismatch')
  fixture.proof.reviewer.name = 'fixture-independent-reviewer'
  fixture.proof.pins.headSha = 'b'.repeat(40)
  await expect(fixture.runner().evidence(fixture.pins)).rejects.toThrow('binding')
  fixture.proof.pins.headSha = fixture.pins.headSha
  const runner = fixture.runner()
  writeFileSync(fixture.reportPath, 'replaced report')
  await expect(runner.evidence(fixture.pins)).rejects.toThrow('asset changed')
})

function vitestReport(root: string) {
  return { success: false, numTotalTests: 2, numFailedTests: 1, numPassedTests: 1,
    testResults: [{ name: `${root}/tests/example.spec.ts`, status: 'failed', message: '', assertionResults: [
      { fullName: 'previously passing test', status: 'passed', failureMessages: [] as string[] },
      { fullName: 'known assertion failure', status: 'failed', failureMessages: [`AssertionError: exact failure at ${root}/tests/example.spec.ts:10`] },
    ] }] }
}
it.each(['unchanged', 'fixed', 'new-failure', 'changed-error', 'missing-test', 'pass-skipped', 'failure-skipped', 'unhandled', 'incomplete', 'duplicate'])('strict baseline comparator: %s', async scenario => {
  const { config } = setup()
  const baselineRoot = join(config.cwd, 'original-root'), currentRoot = join(config.cwd, 'candidate-root')
  const baseline = vitestReport(baselineRoot), current = vitestReport(currentRoot)
  const tests = current.testResults[0]!.assertionResults
  const errors = { reason: 'failed', unhandledErrors: [] as { name: string }[] }
  if (scenario === 'fixed') { tests[1]!.status = 'passed'; tests[1]!.failureMessages = [] }
  if (scenario === 'new-failure') { tests[0]!.status = 'failed'; tests[0]!.failureMessages = ['new regression'] }
  if (scenario === 'changed-error') tests[1]!.failureMessages = ['different failure under same test name']
  if (scenario === 'missing-test') tests.shift()
  if (scenario === 'pass-skipped') tests[0]!.status = 'pending'
  if (scenario === 'failure-skipped') tests[1]!.status = 'pending'
  if (scenario === 'unhandled') errors.unhandledErrors.push({ name: 'UnhandledError' })
  if (scenario === 'duplicate') tests.push({ ...tests[0]! })
  current.numTotalTests = tests.length; current.numFailedTests = tests.filter(test => test.status === 'failed').length; current.numPassedTests = tests.filter(test => test.status === 'passed').length
  current.success = current.numFailedTests === 0; current.testResults[0]!.status = current.success ? 'passed' : 'failed'
  if (scenario === 'incomplete') current.numTotalTests++
  const input = join(config.cwd, 'comparison.json')
  writeFileSync(input, JSON.stringify({ baseline, current, baselineRoot, currentRoot, errors, exitCode: Number(!current.success) }))
  const code = `import json,runpy,sys\nv=json.load(open(sys.argv[2]))\nf=runpy.run_path(sys.argv[1])['compare_reports']\ntry:\n print(json.dumps(f(v['baseline'],v['current'],v['baselineRoot'],v['currentRoot'],v['exitCode'],v['errors'])))\nexcept Exception as error:\n print(json.dumps({'error':str(error)}))\n`
  const output = JSON.parse(await executePublicationCommand({ executable: '/usr/bin/python3', args: ['-c', code, fileURLToPath(new URL('../scripts/publication/baseline.py', import.meta.url)), input], cwd: config.cwd, timeoutMs: 5000 }))
  if (['unchanged', 'fixed'].includes(scenario)) expect(output).toMatchObject({ knownFailures: scenario === 'fixed' ? 0 : 1, total: 2 })
  else expect(output.error).toBeTruthy()
})

async function phaseFixture(serveWrongRelease = false, useBaseline = false) {
  const { config, pins } = setup()
  const target = join(config.cwd, 'target'); mkdirSync(target)
  writeFileSync(join(target, 'file.txt'), 'base\nlocal customization\n')
  writeFileSync(join(target, 'unrelated.txt'), 'unrelated dirty changes\n')
  const patch = 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n-base\n+deployed\n local customization\n'
  writeFileSync(config.patch.path, patch)
  pins.patchSha256 = config.patch.sha256 = createHash('sha256').update(patch).digest('hex')
  const log = join(config.cwd, 'fixture-commands.log')
  const pnpmPath = join(config.cwd, 'pnpm-stub')
  const restartPath = join(config.cwd, 'restart-stub')
  writeFileSync(pnpmPath, `#!/bin/sh\n[ \"$1\" = --config.verify-deps-before-run=false ] || exit 9\nshift\nprintf 'pnpm %s\\n' "$*" >> '${log}'\n`); chmodSync(pnpmPath, 0o755)
  writeFileSync(restartPath, `#!/bin/sh\nprintf 'fixture-only %s\\n' "$*" >> '${log}'\n`); chmodSync(restartPath, 0o755)
  const server = createServer((_request, response) => { response.end(serveWrongRelease ? 'old listener without release identity' : `fixture release marker ${pins.headSha}`) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const asset = (path: string) => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })
  const runnerPath = join(config.cwd, 'publication-runner.py')
  copyFileSync(fileURLToPath(new URL('../scripts/publication/runner.py', import.meta.url)), runnerPath)
  const planPath = join(config.cwd, 'publication-plan.json')
  const baselineDependencies: {path:string;sha256:string}[] = []
  let baselineReport: {path:string;sha256:string;baselineHead:string;root:string}|undefined
  if (useBaseline) {
    const report = vitestReport(target), baselinePath = join(config.cwd, 'baseline-report.json')
    writeFileSync(baselinePath, JSON.stringify(report))
    for (const [source, destination] of [['baseline.py', 'publication-baseline.py'], ['errors-reporter.cjs', 'publication-errors-reporter.cjs']]) {
      const path = join(config.cwd, destination!)
      copyFileSync(fileURLToPath(new URL(`../scripts/publication/${source}`, import.meta.url)), path)
      baselineDependencies.push(asset(path))
    }
    baselineDependencies.push(asset(baselinePath))
    baselineReport = { ...asset(baselinePath), baselineHead: 'c'.repeat(40), root: target }
    writeFileSync(pnpmPath, `#!/usr/bin/python3\nimport json,os,sys\nargs=sys.argv[1:]\nassert args.pop(0)=='--config.verify-deps-before-run=false'\nwith open(${JSON.stringify(log)},'a') as f: f.write('pnpm '+args[0]+'\\n')\nif args[0]=='exec':\n report=json.loads(${JSON.stringify(JSON.stringify(report))})\n output=next(a.split('=',1)[1] for a in args if a.startswith('--outputFile='))\n with open(output,'w') as f: json.dump(report,f)\n with open(os.environ['PUBLICATION_ERRORS_REPORT'],'w') as f: json.dump({'reason':'failed','unhandledErrors':[]},f)\n sys.exit(1)\n`)
  }
  writeFileSync(planPath, JSON.stringify({ version: 1, repository: pins.repository, headSha: pins.headSha, patchSha256: pins.patchSha256,
    target, pnpmPath, restartScript: asset(restartPath), verifyUrl: `http://127.0.0.1:${address.port}/health`, verifyContains: `fixture release marker ${pins.headSha}`, ...(baselineReport ? {baselineReport}: {}) }))
  for (const stage of ['apply', 'build', 'restart', 'verify', 'rollback'] as const) {
    copyFileSync(fileURLToPath(new URL(`../scripts/publication/${stage}.sh`, import.meta.url)), config.scripts[stage].path)
    config.scripts[stage] = { ...asset(config.scripts[stage].path), dependencies: [asset(runnerPath), asset(planPath), asset(restartPath), asset(pnpmPath), ...baselineDependencies] }
  }
  const runner = createPublicationRunner(config, async command => {
    const diagnostic = join(config.cwd, 'fixture-diagnostic.log')
    try { return await executePublicationCommand({ ...command, input: command.input?.replace(/(exec \/usr\/bin\/python3[^\n]+)/, `$1 2>'${diagnostic}'`) }) }
    catch (error) { throw new Error(`${error instanceof Error ? error.message : error}: ${existsSync(diagnostic) ? readFileSync(diagnostic, 'utf8') : ''}`) }
  })
  const phase = (stage: 'apply'|'build'|'restart'|'verify'|'rollback') => runner.perform(stage, pins, `12345678-1234-1234-1234-123456789abc:${stage}`)
  return { target, log, phase, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}
it('executes all checked-in phases against a disposable operator fixture and restores dirty preimages', async () => {
  const fixture = await phaseFixture()
  try {
    for (const phase of ['apply', 'build', 'restart', 'verify'] as const) await fixture.phase(phase)
    expect(readFileSync(join(fixture.target, 'file.txt'), 'utf8')).toBe('deployed\nlocal customization\n')
    await fixture.phase('rollback')
    expect(readFileSync(join(fixture.target, 'file.txt'), 'utf8')).toBe('base\nlocal customization\n')
    expect(readFileSync(join(fixture.target, 'unrelated.txt'), 'utf8')).toBe('unrelated dirty changes\n')
    expect(readFileSync(fixture.log, 'utf8')).toBe('pnpm build\npnpm test\nfixture-only restart\npnpm build\npnpm test\nfixture-only restart\n')
  } finally { await fixture.close() }
}, 30000)
it('builds and rolls back with only exact known assertion failures using pinned full reports', async () => {
  const fixture = await phaseFixture(false, true)
  try {
    await fixture.phase('apply')
    await fixture.phase('build')
    await fixture.phase('rollback')
    expect(readFileSync(join(fixture.target, 'file.txt'), 'utf8')).toBe('base\nlocal customization\n')
    expect(readFileSync(fixture.log, 'utf8')).toBe('pnpm build\npnpm exec\npnpm build\npnpm exec\n')
  } finally { await fixture.close() }
}, 30000)
it.each([undefined, 1000, 300000, 900000])('prepares a strict hash-pinned release and propagates timeout %s without applying it', async timeoutMs => {
  const { config, pins } = setup()
  const gh = join(config.cwd, 'gh-stub')
  writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' '{"headRefOid":"${pins.headSha}","state":"OPEN"}'\n`); chmodSync(gh, 0o755)
  const target = join(config.cwd, 'untouched-target'); mkdirSync(target)
  const release = join(config.cwd, 'prepared-release')
  await executePublicationCommand({ executable: '/usr/bin/python3', args: [fileURLToPath(new URL('../scripts/publication/prepare.py', import.meta.url)),
    '--repository', pins.repository, '--pr', String(pins.prNumber), '--patch', config.patch.path, '--target', target,
    '--release-dir', release, '--gh', gh, '--pnpm', '/bin/echo', '--restart-script', '/bin/echo', '--verify-url', 'http://127.0.0.1:3082/health', '--verify-contains', pins.headSha, ...(timeoutMs === undefined ? [] : ['--timeout-ms', String(timeoutMs)])], cwd: config.cwd, timeoutMs: 10000 })
  const manifest = JSON.parse(readFileSync(join(release, 'publication-runner.json'), 'utf8')) as PublicationRunnerConfig
  expect(manifest.timeoutMs).toBe(timeoutMs ?? 600000)
  const execute = vi.fn(async (_command: RunnerCommand) => '')
  await createPublicationRunner(manifest, execute).perform('build', pins, 'fixture-timeout')
  expect(execute.mock.calls[0]![0].timeoutMs).toBe(timeoutMs ?? 600000)
  const prepared = loadPublicationRunner(join(release, 'publication-runner.json'))
  expect(prepared?.pinsFor(pins.repository, pins.prNumber)).toEqual(pins)
  expect(existsSync(join(release, 'publication-ledgers'))).toBe(false)
}, 15000)
it.each([-1, 0, 999, 900001])('rejects preparation timeout outside supported bounds: %s', async timeout => {
  const { config } = setup()
  const script = fileURLToPath(new URL('../scripts/publication/prepare.py', import.meta.url))
  const args = ['--repository','owner/repo','--pr','159','--patch','/not-needed','--target','/not-needed','--release-dir','/not-needed','--gh','/not-needed','--pnpm','/not-needed','--restart-script','/not-needed','--verify-url','http://127.0.0.1/','--verify-contains','not-needed','--timeout-ms',String(timeout)]
  const code = `import json,runpy,sys\nscript=sys.argv[1]\nargs=json.loads(sys.argv[2])\nmain=runpy.run_path(script)['main']\nsys.argv=[script]+args\ntry:\n main()\nexcept RuntimeError as error:\n print(str(error))\n`
  const output = await executePublicationCommand({ executable: '/usr/bin/python3', args: ['-c', code, script, JSON.stringify(args)], cwd: config.cwd, timeoutMs: 5000 })
  expect(output.trim()).toBe('Publication timeout must be between 1000 and 900000 milliseconds')
})
it.each([
  ['ordinary source', '+Document the deleted file mode guard.', false],
  ['own guard literals', "+if any(marker in text for marker in ['GIT binary patch', 'rename from ', 'rename to ', 'deleted file mode ', 'old mode ', 'new mode ', 'Binary files ']):", false],
  ['context literal', ' GIT binary patch', false],
  ['removed source literal', '-rename from ordinary text', false],
  ['binary metadata', 'GIT binary patch', true],
  ['binary-files metadata', 'Binary files a/example.txt and b/example.txt differ', true],
  ['rename-from metadata', 'rename from example.txt', true],
  ['rename-to metadata', 'rename to other.txt', true],
  ['deletion metadata', 'deleted file mode 100644', true],
  ['old-mode metadata', 'old mode 100644', true],
  ['new-mode metadata', 'new mode 100755', true],
] as const)('patch parser distinguishes %s from actual metadata', async (_label, line, rejected) => {
  const { config } = setup()
  const context = !rejected && line.startsWith(' ')
  const hunk = rejected ? '-before\n+after' : context ? `${line}\n-before\n+after` : line.startsWith('-') ? `${line}\n+after` : `-before\n${line}`
  const patch = `diff --git a/example.txt b/example.txt\n${rejected ? line + '\n' : ''}--- a/example.txt\n+++ b/example.txt\n${context ? '@@ -1,2 +1,2 @@' : '@@ -1 +1 @@'}\n${hunk}\n`
  const code = `import json,runpy,sys\nf=runpy.run_path(sys.argv[1])['patch_names']\ntry:\n print(json.dumps({'names':f(sys.argv[2].encode())}))\nexcept RuntimeError as error:\n print(json.dumps({'error':str(error)}))\n`
  const output = JSON.parse(await executePublicationCommand({ executable: '/usr/bin/python3', args: ['-c', code, fileURLToPath(new URL('../scripts/publication/runner.py', import.meta.url)), patch], cwd: config.cwd, timeoutMs: 5000 }))
  if (rejected) expect(output.error).toContain('Unsupported patch kind')
  else {
    expect(output.names).toEqual(['example.txt'])
    writeFileSync(join(config.cwd, 'example.txt'), context ? `${line.slice(1)}\nbefore\n` : line.startsWith('-') ? `${line.slice(1)}\n` : 'before\n')
    // Prove accepted source literals form a real applicable text patch, not only parser input.
    await executePublicationCommand({ executable: '/usr/bin/git', args: ['apply', '--check', '-p1', '-'], input: patch, cwd: config.cwd, timeoutMs: 5000 })
  }
})
it('rejects a healthy old HTTP listener without the exact release identity', async () => {
  const fixture = await phaseFixture(true)
  try {
    for (const stage of ['apply', 'build', 'restart'] as const) await fixture.phase(stage)
    await expect(fixture.phase('verify')).rejects.toThrow('verification marker absent')
  } finally { await fixture.close() }
}, 30000)
it('refuses rollback that would overwrite post-apply operator edits', async () => {
  const fixture = await phaseFixture()
  try {
    await fixture.phase('apply')
    writeFileSync(join(fixture.target, 'file.txt'), 'new operator edit\n')
    await expect(fixture.phase('rollback')).rejects.toThrow('Publication command failed')
    expect(readFileSync(join(fixture.target, 'file.txt'), 'utf8')).toBe('new operator edit\n')
  } finally { await fixture.close() }
})
