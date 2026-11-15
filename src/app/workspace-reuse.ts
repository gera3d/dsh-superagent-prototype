/**
 * Qualified dependency reuse and isolated task workspace management.
 *
 * Implements deterministic dependency-compatibility keying, containment validation,
 * immutable dependency pool reuse, and per-task cache isolation.
 */
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, relative, sep } from 'node:path'

/** Inputs required to compute a deterministic dependency compatibility key. */
export interface DependencyManifestInputs {
  /** Map of relative manifest paths to their content or SHA256 digest (e.g. package.json, client/package.json). */
  manifests: Record<string, string>
  /** Map of workspace configuration files (e.g. pnpm-workspace.yaml, .npmrc). */
  workspaceConfig?: Record<string, string>
  /** Complete lockfile content or SHA256 digest (e.g. pnpm-lock.yaml). */
  lockfile: string
  /** Package manager identifier and version (e.g. pnpm@11.7.0). */
  packageManager: { name: string; version: string }
  /** Install flags, overrides, or patch declarations. */
  installFlags?: string[]
  patches?: Record<string, string>
  /** Node runtime version and ABI version (e.g. node 22.20.0, ABI 127). */
  nodeRuntime: { version: string; abi: string }
  /** Platform and architecture (e.g. darwin, arm64). */
  platform: { os: string; arch: string }
  /**
   * Native addon build provenance.
   * Explicit verified inventory is mandatory for eligible compatibility.
   * Absent or unverified provenance strictly fails closed.
   */
  nativeProvenance: {
    required?: boolean
    modules: Record<string, { built: boolean; hash: string }>
    verified: boolean
  }
}

export type CompatibilityKeyResult =
  | { ok: true; key: string }
  | { ok: false; reason: string }

const sha256 = (content: string | Buffer): string =>
  createHash('sha256').update(content).digest('hex')

/**
 * Computes a deterministic dependency compatibility key covering manifests, lockfile,
 * package manager, install configuration, Node ABI, platform/arch, and native provenance.
 * Fails closed with an actionable reason if any required component is missing or unverified.
 */
export function computeDependencyCompatibilityKey(input: DependencyManifestInputs): CompatibilityKeyResult {
  if (!input) return { ok: false, reason: 'Missing dependency manifest inputs' }

  // 1. Manifests validation
  if (!input.manifests || Object.keys(input.manifests).length === 0) {
    return { ok: false, reason: 'Missing manifests: at least one manifest (e.g. package.json) is required' }
  }
  for (const [file, content] of Object.entries(input.manifests)) {
    if (!content || typeof content !== 'string' || content.trim() === '') {
      return { ok: false, reason: `Manifest ${file} content is empty or invalid` }
    }
  }

  // 2. Lockfile validation
  if (!input.lockfile || typeof input.lockfile !== 'string' || input.lockfile.trim() === '') {
    return { ok: false, reason: 'Missing or empty lockfile: complete lockfile content required' }
  }

  // 3. Package manager validation
  if (!input.packageManager?.name || !input.packageManager?.version) {
    return { ok: false, reason: 'Missing package manager specification (name and version required)' }
  }

  // 4. Node runtime / ABI validation
  if (!input.nodeRuntime?.version || !input.nodeRuntime?.abi) {
    return { ok: false, reason: 'Missing Node runtime or ABI specification (version and ABI required)' }
  }

  // 5. Platform / architecture validation
  if (!input.platform?.os || !input.platform?.arch) {
    return { ok: false, reason: 'Missing platform or architecture specification (os and arch required)' }
  }

  // 6. Native addon provenance: explicit verified inventory is mandatory
  if (!input.nativeProvenance || typeof input.nativeProvenance !== 'object') {
    return { ok: false, reason: 'Missing native-addon build provenance: explicit verified inventory required' }
  }
  if (input.nativeProvenance.verified !== true) {
    return { ok: false, reason: 'Incompatible or unverified native-addon build provenance: explicit verified build state required' }
  }
  if (!input.nativeProvenance.modules || typeof input.nativeProvenance.modules !== 'object') {
    return { ok: false, reason: 'Missing native-addon modules inventory record' }
  }
  for (const [mod, rec] of Object.entries(input.nativeProvenance.modules)) {
    if (!rec || !rec.built) {
      return { ok: false, reason: `Unbuilt native module provenance: ${mod}` }
    }
    if (!rec.hash || rec.hash.trim() === '') {
      return { ok: false, reason: `Missing build hash for native module: ${mod}` }
    }
  }

  // Canonical deterministic JSON representation
  const canonicalManifests = Object.keys(input.manifests).sort().reduce<Record<string, string>>((acc, key) => {
    acc[key] = sha256(input.manifests[key]!)
    return acc
  }, {})

  const canonicalWorkspaceConfig = input.workspaceConfig
    ? Object.keys(input.workspaceConfig).sort().reduce<Record<string, string>>((acc, key) => {
        acc[key] = sha256(input.workspaceConfig![key]!)
        return acc
      }, {})
    : {}

  const canonicalPatches = input.patches
    ? Object.keys(input.patches).sort().reduce<Record<string, string>>((acc, key) => {
        acc[key] = sha256(input.patches![key]!)
        return acc
      }, {})
    : {}

  const canonicalNativeModules = Object.keys(input.nativeProvenance.modules).sort().reduce<Record<string, { built: boolean; hash: string }>>((acc, key) => {
    acc[key] = input.nativeProvenance.modules[key]!
    return acc
  }, {})

  const payload = {
    manifests: canonicalManifests,
    workspaceConfig: canonicalWorkspaceConfig,
    lockfileDigest: sha256(input.lockfile),
    packageManager: {
      name: input.packageManager.name,
      version: input.packageManager.version,
    },
    installFlags: (input.installFlags ?? []).slice().sort(),
    patches: canonicalPatches,
    nodeRuntime: {
      version: input.nodeRuntime.version,
      abi: input.nodeRuntime.abi,
    },
    platform: {
      os: input.platform.os,
      arch: input.platform.arch,
    },
    nativeProvenance: {
      required: input.nativeProvenance.required ?? true,
      modules: canonicalNativeModules,
      verified: true,
    },
  }

  const serialized = JSON.stringify(payload)
  return { ok: true, key: `dep-${sha256(serialized)}` }
}

