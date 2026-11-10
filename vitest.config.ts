import { existsSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

// These specs exercise the dsh-next-steps plugin, a separate repository (gera3d/dsh-plugins).
// They run only when it is checked out next to this repository.
const pluginPresent = existsSync(new URL('../dsh-next-steps/src/index.ts', import.meta.url))
const needsPlugin = ['tests/canonical-next-steps.spec.ts', 'tests/specialist-integration.spec.ts', 'tests/inline-decision.spec.tsx']
// Share one React instance across DSH client packages and tests.
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    exclude: pluginPresent ? ['node_modules/**'] : ['node_modules/**', ...needsPlugin],
    // These integration specs spawn native processes as well as workers. CPU-count
    // parallelism starves subprocess readiness and jsdom on a busy DSH host.
    // Bound concurrency instead of relaxing the production/test deadlines.
    maxWorkers: 2,
  },
})
