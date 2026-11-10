#!/usr/bin/env node
'use strict'
// Smoke test: drives server.cjs over stdio against a mock orchestrator. No real service is touched.
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const SERVER = path.join(__dirname, '..', 'server.cjs')
const TOKEN = 'tok_ABCDEFGHIJKLMNOP1234'
const SESSION = 'sess_Zz9Yy8Xx7Ww6'
const SECRET_BODY = 'SECRETVALUE-xyz-do-not-log'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mcp-test-'))

let passed = 0, failed = 0
function ok(cond, name, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`) } else { failed++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`) }
}

// ---------------------------------------------------------------- mock orchestrator
const seen = []   // every request the mock received
let tokenLogins = 0
const findings = []
const decisions = [
  { id: 'd1', status: 'pending', urgency: 'high', ticketTitle: 'Pick a db', question: 'Which db?', sessionId: 's1', createdAt: 1700000000000,
    context: 'CONTEXT-EXCERPT-TEXT', choices: [{ id: 'a', label: 'Postgres', prompt: 'PROMPT-A-TEXT' }, { id: 'b', label: 'SQLite', prompt: 'PROMPT-B-TEXT' }],
    recommendation: { recommendedValue: 'a', confidence: 0.8, rationale: 'because' } },
  { id: 'd2', status: 'resolved', question: 'Old?', sessionId: 's1', createdAt: 1690000000000, choices: [{ id: 'x', label: 'X' }], resolvedChoice: 'x' },
]
const mock = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1')
    seen.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body: raw })
    const json = (status, value, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/' && url.searchParams.get('token')) {
      if (url.searchParams.get('token') !== TOKEN) return json(403, { error: 'bad token' })
      tokenLogins++
      res.writeHead(302, { location: '/', 'set-cookie': `dsh_session=${SESSION}; Path=/; HttpOnly` }); return res.end()
    }
    if (!url.pathname.startsWith('/orchestrator/api/')) return json(404, { error: 'nope' })
    if (!(req.headers.cookie || '').includes(`dsh_session=${SESSION}`)) return json(401, { error: 'auth required' })
    if (req.headers['x-orchestrator-request'] !== '1') return json(403, { error: 'missing header' })
    const rel = url.pathname.slice('/orchestrator/api/'.length)
    const body = raw ? JSON.parse(raw) : undefined
    if (req.method === 'GET') {
      if (rel === 'state') return json(200, { health: { executor: { state: 'ready' }, eval: { state: 'degraded' } }, token: 'hide-me-please-1234' })
      if (rel === 'overview') return json(200, { tickets: 3, pending: 1 })
      if (rel === 'sources') return json(200, { sources: [{ id: 'github', status: 'ok' }] })
      if (rel === 'tickets') return json(200, { items: [{ id: 't1', title: 'Fix it' }], q: Object.fromEntries(url.searchParams) })
      if (rel === 'tickets/t1') return json(200, { id: 't1', title: 'Fix it', assignments: [] })
      if (rel === 'decisions/inbox') return json(200, { items: decisions })
      if (rel === 'findings') return json(200, { items: findings })
      if (rel === 'settings') return json(200, { policy: { revision: 4, value: {} } })
      if (rel === 'threads') return json(500, { error: `upstream failed token=${TOKEN} also ${TOKEN}` })
      return json(404, { error: 'unknown GET' })
    }
    if (req.method === 'POST') {
      if (rel === 'decisions/d1/resolve') return json(200, { ok: true, choiceId: body.choiceId })
      if (rel === 'findings/observe') {
        let finding = findings.find(f => f.dedupKey === body.dedupKey)
        if (!finding) { finding = { ...body, id: 'f1', revision: 1, state: 'awaiting_decision', observations: [body.occurrence], provenance: { source: 'external' } }; findings.push(finding) }
        return json(200, { finding, execution_authorized: false })
      }
      if (rel === 'findings/denied/coordinate') return json(403, { error: 'No prior native approval' })
      if (rel === 'executor/pause') return json(200, { paused: body.paused })
      if (rel === 'tickets/t1/retry') return json(200, { ok: true })
      return json(200, { ok: true })
    }
    if (req.method === 'PUT') {
      if (rel === 'settings/policy') return body.revision === 4 ? json(200, { ok: true, revision: 5 }) : json(409, { error: 'revision conflict' })
      return json(200, { ok: true })
    }
    return json(405, { error: 'method' })
  })
})