/**
 * Validates that a target path (and its ancestors, even if target does not yet exist)
 * is strictly contained within the allowed root directory, preventing directory traversal (e.g. `..`)
 * or links escaping outside the sandbox.
 */
export function validateContainment(targetPath: string, allowedRoot: string): boolean {
  if (!allowedRoot || allowedRoot.trim() === '' || !targetPath || targetPath.trim() === '') {
    return false
  }

  try {
    const canonicalRoot = existsSync(allowedRoot) ? realpathSync(resolve(allowedRoot)) : resolve(allowedRoot)
    const canonicalTarget = existsSync(targetPath) ? realpathSync(resolve(targetPath)) : resolve(targetPath)

    // Check containment between canonical paths
    const rel = relative(canonicalRoot, canonicalTarget)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return false
    }

    // Check existing ancestor symlinks for target path to prevent ancestor escapes
    let cur = resolve(targetPath)
    while (cur && cur !== canonicalRoot && cur !== resolve(allowedRoot) && cur !== dirname(cur)) {
      if (existsSync(cur)) {
        try {
          const lstat = lstatSync(cur)
          if (lstat.isSymbolicLink()) {
            const real = realpathSync(cur)
            const realRel = relative(canonicalRoot, real)
            if (realRel.startsWith('..') || isAbsolute(realRel)) {
              return false
            }
          }
        } catch {
          return false
        }
      }
      cur = dirname(cur)
    }

    return true
  } catch {
    return false
  }
}

/** Per-task isolated cache directories, arguments, and environment variables. */
export interface TaskIsolationPaths {
  taskDir: string
  viteCacheDir: string
  vitestCacheDir: string
  tsCacheDir: string
  pnpmStoreDir: string
  tmpDir: string
  vitestConfigFile: string
  env: Record<string, string>
  /** Supported command-line arguments to enforce task isolation in build/test tools. */
  toolArgs: {
    vitest: string[]
    pnpm: string[]
  }
}

/**
 * Creates isolated cache, temp, and output directories for a task,
 * returning environment variables and tool flags ensuring compilers, test runners,
 * and package managers do not collide or mutate shared dependencies.
 */
