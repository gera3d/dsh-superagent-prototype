// Isolated browser only. No connection to the user's CDP, profile or live application.
// Builds the completed-job area twice (base area, then the same area with the new summary) and captures both with headless Chrome.
import { build } from '../../node_modules/.pnpm/vite@8.2.2_@types+node@22.20.0_yaml@2.9.1/node_modules/vite/dist/node/index.js'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../..')
const output = resolve(root, '../evidence/ui-fixtures')
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
await mkdir(output, { recursive: true })
const bundle = await build({ root, configFile: false, logLevel: 'error',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') }, esbuild: { jsx: 'automatic' },
  build: { write: false, minify: false, lib: { entry: resolve(root, 'tests/fixtures/job-usage-visual.tsx'),
    name: 'JobUsageFixture', formats: ['iife'] } } })
const code = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(entry => entry.type === 'chunk').code
for (const mode of ['before', 'after']) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{background:#0d1117;color:#e6edf3;font:15px system-ui;margin:28px}</style></head><body><div id="root"></div><script>globalThis.__fixtureMode = ${JSON.stringify(mode)}</script><script>${code}</script></body></html>`
  const file = resolve(output, `job-usage-${mode}.html`)
  await writeFile(file, html)
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1200,900',
    `--screenshot=${resolve(output, `job-usage-${mode}.png`)}`, `file://${file}`], { timeout: 120_000 })
}
console.log(`Isolated fixture captures saved to ${output}`)
