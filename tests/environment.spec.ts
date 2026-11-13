import { execFile, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SENSITIVE_ENV_PATTERN, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { GIT_LOCATION, agentVariables, credentialHelper, runAsWorker, verifyDirectory, withoutDirectory, workerBin, workerGitConfig, writeEnvironment }
  from '../src/infra/environment.ts'
import { CliError } from '../src/infra/commands.ts'
import { ghCallsDir, hourlyCalls, readTicketCalls } from '../src/infra/gh-calls.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

// Git and shell subprocesses can exceed the 5s default timeout when the test suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
let dir: string
const program = (path: string, body: string): string => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path }
/** Worker shell environment after DSH strips credential-shaped variables. */
const workerEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !SENSITIVE_ENV_PATTERN.test(entry[0])))
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'environment-')); mkdirSync(join(dir, 'real')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('worker shims', () => {
  it('run a wrapper that calls `gh` by name without reaching the shim again, and keep the caller\'s other PATH entries', async () => {
    const real = program(join(dir, 'real', 'gh'), 'echo "{\\"login\\":\\"agent-bot\\",\\"config\\":\\"$GH_CONFIG_DIR\\",\\"path\\":\\"$PATH\\"}"')
    const called = join(dir, 'wrapper-called')
    const wrapper = program(join(dir, 'gh-agent'), `if [ -e "${called}" ]; then echo 'worker shim recursively re-entered wrapper' >&2; exit 97; fi
printf called > "${called}"
GH_CONFIG_DIR=${dir}/agent-config exec gh "$@"`)
    // Prepare only the fake deployment CLIs, never the generated worker shim under test. On this host,
    // fresh scripts launch much more slowly; charging all three cold launches to one deadline obscures recursion.
    const localPath = [join(dir, 'real'), '/usr/bin', '/bin'].join(':')
    for (const cli of [real, wrapper]) await exec(cli, ['api', 'user'], { env: { PATH: localPath }, timeout: 10_000 })
    rmSync(called) // The actual worker invocation must enter the wrapper exactly once, independently of fixture preparation.
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: wrapper }, feishu: undefined }), [])
    const bin = workerBin(dir)
    const path = [bin, join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin'].join(':')
    const { stdout } = await exec('gh', ['api', 'user'], { env: { PATH: path }, timeout: 10_000 })
    expect(readFileSync(called, 'utf8')).toBe('called')
    expect(JSON.parse(stdout)).toEqual({ login: 'agent-bot', config: `${dir}/agent-config`, path: [join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin'].join(':') })
  })
  it('make `lark-cli` fail without a Feishu bot and each blocked command fail with the agent\'s login', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ['personal-gh'])
    const bin = workerBin(dir)
    await expect(exec(join(bin, 'lark-cli'), ['im', '+chat-list'])).rejects.toMatchObject({ code: 1, stderr: 'lark-cli is unavailable: this installation has no Feishu bot.\n' })
    await expect(exec(join(bin, 'personal-gh'), [])).rejects.toMatchObject({ code: 1, stderr: 'personal-gh is blocked in this installation; use gh, which acts as agent-bot.\n' })
  })
  it('keep `gh` and `lark-cli` working, and shim no `git`, when the blocked commands name the commands workers need', async () => {
    const gh = program(join(dir, 'gh-agent'), 'echo gh "$@"'), lark = program(join(dir, 'lark-bot'), 'echo lark "$@"')
    const base = testDeployment()
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...base.github, cli: gh }, feishu: { ...base.feishu!, cli: lark } }), ['gh', 'git', 'lark-cli'])
    const bin = workerBin(dir)
    expect([(await exec(join(bin, 'gh'), ['api', 'user'])).stdout, (await exec(join(bin, 'lark-cli'), ['im'])).stdout]).toEqual(['gh api user\n', 'lark im\n'])
    expect(readdirSync(bin)).not.toContain('git')
  })
  it('replace only what dsh-superagent wrote and refuse anything else in its places', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli'])
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh', 'lark-cli', 'orchestrator_report'])
    // A file that merely contains the marker on a later line, a symlink to a shim, and a foreign gitconfig are all rejected.
    writeFileSync(join(workerBin(dir), 'notes'), `notes\nmore\n${readFileSync(join(workerBin(dir), 'gh'), 'utf8').split('\n')[1]}\n`)
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${join(workerBin(dir), 'notes')} was not written by dsh-superagent`)
    rmSync(join(workerBin(dir), 'notes'))
    symlinkSync(join(workerBin(dir), 'gh'), join(workerBin(dir), 'link'))
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow('link was not written by dsh-superagent')
    rmSync(join(workerBin(dir), 'link'))
    writeFileSync(workerGitConfig(dir), '[user]\n\tname = someone\n')
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${workerGitConfig(dir)} was not written by dsh-superagent`)
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toBe('[user]\n\tname = someone\n')
  })
  it('replaces the files it wrote under the project\'s earlier names', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli', 'older-cli'])
    const legacy = (file: string, name: string) => writeFileSync(file, readFileSync(file, 'utf8').replace('Written by dsh-superagent', `Written by ${name}`))
    legacy(join(workerBin(dir), 'old-cli'), 'dsh-tag'); legacy(join(workerBin(dir), 'older-cli'), 'dsh-freelancer'); legacy(workerGitConfig(dir), 'dsh-go')
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh', 'lark-cli', 'orchestrator_report'])
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('Written by dsh-superagent')
  })
  it('records worker reports via orchestrator_report shim flags and json arguments', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    const bin = workerBin(dir)
    const workDir = join(dir, 'work-dir')
    mkdirSync(workDir, { recursive: true })
    const { stdout } = await exec(join(bin, 'orchestrator_report'), ['--state', 'ready', '--summary', 'Work is verified and ready'], { env: { PATH: process.env.PATH, DSH_SUPERAGENT_DIR: workDir, DSH_SUPERAGENT_TICKET: 'ticket-123' } })
    expect(stdout).toContain('Report recorded for delivery: state=ready')
    const recorded = JSON.parse(readFileSync(join(workDir, '.dsh-report.json'), 'utf8'))
    expect(recorded).toMatchObject({ state: 'ready', summary: 'Work is verified and ready', ticket_id: 'ticket-123' })

    const jsonPayload = JSON.stringify({ state: 'blocked', summary: 'Blocked on credentials' })
    const { stdout: jsonOut } = await exec(join(bin, 'orchestrator_report'), [jsonPayload], { env: { PATH: process.env.PATH, DSH_SUPERAGENT_DIR: workDir } })
    expect(jsonOut).toContain('Report recorded for delivery: state=blocked')
    const jsonRecorded = JSON.parse(readFileSync(join(workDir, '.dsh-report.json'), 'utf8'))
    expect(jsonRecorded).toMatchObject({ state: 'blocked', summary: 'Blocked on credentials' })
  })
})

