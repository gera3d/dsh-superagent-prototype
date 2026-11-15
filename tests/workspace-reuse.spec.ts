import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  computeBuildOutputKey,
  computeDependencyCompatibilityKey,
  createTaskIsolation,
  DependencyPoolManager,
  KNOWN_CONFIG_NAMES,
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
    it('creates isolated cache directories, tool args, config file, and environment variables', () => {
      const taskDir = mkdtempSync(join(tmpdir(), 'task-iso-'))
      try {
        const iso = createTaskIsolation(taskDir)
        expect(existsSync(iso.viteCacheDir)).toBe(true)
        expect(existsSync(iso.vitestCacheDir)).toBe(false)
        expect(existsSync(iso.tsCacheDir)).toBe(true)
        expect(existsSync(iso.pnpmStoreDir)).toBe(true)
        expect(existsSync(iso.tmpDir)).toBe(true)
        expect(existsSync(iso.vitestConfigFile)).toBe(true)
        expect(iso.env.VITE_CACHE_DIR).toBe(iso.viteCacheDir)
        expect(iso.env.VITEST_CACHE_DIR).toBe(iso.vitestCacheDir)
        expect(iso.env.TMPDIR).toBe(iso.tmpDir)
        expect(iso.toolArgs.vitest).toEqual(['--config', iso.vitestConfigFile])
        expect(iso.toolArgs.pnpm).toEqual(['--store-dir', iso.pnpmStoreDir])
        const configContent = readFileSync(iso.vitestConfigFile, 'utf-8')
        expect(configContent).toContain(iso.viteCacheDir)
      } finally {
        rmSync(taskDir, { recursive: true, force: true })
      }
    })

    it('applies per-job config in pinned Vitest CLI, writing cache into isolated cacheDir and rejecting deprecated --cache.dir', () => {
      const taskDir = mkdtempSync(join(tmpdir(), 'task-iso-cli-'))
      try {
        const iso = createTaskIsolation(taskDir)
        const vitestBin = resolve(process.cwd(), 'node_modules/vitest/vitest.mjs')

        // Verify that pinned Vitest CLI rejects --cache.dir with deprecation error
        let deprecatedRejected = false
        try {
          execFileSync(process.execPath, [vitestBin, 'run', '--cache.dir', iso.vitestCacheDir], {
            cwd: taskDir,
            encoding: 'utf-8',
            stdio: 'pipe',
          })
        } catch (err: any) {
          if (err.stderr && err.stderr.includes('--cache.dir is deprecated')) {
            deprecatedRejected = true
          }
        }
        expect(deprecatedRejected).toBe(true)

        // Write a minimal synthetic spec file to run in the isolated task directory
        const syntheticSpec = join(taskDir, 'synthetic.spec.js')
        writeFileSync(
          syntheticSpec,
          'import { test, expect } from "vitest";\ntest("synthetic isolation check", () => expect(1 + 1).toBe(2));\n',
          'utf-8',
        )

        // Verify that before CLI execution, no vitest cache exists
        expect(existsSync(iso.vitestCacheDir)).toBe(false)

        // Run pinned Vitest CLI with the isolated tool arguments emitted by createTaskIsolation
        const output = execFileSync(
          process.execPath,
          [vitestBin, 'run', 'synthetic.spec.js', ...iso.toolArgs.vitest],
          {
            cwd: taskDir,
            encoding: 'utf-8',
            stdio: 'pipe',
          },
        )

        expect(output).toContain('1 passed')
        // Verify genuine cache artifacts produced by CLI execution in the isolated cache directory
        expect(existsSync(iso.vitestCacheDir)).toBe(true)
        const hashDirs = readdirSync(iso.vitestCacheDir)
        expect(hashDirs.length).toBeGreaterThan(0)
        const resultsFile = join(iso.vitestCacheDir, hashDirs[0]!, 'results.json')
        expect(existsSync(resultsFile)).toBe(true)
      } finally {
        rmSync(taskDir, { recursive: true, force: true })
      }
    })

    it('preserves and composes project config (alias, setupFiles, custom include) while isolating cacheDir in synthetic project', () => {
      const taskDir = mkdtempSync(join(tmpdir(), 'task-iso-composed-'))
      try {
        const vitestBin = resolve(process.cwd(), 'node_modules/vitest/vitest.mjs')

        // 1. Setup synthetic module dependencies for alias and setupFiles
        const helperFile = join(taskDir, 'helper.js')
        writeFileSync(helperFile, 'export const GREETING = "HELLO_SYNTHETIC_ALIAS";\n', 'utf-8')

        const setupFile = join(taskDir, 'setup.js')
        writeFileSync(setupFile, 'globalThis.__SYNTHETIC_SETUP_RAN__ = true;\n', 'utf-8')

        // 2. Base project config with necessary aliases, setup files, and custom include pattern
        const baseConfigFile = join(taskDir, 'vitest.config.js')
        writeFileSync(
          baseConfigFile,
          [
            'export default {',
            '  resolve: {',
            '    alias: {',
            `      "@synthetic-helper": ${JSON.stringify(helperFile)},`,
            '    },',
            '  },',
            '  test: {',
            `    setupFiles: [${JSON.stringify(setupFile)}],`,
            '    include: ["custom-specs/**/*.spec.js"],',
            '  },',
            '};',
            '',
          ].join('\n'),
          'utf-8',
        )

        // 3. Test spec inside custom-specs requiring alias and setup to pass
        const customSpecsDir = join(taskDir, 'custom-specs')
        mkdirSync(customSpecsDir, { recursive: true })
        const specFile = join(customSpecsDir, 'composed.spec.js')
        writeFileSync(
          specFile,
          [
            'import { test, expect } from "vitest";',
            'import { GREETING } from "@synthetic-helper";',
            'test("preserves alias and setupFiles while isolating cache", () => {',
            '  expect(GREETING).toBe("HELLO_SYNTHETIC_ALIAS");',
            '  expect(globalThis.__SYNTHETIC_SETUP_RAN__).toBe(true);',
            '});',
            '',
          ].join('\n'),
          'utf-8',
        )

        // 4. Create task isolation which auto-detects and composes the base config
        const iso = createTaskIsolation(taskDir)
        expect(existsSync(iso.vitestConfigFile)).toBe(true)
        const configText = readFileSync(iso.vitestConfigFile, 'utf-8')
        expect(configText).toContain(baseConfigFile)
        expect(configText).toContain(iso.viteCacheDir)

        // Before run, cache does not exist
        expect(existsSync(iso.vitestCacheDir)).toBe(false)

        // 5. Run Vitest with composed config
        const output = execFileSync(
          process.execPath,
          [vitestBin, 'run', ...iso.toolArgs.vitest],
          {
            cwd: taskDir,
            encoding: 'utf-8',
            stdio: 'pipe',
          },
        )

        expect(output).toContain('1 passed')
        // Cache artifacts created strictly in isolated task cache directory
        expect(existsSync(iso.vitestCacheDir)).toBe(true)
        const hashDirs = readdirSync(iso.vitestCacheDir)
        expect(hashDirs.length).toBeGreaterThan(0)
        expect(existsSync(join(iso.vitestCacheDir, hashDirs[0]!, 'results.json'))).toBe(true)
      } finally {
        rmSync(taskDir, { recursive: true, force: true })
      }
    })

    it('matches pinned Vitest configuration discovery list and precedence', () => {
      expect(KNOWN_CONFIG_NAMES).toEqual([
        'vitest.config.ts',
        'vitest.config.mts',
        'vitest.config.cts',
        'vitest.config.js',
        'vitest.config.mjs',
        'vitest.config.cjs',
        'vite.config.ts',
        'vite.config.mts',
        'vite.config.cts',
        'vite.config.js',
        'vite.config.mjs',
        'vite.config.cjs',
      ])
    })

    it('discovers and composes omitted extension config (vitest.config.cjs) with required setup marker', () => {
      const taskDir = mkdtempSync(join(tmpdir(), 'task-iso-cjs-'))
      try {
        const vitestBin = resolve(process.cwd(), 'node_modules/vitest/vitest.mjs')

        // 1. Create a setup file setting a unique runtime marker
        const setupFile = join(taskDir, 'setup-cjs.js')
        writeFileSync(setupFile, 'globalThis.__CJS_SETUP_RAN__ = true;\n', 'utf-8')

        // 2. Base config using .cjs extension
        const baseConfigFile = join(taskDir, 'vitest.config.cjs')
        writeFileSync(
          baseConfigFile,
          `module.exports = { test: { setupFiles: [${JSON.stringify(setupFile)}] } };\n`,
          'utf-8',
        )

        // 3. Spec file requiring the marker set by setupFiles
        const specFile = join(taskDir, 'cjs.spec.js')
        writeFileSync(
          specFile,
          'import { test, expect } from "vitest";\ntest("cjs setup ran", () => expect(globalThis.__CJS_SETUP_RAN__).toBe(true));\n',
          'utf-8',
        )

        // 4. Create task isolation which auto-discovers vitest.config.cjs
        const iso = createTaskIsolation(taskDir)
        expect(existsSync(iso.vitestConfigFile)).toBe(true)
        const configText = readFileSync(iso.vitestConfigFile, 'utf-8')
        expect(configText).toContain(baseConfigFile)

        // 5. Run pinned CLI with emitted arguments
        const output = execFileSync(
          process.execPath,
          [vitestBin, 'run', 'cjs.spec.js', ...iso.toolArgs.vitest],
          {
            cwd: taskDir,
            encoding: 'utf-8',
            stdio: 'pipe',
          },
        )
        expect(output).toContain('1 passed')
        expect(existsSync(iso.vitestCacheDir)).toBe(true)
        const hashDirs = readdirSync(iso.vitestCacheDir)
        expect(hashDirs.length).toBeGreaterThan(0)
        expect(existsSync(join(iso.vitestCacheDir, hashDirs[0]!, 'results.json'))).toBe(true)
      } finally {
        rmSync(taskDir, { recursive: true, force: true })
      }
    })

    it('enforces config precedence order when competing configs exist, selecting vitest.config over vite.config', () => {
      const taskDir = mkdtempSync(join(tmpdir(), 'task-iso-precedence-'))
      try {
        const vitestBin = resolve(process.cwd(), 'node_modules/vitest/vitest.mjs')

        // 1. Competing setup files setting distinct required setup markers
        const setupVitest = join(taskDir, 'setup-vitest.js')
        writeFileSync(setupVitest, 'globalThis.__ACTIVE_CONFIG_MARKER__ = "vitest-config-marker";\n', 'utf-8')
        const setupVite = join(taskDir, 'setup-vite.js')
        writeFileSync(setupVite, 'globalThis.__ACTIVE_CONFIG_MARKER__ = "vite-config-marker";\n', 'utf-8')

        // 2. Both vitest.config.js and vite.config.js exist simultaneously
        const vitestConfigFile = join(taskDir, 'vitest.config.js')
        writeFileSync(
          vitestConfigFile,
          `export default { test: { setupFiles: [${JSON.stringify(setupVitest)}] } };\n`,
          'utf-8',
        )
        const viteConfigFile = join(taskDir, 'vite.config.js')
        writeFileSync(
          viteConfigFile,
          `export default { test: { setupFiles: [${JSON.stringify(setupVite)}] } };\n`,
          'utf-8',
        )

        // 3. Spec file requiring the higher-precedence vitest.config marker
        const specFile = join(taskDir, 'precedence.spec.js')
        writeFileSync(
          specFile,
          'import { test, expect } from "vitest";\ntest("precedence selects vitest over vite", () => expect(globalThis.__ACTIVE_CONFIG_MARKER__).toBe("vitest-config-marker"));\n',
          'utf-8',
        )

        // 4. Create task isolation which must select vitest.config.js over vite.config.js
        const iso = createTaskIsolation(taskDir)
        expect(existsSync(iso.vitestConfigFile)).toBe(true)
        const configText = readFileSync(iso.vitestConfigFile, 'utf-8')
        expect(configText).toContain(vitestConfigFile)
        expect(configText).not.toContain(viteConfigFile)

        // 5. Run pinned CLI with emitted arguments
        const output = execFileSync(
          process.execPath,
          [vitestBin, 'run', 'precedence.spec.js', ...iso.toolArgs.vitest],
          {
            cwd: taskDir,
            encoding: 'utf-8',
            stdio: 'pipe',
          },
        )
        expect(output).toContain('1 passed')
        expect(existsSync(iso.vitestCacheDir)).toBe(true)
      } finally {
        rmSync(taskDir, { recursive: true, force: true })
      }
    })

    it('fails closed when explicit baseConfigFile does not exist', () => {
      const taskDir = mkdtempSync(join(tmpdir(), 'task-iso-missing-'))
      try {
        expect(() =>
          createTaskIsolation(taskDir, { baseConfigFile: '/nonexistent/path/vitest.config.js' }),
        ).toThrow(/Base configuration file not found/)
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

        // 2. Pool with trusted qualification provider and read-only mode succeeds
        const mockProvider = {
          qualify: (_pool: unknown, k: string, _allowed: string) => ({
            ok: true as const,
            receipt: {
              compatibilityKey: k,
              resolvedRootPath: realpathSync(tempRoot),
              resolvedNodeModulesPath: realpathSync(nmDir),
              contentDigest: 'digest-1234',
              verifiedAt: new Date().toISOString(),
              verifiedBy: 'trusted-harness-provider',
              isReadOnly: true,
            },
          }),
        }
        chmodSync(tempRoot, 0o500)
        const q2 = manager.qualifyPoolForReuse(key, tempRoot, { provider: mockProvider })
        expect(q2.ok).toBe(true)
      } finally {
        try { chmodSync(tempRoot, 0o700) } catch {}
        rmSync(tempRoot, { recursive: true, force: true })
      }
    })

    // Regression for Forged Receipt on Writable Directory:
    it('fails closed when an untrusted pool registers a matching receipt on a writable directory without a qualification provider', () => {
      const manager = new DependencyPoolManager()
      const allowedBase = mkdtempSync(join(tmpdir(), 'forged-pool-'))
      try {
        const poolRoot = join(allowedBase, 'pool')
        const nmDir = join(poolRoot, 'node_modules')
        mkdirSync(nmDir, { recursive: true })

        const key = 'dep-forged-key'
        // Register matching receipt fields on a writable synthetic directory
        manager.registerPool({
          id: 'pool-forged',
          key,
          rootPath: poolRoot,
          isImmutable: true,
          state: 'ready',
          receipt: {
            compatibilityKey: key,
            resolvedRootPath: realpathSync(poolRoot),
            resolvedNodeModulesPath: realpathSync(nmDir),
            contentDigest: 'forged-digest-1234',
            verifiedAt: new Date().toISOString(),
            verifiedBy: 'untrusted-caller',
            isReadOnly: true,
          },
        })

        // With NO qualification provider, qualifyPoolForReuse strictly fails closed
        const res = manager.qualifyPoolForReuse(key, allowedBase)
        expect(res.ok).toBe(false)
        if (!res.ok) {
          expect(res.reason).toMatch(/directory is writable on disk|requires a trusted independent read-only qualification provider/)
        }
      } finally {
        rmSync(allowedBase, { recursive: true, force: true })
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
      const poolRoot = join(allowedBase, 'pool')
      const nmDir = join(poolRoot, 'node_modules')
      try {
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

        chmodSync(poolRoot, 0o500)
        const res = manager.qualifyPoolForReuse(key, allowedBase, { provider: mockProvider })
        expect(res.ok).toBe(true)
      } finally {
        try { chmodSync(poolRoot, 0o777) } catch {}
        try { chmodSync(nmDir, 0o777) } catch {}
        try { chmodSync(allowedBase, 0o777) } catch {}
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
