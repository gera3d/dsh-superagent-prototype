#!/usr/bin/env node
/** Deployment smoke check: invalid requests exercise registration without staging, sending or resolving anything. */
const base = new URL(process.argv[2] || 'http://127.0.0.1:3082')
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.username || base.password) {
  throw new Error('Expected a loopback HTTP URL without credentials')
}
const headers = { 'x-orchestrator-request': '1', 'content-type': 'application/json' }
async function request(path, method = 'GET') {
  return fetch(new URL(`/orchestrator/api/decisions/${path}`, base), {
    method, headers, signal: AbortSignal.timeout(15000), ...(method === 'POST' ? { body: '{}' } : {}),
  })
}
const response = await request('inbox')
if (!response.ok) throw new Error(`Inbox returned HTTP ${response.status}`)
const { items } = await response.json()
const item = items.find(item => typeof item.id === 'string')
if (!item) throw new Error('No existing decision is available to check known-item route registration')
let failed = false
for (const operation of ['stage', 'submission', 'discard-staging', 'restart']) {
  const result = await request(`${encodeURIComponent(item.id)}/${operation}`, 'POST')
  console.log(`${operation}: HTTP ${result.status} (expected 400 for deliberately invalid input)`)
  if (result.status !== 400) failed = true
  await result.body?.cancel()
}
const evaluator = await request('evaluate')
console.log(`evaluate: HTTP ${evaluator.status} (expected 405 for GET; no model call)`)
if (evaluator.status !== 405) failed = true
await evaluator.body?.cancel()
if (failed) {
  console.error('Decision deployment is out of sync. Rebuild and activate the independent inbox provider; a successful source build alone is insufficient.')
  process.exitCode = 1
} else {
  console.log('Live decision routes are registered. No choices were staged, sent, restarted or resolved.')
}