describe('the gh call counter', () => {
  const TICKET = 'ticket-123'
  const SECRETS = ['ghp_SECRET1', 'ghp_SECRET2', 'ghp_SECRET3', 'ghp_SECRET4', 'ghp_SECRET5', 'Bearer', 'Authorization', 'body=']
  const gh = async (args: string[], ticket: string | null = TICKET) => {
    const env: Record<string, string> = { PATH: [workerBin(dir), '/usr/bin', '/bin'].join(':'), ...ticket === null ? {} : { DSH_SUPERAGENT_TICKET: ticket } }
    return exec(join(workerBin(dir), 'gh'), args, { env, timeout: 10_000 })
  }
  const deployment = () => testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: join(dir, 'real', 'gh') }, feishu: undefined })
  const prepare = async (body = 'echo real "$@"') => { program(join(dir, 'real', 'gh'), body); await writeEnvironment(deployment(), []) }
  const lines = () => readFileSync(join(ghCallsDir(dir), TICKET), 'utf8').split('\n').filter(Boolean).map(line => line.split('\t'))

  it('writes one line per call, with the date and hour and the subcommand only, and still runs the real gh', async () => {
    await prepare()
    const before = new Date().toISOString().slice(0, 13)
    expect((await gh(['pr', 'view', '12', '--json', 'title'])).stdout).toBe('real pr view 12 --json title\n')
    await gh(['issue', 'comment', '5', '--body', 'ghp_SECRET5'])
    await gh(['ghp_SECRET4', 'foo'])
    await gh(['pr', 'ghp_SECRET3'])
    await gh([])
    const rows = lines()
    expect(rows.map(row => row.slice(1))).toEqual([['pr', 'view'], ['issue', 'comment'], ['other', ''], ['pr', ''], ['other', '']])
    for (const [hour] of rows) expect([before, new Date().toISOString().slice(0, 13)]).toContain(hour)
    expect(readFileSync(join(ghCallsDir(dir), TICKET), 'utf8')).not.toMatch(/SECRET/)
  })
  it('records `gh api` endpoints with the owner, repository, users and numbers masked, and never flags, bodies, headers or queries', async () => {
    await prepare()
    await gh(['api', 'repos/gera3d/superagent-sandbox/issues/204/comments?per_page=5&access=ghp_SECRET1', '--cache', '60s', '-H', 'Authorization: token ghp_SECRET1', '-f', 'body=ghp_SECRET2'])
    await gh(['api', '-X', 'POST', '/repos/o/r/pulls/12/comments/345/replies', '-f', 'body=Bearer ghp_SECRET3'])
    await gh(['api', 'https://api.github.com/user', '--jq', '.login'])
    await gh(['api', '--paginate', 'rate_limit'])
    await gh(['api', 'users/bob/repos'])
    await gh(['api', 'orgs/acme/members'])
    await gh(['api', 'repos/o/r/git/ref/heads/agent/gh-call-counting-4c15fb9c193a'])
    await gh(['api', '--method=GET', 'repos/o/r/commits/ABCDEF0123'])
    await gh(['api', 'ghp_SECRET4'])
    await gh(['api', '--input', '-', '--', 'graphql'])
    await gh(['api'])
    expect(lines().map(row => row.slice(1).join(' '))).toEqual([
      'api repos/:o/:r/issues/:n/comments', 'api repos/:o/:r/pulls/:n/comments/:n/replies', 'api user', 'api rate_limit', 'api users/:u/repos',
      'api orgs/:o/members', 'api repos/:o/:r/git/ref/heads/agent/:x', 'api repos/:o/:r/commits/:x', 'api :x', 'api graphql', 'api ',
    ])
    const text = readFileSync(join(ghCallsDir(dir), TICKET), 'utf8')
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret)
    expect(text).not.toMatch(/gera3d|sandbox|per_page|204|bob|acme/)
  })
  it('counts nothing without a safe ticket id, and never changes the exit status or output of gh, even when the counter cannot be written', async () => {
    await prepare('echo "out $1"; echo "err $1" >&2; exit 7')
    const failure = (error: unknown) => error as { code: number; stdout: string; stderr: string }
    expect(await gh(['pr'], null).catch(failure)).toMatchObject({ code: 7, stdout: 'out pr\n', stderr: 'err pr\n' })
    for (const ticket of ['../escape', 'a b']) await gh(['pr'], ticket).catch(failure)
    await gh(['pr'], 'other-ticket').catch(failure)
    expect(readdirSync(ghCallsDir(dir))).toEqual(['other-ticket'])
    rmSync(ghCallsDir(dir), { recursive: true })
    writeFileSync(ghCallsDir(dir), 'not a directory')
    expect(await gh(['pr']).catch(failure)).toMatchObject({ code: 7, stdout: 'out pr\n', stderr: 'err pr\n' })
  })
  it('keeps the shims atomic while they are rewritten and still blocks blocked commands', async () => {
    await prepare()
    const rewrite = async () => { for (let i = 0; i < 5; i++) await writeEnvironment(deployment(), ['personal-gh']) }
    const calls = async () => { const outputs: string[] = []; for (let i = 0; i < 15; i++) outputs.push((await gh(['api', 'user'])).stdout); return outputs }
    const [, outputs] = await Promise.all([rewrite(), calls()])
    expect(outputs).toEqual(Array(15).fill('real api user\n'))
    expect(readdirSync(workerBin(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
    const blocked = await exec(join(workerBin(dir), 'personal-gh'), []).catch((error: unknown) => error as { code: number; stderr: string })
    expect(blocked).toMatchObject({ code: 1, stderr: expect.stringContaining('personal-gh is blocked in this installation') })
    expect(readdirSync(ghCallsDir(dir))).toEqual([TICKET])
  })
  it('reads a ticket\'s counter back by hour and command, and sums the current hour across tickets', async () => {
    const now = new Date('2026-11-13T15:30:00Z')
    mkdirSync(ghCallsDir(dir))
    const file = (name: string, text: string, modified = now) => { writeFileSync(join(ghCallsDir(dir), name), text); utimesSync(join(ghCallsDir(dir), name), modified, modified) }
    file('a', ['2026-11-13T14\tpr\tview', '2026-11-13T15\tapi\trepos/:o/:r', '2026-11-13T15\tpr\tview', 'garbage', '2026-11-13T15\tpr\tview', ''].join('\n'))
    file('b', '2026-11-13T15\tapi\t\n')
    file('old', '2026-11-13T15\tapi\t\n', new Date('2026-11-12T00:00:00Z'))
    expect(await readTicketCalls(dir, 'a')).toEqual({ total: 4, hours: [{ hour: '2026-11-13T14', count: 1 }, { hour: '2026-11-13T15', count: 3 }],
      commands: [{ name: 'pr view', count: 3 }, { name: 'api repos/:o/:r', count: 1 }] })
    expect(await readTicketCalls(dir, 'missing')).toEqual({ total: 0, hours: [], commands: [] })
    expect(await readTicketCalls(dir, '../a')).toEqual({ total: 0, hours: [], commands: [] })
    expect(await hourlyCalls(dir, now)).toEqual({ hour: '2026-11-13T15', total: 4 })
    expect(await hourlyCalls(join(dir, 'none'), now)).toEqual({ hour: '2026-11-13T15', total: 0 })
  })
})

describe('agent git configuration', () => {
  it('ignores the operator\'s global and system git configuration, also after DSH drops credential-shaped variables', async () => {
    const home = join(dir, 'home'); mkdirSync(home)
    // Operator configuration that rewrites HTTPS to SSH, enables commit signing, and sets a credential helper.
    writeFileSync(join(home, '.gitconfig'), '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n[commit]\n\tgpgsign = true\n[credential]\n\thelper = osxkeychain\n')
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: '/opt/agent tools/gh' } })
    await writeEnvironment(deployment, [])
    // Operator identity variables and git's fallback from the OS username must not apply to worker commits.
    const env = workerEnv({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.abbrev', GIT_CONFIG_VALUE_0: '12', GIT_AUTHOR_NAME: 'Operator', GIT_COMMITTER_EMAIL: 'operator@example.com', ...agentVariables(dir) })
    const git = async (...args: string[]): Promise<string> => (await exec('git', args, { cwd: dir, env })).stdout.trim()
    await git('init', '-q', 'repo')
    await exec('git', ['-C', 'repo', 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir, env })
    expect(await git('-C', 'repo', 'remote', 'get-url', '--push', 'origin')).toBe('https://github.com/acme/widgets.git')
    expect(await git('config', '--show-origin', '--get-all', 'credential.https://github.com.helper')).toBe(`file:${workerGitConfig(dir)}\t${credentialHelper('/opt/agent tools/gh')}`)
    expect(await git('config', '--get-all', 'credential.helper')).toBe('')
    await expect(git('config', 'commit.gpgsign')).rejects.toThrow()
    await expect(git('config', 'core.abbrev')).rejects.toThrow()
    expect(env).not.toHaveProperty('GIT_AUTHOR_NAME')
    expect(env).not.toHaveProperty('GIT_COMMITTER_EMAIL')
    await expect(git('-C', 'repo', 'commit', '--allow-empty', '-q', '-m', 'without identity')).rejects.toMatchObject({ stderr: expect.stringContaining('no email was given') })
    await git('-C', 'repo', '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', 'commit', '--allow-empty', '-q', '-m', 'with identity')
    expect(await git('-C', 'repo', 'log', '-1', '--format=%an <%ae> / %cn <%ce>')).toBe('Alice <alice@example.com> / Alice <alice@example.com>')
  })
})

