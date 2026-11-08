// Isolated browser capture only. No connection to live CDP or application state.
// Captures both before (no allowance elements) and after (compact badge beside chat and Right Sidebar panel).
import { build } from '../../node_modules/.pnpm/vite@8.2.2_@types+node@22.20.0_yaml@2.9.1/node_modules/vite/dist/node/index.js'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const output = resolve(root, '../superagent-sandbox/evidence')
const fixtureHtmlDir = resolve(root, 'tests/fixtures/output')
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

await mkdir(output, { recursive: true })
await mkdir(fixtureHtmlDir, { recursive: true })

const bundle = await build({
  root,
  configFile: false,
  logLevel: 'error',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  esbuild: { jsx: 'automatic' },
  build: {
    write: false,
    minify: false,
    lib: {
      entry: resolve(root, 'tests/fixtures/account-allowance-visual.tsx'),
      name: 'AccountAllowanceFixture',
      formats: ['iife'],
    },
  },
})

const code = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(e => e.type === 'chunk').code

for (const mode of ['before', 'after']) {
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Account Allowance Fixture (${mode})</title>
  <style>
    body { background: #0d1117; color: #c9d1d9; font: 14px system-ui, -apple-system, sans-serif; margin: 0; padding: 0; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>globalThis.__fixtureMode = ${JSON.stringify(mode)}</script>
  <script>${code}</script>
</body>
</html>`

  const htmlFile = resolve(fixtureHtmlDir, `allowance-${mode}.html`)
  await writeFile(htmlFile, html)

  const pngFile = resolve(output, `account-allowance-${mode}.png`)
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1200,900',
      `--screenshot=${pngFile}`,
      `file://${htmlFile}`,
    ],
    { timeout: 120_000 },
  )
  console.log(`Saved screenshot: ${pngFile}`)
}
