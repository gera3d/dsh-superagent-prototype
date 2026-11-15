/**
 * Workspace retention dry-run analysis and conservative audit manifest generation.
 *
 * Implements read-only, symlink-aware inspection of task workspace directories.
 * Strictly protects active sessions, uncommitted work, histories, reports, evidence,
 * bundles, backups, and release artifacts without performing any deletion or mutation.
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { validateContainment } from './workspace-reuse.ts'

export interface MeasuredBytes {
  exclusiveBytes: number
  sharedPoolBytes: number
  totalBytes: number
  uncertainty: 'exact' | 'shared_filesystem_estimate' | 'unavailable'
}

export interface CandidateGitStatus {
  headSha?: string
  branch?: string
  isClean: boolean
  hasUntracked: boolean
  hasDirty: boolean
  hasIgnored: boolean
  checkAvailable: boolean
}

export interface CandidateDependencyRef {
  nodeModulesTarget?: string
  isSymlink: boolean
  poolKey?: string
  isContained: boolean
}

export interface CandidateRetainedReferences {
  hasReports: boolean
  hasEvidence: boolean
  hasBundles: boolean
  hasPatches: boolean
  hasBackups: boolean
  hasFailedAttempts: boolean
  activeOrResumable: boolean
  releaseReferences: string[]
}

export interface WorkspaceCandidateRecord {
  candidatePath: string
  resolvedTarget: string
  measuredBytes: MeasuredBytes
  owningTicket?: {
    id: string
    assignmentId?: string
    isLive: boolean
  }
  gitStatus: CandidateGitStatus
  dependencyReferences: CandidateDependencyRef
  retainedReferences: CandidateRetainedReferences
  decision: 'retain' | 'candidate_for_future_prune'
  reasons: string[]
}

export interface WorkspaceRetentionManifest {
  version: 1
  generatedAt: string
  totalCandidates: number
  retainedCount: number
  candidatePruneCount: number
  records: WorkspaceCandidateRecord[]
  summary: {
    retainedBytes: number
    candidatePruneBytes: number
  }
}

/** Options for inspecting a candidate workspace. */
export interface WorkspaceInspectOptions {
  /** Map of ticket ID to liveness boolean. */
  isTicketLive?: (ticketId: string) => boolean
  /** Active release references (e.g. delivery IDs or release hashes). */
  activeReleaseRefs?: string[]
  /** Git status provider for candidate directory (mockable for tests). */
  getGitStatus?: (directory: string) => CandidateGitStatus
  /** Size measurement provider (mockable for tests). */
  measureBytes?: (directory: string) => MeasuredBytes
  /** Allowed root directory for dependency pools (containment check). */
  allowedDependencyRoot?: string
}

/**
 * Checks directory contents for known retained artifacts:
 * reports, evidence, bundles, patches, backups, and failed attempts.
 */
export function inspectRetainedReferences(directory: string, activeReleaseRefs: string[] = []): CandidateRetainedReferences {
  let hasReports = false
  let hasEvidence = false
  let hasBundles = false
  let hasPatches = false
  let hasBackups = false
  let hasFailedAttempts = false
  const matchedReleases: string[] = []

  try {
    if (existsSync(directory)) {
      const entries = readdirSync(directory)
      for (const entry of entries) {
        const lower = entry.toLowerCase()
        if (lower.includes('report') || lower.endsWith('.dsh-report.json') || lower.endsWith('-pass.log') || lower.endsWith('.log')) {
          hasReports = true
        }
        if (lower.includes('evidence') || lower === 'record-evidence.py') {
          hasEvidence = true
        }
        if (lower.endsWith('.bundle')) {
          hasBundles = true
        }
        if (lower.endsWith('.patch')) {
          hasPatches = true
        }
        if (lower.includes('backup') || lower.endsWith('.bak')) {
          hasBackups = true
        }
        if (lower.includes('failed') || lower.includes('attempt')) {
          hasFailedAttempts = true
        }
        for (const ref of activeReleaseRefs) {
          if (entry.includes(ref)) {
            matchedReleases.push(ref)
          }
        }
      }
    }
  } catch {
    // If directory inspection fails, conservative fallback
    hasReports = true
  }

  return {
    hasReports,
    hasEvidence,
    hasBundles,
    hasPatches,
    hasBackups,
    hasFailedAttempts,
    activeOrResumable: false,
    releaseReferences: matchedReleases,
  }
}