it('fails instead of asking the operator\'s askpass helpers when the agent\'s credential helper has no answer', async () => {
  const log = join(dir, 'asked')
  const askpass = program(join(dir, 'askpass'), `echo asked >> ${log}; echo operator-secret`)
  const agent = program(join(dir, 'real', 'gh'), 'exit 0')
  const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: agent } })
  await writeEnvironment(deployment, [])
  const env = workerEnv({ PATH: process.env.PATH, HOME: dir, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, ...agentVariables(dir) })
  await exec('git', ['init', '-q', 'repo'], { cwd: dir, env })
  await exec('git', ['-C', 'repo', 'config', 'core.askPass', askpass], { cwd: dir, env })
  const fill = exec('git', ['-C', 'repo', 'credential', 'fill'], { cwd: dir, env, timeout: 10_000 })
  fill.child.stdin?.end('protocol=https\nhost=github.com\n\n')
  await expect(fill).rejects.toMatchObject({ stderr: expect.stringContaining('terminal prompts disabled') })
  expect(() => readFileSync(log, 'utf8')).toThrow()
})

it('removes every spelling of a directory from PATH and keeps the other entries', () => {
  mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true })
  symlinkSync(join(dir, 'state'), join(dir, 'link'))
  const bin = join(dir, 'state', 'worker-bin')
  expect(withoutDirectory([`${bin}/`, join(dir, 'link', 'worker-bin'), '/usr/bin', 'node_modules/.bin'].join(':'), bin)).toBe('/usr/bin:node_modules/.bin')
})

