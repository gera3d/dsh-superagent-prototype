// Isolated browser only. No connection to user's CDP, profile or live application.
import { build } from '../../node_modules/.pnpm/vite@8.2.2_@types+node@22.20.0_yaml@2.9.1/node_modules/vite/dist/node/index.js'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../..')
const output = resolve(root, '../evidence/ui-fixtures')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
try {
  for (const mode of ['before', 'after', 'delivery', 'publish']) {
    const bundle = await build({ root, configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': JSON.stringify('production') }, resolve: { alias: mode === 'before' ? [{ find: '../../src/client/lifecycle-card.tsx', replacement: resolve(root, '../baseline-backend/src/client/lifecycle-card.tsx') }] : [] }, esbuild: { jsx: 'automatic' }, build: { write: false, minify: false, lib: { entry: resolve(root, 'tests/fixtures/delivery-visual.tsx'), name: 'DeliveryFixture', formats: ['iife'] } } })
    const code = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(f => f.type === 'chunk').code
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 1 })
    page.on('pageerror', error => console.error('Fixture page error:', error.message))
    await page.setContent('<html><head><style>body{background:#0d1117;color:#e6edf3;font:15px system-ui;margin:28px}header{border:1px solid #8b949e;padding:12px;margin-bottom:16px;color:#d29922}dd{margin-bottom:8px;overflow-wrap:anywhere}button{margin-top:12px;border:1px solid #526177;border-radius:6px;padding:9px 14px;background:#238636;color:white}button:disabled{opacity:.5}p{line-height:1.45}</style></head><body><div id="root"></div></body></html>')
    await page.evaluate(mode => { globalThis.__fixtureMode = mode }, mode)
    await page.addScriptTag({ content: code })
    await page.locator('section').first().waitFor()
    if (mode !== 'delivery') {
      const count = await page.getByRole('button', { name: 'Approve + publish', exact: true }).count()
      if (count !== (mode === 'before' ? 1 : 0)) throw new Error(`Unexpected ${mode} approval count ${count}`)
    }
    if (mode === 'publish') await page.locator('details[aria-label="Pinned scope and publication references"]').evaluate(node => { node.open = true })
    await page.screenshot({ path: resolve(output, `${mode}.png`), fullPage: true })
    await writeFile(resolve(output, `${mode}.html`), await page.content())
    await page.close()
  }
} finally { await browser.close() }
console.log(`Isolated fixture captures saved to ${output}`)
