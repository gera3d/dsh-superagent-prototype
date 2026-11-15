import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  evaluateRetentionCandidate,
  generateRetentionManifest,
  inspectDependencyReference,
  inspectRetainedReferences,
  sanitizeManifestForPublication,
  type WorkspaceCandidateRecord,
} from '../src/app/workspace-retention.ts'

describe('workspace-retention', () => {
  describe('inspectRetainedReferences', () => {
    it('detects reports, evidence, bundles, patches, backups, and release references', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'ret-ref-'))
      try {
        writeFileSync(join(tempDir, '.dsh-report.json'), '{"verdict":"pass"}')
        writeFileSync(join(tempDir, 'candidate.patch'), 'diff --git a b')
        writeFileSync(join(tempDir, 'publication-diagnostics.bundle'), 'bundle-bytes')
        writeFileSync(join(tempDir, 'backup-worktree.tar'), 'backup-bytes')
        writeFileSync(join(tempDir, 'release-rel-789.json'), '{}')

        const refs = inspectRetainedReferences(tempDir, ['rel-789'])
        expect(refs.hasReports).toBe(true)
        expect(refs.hasPatches).toBe(true)
        expect(refs.hasBundles).toBe(true)
        expect(refs.hasBackups).toBe(true)
        expect(refs.releaseReferences).toEqual(['rel-789'])
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe('evaluateRetentionCandidate', () => {
    const baseCandidate: Omit<WorkspaceCandidateRecord, 'decision' | 'reasons'> = {
      candidatePath: '/path/to/work/ws-1234567890ab',
      resolvedTarget: '/path/to/work/ws-1234567890ab',
      measuredBytes: { exclusiveBytes: 1024, sharedPoolBytes: 2048, totalBytes: 3072, uncertainty: 'exact' },
      owningTicket: { id: '1234567890ab', isLive: false },
      gitStatus: { isClean: true, hasUntracked: false, hasDirty: false, hasIgnored: false, checkAvailable: true },
      dependencyReferences: { isSymlink: true, isContained: true },
      retainedReferences: {
        hasReports: false,
        hasEvidence: false,
        hasBundles: false,
        hasPatches: false,
        hasBackups: false,
        hasFailedAttempts: false,
        activeOrResumable: false,
        releaseReferences: [],
      },
    }

    it('marks clean, inactive, unreferenced candidate for future review with owner approval', () => {
      const evaluated = evaluateRetentionCandidate(baseCandidate)
      expect(evaluated.decision).toBe('candidate_for_future_prune')
      expect(evaluated.reasons[0]).toMatch(/No active ticket/)
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

    it('strictly retains workspaces containing reports, evidence, patches, or bundles', () => {
      const withEvidence = {
        ...baseCandidate,
        retainedReferences: { ...baseCandidate.retainedReferences, hasEvidence: true },
      }
      const evaluatedEvidence = evaluateRetentionCandidate(withEvidence)
      expect(evaluatedEvidence.decision).toBe('retain')

      const withReports = {
        ...baseCandidate,
        retainedReferences: { ...baseCandidate.retainedReferences, hasReports: true },
      }
      const evaluatedReports = evaluateRetentionCandidate(withReports)
      expect(evaluatedReports.decision).toBe('retain')
    })

    it('strictly retains workspaces containing backups or failed attempts', () => {
      const withBackup = {
        ...baseCandidate,
        retainedReferences: { ...baseCandidate.retainedReferences, hasBackups: true },
      }
      const evaluated = evaluateRetentionCandidate(withBackup)
      expect(evaluated.decision).toBe('retain')
      expect(evaluated.reasons.some(r => r.includes('backup files'))).toBe(true)
    })

    it('strictly retains workspaces referenced by an active release', () => {
      const withRelease = {
        ...baseCandidate,
        retainedReferences: { ...baseCandidate.retainedReferences, releaseReferences: ['rel-v1'] },
      }
      const evaluated = evaluateRetentionCandidate(withRelease)
      expect(evaluated.decision).toBe('retain')
      expect(evaluated.reasons.some(r => r.includes('Referenced by active release'))).toBe(true)
    })
  })

  describe('generateRetentionManifest & read-only guarantee', () => {
    it('runs strictly read-only: no files are created, modified, or removed', () => {
      const workDir = mkdtempSync(join(tmpdir(), 'ret-audit-'))
      try {
        const ws1 = join(workDir, 'finding-task-111111111111')
        const ws2 = join(workDir, 'finding-task-222222222222')
        mkdirSync(ws1)
        mkdirSync(ws2)
        writeFileSync(join(ws1, 'test.log'), 'log output')
        writeFileSync(join(ws2, 'candidate.patch'), 'patch output')

        const beforeWs1 = readdirSync(ws1)
        const beforeWs2 = readdirSync(ws2)

        const manifest = generateRetentionManifest([ws1, ws2], {
          isTicketLive: (id) => id === '111111111111',
          measureBytes: () => ({ exclusiveBytes: 500, sharedPoolBytes: 1000, totalBytes: 1500, uncertainty: 'exact' }),
        })

        expect(manifest.totalCandidates).toBe(2)
        expect(manifest.retainedCount).toBe(2) // ws1 has live ticket + test.log, ws2 has candidate.patch
        expect(manifest.candidatePruneCount).toBe(0)

        // Verify filesystem was unmodified
        expect(readdirSync(ws1)).toEqual(beforeWs1)
        expect(readdirSync(ws2)).toEqual(beforeWs2)
      } finally {
        rmSync(workDir, { recursive: true, force: true })
      }
    })
  })

  describe('sanitizeManifestForPublication', () => {
    it('replaces machine-private directory prefixes with generic placeholders', () => {
      const workDir = '/Users/gerayeremin/Library/Application Support/dsh-desktop/harness/state/superagent/work'
      const manifest = generateRetentionManifest([join(workDir, 'ws-abc123456789')], {
        measureBytes: () => ({ exclusiveBytes: 100, sharedPoolBytes: 200, totalBytes: 300, uncertainty: 'exact' }),
      })

      const sanitized = sanitizeManifestForPublication(manifest, workDir)
      expect(sanitized.records[0]!.candidatePath).toBe('<workspace-root>/ws-abc123456789')
      expect(sanitized.records[0]!.candidatePath).not.toContain('gerayeremin')
    })
  })
})