// ---------------------------------------------------------------- stdio client
function launch(env, { cwd } = {}) {
  const base = { ...process.env }
  for (const k of Object.keys(base)) if (k.startsWith('DSH_')) delete base[k]
  const child = spawn(process.execPath, [SERVER], { env: { ...base, ...env }, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map(); let nextId = 1, buffer = '', stderr = ''
  child.stdout.on('data', chunk => {
    buffer += chunk
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    }
  })
  child.stderr.on('data', c => { stderr += c })
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)))
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20000)
    pending.set(id, msg => { clearTimeout(timer); resolve(msg) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  const call = async (name, args = {}) => {
    const msg = await request('tools/call', { name, arguments: args })
    if (msg.error) return { rpcError: msg.error }
    const text = msg.result.content.map(c => c.text).join('')
    return { isError: !!msg.result.isError, text, json: (() => { try { return JSON.parse(text) } catch { return undefined } })() }
  }
  return { child, request, call, exited, stderr: () => stderr, close: () => { child.stdin.end(); child.kill() } }
}

async function main() {
  await new Promise(r => mock.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${mock.address().port}`
  const audit = path.join(tmp, 'audit.log')
  const env = { DSH_SUPERAGENT_URL: url, DSH_SUPERAGENT_TOKEN: TOKEN, DSH_MCP_AUDIT_LOG: audit }

  console.log('\nprotocol')
  const s = launch(env)
  let r = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })
  ok(r.result.serverInfo.name === 'dsh-superagent-control', 'initialize returns server info')
  ok(r.result.protocolVersion === '2025-06-18', 'initialize echoes a supported protocol version')
  r = await s.request('initialize', { protocolVersion: '1999-01-01' })
  ok(r.result.protocolVersion === '2025-06-18', 'unknown protocol version falls back to newest supported')
  r = await s.request('tools/list')
  const names = r.result.tools.map(t => t.name)
  for (const n of ['harness_status', 'list_tickets', 'get_ticket', 'decision_inbox', 'get_decision', 'get_settings', 'get_prompts', 'list_threads', 'search',
    'list_findings', 'get_finding', 'observe_finding', 'coordinate_finding', 'resolve_decision', 'dismiss_decision', 'restart_decision', 'pause_executor', 'retry_ticket', 'stop_ticket', 'requeue_trigger', 'sync_policy', 'save_settings', 'save_prompts', 'check_setup', 'api_request'])
    ok(names.includes(n), `tools/list has ${n}`)
  ok(r.result.tools.every(t => t.inputSchema && t.annotations && typeof t.annotations.readOnlyHint === 'boolean'), 'every tool has a schema and annotations')
  r = await s.request('ping'); ok(r.result && Object.keys(r.result).length === 0, 'ping')
  r = await s.request('nope/method'); ok(r.error && r.error.code === -32601, 'unknown method → -32601')
  r = await s.request('resources/list'); ok(Array.isArray(r.result.resources), 'resources/list is empty list')

  console.log('\nreads + auth')
  let t = await s.call('harness_status')
  ok(!t.isError && t.json && t.json.mode === 'read-write', 'harness_status works', t.text)
  ok(tokenLogins === 1, 'authenticated exactly once via the token URL', `logins=${tokenLogins}`)
  ok(t.json && t.json.attention && t.json.attention.some(a => a.part === 'eval'), 'harness_status flags the degraded part')
  ok(!t.text.includes(TOKEN) && !t.text.includes('hide-me-please'), 'secrets/tokens are redacted from output')
  const first401 = seen.find(x => x.path === '/orchestrator/api/state')
  ok(first401 && first401.headers['x-orchestrator-request'] === '1', 'every API call carries x-orchestrator-request')
  t = await s.call('harness_status'); ok(tokenLogins === 1, 'cookie is reused, no second login')

  t = await s.call('list_tickets', { state: 'open', limit: 5 })
  ok(!t.isError && t.json.items[0].id === 't1', 'list_tickets')
  const q = seen.filter(x => x.path === '/orchestrator/api/tickets').pop()
  ok(q.search.includes('state=open') && q.search.includes('limit=5'), 'list_tickets sends filters as query')
  t = await s.call('get_ticket', { id: 't1' }); ok(!t.isError && t.json.id === 't1', 'get_ticket')

  t = await s.call('decision_inbox')
  ok(!t.isError && t.json.matched === 1 && t.json.items[0].id === 'd1', 'decision_inbox defaults to pending only')
  ok(t.json.counts.pending === 1 && t.json.counts.resolved === 1, 'decision_inbox reports counts')
  ok(!t.text.includes('PROMPT-A-TEXT') && !t.text.includes('CONTEXT-EXCERPT-TEXT'), 'inbox omits prompts and context by default')
  t = await s.call('decision_inbox', { status: 'all', include_context: true })
  ok(t.json.matched === 2 && t.text.includes('CONTEXT-EXCERPT-TEXT') && !t.text.includes('PROMPT-A-TEXT'), 'include_context adds context but still no prompts')
  t = await s.call('get_decision', { id: 'd1' })
  ok(t.text.includes('PROMPT-A-TEXT') && t.text.includes('CONTEXT-EXCERPT-TEXT'), 'get_decision includes prompts and context')
  t = await s.call('get_decision', { id: 'zzz' }); ok(t.isError && /No decision/.test(t.text), 'get_decision on a missing id is a clean error')
  t = await s.call('get_settings'); ok(!t.isError && t.json.policy.revision === 4, 'get_settings')

  console.log('\nguards')
  const before = seen.length
  for (const bad of ['../x', '..%2fadmin', 'a/b', 'a b', 'x?y=1', '']) {
    t = await s.call('get_ticket', { id: bad })
    ok(t.isError, `get_ticket rejects id ${JSON.stringify(bad)}`)
  }
  ok(seen.length === before, 'rejected ids never reached the network')
  t = await s.call('api_request', { method: 'GET', path: '../../etc/passwd' }); ok(t.isError && /not permitted/.test(t.text), 'api_request refuses traversal')
  t = await s.call('api_request', { method: 'POST', path: 'tickets/t1/delete' }); ok(t.isError && /not permitted/.test(t.text), 'api_request refuses routes not in the table')
  t = await s.call('api_request', { method: 'POST', path: '/tickets/t1/retry' }); ok(!t.isError, 'api_request allows a table route')
  t = await s.call('api_request', { method: 'DELETE', path: 'tickets/t1' }); ok(t.isError, 'api_request refuses DELETE')
  t = await s.call('no_such_tool'); ok(t.rpcError && t.rpcError.code === -32602, 'unknown tool → -32602')
  const pre = seen.length
  t = await s.call('check_setup')
  ok(t.isError && /DSH_MCP_ALLOW_RESTART/.test(t.text) && seen.length === pre, 'check_setup (restart route) is gated and never sent')
  t = await s.call('list_threads')
  ok(t.isError && !t.text.includes(TOKEN), 'upstream 500 is surfaced without leaking the token', t.text)

  console.log('\nwrites')
  t = await s.call('resolve_decision', { id: 'd1', choice_id: 'nope' })
  ok(t.isError && /not one of/.test(t.text), 'resolve_decision validates choice against the decision')
  ok(!seen.some(x => x.method === 'POST' && x.path.endsWith('/resolve')), 'invalid choice sent no POST')
  t = await s.call('resolve_decision', { id: 'd1', choice_id: 'a' })
  const post = seen.find(x => x.method === 'POST' && x.path === '/orchestrator/api/decisions/d1/resolve')
  ok(!t.isError && post && JSON.parse(post.body).choiceId === 'a', 'resolve_decision POSTs {choiceId}', t.text)
  t = await s.call('pause_executor', { paused: true })
  ok(!t.isError && JSON.parse(seen.filter(x => x.path.endsWith('executor/pause')).pop().body).paused === true, 'pause_executor POSTs {paused:true}')
  t = await s.call('pause_executor', { paused: 'yes' }); ok(t.isError, 'pause_executor validates boolean')
  t = await s.call('retry_ticket', { id: 't1' }); ok(!t.isError, 'retry_ticket')
  t = await s.call('save_settings', { block: 'policy', value: { note: SECRET_BODY }, revision: 3 })
  ok(t.isError && /stale revision/.test(t.text), 'save_settings with a stale revision → friendly 409 message', t.text)
  t = await s.call('save_settings', { block: 'policy', value: { note: SECRET_BODY }, revision: 4 })
  const put = seen.filter(x => x.method === 'PUT').pop()
  ok(!t.isError && put.path === '/orchestrator/api/settings/policy' && JSON.parse(put.body).revision === 4, 'save_settings PUTs value + revision')
  t = await s.call('save_settings', { block: 'models', value: { hierarchy: [], maxEscalations: 0, helper: null }, revision: 8 })
  const modelsPut = seen.filter(x => x.method === 'PUT').pop()
  ok(!t.isError && modelsPut.path === '/orchestrator/api/settings/models' && JSON.parse(modelsPut.body).revision === 8, 'save_settings supports the exact models block with revision fencing')
  t = await s.call('save_settings', { block: 'bogus', value: {}, revision: 1 }); ok(t.isError && /not permitted/.test(t.text), 'save_settings refuses unknown blocks')

  console.log('\nfinding observation boundary')
  const finding = { dedupKey: 'case-one', title: 'Inspect bounded behavior', problem: SECRET_BODY, scope: 'Read only this fixture',
    owner: 'operator', kind: 'verification', requirements: ['native-proof'], repository: 'owner/repo',
    occurrence: { id: 'observation-one', reference: 'https://example.test/evidence', evidence: 'Observed only; no authority' } }
  t = await s.call('observe_finding', { finding })
  ok(!t.isError && t.json.execution_authorized === false && t.json.finding.state === 'awaiting_decision', 'MCP records observation without dispatch or approval', t.text)
  const observationPost = seen.filter(x => x.path === '/orchestrator/api/findings/observe').pop()
  ok(observationPost && JSON.parse(observationPost.body).dedupKey === finding.dedupKey, 'observation uses exactly the data-only route')
  ok(observationPost && !observationPost.headers.origin && !observationPost.headers['sec-fetch-site'] && !observationPost.headers['sec-fetch-dest'] && observationPost.headers['sec-fetch-mode'] !== 'same-origin', 'MCP never synthesizes browser approval headers')
  t = await s.call('observe_finding', { finding }); ok(!t.isError && findings.length === 1 && t.json.finding.id === 'f1', 'repeat transport observation preserves backend identity')
  t = await s.call('list_findings', { state: 'awaiting_decision' }); ok(!t.isError && t.json.matched === 1 && t.json.items[0].id === 'f1', 'finding read exposes current canonical identity')
  t = await s.call('list_findings', { state: 'resolved' }); ok(!t.isError && t.json.matched === 0, 'finding list filters the returned state')
  t = await s.call('get_finding', { id: 'f1' }); ok(!t.isError && t.json.scope === finding.scope, 'get_finding preserves bounded scope')
  t = await s.call('get_finding', { id: 'absent' }); ok(t.isError && /not found/i.test(t.text), 'missing finding is a clean read error')
  t = await s.call('coordinate_finding', { id: 'f1', instruction_file: '/tmp/exact-coordination.json' })
  ok(!t.isError, 'approved finding coordination uses its typed backend path', t.text)
  const coordinationPost = seen.at(-1)
  ok(coordinationPost.path === '/orchestrator/api/findings/f1/coordinate' && JSON.stringify(JSON.parse(coordinationPost.body)) === JSON.stringify({ instructionFile: '/tmp/exact-coordination.json' }), 'transport sends only the instruction path, no authority claim')
  ok(!coordinationPost.headers.origin && !coordinationPost.headers['sec-fetch-site'] && !coordinationPost.headers['sec-fetch-dest'], 'headless coordination never impersonates browser origin')
  const beforeInvalidCoordination = seen.length
  t = await s.call('coordinate_finding', { id: 'f1', instruction_file: 'relative.json' }); ok(t.isError, 'relative instruction path refused')
  t = await s.call('coordinate_finding', { id: 'f1', instruction_file: '/tmp/x', actor: 'local-operator' }); ok(t.isError, 'transport rejects invented operator authority')
  ok(seen.length === beforeInvalidCoordination, 'invalid coordination does not reach backend')
  t = await s.call('coordinate_finding', { id: 'denied', instruction_file: '/tmp/x' }); ok(t.isError && /prior native approval/.test(t.text), 'backend approval denial is preserved')
  const observationCount = seen.length
  t = await s.call('observe_finding', { finding, actor: 'local-operator' }); ok(t.isError, 'observation rejects caller approval identity')
  t = await s.call('observe_finding', { finding: { ...finding, authority: 'approved' } }); ok(t.isError, 'observation rejects invented authority fields')
  t = await s.call('list_findings', { state: 'bogus' }); ok(t.isError, 'unknown finding filter is refused')
  for (const path of ['findings/f1/confirm', 'findings/f1/review', 'findings/f1/revisit', 'findings/f1/evidence', 'findings']) {
    t = await s.call('api_request', { method: 'POST', path, body: { actor: 'local-operator', choiceId: 'fix_now' } })
    ok(t.isError && /not permitted/.test(t.text), `MCP escape refuses privileged route ${path}`)
  }
  ok(seen.length === observationCount, 'rejected finding authority requests never reach the backend')
  decisions.push({ id: 'fd1', status: 'pending', actionMode: 'finding_triage', finding: { id: 'f1', revision: 1, state: 'awaiting_decision' }, choices: [{ id: 'fix_now', label: 'Fix now' }] })
  t = await s.call('get_decision', { id: 'fd1' }); ok(!t.isError && t.json.actionMode === 'finding_triage' && t.json.finding.id === 'f1', 'decision reads identify typed findings')
  const writeCount = seen.filter(x => x.method !== 'GET').length
  t = await s.call('resolve_decision', { id: 'fd1', choice_id: 'fix_now' }); ok(t.isError && /typed finding/.test(t.text), 'generic choice resolution cannot confirm finding work')
  t = await s.call('dismiss_decision', { id: 'fd1' }); ok(t.isError && /typed finding/.test(t.text), 'generic dismissal cannot defer a typed finding')
  t = await s.call('restart_decision', { id: 'fd1', session_id: 's1' }); ok(t.isError && /typed finding/.test(t.text), 'generic restart cannot reopen a typed finding')
  for (const action of ['resolve', 'dismiss', 'restart', 'stage', 'submission', 'discard-staging']) {
    t = await s.call('api_request', { method: 'POST', path: `decisions/fd1/${action}`, body: { choiceId: 'fix_now', sessionId: 's1' } })
    ok(t.isError && /typed finding/.test(t.text), `generic escape cannot mutate typed finding via ${action}`)
  }
  ok(seen.filter(x => x.method !== 'GET').length === writeCount, 'typed decision guards send no mutation')
  decisions.pop()

  console.log('\naudit log')
  const lines = fs.readFileSync(audit, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  ok(lines.length >= 5, 'writes are audited', `lines=${lines.length}`)
  const res = lines.find(l => l.tool === 'resolve_decision' && l.status === 200)
  ok(res && res.method === 'POST' && res.route === 'decisions/d1/resolve' && res.bodyKeys.includes('choiceId'), 'audit records tool, route and body keys')
  ok(lines.some(l => l.tool === 'save_settings' && l.status === 409), 'audit records failed attempts too')
  const auditText = fs.readFileSync(audit, 'utf8')
  ok(!auditText.includes(SECRET_BODY) && !auditText.includes(TOKEN) && !auditText.includes(SESSION), 'audit never contains body values, token or cookie')
  ok((fs.statSync(audit).mode & 0o077) === 0, 'audit file is owner-only')
  ok(!s.stderr().includes(TOKEN) && !s.stderr().includes(SESSION), 'stderr never contains token or cookie')
  s.close()

  console.log('\nread-only mode')
  const ro = launch({ ...env, DSH_MCP_READONLY: '1', DSH_MCP_AUDIT_LOG: path.join(tmp, 'ro-audit.log') })
  await ro.request('initialize', { protocolVersion: '2025-06-18' })
  const roNames = (await ro.request('tools/list')).result.tools.map(x => x.name)
  ok(roNames.includes('harness_status') && !roNames.includes('resolve_decision') && !roNames.includes('api_request') && !roNames.includes('save_settings'), 'read-only hides every write tool')
  const attempt = await ro.call('resolve_decision', { id: 'd1', choice_id: 'a' }); ok(attempt.rpcError, 'read-only refuses write tools')
  ok(!(await ro.call('decision_inbox')).isError, 'read-only still serves reads')
  ok(roNames.includes('list_findings') && roNames.includes('get_finding') && !roNames.includes('observe_finding'), 'read-only exposes finding reads but hides observation')
  ok((await ro.call('observe_finding', { finding })).rpcError, 'read-only refuses observation before HTTP')
  ok(!roNames.includes('coordinate_finding') && (await ro.call('coordinate_finding', { id: 'f1', instruction_file: '/tmp/x' })).rpcError, 'read-only hides and refuses coordination')
  ok(!(await ro.call('list_findings')).isError, 'read-only finding lookup works')
  ro.close()

  console.log('\nrestart gate opened')
  const rs = launch({ ...env, DSH_MCP_ALLOW_RESTART: '1', DSH_MCP_AUDIT_LOG: path.join(tmp, 'rs-audit.log') })
  await rs.request('initialize', { protocolVersion: '2025-06-18' })
  const cs = await rs.call('check_setup'); ok(!cs.isError, 'check_setup works when DSH_MCP_ALLOW_RESTART=1', cs.text)
  rs.close()

  console.log('\ntoken discovery from logs')
  const logs = path.join(tmp, 'logs'); fs.mkdirSync(logs)
  fs.writeFileSync(path.join(logs, 'dsh-superagent-20260101.log'), `boot\ndsh web: ${url}/?token=${TOKEN}\nmore lines\n`)
  const logins = tokenLogins
  const ld = launch({ DSH_SUPERAGENT_URL: url, DSH_SUPERAGENT_LOG_DIR: logs, DSH_MCP_AUDIT_LOG: path.join(tmp, 'ld-audit.log') })
  await ld.request('initialize', { protocolVersion: '2025-06-18' })
  t = await ld.call('harness_status'); ok(!t.isError && tokenLogins === logins + 1, 'finds the token in the newest service log', t.text)
  ld.close()
  const nt = launch({ DSH_SUPERAGENT_URL: url, DSH_SUPERAGENT_LOG_DIR: path.join(tmp, 'empty'), DSH_MCP_AUDIT_LOG: path.join(tmp, 'nt-audit.log') })
  await nt.request('initialize', { protocolVersion: '2025-06-18' })
  t = await nt.call('list_tickets'); ok(t.isError && /no token was found/.test(t.text), 'no token anywhere → clear message')
  nt.close()

  console.log('\nstartup + failure behavior')
  for (const bad of ['http://example.com:3082', 'https://127.0.0.1:3082', 'http://user:pw@127.0.0.1:3082', 'http://127.0.0.1.evil.com:3082', 'not a url']) {
    const p = launch({ ...env, DSH_SUPERAGENT_URL: bad })
    const code = await Promise.race([p.exited, new Promise(r => setTimeout(() => r('still-running'), 3000))])
    ok(code !== 0 && code !== 'still-running', `refuses non-loopback URL ${bad}`, `exit=${code}`)
    p.close()
  }
  const dead = http.createServer(); await new Promise(r => dead.listen(0, '127.0.0.1', r)); const deadPort = dead.address().port; await new Promise(r => dead.close(r))
  const un = launch({ DSH_SUPERAGENT_URL: `http://127.0.0.1:${deadPort}`, DSH_SUPERAGENT_TOKEN: TOKEN, DSH_MCP_AUDIT_LOG: path.join(tmp, 'un-audit.log') })
  await un.request('initialize', { protocolVersion: '2025-06-18' })
  t = await un.call('harness_status'); ok(t.isError && /not reachable/.test(t.text), 'service down → friendly "not reachable"', t.text)
  un.close()

  console.log('\nsource audit')
  const src = fs.readFileSync(SERVER, 'utf8')
  ok(!/createServer|\.listen\(/.test(src), 'server.cjs opens no listening socket')
  ok((src.match(/fetch\(/g) || []).length === 1, 'exactly one network call site')
  ok(!/child_process|\bexec(Sync)?\(|\bspawn\(/.test(src), 'server.cjs spawns no processes')
}

main().catch(e => { console.error(e); failed++ }).finally(() => {
  mock.close()
  console.log(`\n${passed} passed, ${failed} failed`)
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
})
