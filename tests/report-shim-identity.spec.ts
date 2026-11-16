import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeEnvironment, workerBin } from '../src/infra/environment.ts'
import { findWorkerReportFile } from '../src/executor/dsh.ts'
import { testDeployment } from './fixtures/deployment.ts'

const exec = promisify(execFile)
let dir: string
const bound = { state: 'ready', summary: 'Verified test result', ticket_id: 'ticket', assignment_id: 'assignment', turn_id: 2 }
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'report-shim-identity-'))
  await writeEnvironment(testDeployment({ stateDir: dir }), [])
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const run = (args: string[], env: Record<string, string> = {}) => exec(join(workerBin(dir), 'orchestrator_report'), args,
  { env: { PATH: process.env.PATH, DSH_SUPERAGENT_DIR: dir, ...env } })

describe('report CLI identity contract', () => {
  it.each(['ticket_id', 'assignment_id', 'turn_id'] as const)('rejects missing %s without replacing an existing report', async key => {
    const report = { ...bound }; delete (report as Record<string, unknown>)[key]
    const target = join(dir, '.dsh-report.json')
    writeFileSync(target, 'existing report')
    await expect(run([JSON.stringify(report)])).rejects.toMatchObject({ code: 1 })
    expect(readFileSync(target, 'utf8')).toBe('existing report')
    expect(readdirSync(dir).filter(name => name.startsWith('.dsh-report'))).toEqual(['.dsh-report.json'])
  })

  it.each([
    ['ticket_id', 7], ['ticket_id', '  '], ['assignment_id', {}], ['assignment_id', '\t'],
    ['turn_id', {}], ['turn_id', []], ['turn_id', false], ['turn_id', '   '],
  ])('rejects malformed %s = %j', async (key, value) => {
    await expect(run([JSON.stringify({ ...bound, [String(key)]: value })])).rejects.toMatchObject({ code: 1 })
    expect(readdirSync(dir).some(name => name.startsWith('.dsh-report'))).toBe(false)
  })

  it('produces a consumer-accepted report using explicit flags with no shell identity environment', async () => {
    const result = await run(['--state', 'ready', '--summary', bound.summary, '--ticket', 'ticket', '--assignment', 'assignment', '--turn', '2'])
    expect(result.stdout).toContain('Report recorded for delivery')
    expect(findWorkerReportFile(dir, { id: 'ticket', assignmentId: 'assignment', turn: 2 })).toMatchObject({ state: 'ready', summary: bound.summary })
  })

  it('supports complete shell identity environment', async () => {
    await run(['--state', 'ready', '--summary', bound.summary], { DSH_SUPERAGENT_TICKET: 'ticket', DSH_SUPERAGENT_ASSIGNMENT: 'assignment', DSH_SUPERAGENT_TURN: '2' })
    expect(findWorkerReportFile(dir, { id: 'ticket', assignmentId: 'assignment', turn: 2 })).toBeDefined()
  })

  it('preserves explicit numeric zero turn identity', async () => {
    await run([JSON.stringify({ ...bound, turn_id: 0 })], { DSH_SUPERAGENT_TURN: '99' })
    expect(findWorkerReportFile(dir, { id: 'ticket', assignmentId: 'assignment', turn: 0 })).toBeDefined()
  })

  it.each(['turn', 'nonce'])('preserves supported %s identity alias', async alias => {
    const { turn_id, ...report } = bound
    await run([JSON.stringify({ ...report, [alias]: turn_id })])
    expect(findWorkerReportFile(dir, { id: 'ticket', assignmentId: 'assignment', turn: turn_id })).toBeDefined()
  })
})
