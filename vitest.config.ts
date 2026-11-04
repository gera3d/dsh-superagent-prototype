import { defineConfig } from 'vitest/config'
// Share one React instance across DSH client packages and tests.
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    // These integration specs spawn native processes as well as workers. CPU-count
    // parallelism starves subprocess readiness and jsdom on a busy DSH host.
    // Bound concurrency instead of relaxing the production/test deadlines.
    maxWorkers: 2,
  },
})
