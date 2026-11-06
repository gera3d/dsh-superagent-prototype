import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = path.dirname(fileURLToPath(import.meta.url)), backend = path.resolve(root, '../../..')
const deps = path.resolve(backend, '../plugins/docs/evidence/finding-triage/node_modules')
const require = createRequire(path.join(deps, '../capture.mjs'))
const { build } = require('esbuild'), { chromium } = require('playwright')
const hash = data => createHash('sha256').update(data).digest('hex')
const baseline = '4972e30cd711c076ac58db43564d064d31c316cb'
const git = (...args) => execFileSync('git', args, { cwd: backend })
const baselineSource = git('show', `${baseline}:src/app/delivery-currency.ts`)
if (!(await readFile(path.join(root, 'baseline-helper.ts'))).equals(baselineSource)) throw Error('Baseline source mismatch')
for (const file of ['src/client/delivery-card.tsx', 'src/client/controls.tsx']) {
  if (!(await readFile(path.join(backend, file))).equals(git('show', `${baseline}:${file}`))) throw Error(`Component changed: ${file}`)
}
const sources = {}
for (const file of ['baseline-helper.ts', 'fixture.tsx', 'capture.mjs', '../../../src/app/delivery-currency.ts', '../../../src/client/delivery-card.tsx', '../../../src/client/controls.tsx']) sources[file] = hash(await readFile(path.resolve(root, file)))
const bundle = await build({ entryPoints: [path.join(root, 'fixture.tsx')], bundle: true, write: false,
  format: 'iife', jsx: 'automatic', alias: { react: path.join(deps, 'react'), 'react-dom': path.join(deps, 'react-dom') }, nodePaths: [deps] })
const browser = await chromium.launch({ headless: true })
const images = {}, projections = {}
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1200 }, deviceScaleFactor: 1, colorScheme: 'dark', timezoneId: 'UTC', locale: 'en-US', serviceWorkers: 'block' })
  await context.route('**/*', route => route.abort()) // No live pages, services or endpoints.
  const page = await context.newPage()
  const errors = []; page.on('pageerror', error => errors.push(String(error)))
  for (const variant of ['before', 'after']) {
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#0d1117;color:#e6edf3;font:16px/1.5 system-ui}h1{font-size:26px}summary{cursor:pointer}small{color:#9da7b3}</style></head><body><div id="root"></div></body></html>')
    await page.evaluate(value => { window.variant = value }, variant)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.locator('.dt-delivery-card').waitFor()
    await page.evaluate(() => document.fonts.ready)
    projections[variant] = await page.evaluate(() => window.projection)
    const ownership = await page.getByRole('region', { name: 'Current work ownership' }).count()
    if (ownership !== (variant === 'after' ? 1 : 0)) throw Error('Unexpected helper ownership projection')
    if (await page.getByRole('button').count()) throw Error('Unbound fixture must not offer actions')
    const file = `${variant}.png`
    await page.screenshot({ path: path.join(root, file) })
    images[file] = hash(await readFile(path.join(root, file)))
  }
  if (errors.length) throw Error(errors.join('\n'))
  if (JSON.stringify(projections.before.input) !== JSON.stringify(projections.after.input)) throw Error('Fixture inputs differ')
  await writeFile(path.join(root, 'provenance.json'), JSON.stringify({ baseline, backendHead: git('rev-parse', 'HEAD').toString().trim(), afterIdentity: 'uncommitted working-tree helper, SHA-256 below; component unchanged from baseline', sources, viewport: { width: 1280, height: 1200 }, colorScheme: 'dark', timezone: 'UTC', browser: browser.version(), network: 'blocked; setContent + in-memory bundle; fresh unauthenticated context', projections, images }, null, 2) + '\n')
} finally { await browser.close() }
console.log(JSON.stringify({ baseline, sources, images }, null, 2))
