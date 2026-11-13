// Isolated browser only: builds the Ticket page and Source status fixtures from the checkout in GH_CALLS_ROOT (default: this one) and
// captures them with headless Chrome. Run it on the base revision and on the changed one for Before and After captures.
import { build } from 'vite'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(process.env.GH_CALLS_ROOT ?? resolve(import.meta.dirname, '../..'))
const output = resolve(process.env.GH_CALLS_OUTPUT ?? resolve(root, 'evidence/ui-fixtures'))
const label = process.env.GH_CALLS_LABEL ?? 'after'
const chrome = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']
  .find(path => path && existsSync(path))
if (!chrome) { console.error('Set CHROME_BIN to a Chrome/Chromium executable.'); process.exit(1) }
await mkdir(output, { recursive: true })
const bundle = await build({ root, configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  esbuild: { jsx: 'automatic' }, build: { write: false, minify: false, lib: { entry: resolve(root, 'tests/fixtures/gh-calls-visual.tsx'), name: 'GhCallsFixture', formats: ['iife'] } } })
const code = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(entry => entry.type === 'chunk').code
for (const page of (process.env.GH_CALLS_PAGES ?? 'ticket,source').split(',')) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{background:#0d1117;color:#e6edf3;font:15px system-ui;margin:28px}</style></head><body><div id="root"></div><script>globalThis.__fixtureMode=${JSON.stringify(label)};globalThis.__fixturePage=${JSON.stringify(page)}</script><script>${code}</script></body></html>`
  const file = resolve(output, `gh-calls-${page}-${label}.html`)
  await writeFile(file, html)
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=4000', '--window-size=1100,800',
    `--screenshot=${resolve(output, `gh-calls-${page}-${label}.png`)}`, `file://${file}`], { timeout: 120_000, stdio: 'ignore' })
}
console.log(`Captures saved to ${output}`)