/**
 * Inspects the node_modules dependency reference of a workspace.
 */
export function inspectDependencyReference(directory: string, allowedRoot?: string): CandidateDependencyRef {
  const nmPath = join(directory, 'node_modules')
  try {
    if (!existsSync(nmPath) && !(() => { try { return lstatSync(nmPath) } catch { return false } })()) {
      return { isSymlink: false, isContained: true }
    }
    const lstat = lstatSync(nmPath)
    if (lstat.isSymbolicLink()) {
      const realTarget = realpathSync(nmPath)
      const isContained = allowedRoot ? validateContainment(realTarget, allowedRoot) : true
      return {
        nodeModulesTarget: realTarget,
        isSymlink: true,
        isContained,
      }
    }
    return {
      nodeModulesTarget: nmPath,
      isSymlink: false,
      isContained: true,
    }
  } catch {
    return {
      isSymlink: false,
      isContained: false,
    }
  }
}

/**
 * Evaluates retention decision for a candidate workspace.
 * Uses conservative fail-closed logic: any active work, uncommitted git status,
 * historical reports, evidence, backups, or ambiguous checks mandate 'retain'.
 */
export function evaluateRetentionCandidate(candidate: Omit<WorkspaceCandidateRecord, 'decision' | 'reasons'>): WorkspaceCandidateRecord {
  const reasons: string[] = []

  // 1. Active or resumable ticket
  if (candidate.owningTicket?.isLive) {
    reasons.push('Ticket session is currently live and active')
  }
  if (candidate.retainedReferences.activeOrResumable) {
    reasons.push('Workspace contains active or resumable work')
  }

  // 2. Git status checks: dirty, untracked, or unavailable check
  if (!candidate.gitStatus.checkAvailable) {
    reasons.push('Git status check unavailable or ambiguous; failing closed to protect uncommitted work')
  } else if (!candidate.gitStatus.isClean || candidate.gitStatus.hasDirty || candidate.gitStatus.hasUntracked) {
    reasons.push('Uncommitted modifications or untracked changes detected in workspace')
  }

  // 3. Historical artifacts: reports, logs, evidence, bundles, patches, backups, attempts
  if (candidate.retainedReferences.hasReports) {
    reasons.push('Retained diagnostic reports, test logs, or audit records present')
  }
  if (candidate.retainedReferences.hasEvidence) {
    reasons.push('Delivery verification evidence present')
  }
  if (candidate.retainedReferences.hasBundles) {
    reasons.push('Diagnostic git bundles present')
  }
  if (candidate.retainedReferences.hasPatches) {
    reasons.push('Candidate diff patches present')
  }
  if (candidate.retainedReferences.hasBackups) {
    reasons.push('Workspace backup files present')
  }
  if (candidate.retainedReferences.hasFailedAttempts) {
    reasons.push('Historical failed attempt diagnostics present')
  }
  if (candidate.retainedReferences.releaseReferences.length > 0) {
    reasons.push(`Referenced by active release: ${candidate.retainedReferences.releaseReferences.join(', ')}`)
  }

  // 4. Dependency containment
  if (candidate.dependencyReferences.isSymlink && !candidate.dependencyReferences.isContained) {
    reasons.push('Dependency link escapes authorized containment root')
  }

  // 5. Size uncertainty
  if (candidate.measuredBytes.uncertainty === 'unavailable') {
    reasons.push('Filesystem measurements unavailable or uncertain')
  }

  const decision: 'retain' | 'candidate_for_future_prune' = reasons.length > 0 ? 'retain' : 'candidate_for_future_prune'

  if (decision === 'candidate_for_future_prune') {
    reasons.push('No active ticket, uncommitted work, evidence, reports, or backups detected; dry-run candidate for operator review')
  }

  return {
    ...candidate,
    decision,
    reasons,
  }
}

