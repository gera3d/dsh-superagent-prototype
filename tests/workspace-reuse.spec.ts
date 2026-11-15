import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  computeBuildOutputKey,
  computeDependencyCompatibilityKey,
  createTaskIsolation,
  DependencyPoolManager,
  validateContainment,
  type DependencyManifestInputs,
} from '../src/app/workspace-reuse.ts'

describe('workspace-reuse', () => {
  const baseInputs: DependencyManifestInputs = {
    manifests: {
      'package.json': JSON.stringify({ name: 'test-app', version: '1.0.0', dependencies: { zod: '^4.4.3' } }),
    },
    workspaceConfig: {
      'pnpm-workspace.yaml': "packages:\n  - '.'\n",
    },
    lockfile: 'lockfileVersion: "9.0"\nimporters:\n  .:\n    dependencies:\n      zod:\n        specifier: ^4.4.3\n        version: 4.4.3\n',
    packageManager: { name: 'pnpm', version: '11.7.0' },
    installFlags: ['--frozen-lockfile'],
    patches: {},
    nodeRuntime: { version: '22.20.0', abi: '127' },
    platform: { os: 'darwin', arch: 'arm64' },
    nativeProvenance: {
      required: true,
      verified: true,
      modules: {
        'better-sqlite3': { built: true, hash: 'a1b2c3d4e5f6' },
      },
    },
  }

  describe('dependency compatibility key', () => {
    it('generates a deterministic key for identical inputs', () => {
      const res1 = computeDependencyCompatibilityKey(baseInputs)
      const res2 = computeDependencyCompatibilityKey(baseInputs)
      expect(res1.ok).toBe(true)
      expect(res2.ok).toBe(true)
      if (res1.ok && res2.ok) {
        expect(res1.key).toBe(res2.key)
        expect(res1.key).toMatch(/^dep-[a-f0-9]{64}$/)
      }
    })

    it('produces distinct keys when manifests change', () => {
      const modified: DependencyManifestInputs = {
        ...baseInputs,
        manifests: {
          'package.json': JSON.stringify({ name: 'test-app', version: '1.0.0', dependencies: { zod: '^4.5.0' } }),
        },
      }
      const res1 = computeDependencyCompatibilityKey(baseInputs)
      const res2 = computeDependencyCompatibilityKey(modified)
      expect(res1.ok).toBe(true)
      expect(res2.ok).toBe(true)
      if (res1.ok && res2.ok) {
        expect(res1.key).not.toBe(res2.key)
      }
    })

    it('produces distinct keys when lockfile changes', () => {
      const modified: DependencyManifestInputs = {
        ...baseInputs,
        lockfile: baseInputs.lockfile + '\n# updated hash',
      }
      const res1 = computeDependencyCompatibilityKey(baseInputs)
      const res2 = computeDependencyCompatibilityKey(modified)
      expect(res1.ok).toBe(true)
      expect(res2.ok).toBe(true)
      if (res1.ok && res2.ok) {
        expect(res1.key).not.toBe(res2.key)
      }
    })

    it('produces distinct keys when package manager changes', () => {
      const modified: DependencyManifestInputs = {
        ...baseInputs,
        packageManager: { name: 'pnpm', version: '11.8.0' },
      }
      const res1 = computeDependencyCompatibilityKey(baseInputs)
      const res2 = computeDependencyCompatibilityKey(modified)
      if (res1.ok && res2.ok) {
        expect(res1.key).not.toBe(res2.key)
      }
    })

    it('produces distinct keys when Node runtime ABI or version changes', () => {
      const modified: DependencyManifestInputs = {
        ...baseInputs,
        nodeRuntime: { version: '22.21.0', abi: '127' },
      }
      const res1 = computeDependencyCompatibilityKey(baseInputs)
      const res2 = computeDependencyCompatibilityKey(modified)
      if (res1.ok && res2.ok) {
        expect(res1.key).not.toBe(res2.key)
      }
    })

    it('produces distinct keys when platform or architecture changes', () => {
      const modified: DependencyManifestInputs = {
        ...baseInputs,
        platform: { os: 'linux', arch: 'x64' },
      }
      const res1 = computeDependencyCompatibilityKey(baseInputs)
      const res2 = computeDependencyCompatibilityKey(modified)
      if (res1.ok && res2.ok) {
        expect(res1.key).not.toBe(res2.key)
      }
    })

    it('fails closed when required manifests are missing or empty', () => {
      const invalid = { ...baseInputs, manifests: {} }
      const res = computeDependencyCompatibilityKey(invalid)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.reason).toMatch(/Missing manifests/)
      }
    })

    it('fails closed when required lockfile is missing', () => {
      const invalid = { ...baseInputs, lockfile: '' }
      const res = computeDependencyCompatibilityKey(invalid)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.reason).toMatch(/Missing or empty lockfile/)
      }
    })

    // Regression for Counterexample 1:
    it('fails closed when nativeProvenance is entirely absent or unverified (Counterexample 1)', () => {
      const withoutProvenance = {
        manifests: baseInputs.manifests,
        workspaceConfig: baseInputs.workspaceConfig,
        lockfile: baseInputs.lockfile,
        packageManager: baseInputs.packageManager,
        nodeRuntime: baseInputs.nodeRuntime,
        platform: baseInputs.platform,
      } as unknown as DependencyManifestInputs

      const res = computeDependencyCompatibilityKey(withoutProvenance)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.reason).toMatch(/Missing native-addon build provenance: explicit verified inventory required/)
      }
    })

    it('fails closed when native provenance is unverified or unbuilt', () => {
      const unverified: DependencyManifestInputs = {
        ...baseInputs,
        nativeProvenance: {
          verified: false,
          modules: { 'better-sqlite3': { built: true, hash: 'abc' } },
        },
      }
      const resUnverified = computeDependencyCompatibilityKey(unverified)
      expect(resUnverified.ok).toBe(false)
      if (!resUnverified.ok) {
        expect(resUnverified.reason).toMatch(/explicit verified build state/)
      }

      const unbuilt: DependencyManifestInputs = {
        ...baseInputs,
        nativeProvenance: {
          verified: true,
          modules: { 'better-sqlite3': { built: false, hash: '' } },
        },
      }
      const resUnbuilt = computeDependencyCompatibilityKey(unbuilt)
      expect(resUnbuilt.ok).toBe(false)
      if (!resUnbuilt.ok) {
        expect(resUnbuilt.reason).toMatch(/Unbuilt native module/)
      }
    })
  })

  describe('containment validation', () => {
    it('allows valid paths within the root', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'containment-'))
      try {
        const sub = join(tempDir, 'sub', 'target')
        mkdirSync(sub, { recursive: true })
        expect(validateContainment(sub, tempDir)).toBe(true)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it('rejects traversal outside the root', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'containment-'))
      try {
        const outside = join(tempDir, '..', 'escaped')
        expect(validateContainment(outside, tempDir)).toBe(false)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it('rejects symlinks that point outside the root', () => {
      const baseDir = mkdtempSync(join(tmpdir(), 'containment-base-'))
      const outsideDir = mkdtempSync(join(tmpdir(), 'containment-outside-'))
      try {
        const linkPath = join(baseDir, 'escape-link')
        symlinkSync(outsideDir, linkPath)
        expect(validateContainment(linkPath, baseDir)).toBe(false)
      } finally {
        rmSync(baseDir, { recursive: true, force: true })
        rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    it('rejects not-yet-created targets when an ancestor is an escaping symlink', () => {
      const baseDir = mkdtempSync(join(tmpdir(), 'containment-anc-base-'))
      const outsideDir = mkdtempSync(join(tmpdir(), 'containment-anc-outside-'))
      try {
        const symlinkParent = join(baseDir, 'linked-parent')
        symlinkSync(outsideDir, symlinkParent)
        const nestedNonExistent = join(symlinkParent, 'not-yet-created-dir')
        expect(validateContainment(nestedNonExistent, baseDir)).toBe(false)
      } finally {
        rmSync(baseDir, { recursive: true, force: true })
        rmSync(outsideDir, { recursive: true, force: true })
      }
    })
  })

  describe('task cache and environment isolation', () => {
    it('creates isolated cache directories, tool args, and environment variables', () => {
      const taskDir = mkdtempSync(join(tmpdir(), 'task-iso-'))
      try {
        const iso = createTaskIsolation(taskDir)
        expect(existsSync(iso.viteCacheDir)).toBe(true)
        expect(existsSync(iso.vitestCacheDir)).toBe(true)
        expect(existsSync(iso.tsCacheDir)).toBe(true)
        expect(existsSync(iso.pnpmStoreDir)).toBe(true)
        expect(existsSync(iso.tmpDir)).toBe(true)
        expect(iso.env.VITE_CACHE_DIR).toBe(iso.viteCacheDir)
        expect(iso.env.VITEST_CACHE_DIR).toBe(iso.vitestCacheDir)
        expect(iso.env.TMPDIR).toBe(iso.tmpDir)
        expect(iso.toolArgs.vitest).toContain('--cache.dir')
        expect(iso.toolArgs.pnpm).toContain('--store-dir')
      } finally {
        rmSync(taskDir, { recursive: true, force: true })
      }
    })
  })

  describe('qualified dependency pool management', () => {
    // Regression for Counterexample 2:
    it('fails closed on synthetic nonexistent directory, empty/malformed attestation, or missing boundary (Counterexample 2)', () => {
      const manager = new DependencyPoolManager()
      const syntheticNonExistent = '/nonexistent/path/to/synthetic/pool'

      manager.registerPool({
        id: 'pool-synth',
        key: 'dep-synth',
        rootPath: syntheticNonExistent,
        isImmutable: true,
        state: 'ready',
        attestation: {
          isImmutable: true,
          contentDigest: '',
          verifiedAt: '',
          verifiedBy: '',
        },
      })

      // 1. Without allowedRoot boundary fails closed
      const qNoBoundary = manager.qualifyPoolForReuse('dep-synth', '')
      expect(qNoBoundary.ok).toBe(false)
      if (!qNoBoundary.ok) {
        expect(qNoBoundary.reason).toMatch(/Missing mandatory trusted allowed root boundary/)
      }

      // 2. With boundary but nonexistent directory / empty attestation fails closed
      const qWithBoundary = manager.qualifyPoolForReuse('dep-synth', '/nonexistent')
      expect(qWithBoundary.ok).toBe(false)
      if (!qWithBoundary.ok) {
        expect(qWithBoundary.reason).toMatch(/does not exist on disk|attestation is incomplete/)
      }
    })

    it('requires verified complete immutable content attestation and existing node_modules', () => {
      const manager = new DependencyPoolManager()
      const tempRoot = mkdtempSync(join(tmpdir(), 'pool-root-'))
      try {
        const key = 'dep-1234567890abcdef'
        const nmDir = join(tempRoot, 'node_modules')
        mkdirSync(nmDir, { recursive: true })

        // 1. Pool marked ready but missing attestation and receipt is INELIGIBLE
        manager.registerPool({
          id: 'pool-1',
          key,
          rootPath: tempRoot,
          isImmutable: true,
          state: 'ready',
        })
        const q1 = manager.qualifyPoolForReuse(key, tempRoot)
        expect(q1.ok).toBe(false)
        if (!q1.ok) {
          expect(q1.reason).toMatch(/lacks verified immutable content attestation|lacks trusted read-only qualification provider|directory is writable/)
        }

        // 2. Pool with validated receipt bound to exact key and disk paths succeeds
        manager.registerPool({
          id: 'pool-1',
          key,
          rootPath: tempRoot,
          isImmutable: true,
          state: 'ready',
          receipt: {
            compatibilityKey: key,
            resolvedRootPath: realpathSync(tempRoot),
            resolvedNodeModulesPath: realpathSync(nmDir),
            contentDigest: 'digest-1234',
            verifiedAt: new Date().toISOString(),
            verifiedBy: 'test-harness',
            isReadOnly: true,
          },
        })
        const q2 = manager.qualifyPoolForReuse(key, tempRoot)
        expect(q2.ok).toBe(true)
      } finally {
        rmSync(tempRoot, { recursive: true, force: true })
      }
    })

    // Regression for New Synthetic Boundary Check 1:
    it('rejects pool when node_modules is a symlink targeting outside allowedRoot (New Check 1)', () => {
      const manager = new DependencyPoolManager()
      const allowedBase = mkdtempSync(join(tmpdir(), 'allowed-root-'))
      const outsideDir = mkdtempSync(join(tmpdir(), 'outside-target-'))
      try {
        const poolRoot = join(allowedBase, 'pool')
        mkdirSync(poolRoot, { recursive: true })
        const externalNm = join(outsideDir, 'external_nm')
        mkdirSync(externalNm, { recursive: true })
        symlinkSync(externalNm, join(poolRoot, 'node_modules'))

        manager.registerPool({
          id: 'pool-sym-escape',
          key: 'dep-escape',
          rootPath: poolRoot,
          isImmutable: true,
          state: 'ready',
          receipt: {
            compatibilityKey: 'dep-escape',
            resolvedRootPath: realpathSync(poolRoot),
            resolvedNodeModulesPath: realpathSync(externalNm),
            contentDigest: 'digest-1',
            verifiedAt: new Date().toISOString(),
            verifiedBy: 'test-harness',
            isReadOnly: true,
          },
        })

        const res = manager.qualifyPoolForReuse('dep-escape', allowedBase)
        expect(res.ok).toBe(false)
        if (!res.ok) {
          expect(res.reason).toMatch(/node_modules (?:target )?escapes allowed boundary/)
        }
      } finally {
        rmSync(allowedBase, { recursive: true, force: true })
        rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    // Regression for New Synthetic Boundary Check 2:
    it('rejects writable synthetic directory with self-asserted nonempty attestation strings (New Check 2)', () => {
      const manager = new DependencyPoolManager()
      const allowedBase = mkdtempSync(join(tmpdir(), 'writable-pool-'))
      try {
        const poolRoot = join(allowedBase, 'pool')
        mkdirSync(join(poolRoot, 'node_modules'), { recursive: true })

        // Caller self-asserts attestation strings, with verifiedAt='not-a-date' on a writable directory
        manager.registerPool({
          id: 'pool-writable',
          key: 'dep-writable',
          rootPath: poolRoot,
          isImmutable: true,
          state: 'ready',
          attestation: {
            contentDigest: 'some-hash',
            verifiedAt: 'not-a-date',
            verifiedBy: 'untrusted-caller',
            isImmutable: true,
          },
        })

        const res = manager.qualifyPoolForReuse('dep-writable', allowedBase)
        expect(res.ok).toBe(false)
        if (!res.ok) {
          expect(res.reason).toMatch(/writable|invalid or non-ISO verifiedAt date|lacks trusted read-only qualification provider/)
        }
      } finally {
        rmSync(allowedBase, { recursive: true, force: true })
      }
    })

    it('admits a pool when qualified by a trusted qualification provider', () => {
      const manager = new DependencyPoolManager()
      const allowedBase = mkdtempSync(join(tmpdir(), 'provider-pool-'))
      try {
        const poolRoot = join(allowedBase, 'pool')
        const nmDir = join(poolRoot, 'node_modules')
        mkdirSync(nmDir, { recursive: true })

        const key = 'dep-provider-verified'
        manager.registerPool({
          id: 'pool-prov',
          key,
          rootPath: poolRoot,
          isImmutable: true,
          state: 'ready',
        })

        const mockProvider = {
          qualify: (_pool: unknown, k: string, _allowed: string) => ({
            ok: true as const,
            receipt: {
              compatibilityKey: k,
              resolvedRootPath: realpathSync(poolRoot),
              resolvedNodeModulesPath: realpathSync(nmDir),
              contentDigest: 'sha256-verified-digest',
              verifiedAt: new Date().toISOString(),
              verifiedBy: 'trusted-harness-provider',
              isReadOnly: true,
            },
          }),
        }

        const res = manager.qualifyPoolForReuse(key, allowedBase, { provider: mockProvider })
        expect(res.ok).toBe(true)
      } finally {
        rmSync(allowedBase, { recursive: true, force: true })
      }
    })
  })

  describe('build output fingerprinting', () => {
    it('produces identical fingerprints for identical complete inputs', () => {
      const input = {
        sourceCommit: 'abcdef1234567890abcdef1234567890abcdef12',
        dirtyContentHash: '',
        sourceStateStatus: 'clean' as const,
        dependencyKey: 'dep-1234567890abcdef',
        command: { name: 'tsdown', version: '0.22.14', args: ['build'] },
        buildConfig: { 'tsdown.config.ts': 'export default {}' },
        environment: { NODE_ENV: 'production' },
      }
      const b1 = computeBuildOutputKey(input)
      const b2 = computeBuildOutputKey(input)
      expect(b1.ok).toBe(true)
      expect(b2.ok).toBe(true)
      if (b1.ok && b2.ok) {
        expect(b1.key).toBe(b2.key)
        expect(b1.key).toMatch(/^build-[a-f0-9]{64}$/)
      }
    })

    // Regression for Counterexample 3:
    it('fails closed when sourceStateStatus is absent or unknown (Counterexample 3)', () => {
      const inputWithoutStatus = {
        sourceCommit: 'fixture',
        dependencyKey: 'fixture',
        command: { name: 'fixture', version: '1', args: [] },
      } as unknown as Parameters<typeof computeBuildOutputKey>[0]

      const b = computeBuildOutputKey(inputWithoutStatus)
      expect(b.ok).toBe(false)
      if (!b.ok) {
        expect(b.reason).toMatch(/Source working tree dirty\/untracked status is missing or unknown/)
      }
    })

    it('fails closed when secret environment variables are present to prevent false reuse or secret leakage', () => {
      const inputWithSecrets = {
        sourceCommit: 'abcdef1234567890abcdef1234567890abcdef12',
        dirtyContentHash: '',
        sourceStateStatus: 'clean' as const,
        dependencyKey: 'dep-1234567890abcdef',
        command: { name: 'tsdown', version: '0.22.14', args: ['build'] },
        environment: {
          NODE_ENV: 'production',
          GITHUB_TOKEN: 'ghp_secretToken12345',
        },
      }
      const b = computeBuildOutputKey(inputWithSecrets)
      expect(b.ok).toBe(false)
      if (!b.ok) {
        expect(b.reason).toMatch(/Secret environment variable detected/)
      }
    })
  })
})