export function createTaskIsolation(taskDir: string): TaskIsolationPaths {
  const cacheBase = join(taskDir, '.cache')
  const viteCacheDir = join(cacheBase, 'vite')
  const vitestCacheDir = join(viteCacheDir, 'vitest')
  const tsCacheDir = join(cacheBase, 'ts')
  const pnpmStoreDir = join(cacheBase, 'pnpm-store')
  const tmpDir = join(taskDir, '.tmp')
  const vitestConfigFile = join(cacheBase, 'vitest.config.mjs')

  mkdirSync(viteCacheDir, { recursive: true })
  mkdirSync(vitestCacheDir, { recursive: true })
  mkdirSync(tsCacheDir, { recursive: true })
  mkdirSync(pnpmStoreDir, { recursive: true })
  mkdirSync(tmpDir, { recursive: true })

  // Write isolated per-job vitest configuration setting cacheDir
  const configContent = `export default {\n  cacheDir: ${JSON.stringify(viteCacheDir)},\n}\n`
  writeFileSync(vitestConfigFile, configContent, 'utf-8')

  const env: Record<string, string> = {
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    VITE_CACHE_DIR: viteCacheDir,
    VITEST_CACHE_DIR: vitestCacheDir,
    TS_CACHE_DIR: tsCacheDir,
    PNPM_HOME: pnpmStoreDir,
  }

  const toolArgs = {
    vitest: ['--config', vitestConfigFile],
    pnpm: ['--store-dir', pnpmStoreDir],
  }

  return {
    taskDir,
    viteCacheDir,
    vitestCacheDir,
    tsCacheDir,
    pnpmStoreDir,
    tmpDir,
    vitestConfigFile,
    env,
    toolArgs,
  }
}

/** Verified immutable receipt binding a dependency pool to an exact key and disk tree. */
export interface ImmutablePoolReceipt {
  /** Exact compatibility key this receipt binds. */
  compatibilityKey: string
  /** Resolved realpath of the verified pool root. */
  resolvedRootPath: string
  /** Resolved realpath of the verified node_modules target. */
  resolvedNodeModulesPath: string
  /** Content digest of the verified immutable tree. */
  contentDigest: string
  /** Valid ISO 8601 date string. */
  verifiedAt: string
  /** Trusted qualification verifier identifier. */
  verifiedBy: string
  /** Explicit verification that pool content is immutable and read-only. */
  isReadOnly: boolean
}

/** Trusted qualification provider to independently verify and attest dependency pools. */
export interface PoolQualificationProvider {
  /** Inspects and verifies the pool root and its node_modules target on disk. */
  qualify(pool: QualifiedDependencyPool, key: string, allowedRoot: string):
    | { ok: true; receipt: ImmutablePoolReceipt }
    | { ok: false; reason: string }
}

/** Options for qualifying a pool for reuse. */
export interface PoolQualificationOptions {
  /** Trusted read-only qualification provider. */
  provider?: PoolQualificationProvider
}

/** Legacy/caller attestation interface. */
export interface DependencyPoolAttestation {
  contentDigest: string
  verifiedAt: string
  verifiedBy: string
  isImmutable: boolean
}

/** Qualified immutable dependency pool definition. */
export interface QualifiedDependencyPool {
  id: string
  key: string
  rootPath: string
  isImmutable: boolean
  state: 'ready' | 'preparing' | 'failed'
  preparedAt?: string
  error?: string
  /** Caller-authored attestation (untrusted without a provider or receipt). */
  attestation?: DependencyPoolAttestation
  /** Validated receipt bound to compatibility key and real paths. */
  receipt?: ImmutablePoolReceipt
}

/** In-memory or state-backed registry for qualified dependency pools. */
export class DependencyPoolManager {
  private pools = new Map<string, QualifiedDependencyPool>()

  /** Register or update a pool record. */
  registerPool(pool: QualifiedDependencyPool): void {
    const existing = this.pools.get(pool.key)
    if (existing?.state === 'ready' && pool.state === 'preparing') {
      // Cannot regress an already ready pool to preparing
      return
    }
    this.pools.set(pool.key, { ...pool })
  }

  getPool(key: string): QualifiedDependencyPool | undefined {
    const p = this.pools.get(key)
    return p ? { ...p } : undefined
  }

