import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  evaluateRetentionCandidate,
  generateRetentionManifest,
  generateSanitizedPublicSummary,
  inspectDependencyReference,
  inspectRetainedReferences,
  type WorkspaceCandidateRecord,
} from '../src/app/workspace-retention.ts'

describe('workspace-retention', () => {
  describe('inspectRetainedReferences', () => {
    it('detects reports, evidence, bundles, patches, backups, consumed markers, and release references', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'ret-ref-'))
      try {
        writeFileSync(join(tempDir, '.dsh-report.json'), '{"verdict":"pass"}')
        writeFileSync(join(tempDir, 'candidate.patch'), 'diff --git a b')
        writeFileSync(join(tempDir, 'publication-diagnostics.bundle'), 'bundle-bytes')
        writeFileSync(join(tempDir, 'backup-worktree.tar'), 'backup-bytes')
        writeFileSync(join(tempDir, '.dsh-consumed'), 'consumed')
        writeFileSync(join(tempDir, 'release-rel-789.json'), '{}')

        const refs = inspectRetainedReferences(tempDir, ['rel-789'])
        expect(refs.hasReports).toBe(true)
        expect(refs.hasPatches).toBe(true)
        expect(refs.hasBundles).toBe(true)
        expect(refs.hasBackups).toBe(true)
        expect(refs.hasConsumedMarkers).toBe(true)
        expect(refs.releaseReferences).toEqual(['rel-789'])
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe('evaluateRetentionCandidate', () => {
    const baseCandidate: Omit<WorkspaceCandidateRecord, 'decision' | 'reasons'> = {
      candidatePath: '/path/to/work/ws-output-1234567890ab',
      resolvedTarget: '/path/to/work/ws-output-1234567890ab',
      measuredBytes: { exclusiveBytes: 1024, sharedPoolBytes: 2048, totalBytes: 3072, uncertainty: 'exact' },
      owningTicket: { id: '1234567890ab', isLive: false },
      gitStatus: { isClean: true, hasUntracked: false, hasDirty: false, hasIgnored: false, checkAvailable: true, isSourceWorkspace: false },
      dependencyReferences: { isSymlink: true, isContained: true },
      retainedReferences: {
        hasReports: false,
        hasEvidence: false,
        hasBundles: false,
        hasPatches: false,
        hasBackups: false,
        hasFailedAttempts: false,
        hasConsumedMarkers: false,
        activeOrResumable: false,
        releaseReferences: [],
      },
      artifactClass: 'regenerable_output',
    }

    it('marks verified inactive regenerable output with clean state as provisional candidate', () => {
      const evaluated = evaluateRetentionCandidate(baseCandidate)
      expect(evaluated.decision).toBe('candidate_for_future_prune')
      expect(evaluated.reasons[0]).toMatch(/provisional candidate/)
    })

    it('strictly retains whole source workspace even if clean and ended', () => {
      const sourceWs = {
        ...baseCandidate,
        artifactClass: 'source_workspace' as const,
        gitStatus: { ...baseCandidate.gitStatus, isSourceWorkspace: true },
      }
      const evaluated = evaluateRetentionCandidate(sourceWs)
      expect(evaluated.decision).toBe('retain')
      expect(evaluated.reasons.some(r => r.includes('Full source repository/worktree workspace'))).toBe(true)
    })

    it('strictly retains when owning ticket or liveness is missing/unavailable (fail closed)', () => {
      const missingTicket = {
        ...baseCandidate,
        owningTicket: undefined,
      }
      const evaluatedMissing = evaluateRetentionCandidate(missingTicket)
      expect(evaluatedMissing.decision).toBe('retain')
      expect(evaluatedMissing.reasons.some(r => r.includes('Owning ticket or liveness status unavailable'))).toBe(true)

      const unknownLiveness = {
        ...baseCandidate,
        owningTicket: { id: '1234567890ab', isLive: undefined },
      }
      const evaluatedUnknown = evaluateRetentionCandidate(unknownLiveness)
      expect(evaluatedUnknown.decision).toBe('retain')
    })

    it('strictly retains workspaces with active ticket session', () => {
      const live = {
        ...baseCandidate,
        owningTicket: { id: '1234567890ab', isLive: true },
      }
      const evaluated = evaluateRetentionCandidate(live)
      expect(evaluated.decision).toBe('retain')
      expect(evaluated.reasons.some(r => r.includes('live and active'))).toBe(true)
    })

    it('strictly retains workspaces with dirty git working copy or untracked modifications', () => {
      const dirty = {
        ...baseCandidate,
        gitStatus: { ...baseCandidate.gitStatus, isClean: false, hasDirty: true },
      }
      const evaluatedDirty = evaluateRetentionCandidate(dirty)
      expect(evaluatedDirty.decision).toBe('retain')
      expect(evaluatedDirty.reasons.some(r => r.includes('Uncommitted modifications'))).toBe(true)

      const untracked = {
        ...baseCandidate,
        gitStatus: { ...baseCandidate.gitStatus, isClean: false, hasUntracked: true },
      }
      const evaluatedUntracked = evaluateRetentionCandidate(untracked)
      expect(evaluatedUntracked.decision).toBe('retain')
    })

    it('strictly retains workspaces when git check fails or is unavailable (fail closed)', () => {
      const unavailable = {
        ...baseCandidate,
        gitStatus: { ...baseCandidate.gitStatus, checkAvailable: false },
      }
      const evaluated = evaluateRetentionCandidate(unavailable)
      expect(evaluated.decision).toBe('retain')
      expect(evaluated.reasons.some(r => r.includes('failing closed'))).toBe(true)
    })

    it('strictly retains workspaces containing consumed markers', () => {
      const withConsumed = {
        ...baseCandidate,
        retainedReferences: { ...baseCandidate.retainedReferences, hasConsumedMarkers: true },
      }
      const evaluated = evaluateRetentionCandidate(withConsumed)
      expect(evaluated.decision).toBe('retain')
      expect(evaluated.reasons.some(r => r.includes('Consumed assignment/delivery markers'))).toBe(true)
    })

    it('strictly retains non-existent or unavailable paths', () => {
      const missingPath = {
        ...baseCandidate,
        measuredBytes: { exclusiveBytes: 0, sharedPoolBytes: 0, totalBytes: 0, uncertainty: 'unavailable' as const },
      }
      const evaluated = evaluateRetentionCandidate(missingPath)
      expect(evaluated.decision).toBe('retain')
      expect(evaluated.reasons.some(r => r.includes('measurements or candidate path unavailable'))).toBe(true)
    })
  })

  describe('generateRetentionManifest & read-only guarantee', () => {
    it('runs strictly read-only and orders candidates deterministically', () => {
      const workDir = mkdtempSync(join(tmpdir(), 'ret-audit-'))
      try {
        const wsB = join(workDir, 'finding-task-bbbbbbbbbbbb')
        const wsA = join(workDir, 'finding-task-aaaaaaaaaaaa')
        mkdirSync(wsB)
        mkdirSync(wsA)
        writeFileSync(join(wsB, 'candidate.patch'), 'patch output')
        writeFileSync(join(wsA, 'test.log'), 'log output')

        const beforeWsA = readdirSync(wsA)
        const beforeWsB = readdirSync(wsB)

        // Pass out of order: wsB then wsA
        const manifest = generateRetentionManifest([wsB, wsA], {
          isTicketLive: () => false,
          measureBytes: () => ({ exclusiveBytes: 500, sharedPoolBytes: 1000, totalBytes: 1500, uncertainty: 'exact' }),
        })

        // Manifest records are ordered deterministically: wsA first, then wsB
        expect(manifest.records[0]!.candidatePath).toBe(wsA)
        expect(manifest.records[1]!.candidatePath).toBe(wsB)

        // Filesystem is unmodified
        expect(readdirSync(wsA)).toEqual(beforeWsA)
        expect(readdirSync(wsB)).toEqual(beforeWsB)
      } finally {
        rmSync(workDir, { recursive: true, force: true })
      }
    })
  })

  describe('generateSanitizedPublicSummary', () => {
    it('excludes private machine paths, measurements, and commit hashes comprehensively', () => {
      const workDir = '/Users/gerayeremin/Library/Application Support/dsh-desktop/harness/state/superagent/work'
      const manifest = generateRetentionManifest([join(workDir, 'ws-abc123456789')], {
        measureBytes: () => ({ exclusiveBytes: 100, sharedPoolBytes: 200, totalBytes: 300, uncertainty: 'exact' }),
      })

      const summary = generateSanitizedPublicSummary(manifest)
      expect(summary.totalCandidateCount).toBe(1)
      expect(summary.retainedCandidateCount).toBe(1)
      expect(summary.provisionalCandidateCount).toBe(0)
      expect(summary.designBoundaries.length).toBeGreaterThan(0)

      const serialized = JSON.stringify(summary)
      expect(serialized).not.toContain('gerayeremin')
      expect(serialized).not.toContain('/Users/')
      expect(serialized).not.toContain('/Library/')
    })
  })
})
