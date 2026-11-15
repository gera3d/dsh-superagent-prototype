/**
 * Workspace retention dry-run analysis and conservative audit manifest generation.
 *
 * Implements read-only, symlink-aware inspection of task workspace directories.
 * Strictly protects active sessions, uncommitted work, source repositories, histories,
 * reports, evidence, bundles, backups, consumed markers, and release artifacts without
 * performing any deletion or mutation.
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
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
  /** Whether directory is a full git source repository or git worktree. */
  isSourceWorkspace?: boolean
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
  hasConsumedMarkers: boolean
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
    isLive?: boolean
  }
  gitStatus: CandidateGitStatus
  dependencyReferences: CandidateDependencyRef
  retainedReferences: CandidateRetainedReferences
  /** Classification of artifact: only non-source regenerable output may ever be a candidate. */
  artifactClass: 'source_workspace' | 'regenerable_output' | 'unknown'
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
    sharingUncertainty: 'exact' | 'shared_filesystem_estimate' | 'unavailable'
  }
}

/** Sanitized public summary of a retention manifest containing aggregate counts only. */
export interface SanitizedRetentionSummary {
  version: 1
  generatedAt: string
  totalCandidateCount: number
  retainedCandidateCount: number
  provisionalCandidateCount: number
  retentionCategoryTallies: Record<string, number>
  designBoundaries: string[]
}

/** Options for inspecting a candidate workspace. */
export interface WorkspaceInspectOptions {
  /** Map of ticket ID to liveness boolean. Returns undefined if unknown/unavailable. */
  isTicketLive?: (ticketId: string) => boolean | undefined
  /** Active release references (e.g. delivery IDs or release hashes). */
  activeReleaseRefs?: string[]
  /** Git status provider for candidate directory (mockable for tests). */
  getGitStatus?: (directory: string) => CandidateGitStatus
  /** Size measurement provider (mockable for tests). */
  measureBytes?: (directory: string) => MeasuredBytes
  /** Explicit classification map for candidate paths. */
  classifyArtifact?: (directory: string) => 'source_workspace' | 'regenerable_output' | 'unknown'
  /** Allowed root directory for dependency pools (containment check). */
  allowedDependencyRoot?: string
}

/**
 * Checks directory contents for known retained artifacts:
 * reports, evidence, bundles, patches, backups, consumed markers, and failed attempts.
 * Does not follow arbitrary symlinks.
 */
