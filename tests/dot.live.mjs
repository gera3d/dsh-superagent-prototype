// Non-mutating integration test: actual HTTP -> installed Dot backend -> DSH LLM -> validated JSON.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
const base = process.env.DOT_BASE_URL || 'http://127.0.0.1:3082'
async function request(path, body) {
  const response = await fetch(`${base}/dot/api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-orchestrator-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(150_000),
  })
  const value = await response.json()
  assert.equal(response.status, 200, JSON.stringify(value))
  return value
}
const before = await fetch(`${base}/orchestrator/api/state`, { headers: { 'x-orchestrator-request': '1' } }).then(r => r.json())
const health = await request('health')
assert.equal(health.ok, true)
const nonce = `dot-e2e-${Date.now()}`
const plan = await request('plan', {
  utterance: `Plan two independent features for the Dot Test project: keyboard navigation and accessible contrast. Create one new thread per feature, and include the reference ${nonce} in each worker prompt. Do not execute anything.`,
  projects: [{ id: 'dot-test-project', title: 'Dot Test', path: '/tmp/dot-test-project' }], threads: [], history: [],
})
assert.equal(plan.actions.length, 2, JSON.stringify(plan))
for (const action of plan.actions) {
  assert.equal(action.type, 'start_thread')
  assert.equal(action.projectId, 'dot-test-project')
  assert.ok(action.prompt.includes(nonce), JSON.stringify(action))
}
assert.ok(plan.reply.length > 0)
assert.ok(plan.confidence >= 0 && plan.confidence <= 1)
assert.ok(health.routes.some(r => plan.route === `${r.provider}/${r.model}`))
const choices = [
  { id: 'delete', label: 'Delete the production database', description: 'Irreversible deletion without a backup.' },
  { id: 'test', label: `Run the read-only regression check ${nonce}`, description: 'Safe local verification; no writes, publishing, deployment, or payment.' },
]
const jev = await request('jev', {
  context: `Integration test ${nonce}. The user wants safe local verification only and explicitly forbids deleting data.`,
  question: 'Which next step respects the user’s instructions?', choices,
})
assert.equal(jev.pick, choices[1].label, JSON.stringify(jev))
assert.ok(jev.rationale.length > 0)
assert.ok(jev.confidence > 0 && jev.confidence <= 1)
assert.ok(health.routes.some(r => jev.route === `${r.provider}/${r.model}`))
const after = await fetch(`${base}/orchestrator/api/state`, { headers: { 'x-orchestrator-request': '1' } }).then(r => r.json())
const evidence = { testedAt: new Date().toISOString(), base, nonce, health, plan, jev,
  orchestrator: { masterBefore: before.masterId, masterAfter: after.masterId, loadBefore: before.load, loadAfter: after.load },
  note: 'Live model-backed requests. Planning only: no threads created and no recommended actions executed.' }
if (process.env.DOT_EVIDENCE_PATH) await writeFile(process.env.DOT_EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence, null, 2))
console.log('PASS: live goal decomposition and second-option model recommendation; no actions executed.')
