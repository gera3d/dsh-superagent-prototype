import { describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFindingCoordinationInstruction } from '../src/app/finding-coordination.ts'
import { FindingError } from '../src/app/finding.ts'

describe('root headless approval audit boundary verification', () => {
  it('prior defer confirmation does not authorize a later headless fix_now', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-approval-')))
    try {
      const id = 'a338ad44-893d-4ebf-b8ff-aa0c3067e384'
      const now = Date.now()
      const finding = {
        id,
        revision: 3,
        state: 'awaiting_decision',
        scope: 'Bounded repair',
        choices: [{ id: 'fix_now' }],
        audit: [{ event: 'confirmed', actor: 'local-operator', detail: 'defer', at: new Date(now - 1000).toISOString() }],
      }
      const instruction = {
        version: 1,
        authority: 'explicit_operator_coordination',
        findingId: id,
        revision: 3,
        action: 'confirm',
        choiceId: 'fix_now',
        actorId: 'coordinator',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(),
        source: { reference: 'test', reason: 'A prior defer is not execution approval' },
      }
      const file = join(dir, 'instruction.json')
      writeFileSync(file, JSON.stringify(instruction), { mode: 0o600 })
      expect(() => readFindingCoordinationInstruction(file, finding as any, now)).toThrow(
        /Headless coordination is only supported for existing explicitly approved bounded work/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prior defer confirmation does not authorize a later headless queue_next or retry_scope', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-defer-')))
    try {
      const id = 'a338ad44-893d-4ebf-b8ff-aa0c3067e384'
      const now = Date.now()
      const finding = {
        id,
        revision: 3,
        state: 'awaiting_decision',
        scope: 'Bounded repair',
        choices: [{ id: 'queue_next' }],
        audit: [{ event: 'confirmed', actor: 'local-operator', detail: 'defer', at: new Date(now - 1000).toISOString() }],
      }
      const queueInstruction = {
        version: 1,
        authority: 'explicit_operator_coordination',
        findingId: id,
        revision: 3,
        action: 'confirm',
        choiceId: 'queue_next',
        actorId: 'coordinator',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(),
        source: { reference: 'test', reason: 'Prior deferral rejects queue_next' },
      }
      const file = join(dir, 'instruction.json')
      writeFileSync(file, JSON.stringify(queueInstruction), { mode: 0o600 })
      expect(() => readFindingCoordinationInstruction(file, finding as any, now)).toThrow(FindingError)

      // Also verify retry_scope is rejected on deferral
      const blockedFinding = {
        ...finding,
        state: 'blocked',
        choices: [{ id: 'fix_now' }],
      }
      const retryInstruction = {
        ...queueInstruction,
        action: 'retry_scope',
        choiceId: undefined,
      }
      writeFileSync(file, JSON.stringify(retryInstruction), { mode: 0o600 })
      expect(() => readFindingCoordinationInstruction(file, blockedFinding as any, now)).toThrow(FindingError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('subsequent operator deferral revokes earlier fix_now approval (disallow stale approval)', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-stale-')))
    try {
      const id = 'a338ad44-893d-4ebf-b8ff-aa0c3067e384'
      const now = Date.now()
      const finding = {
        id,
        revision: 4,
        state: 'awaiting_decision',
        scope: 'Bounded repair',
        choices: [{ id: 'fix_now' }],
        audit: [
          { event: 'confirmed', actor: 'local-operator', detail: 'fix_now', at: new Date(now - 2000).toISOString() },
          { event: 'dispatched', actor: 'local-operator', detail: 'ticket/assign', at: new Date(now - 1800).toISOString() },
          { event: 'blocked', actor: 'finding-runtime', detail: 'Verification failed', at: new Date(now - 1500).toISOString() },
          // Later, local operator explicitly reviewed and chose defer
          { event: 'reviewed', actor: 'local-operator', detail: JSON.stringify({ revision: 3, decision: 'defer' }), at: new Date(now - 1000).toISOString() },
        ],
        priorJobs: [{ id: `finding:${id}:r1` }],
      }
      const instruction = {
        version: 1,
        authority: 'explicit_operator_coordination',
        findingId: id,
        revision: 4,
        action: 'confirm',
        choiceId: 'fix_now',
        actorId: 'coordinator',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(),
        source: { reference: 'test', reason: 'Subsequent operator deferral revokes prior approval' },
      }
      const file = join(dir, 'instruction.json')
      writeFileSync(file, JSON.stringify(instruction), { mode: 0o600 })
      expect(() => readFindingCoordinationInstruction(file, finding as any, now)).toThrow(
        /Headless coordination is only supported for existing explicitly approved bounded work/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('foreign non-operator confirmation does not authorize headless coordination', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-foreign-')))
    try {
      const id = 'a338ad44-893d-4ebf-b8ff-aa0c3067e384'
      const now = Date.now()
      const finding = {
        id,
        revision: 2,
        state: 'awaiting_decision',
        scope: 'Bounded repair',
        choices: [{ id: 'fix_now' }],
        audit: [{ event: 'confirmed', actor: 'foreign-coordinator', detail: 'fix_now', at: new Date(now - 1000).toISOString() }],
        priorJobs: [{ id: `finding:${id}:r1` }],
      }
      const instruction = {
        version: 1,
        authority: 'explicit_operator_coordination',
        findingId: id,
        revision: 2,
        action: 'confirm',
        choiceId: 'fix_now',
        actorId: 'coordinator',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(),
        source: { reference: 'test', reason: 'Foreign approval cannot grant execution' },
      }
      const file = join(dir, 'instruction.json')
      writeFileSync(file, JSON.stringify(instruction), { mode: 0o600 })
      expect(() => readFindingCoordinationInstruction(file, finding as any, now)).toThrow(
        /Headless coordination is only supported for existing explicitly approved bounded work/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('awaiting_decision finding without prior jobs does not authorize headless confirm (missing retry lineage)', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-lineage-')))
    try {
      const id = 'a338ad44-893d-4ebf-b8ff-aa0c3067e384'
      const now = Date.now()
      const finding = {
        id,
        revision: 2,
        state: 'awaiting_decision',
        scope: 'Bounded repair',
        choices: [{ id: 'fix_now' }],
        audit: [{ event: 'confirmed', actor: 'local-operator', detail: 'fix_now', at: new Date(now - 1000).toISOString() }],
        // Missing priorJobs: never dispatched
      }
      const instruction = {
        version: 1,
        authority: 'explicit_operator_coordination',
        findingId: id,
        revision: 2,
        action: 'confirm',
        choiceId: 'fix_now',
        actorId: 'coordinator',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(),
        source: { reference: 'test', reason: 'Lineage required for headless confirm' },
      }
      const file = join(dir, 'instruction.json')
      writeFileSync(file, JSON.stringify(instruction), { mode: 0o600 })
      expect(() => readFindingCoordinationInstruction(file, finding as any, now)).toThrow(
        /Headless confirmation is only supported for retrying existing bounded work with approved execution lineage/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects action mismatch when instruction confirms choice differing from prior operator approval', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-mismatch-')))
    try {
      const id = 'a338ad44-893d-4ebf-b8ff-aa0c3067e384'
      const now = Date.now()
      const finding = {
        id,
        revision: 3,
        state: 'awaiting_decision',
        scope: 'Bounded repair',
        choices: [{ id: 'fix_now' }, { id: 'queue_next' }],
        // Operator specifically approved queue_next, not fix_now
        audit: [{ event: 'confirmed', actor: 'local-operator', detail: 'queue_next', at: new Date(now - 1000).toISOString() }],
        priorJobs: [{ id: `finding:${id}:r1` }],
      }
      const instruction = {
        version: 1,
        authority: 'explicit_operator_coordination',
        findingId: id,
        revision: 3,
        action: 'confirm',
        choiceId: 'fix_now', // Differs from operator's queue_next!
        actorId: 'coordinator',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(),
        source: { reference: 'test', reason: 'Must match approved action' },
      }
      const file = join(dir, 'instruction.json')
      writeFileSync(file, JSON.stringify(instruction), { mode: 0o600 })
      expect(() => readFindingCoordinationInstruction(file, finding as any, now)).toThrow(
        /Headless confirmation must match the exact prior approved action \(queue_next\)/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('valid bounded retry lineage with prior approved fix_now succeeds', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-valid-')))
    try {
      const id = 'a338ad44-893d-4ebf-b8ff-aa0c3067e384'
      const now = Date.now()
      const finding = {
        id,
        revision: 3,
        state: 'awaiting_decision',
        scope: 'Bounded repair',
        choices: [{ id: 'fix_now' }, { id: 'queue_next' }, { id: 'defer' }],
        audit: [
          { event: 'confirmed', actor: 'local-operator', detail: 'fix_now', at: new Date(now - 3000).toISOString() },
          { event: 'dispatched', actor: 'local-operator', detail: 'ticket/assign', at: new Date(now - 2500).toISOString() },
          { event: 'blocked', actor: 'finding-runtime', detail: 'Review needed', at: new Date(now - 2000).toISOString() },
          { event: 'reviewed', actor: 'coordinator', detail: JSON.stringify({ revision: 2, decision: 'retry_scope' }), at: new Date(now - 1000).toISOString() },
        ],
        priorJobs: [{ id: `finding:${id}:r1` }],
      }
      const instruction = {
        version: 1,
        authority: 'explicit_operator_coordination',
        findingId: id,
        revision: 3,
        action: 'confirm',
        choiceId: 'fix_now',
        actorId: 'coordinator',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(),
        source: { reference: 'test', reason: 'Valid bounded retry lineage' },
      }
      const file = join(dir, 'instruction.json')
      writeFileSync(file, JSON.stringify(instruction), { mode: 0o600 })
      const parsed = readFindingCoordinationInstruction(file, finding as any, now)
      expect(parsed.action).toBe('confirm')
      expect(parsed.choiceId).toBe('fix_now')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
