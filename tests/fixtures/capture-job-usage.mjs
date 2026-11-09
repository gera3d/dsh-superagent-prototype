// Isolated browser only. No connection to the user's CDP, profile or live application.
// Builds the completed-job area twice (base area, then the same area with the new summary) and captures both with headless Chrome.
import { build } from 'vite'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const output = process.env.JOB_USAGE_FIXTURE_OUTPUT
  ? resolve(root, process.env.JOB_USAGE_FIXTURE_OUTPUT)
  : resolve(root, 'evidence/ui-fixtures')
const relativeOutput = relative(root, output)
if (relativeOutput === '..' || relativeOutput.startsWith('../') || relativeOutput.startsWith('..\\') || isAbsolute(relativeOutput)) {
  throw new Error('JOB_USAGE_FIXTURE_OUTPUT must stay inside the checkout')
}

function resolveBrowser() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN
  if (process.env.BROWSER_BIN && existsSync(process.env.BROWSER_BIN)) return process.env.BROWSER_BIN
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const chrome = resolveBrowser()
if (!chrome) {
  console.error('Error: Headless browser not found. Set CHROME_BIN or BROWSER_BIN to a valid Chrome/Chromium executable path.')
  process.exit(1)
}

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
