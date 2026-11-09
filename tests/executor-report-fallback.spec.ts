import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { currentTurnOf, extractReportFromText, findWorkerReportFile } from '../src/executor/dsh.ts'

describe('findWorkerReportFile', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'worker-report-file-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('reads and safely validates .dsh-report.json without immediate deletion until consumed', () => {
    const reportPath = join(dir, '.dsh-report.json')
    writeFileSync(reportPath, JSON.stringify({
      state: 'ready',
      summary: 'Offline verification complete',
      pr_number: 123,
      ticket_id: 't-1',
      assignment_id: 'a-1',
      turn_id: 1,
      at: new Date().toISOString(),
    }))
    const result = findWorkerReportFile(dir, { id: 't-1', assignmentId: 'a-1', turn: 1 })
    expect(result).toBeDefined()
    expect(result).toMatchObject({ state: 'ready', summary: 'Offline verification complete', pr_number: 123, ticket_id: 't-1', assignment_id: 'a-1' })

    // File is NOT unlinked upon read: must remain intact until consume() is called after successful recording
    expect(findWorkerReportFile(dir, { id: 't-1', assignmentId: 'a-1', turn: 1 })).toBeDefined()
    result!.consume()
    expect(findWorkerReportFile(dir, { id: 't-1', assignmentId: 'a-1', turn: 1 })).toBeUndefined()
  })

  it('does not ingest unbound generic report.json or .dsh/report.json', () => {
    writeFileSync(join(dir, 'report.json'), JSON.stringify({ state: 'ready', summary: 'old assignment' }))
    expect(findWorkerReportFile(dir)).toBeUndefined()

    const dshSubdir = join(dir, '.dsh')
    mkdirSync(dshSubdir)
    writeFileSync(join(dshSubdir, 'report.json'), JSON.stringify({ state: 'ready', summary: 'old nested assignment' }))
    expect(findWorkerReportFile(dir)).toBeUndefined()
  })

  it('rejects external symlinks', () => {
    const outside = mkdtempSync(join(tmpdir(), 'worker-outside-'))
    try {
      writeFileSync(join(outside, 'payload.json'), JSON.stringify({ state: 'ready', summary: 'outside payload' }))
      symlinkSync(join(outside, 'payload.json'), join(dir, '.dsh-report.json'))
      expect(findWorkerReportFile(dir)).toBeUndefined()
    } finally {
      try { unlinkSync(join(dir, '.dsh-report.json')) } catch {}
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects directories in place of report file', () => {
    mkdirSync(join(dir, '.dsh-report.json'))
    expect(findWorkerReportFile(dir)).toBeUndefined()
  })

  it('rejects oversized files exceeding 256KB', () => {
    const reportPath = join(dir, '.dsh-report.json')
    const huge = JSON.stringify({ state: 'ready', summary: 'x'.repeat(300 * 1024) })
    writeFileSync(reportPath, huge)
    expect(findWorkerReportFile(dir)).toBeUndefined()
  })

  it('rejects mismatched ticket_id, assignment_id, and stale timestamps', () => {
    const reportPath = join(dir, '.dsh-report.json')
    writeFileSync(reportPath, JSON.stringify({
      state: 'ready',
      summary: 'Work done',
      ticket_id: 'other-ticket',
      assignment_id: 'other-assignment',
      turn_id: 1,
      at: new Date().toISOString(),
    }))
    // Mismatched ticket_id
    expect(findWorkerReportFile(dir, { id: 'expected-ticket', assignmentId: 'other-assignment', turn: 1 })).toBeUndefined()

    // Mismatched assignment_id
    expect(findWorkerReportFile(dir, { id: 'other-ticket', assignmentId: 'expected-assignment', turn: 1 })).toBeUndefined()

    // Missing assignmentId on consumer
    expect(findWorkerReportFile(dir, { id: 'other-ticket', turn: 1 })).toBeUndefined()

    // Correct ticket and assignment passes
    expect(findWorkerReportFile(dir, { id: 'other-ticket', assignmentId: 'other-assignment', turn: 1 })).toBeDefined()

    // Stale currency check
    const now = Date.now()
    expect(findWorkerReportFile(dir, { id: 'other-ticket', assignmentId: 'other-assignment', turn: 1, since: now + 100_000 })).toBeUndefined()
  })

  it('rejects reports missing mandatory ticket_id, assignment_id, or at', () => {
    const reportPath = join(dir, '.dsh-report.json')
    writeFileSync(reportPath, JSON.stringify({ state: 'ready', summary: 'Missing identity' }))
    expect(findWorkerReportFile(dir, { id: 't-1', assignmentId: 'a-1' })).toBeUndefined()
  })

  it('validates turn and nonce binding when specified', () => {
    const reportPath = join(dir, '.dsh-report.json')
    writeFileSync(reportPath, JSON.stringify({
      state: 'ready',
      summary: 'Turn bound report',
      ticket_id: 't-1',
      assignment_id: 'a-1',
      turn_id: 'turn-2',
      at: new Date().toISOString(),
    }))
    expect(findWorkerReportFile(dir, { id: 't-1', assignmentId: 'a-1', turn: 'turn-1' })).toBeUndefined()
    expect(findWorkerReportFile(dir, { id: 't-1', assignmentId: 'a-1', turn: 'turn-2' })).toBeDefined()
  })

  it('rejects replayed same-assignment earlier-turn reports and reports missing turn when consumer specifies turn', () => {
    const reportPath = join(dir, '.dsh-report.json')
    // 1. Report from turn 1 cannot be replayed on turn 2 of same assignment
    writeFileSync(reportPath, JSON.stringify({
      state: 'ready',
      summary: 'Turn 1 report',
      ticket_id: 't-1',
      assignment_id: 'a-1',
      turn_id: 1,
      at: new Date().toISOString(),
    }))
    expect(findWorkerReportFile(dir, { id: 't-1', assignmentId: 'a-1', turn: 2 })).toBeUndefined()

    // 2. Report missing turn_id is rejected when consumer expects a bound turn
    writeFileSync(reportPath, JSON.stringify({
      state: 'ready',
      summary: 'Unbound turn report',
      ticket_id: 't-1',
      assignment_id: 'a-1',
      at: new Date().toISOString(),
    }))
    expect(findWorkerReportFile(dir, { id: 't-1', assignmentId: 'a-1', turn: 2 })).toBeUndefined()

    // 3. Report matching current turn is accepted
    writeFileSync(reportPath, JSON.stringify({
      state: 'ready',
      summary: 'Turn 2 report',
      ticket_id: 't-1',
      assignment_id: 'a-1',
      turn_id: 2,
      at: new Date().toISOString(),
    }))
    expect(findWorkerReportFile(dir, { id: 't-1', assignmentId: 'a-1', turn: 2 })).toBeDefined()
  })

  it('ignores malformed JSON and files with invalid state or empty summary', () => {
    writeFileSync(join(dir, '.dsh-report.json'), 'not json')
    expect(findWorkerReportFile(dir)).toBeUndefined()

    writeFileSync(join(dir, '.dsh-report.json'), JSON.stringify({ state: 'invalid_state', summary: 'test' }))
    expect(findWorkerReportFile(dir)).toBeUndefined()

    writeFileSync(join(dir, '.dsh-report.json'), JSON.stringify({ state: 'ready', summary: '   ' }))
    expect(findWorkerReportFile(dir)).toBeUndefined()
  })
})

