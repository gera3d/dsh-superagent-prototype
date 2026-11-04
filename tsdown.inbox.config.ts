import { defineConfig } from 'tsdown'

// Rebuild the independent inbox without rewriting the orchestrator's loaded entry or shared chunks.
export default defineConfig({
  entry: { 'decision-inbox-provider-canonical': 'src/app/decision-inbox-provider.ts' },
  outDir: 'lib', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024',
  dts: false, clean: false,
  deps: { neverBundle: [/^@deepseek-ai\//, 'zod', 'proper-lockfile'] },
})
