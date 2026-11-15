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

    it('fails closed when native provenance is unverified or unbuilt', () => {
      const unverified: DependencyManifestInputs = {
        ...baseInputs,
        nativeProvenance: {
          required: true,
          verified: false,
          modules: { 'better-sqlite3': { built: true, hash: 'abc' } },
        },
      }
      const resUnverified = computeDependencyCompatibilityKey(unverified)
      expect(resUnverified.ok).toBe(false)
      if (!resUnverified.ok) {
        expect(resUnverified.reason).toMatch(/unverified native-addon/)
      }

      const unbuilt: DependencyManifestInputs = {
        ...baseInputs,
        nativeProvenance: {
          required: true,
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
  })

  describe('task cache and environment isolation', () => {
    it('creates isolated cache directories and environment variables for a task', () => {
      const taskDir = mkdtempSync(join(tmpdir(), 'task-iso-'))
      try {
        const iso = createTaskIsolation(taskDir)
        expect(existsSync(iso.viteCacheDir)).toBe(true)
        expect(existsSync(iso.vitestCacheDir)).toBe(true)
        expect(existsSync(iso.tsCacheDir)).toBe(true)
        expect(existsSync(iso.tmpDir)).toBe(true)
        expect(iso.env.VITE_CACHE_DIR).toBe(iso.viteCacheDir)
        expect(iso.env.VITEST_CACHE_DIR).toBe(iso.vitestCacheDir)
        expect(iso.env.TMPDIR).toBe(iso.tmpDir)
      } finally {
        rmSync(taskDir, { recursive: true, force: true })
      }
    })
  })

  describe('qualified dependency pool management', () => {
    it('qualifies immutable ready pools and rejects preparing or failed pools', () => {
      const manager = new DependencyPoolManager()
      const tempRoot = mkdtempSync(join(tmpdir(), 'pool-root-'))
      try {
        const key = 'dep-1234567890abcdef'
        manager.registerPool({
          id: 'pool-1',
          key,
          rootPath: tempRoot,
          isImmutable: true,
          state: 'preparing',
        })

        // 1. Preparing pool fails closed
        const q1 = manager.qualifyPoolForReuse(key)
        expect(q1.ok).toBe(false)
        if (!q1.ok) {
          expect(q1.reason).toMatch(/currently preparing/)
        }

        // 2. Ready pool succeeds
        manager.registerPool({
          id: 'pool-1',
          key,
          rootPath: tempRoot,
          isImmutable: true,
          state: 'ready',
        })
        const q2 = manager.qualifyPoolForReuse(key)
        expect(q2.ok).toBe(true)

        // 3. Mutable pool is rejected
        manager.registerPool({
          id: 'pool-mut',
          key: 'dep-mutable',
          rootPath: tempRoot,
          isImmutable: false,
          state: 'ready',
        })
        const q3 = manager.qualifyPoolForReuse('dep-mutable')
        expect(q3.ok).toBe(false)
        if (!q3.ok) {
          expect(q3.reason).toMatch(/not immutable/)
        }

        // 4. Failed pool is rejected with actionable error
        manager.registerPool({
          id: 'pool-fail',
          key: 'dep-failed',
          rootPath: tempRoot,
          isImmutable: true,
          state: 'failed',
          error: 'out of memory',
        })
        const q4 = manager.qualifyPoolForReuse('dep-failed')
        expect(q4.ok).toBe(false)
        if (!q4.ok) {
          expect(q4.reason).toMatch(/out of memory/)
        }
      } finally {
        rmSync(tempRoot, { recursive: true, force: true })
      }
    })

    it('links qualified immutable pool to workspace safely', () => {
      const manager = new DependencyPoolManager()
      const poolDir = mkdtempSync(join(tmpdir(), 'pool-inst-'))
      const taskDir = mkdtempSync(join(tmpdir(), 'task-ws-'))
      try {
        const nmDir = join(poolDir, 'node_modules')
        mkdirSync(nmDir, { recursive: true })
        writeFileSync(join(nmDir, 'test-pkg.json'), '{"name":"test-pkg"}')

        const key = 'dep-sample-key'
        manager.registerPool({
          id: 'pool-inst',
          key,
          rootPath: poolDir,
          isImmutable: true,
          state: 'ready',
        })

        manager.linkToWorkspace(taskDir, key)
        const targetNm = join(taskDir, 'node_modules')
        expect(existsSync(targetNm)).toBe(true)
        expect(lstatSync(targetNm).isSymbolicLink()).toBe(true)
        expect(existsSync(join(targetNm, 'test-pkg.json'))).toBe(true)

        // Repeated linking is idempotent
        expect(() => manager.linkToWorkspace(taskDir, key)).not.toThrow()
      } finally {
        rmSync(poolDir, { recursive: true, force: true })
        rmSync(taskDir, { recursive: true, force: true })
      }
    })
  })

  describe('build output fingerprinting', () => {
    it('produces identical fingerprints for identical complete inputs', () => {
      const input = {
        sourceCommit: 'abcdef1234567890abcdef1234567890abcdef12',
        dirtyContentHash: '',
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

    it('excludes secrets from persisted fingerprints', () => {
      const inputWithSecrets = {
        sourceCommit: 'abcdef1234567890abcdef1234567890abcdef12',
        dirtyContentHash: '',
        dependencyKey: 'dep-1234567890abcdef',
        command: { name: 'tsdown', version: '0.22.14', args: ['build'] },
        environment: {
          NODE_ENV: 'production',
          GITHUB_TOKEN: 'ghp_secretToken12345',
          API_KEY: 'sk-987654321',
        },
      }
      const inputWithoutSecrets = {
        sourceCommit: 'abcdef1234567890abcdef1234567890abcdef12',
        dirtyContentHash: '',
        dependencyKey: 'dep-1234567890abcdef',
        command: { name: 'tsdown', version: '0.22.14', args: ['build'] },
        environment: {
          NODE_ENV: 'production',
        },
      }
      const b1 = computeBuildOutputKey(inputWithSecrets)
      const b2 = computeBuildOutputKey(inputWithoutSecrets)
      if (b1.ok && b2.ok) {
        expect(b1.key).toBe(b2.key)
      }
    })

    it('yields distinct fingerprints when source, tool version, or configuration changes', () => {
      const base = {
        sourceCommit: 'abcdef1234567890abcdef1234567890abcdef12',
        dirtyContentHash: '',
        dependencyKey: 'dep-1234567890abcdef',
        command: { name: 'tsdown', version: '0.22.14', args: ['build'] },
      }
      const b1 = computeBuildOutputKey(base)
      const bChangedCommit = computeBuildOutputKey({ ...base, sourceCommit: '1111111111111111111111111111111111111111' })
      const bChangedTool = computeBuildOutputKey({ ...base, command: { ...base.command, version: '0.22.15' } })
      const bDirty = computeBuildOutputKey({ ...base, dirtyContentHash: 'dirty-diff-hash' })

      if (b1.ok && bChangedCommit.ok && bChangedTool.ok && bDirty.ok) {
        expect(b1.key).not.toBe(bChangedCommit.key)
        expect(b1.key).not.toBe(bChangedTool.key)
        expect(b1.key).not.toBe(bDirty.key)
      }
    })
  })
})