describe('extractReportFromText', () => {
  it('does not elevate quoted examples or contradictory prose to ready', () => {
    const quoted = 'Implementation is NOT ready. Example payload for later:\n```json\n{"state":"ready","summary":"example only"}\n```'
    expect(extractReportFromText(quoted)).toBeUndefined()

    const proseWithReady = 'Here is the result of the bounded implementation:\n```json\n{\n  "state": "ready",\n  "summary": "Completed fix and passed 20 tests."\n}\n```\nAll done.'
    expect(extractReportFromText(proseWithReady)).toBeUndefined()
  })

  it('never elevates text, emoji, or missing-tool messages to ready', () => {
    const readyProse = 'Completed audit.\n**state**: ready\nSummary: Verified offline.'
    expect(extractReportFromText(readyProse)).toBeUndefined()

    const doneEmoji = `Native tool availability failure: \`orchestrator_report\` is not available in this provider (\`antigravity\` / Gemini runtime).

🟢 **DONE**:
- Verified tool catalog: \`orchestrator_report\` is not exposed as a native or MCP tool in this runtime.
- Implementation confirmed ready by root review across backend candidate \`5c921e2\`.`
    expect(extractReportFromText(doneEmoji)).toBeUndefined()
  })

  it('extracts isolated non-ready report (blocked/failed/dropped) from pure JSON block', () => {
    const blockedPayload = '{"state": "blocked", "summary": "Blocked by third-party rate limit"}'
    expect(extractReportFromText(blockedPayload)).toEqual({
      state: 'blocked',
      summary: 'Blocked by third-party rate limit',
    })

    const fencedFailed = '```json\n{"state": "failed", "summary": "Build failed on target arch"}\n```'
    expect(extractReportFromText(fencedFailed)).toEqual({
      state: 'failed',
      summary: 'Build failed on target arch',
    })
  })

  it('returns undefined for ordinary conversational text', () => {
    expect(extractReportFromText('I am currently inspecting the codebase.')).toBeUndefined()
    expect(extractReportFromText('')).toBeUndefined()
  })
})

describe('currentTurnOf', () => {
  it('fails closed when actual session turn cannot be established', () => {
    expect(currentTurnOf(null)).toBeUndefined()
    expect(currentTurnOf({ session: { snapshotEvents: () => [] } } as any)).toBeUndefined()
  })

  it('extracts latest turn number from session turn and assistant events', () => {
    const agentWithTurn = {
      session: {
        snapshotEvents: () => [
          { type: 'turn/start', data: { turn: 1 } },
          { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [] } } },
          { type: 'turn/start', data: { turn: 2 } },
          { type: 'step/start', data: { turn: 2, step: 1 } },
        ],
      },
    }
    expect(currentTurnOf(agentWithTurn as any)).toBe(2)
  })
})