/** Minimal SubprocessRuntime backed by child_process.spawn with an isolated global git config. */
const subprocess = (config: string): SubprocessRuntime => ({
  spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: gitEnv({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }) })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    const done = new Promise(resolve => child.on('close', code => resolve({ exitCode: code, signal: null })))
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
}) as unknown as SubprocessRuntime
describe('ticket directory check', () => {
  const signal = new AbortController().signal
  const env = () => gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' })
  const git = (...args: string[]) => exec('git', args, { cwd: dir, env: env() })
  const check = (directory: string) => verifyDirectory(join(dir, directory), subprocess(join(dir, 'global')), signal)
  beforeEach(() => { writeFileSync(join(dir, 'global'), '[credential]\n\thelper = global-helper\n') })
  it('passes a directory whose repository adds no credentials, and one outside any repository', async () => {
    await git('init', '-q', 'repo')
    await expect(check('repo')).resolves.toBeUndefined()
    // When no config key matches at all, git config --get-regexp exits with status 1.
    writeFileSync(join(dir, 'global'), '')
    await expect(check('real')).resolves.toBeUndefined()
  })
  it('names the credential settings of the repository\'s own configuration', async () => {
    await git('init', '-q', 'repo')
    await git('-C', 'repo', 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic x')
    await expect(check('repo')).rejects.toThrow('sets http.https://github.com/.extraheader')
  })
  it('fails when git cannot read the repository\'s configuration, instead of passing it', async () => {
    await git('init', '-q', 'repo')
    writeFileSync(join(dir, 'repo', '.git', 'config'), '[core\n')
    await expect(check('repo')).rejects.toThrow(/bad config/)
  })
  it('reports a failed command\'s exit status', async () => {
    const failing = ['sh', '-c', 'echo nope >&2; exit 3']
    const error = await runAsWorker(subprocess(join(dir, 'global')), failing, dir, signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({ message: 'nope', exitCode: 3 })
  })
})

describe('the repository the host\'s environment names', () => {
  it('is left alone by the tests\' git and named in no worker\'s environment, as when they run inside `git rebase --exec`', async () => {
    // A scratch repository stands for the one under test, which `git rebase --exec` names in GIT_DIR and GIT_WORK_TREE.
    await exec('git', ['init', '-q', 'scratch'], { cwd: dir, env: gitEnv() })
    const config = () => readFileSync(join(dir, 'scratch', '.git', 'config'), 'utf8')
    const before = config()
    vi.stubEnv('GIT_DIR', join(dir, 'scratch', '.git')); vi.stubEnv('GIT_WORK_TREE', join(dir, 'scratch'))
    // The operator's limit on git's search for a repository names none, and stays.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', dir)
    try {
      // What the tests do: a repository of their own, checked as a ticket directory.
      await exec('git', ['init', '-q', 'repo'], { cwd: dir, env: gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' }) })
      writeFileSync(join(dir, 'global'), '')
      await expect(verifyDirectory(join(dir, 'repo'), subprocess(join(dir, 'global')), new AbortController().signal)).resolves.toBeUndefined()
      expect(readdirSync(join(dir, 'repo'))).toContain('.git')
      expect(config()).toBe(before)
      // The worker environment, which workers' shells and the host's own commands get, names no repository.
      const env = workerEnv({ ...process.env, ...agentVariables(dir) })
      for (const name of GIT_LOCATION) expect(env, name).not.toHaveProperty(name)
      expect(env.GIT_CEILING_DIRECTORIES).toBe(dir)
    } finally { vi.unstubAllEnvs() }
  })
})