export function inspectRetainedReferences(directory: string, activeReleaseRefs: string[] = []): CandidateRetainedReferences {
  let hasReports = false
  let hasEvidence = false
  let hasBundles = false
  let hasPatches = false
  let hasBackups = false
  let hasFailedAttempts = false
  let hasConsumedMarkers = false
  const matchedReleases: string[] = []

  try {
    if (existsSync(directory)) {
      const entries = readdirSync(directory, { withFileTypes: true })
      for (const entry of entries) {
        // Do not traverse into nested symlink directories
        if (entry.isSymbolicLink() && entry.name === 'node_modules') continue

        const lower = entry.name.toLowerCase()
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
        if (lower.includes('consumed') || lower.startsWith('.consumed') || lower.endsWith('.consumed')) {
          hasConsumedMarkers = true
        }
        for (const ref of activeReleaseRefs) {
          if (entry.name.includes(ref)) {
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
    hasConsumedMarkers,
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
 * Conservative fail-closed logic: any missing owner/liveness, active session,
 * uncommitted or ignored git status, whole source workspace status, historical reports,
 * evidence, consumed markers, backups, or ambiguous checks strictly mandate 'retain'.
 */
export function evaluateRetentionCandidate(candidate: Omit<WorkspaceCandidateRecord, 'decision' | 'reasons'>): WorkspaceCandidateRecord {
  const reasons: string[] = []

  // 1. Owning ticket and liveness checks: missing or unavailable mandates retain
  if (!candidate.owningTicket || candidate.owningTicket.isLive === undefined) {
    reasons.push('Owning ticket or liveness status unavailable; failing closed')
  } else if (candidate.owningTicket.isLive) {
    reasons.push('Ticket session is currently live and active')
  }

  if (candidate.retainedReferences.activeOrResumable) {
    reasons.push('Workspace contains active or resumable work')
  }

  // 2. Whole source workspace protection: clean/merged status does not make source workspaces disposable
  if (candidate.artifactClass === 'source_workspace' || candidate.gitStatus.isSourceWorkspace) {
    reasons.push('Full source repository/worktree workspace; source trees are not disposable based on ended/clean status alone')
  } else if (candidate.artifactClass !== 'regenerable_output') {
    reasons.push('Workspace is not an explicitly verified non-source regenerable output artifact; failing closed')
  }

  // 3. Git status checks: dirty, untracked, ignored, or unavailable check
  if (!candidate.gitStatus.checkAvailable) {
    reasons.push('Git status check unavailable or ambiguous; failing closed to protect uncommitted work')
  } else {
    if (!candidate.gitStatus.isClean || candidate.gitStatus.hasDirty || candidate.gitStatus.hasUntracked) {
      reasons.push('Uncommitted modifications or untracked changes detected in workspace')
    }
    if (candidate.gitStatus.hasIgnored) {
      reasons.push('Ignored or unclassified files detected in workspace; failing closed to protect unknown contents')
    }
  }

  // 4. Historical artifacts: reports, logs, evidence, bundles, patches, backups, attempts, consumed markers
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
  if (candidate.retainedReferences.hasConsumedMarkers) {
    reasons.push('Consumed assignment/delivery markers present')
  }
  if (candidate.retainedReferences.releaseReferences.length > 0) {
    reasons.push(`Referenced by active release: ${candidate.retainedReferences.releaseReferences.join(', ')}`)
  }

  // 5. Dependency containment
  if (candidate.dependencyReferences.isSymlink && !candidate.dependencyReferences.isContained) {
    reasons.push('Dependency link escapes authorized containment root')
  }

  // 6. Size and path availability
  if (candidate.measuredBytes.uncertainty === 'unavailable') {
    reasons.push('Filesystem measurements or candidate path unavailable')
  }

  const decision: 'retain' | 'candidate_for_future_prune' = reasons.length > 0 ? 'retain' : 'candidate_for_future_prune'

  if (decision === 'candidate_for_future_prune') {
    reasons.push('Pure non-source regenerable output with verified inactive state, clean git status, no ignored files, and no retained artifacts; provisional candidate for future review')
  }

  return {
    ...candidate,
    decision,
    reasons,
  }
}

/**
 * Generates a full read-only WorkspaceRetentionManifest across candidate workspace directories.
 * Input paths are processed in deterministic order.
 * Absolutely no files or directories are deleted, moved, or altered.
 */
export function generateRetentionManifest(candidates: string[], options: WorkspaceInspectOptions = {}): WorkspaceRetentionManifest {
  const sortedCandidates = candidates.slice().sort()
  const records: WorkspaceCandidateRecord[] = []
  let retainedBytes = 0
  let candidatePruneBytes = 0
  let overallUncertainty: 'exact' | 'shared_filesystem_estimate' | 'unavailable' = 'exact'

  for (const candidatePath of sortedCandidates) {
    const pathExists = existsSync(candidatePath)
    const resolvedTarget = pathExists ? realpathSync(candidatePath) : candidatePath
    const dirName = basename(candidatePath)

    // Parse ticket ID if dir matches convention: e.g. <name>-<ticketId>
    const match = dirName.match(/([a-f0-9]{12,64})$/i)
    const ticketId = match ? match[1] : undefined
    const isLive = ticketId && options.isTicketLive ? options.isTicketLive(ticketId) : undefined

    const hasGit = pathExists && (existsSync(join(candidatePath, '.git')) || (() => { try { return lstatSync(join(candidatePath, '.git')).isFile() } catch { return false } })())
    const isSource = Boolean(hasGit)

    // In the absence of an explicit provider, checks are UNAVAILABLE (failing closed)
    const gitStatus: CandidateGitStatus = options.getGitStatus
      ? options.getGitStatus(candidatePath)
      : { isClean: false, hasUntracked: false, hasDirty: false, hasIgnored: false, checkAvailable: false, isSourceWorkspace: isSource }

    const measuredBytes: MeasuredBytes = options.measureBytes
      ? options.measureBytes(candidatePath)
      : { exclusiveBytes: 0, sharedPoolBytes: 0, totalBytes: 0, uncertainty: 'unavailable' }

    if (measuredBytes.uncertainty === 'unavailable') {
      overallUncertainty = 'unavailable'
    } else if (measuredBytes.uncertainty === 'shared_filesystem_estimate' && overallUncertainty !== 'unavailable') {
      overallUncertainty = 'shared_filesystem_estimate'
    }

    const retainedRefs = inspectRetainedReferences(candidatePath, options.activeReleaseRefs)
    const depRef = inspectDependencyReference(candidatePath, options.allowedDependencyRoot)

    const explicitClass = options.classifyArtifact ? options.classifyArtifact(candidatePath) : undefined
    const artifactClass = explicitClass ?? (isSource ? 'source_workspace' : 'unknown')

    const evaluated = evaluateRetentionCandidate({
      candidatePath,
      resolvedTarget,
      measuredBytes,
      owningTicket: ticketId ? { id: ticketId, isLive } : undefined,
      gitStatus,
      dependencyReferences: depRef,
      retainedReferences: retainedRefs,
      artifactClass,
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
      sharingUncertainty: overallUncertainty,
    },
  }
}

/**
 * Generates an aggregate public summary for public issues / PRs that completely
 * excludes private machine paths, user names, raw individual measurements, and commit digests.
 */
export function generateSanitizedPublicSummary(manifest: WorkspaceRetentionManifest): SanitizedRetentionSummary {
  const categoryTallies: Record<string, number> = {}

  for (const record of manifest.records) {
    for (const reason of record.reasons) {
      categoryTallies[reason] = (categoryTallies[reason] ?? 0) + 1
    }
  }

  return {
    version: 1,
    generatedAt: manifest.generatedAt,
    totalCandidateCount: manifest.totalCandidates,
    retainedCandidateCount: manifest.retainedCount,
    provisionalCandidateCount: manifest.candidatePruneCount,
    retentionCategoryTallies: categoryTallies,
    designBoundaries: [
      'Pure read-only dry-run analysis; zero filesystem deletion or moving',
      'Whole source workspaces and git worktrees are protected unconditionally',
      'Missing or unavailable liveness/git checks strictly fail closed',
      'All local machine paths and private measurements excluded from public reporting',
    ],
  }
}