  /**
   * Qualifies a dependency pool for reuse by a task workspace.
   * Requires mandatory allowedRoot boundary. Fails closed if pool does not exist,
   * directory does not exist on disk, is still preparing, is failed,
   * is not marked immutable, node_modules target escapes allowed boundary,
   * or lacks a trusted read-only qualification provider or validated receipt.
   */
  qualifyPoolForReuse(
    key: string,
    allowedRoot: string,
    options?: PoolQualificationOptions
  ): { ok: true; pool: QualifiedDependencyPool } | { ok: false; reason: string } {
    if (!allowedRoot || allowedRoot.trim() === '') {
      return { ok: false, reason: 'Missing mandatory trusted allowed root boundary' }
    }

    const pool = this.pools.get(key)
    if (!pool) {
      return { ok: false, reason: `No qualified dependency pool found for key ${key}` }
    }
    if (pool.state === 'preparing') {
      return { ok: false, reason: 'Dependency pool is currently preparing; partial preparation cannot be reused' }
    }
    if (pool.state === 'failed') {
      return { ok: false, reason: `Dependency pool preparation previously failed: ${pool.error ?? 'unspecified error'}` }
    }
    if (!pool.isImmutable) {
      return { ok: false, reason: 'Dependency pool is not immutable; refusing to reuse mutable tree' }
    }

    // 1. Root directory containment and existence
    if (!validateContainment(pool.rootPath, allowedRoot)) {
      return { ok: false, reason: `Dependency pool root escapes allowed boundary ${allowedRoot}` }
    }
    if (!existsSync(pool.rootPath)) {
      return { ok: false, reason: `Dependency pool root directory does not exist on disk: ${pool.rootPath}` }
    }

    // 2. node_modules containment (both link path AND resolved target)
    const nmPath = join(pool.rootPath, 'node_modules')
    if (!existsSync(nmPath)) {
      return { ok: false, reason: `Dependency pool is missing node_modules directory at ${nmPath}` }
    }
    if (!validateContainment(nmPath, allowedRoot)) {
      return { ok: false, reason: `Dependency pool node_modules escapes allowed boundary ${allowedRoot}` }
    }
    let realNmTarget: string
    try {
      realNmTarget = realpathSync(nmPath)
    } catch {
      return { ok: false, reason: `Failed to resolve realpath of node_modules target at ${nmPath}` }
    }
    if (!validateContainment(realNmTarget, allowedRoot)) {
      return { ok: false, reason: `Dependency pool node_modules target escapes allowed boundary ${allowedRoot}` }
    }

    // 3. Immutability check on disk: writable directory must fail closed
    let isWritable = false
    try {
      accessSync(pool.rootPath, constants.W_OK)
      isWritable = true
    } catch {
      isWritable = false
    }

    if (isWritable) {
      return { ok: false, reason: 'Dependency pool directory is writable on disk without verified read-only isolation' }
    }

    // 4. Require a trusted independent qualification provider; untrusted caller-supplied receipts are ineligible
    if (!options?.provider) {
      return { ok: false, reason: 'Dependency pool qualification requires a trusted independent read-only qualification provider; untrusted caller-supplied receipts or registrations are ineligible' }
    }

    const res = options.provider.qualify(pool, key, allowedRoot)
    if (!res.ok) {
      return { ok: false, reason: `Trusted provider qualification rejected: ${res.reason}` }
    }

    return { ok: true, pool: { ...pool, receipt: res.receipt } }
  }

  /**
   * Plans or connects a qualified immutable dependency pool to a task workspace directory.
   * Validates containment of both pool AND workspace against the allowed root,
   * checks ancestor symlinks, and verifies target directory does not overwrite existing contents.
   */
  linkToWorkspace(workspaceDir: string, key: string, allowedRoot: string, options?: PoolQualificationOptions): void {
    if (!allowedRoot || allowedRoot.trim() === '') {
      throw new Error('Missing mandatory trusted allowed root boundary')
    }
    if (!validateContainment(workspaceDir, allowedRoot)) {
      throw new Error(`Workspace directory escapes allowed boundary ${allowedRoot}`)
    }

    const qualification = this.qualifyPoolForReuse(key, allowedRoot, options)
    if (!qualification.ok) {
      throw new Error(`Cannot link dependency pool: ${qualification.reason}`)
    }

    const nmTarget = join(realpathSync(qualification.pool.rootPath), 'node_modules')
    if (!existsSync(nmTarget)) {
      throw new Error(`Qualified pool is missing node_modules directory at ${nmTarget}`)
    }

    const taskNm = join(workspaceDir, 'node_modules')
    if (existsSync(taskNm) || (() => { try { return lstatSync(taskNm) } catch { return false } })()) {
      try {
        const stat = lstatSync(taskNm)
        if (stat.isSymbolicLink()) {
          const currentTarget = realpathSync(taskNm)
          if (currentTarget === realpathSync(nmTarget)) {
            // Already correctly linked
            return
          }
        }
      } catch {
        // Fall through
      }
      throw new Error(`Workspace already has node_modules at ${taskNm}; refusing to overwrite`)
    }

    mkdirSync(workspaceDir, { recursive: true })
    symlinkSync(nmTarget, taskNm)
  }
}