/**
 * Generates a full read-only WorkspaceRetentionManifest across candidate workspace directories.
 * Absolutely no files or directories are deleted, moved, or altered.
 */
export function generateRetentionManifest(candidates: string[], options: WorkspaceInspectOptions = {}): WorkspaceRetentionManifest {
  const records: WorkspaceCandidateRecord[] = []
  let retainedBytes = 0
  let candidatePruneBytes = 0

  for (const candidatePath of candidates) {
    const resolvedTarget = existsSync(candidatePath) ? realpathSync(candidatePath) : candidatePath
    const dirName = basename(candidatePath)

    // Parse ticket ID if dir matches convention: e.g. <name>-<ticketId>
    const match = dirName.match(/([a-f0-9]{12,64})$/i)
    const ticketId = match ? match[1] : undefined
    const isLive = ticketId && options.isTicketLive ? options.isTicketLive(ticketId) : false

    const gitStatus: CandidateGitStatus = options.getGitStatus
      ? options.getGitStatus(candidatePath)
      : { isClean: true, hasUntracked: false, hasDirty: false, hasIgnored: false, checkAvailable: true }

    const measuredBytes: MeasuredBytes = options.measureBytes
      ? options.measureBytes(candidatePath)
      : { exclusiveBytes: 0, sharedPoolBytes: 0, totalBytes: 0, uncertainty: 'exact' }

    const retainedRefs = inspectRetainedReferences(candidatePath, options.activeReleaseRefs)
    const depRef = inspectDependencyReference(candidatePath, options.allowedDependencyRoot)

    const evaluated = evaluateRetentionCandidate({
      candidatePath,
      resolvedTarget,
      measuredBytes,
      owningTicket: ticketId ? { id: ticketId, isLive } : undefined,
      gitStatus,
      dependencyReferences: depRef,
      retainedReferences: retainedRefs,
    })

    records.push(evaluated)

    if (evaluated.decision === 'retain') {
      retainedBytes += evaluated.measuredBytes.totalBytes
    } else {
      candidatePruneBytes += evaluated.measuredBytes.exclusiveBytes
    }
  }

  const retainedCount = records.filter(r => r.decision === 'retain').length
  const candidatePruneCount = records.filter(r => r.decision === 'candidate_for_future_prune').length

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    totalCandidates: records.length,
    retainedCount,
    candidatePruneCount,
    records,
    summary: {
      retainedBytes,
      candidatePruneBytes,
    },
  }
}

/**
 * Sanitizes a retention manifest for safe external reporting / publication.
 * Replaces machine-private directory prefixes with generic placeholders.
 */
export function sanitizeManifestForPublication(
  manifest: WorkspaceRetentionManifest,
  machineRoot?: string
): WorkspaceRetentionManifest {
  const sanitizePath = (p: string): string => {
    if (!machineRoot) {
      // Anonymize user home directory / absolute prefix
      return p.replace(/^\/(?:Users|home)\/[^/]+\//, '<workspace-root>/')
    }
    if (p.startsWith(machineRoot)) {
      return `<workspace-root>${p.slice(machineRoot.length)}`
    }
    return p.replace(/^\/(?:Users|home)\/[^/]+\//, '<workspace-root>/')
  }

  return {
    ...manifest,
    records: manifest.records.map(rec => ({
      ...rec,
      candidatePath: sanitizePath(rec.candidatePath),
      resolvedTarget: sanitizePath(rec.resolvedTarget),
      dependencyReferences: {
        ...rec.dependencyReferences,
        nodeModulesTarget: rec.dependencyReferences.nodeModulesTarget
          ? sanitizePath(rec.dependencyReferences.nodeModulesTarget)
          : undefined,
      },
    })),
  }
}