/** Build output input parameters for deterministic fingerprinting. */
export interface BuildOutputInputs {
  /** Commit SHA or git tree hash of the source. */
  sourceCommit: string
  /** Hash of dirty / uncommitted working copy changes (empty string if clean). */
  dirtyContentHash?: string
  /** Source working copy state status. Must be explicitly 'clean' or 'dirty'. */
  sourceStateStatus: 'clean' | 'dirty' | 'unknown'
  /** Dependency compatibility key. */
  dependencyKey: string
  /** Exact command and tool version, e.g. { name: 'tsdown', version: '0.22.14', args: ['build'] }. */
  command: { name: string; version: string; args: string[] }
  /** Build configuration map (e.g. config file path -> sha256). */
  buildConfig?: Record<string, string>
  /** Environment variables relevant to the build. */
  environment?: Record<string, string>
}

const SECRET_ENV_REGEX = /(?:SECRET|TOKEN|KEY|PASS|AUTH|CRED|BEARER|JWT)/i

/**
 * Computes a deterministic build output cache key.
 * Fails closed if source dirty/untracked status is missing or unknown,
 * or if a secret environment variable is present in the build environment
 * (preventing secret leakage into cache fingerprints and false cache hits).
 */
export function computeBuildOutputKey(input: BuildOutputInputs): { ok: true; key: string } | { ok: false; reason: string } {
  if (!input) return { ok: false, reason: 'Missing build output inputs' }
  if (!input.sourceCommit || input.sourceCommit.trim() === '') {
    return { ok: false, reason: 'Missing source commit SHA' }
  }
  if (!input.sourceStateStatus || input.sourceStateStatus === 'unknown') {
    return { ok: false, reason: 'Source working tree dirty/untracked status is missing or unknown; failing closed' }
  }
  if (input.sourceStateStatus === 'dirty' && (!input.dirtyContentHash || input.dirtyContentHash.trim() === '')) {
    return { ok: false, reason: 'Source working copy is dirty but dirty content hash is missing' }
  }
  if (!input.dependencyKey || input.dependencyKey.trim() === '') {
    return { ok: false, reason: 'Missing dependency compatibility key' }
  }
  if (!input.command?.name || !input.command?.version) {
    return { ok: false, reason: 'Missing build command or tool version' }
  }

  // Check for secret environment variables: fail closed rather than ignoring changes to secrets
  if (input.environment) {
    for (const k of Object.keys(input.environment)) {
      if (SECRET_ENV_REGEX.test(k)) {
        return { ok: false, reason: `Secret environment variable detected (${k}); refusing to cache build output without secret-isolated configuration` }
      }
    }
  }

  const sortedEnv = input.environment
    ? Object.keys(input.environment).sort().reduce<Record<string, string>>((acc, k) => {
        acc[k] = input.environment![k]!
        return acc
      }, {})
    : {}

  const sortedConfig = input.buildConfig
    ? Object.keys(input.buildConfig).sort().reduce<Record<string, string>>((acc, k) => {
        acc[k] = sha256(input.buildConfig![k]!)
        return acc
      }, {})
    : {}

  const payload = {
    sourceCommit: input.sourceCommit,
    dirtyContentHash: input.dirtyContentHash ?? '',
    sourceStateStatus: input.sourceStateStatus,
    dependencyKey: input.dependencyKey,
    command: {
      name: input.command.name,
      version: input.command.version,
      args: input.command.args ?? [],
    },
    buildConfig: sortedConfig,
    env: sortedEnv,
  }

  return { ok: true, key: `build-${sha256(JSON.stringify(payload))}` }
}
