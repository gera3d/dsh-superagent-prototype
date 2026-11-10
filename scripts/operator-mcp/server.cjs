#!/usr/bin/env node
'use strict'
/**
 * dsh-superagent-control — a Model Context Protocol (MCP) server (stdio) that lets an MCP client read and
 * control the dsh-superagent orchestrator running on THIS machine.
 *
 *  - Zero dependencies. One process, speaks newline-delimited JSON-RPC on stdin/stdout, logs to stderr.
 *  - Talks only to a loopback URL (default http://127.0.0.1:3082). It opens no listening socket of its own.
 *  - Every request goes through one route table (ROUTES). Anything not listed there is refused.
 *  - Tokens/cookies live in memory only and are redacted from every error and log line.
 *  - Every write is appended to audit.log (tool, route, body keys + hash, outcome; never body values).
 *
 * Environment:
 *   DSH_SUPERAGENT_URL        loopback base URL                              (default http://127.0.0.1:3082)
 *   DSH_SUPERAGENT_TOKEN      auth token, if the service asks for one         (optional)
 *   DSH_SUPERAGENT_LOG_DIR    folder with dsh-superagent-*.log to find the token when none is set
 *                             (default ../dsh-superagent/.artifacts)
 *   DSH_MCP_READONLY=1        hide and refuse every write tool
 *   DSH_MCP_ALLOW_RESTART=1   permit routes that restart the service (setup/check). Off by default.
 *   DSH_MCP_AUDIT_LOG         audit file path                                (default ./audit.log)
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const readline = require('node:readline')

const SERVER = { name: 'dsh-superagent-control', version: '0.2.0' }
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const READONLY = process.env.DSH_MCP_READONLY === '1'
const ALLOW_RESTART = process.env.DSH_MCP_ALLOW_RESTART === '1'
const AUDIT_LOG = process.env.DSH_MCP_AUDIT_LOG || path.join(__dirname, 'audit.log')
const MAX_OUTPUT = 60000
const MAX_BODY = 4000000
const TIMEOUT_MS = 15000

// ---------------------------------------------------------------- base URL (loopback only)
function loopbackBase(raw) {
  let url
  try { url = new URL(raw) } catch { throw new Error('DSH_SUPERAGENT_URL is not a valid URL') }
  const ok = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'http:' || !ok || url.username || url.password) {
    throw new Error('DSH_SUPERAGENT_URL must be a loopback http URL without credentials; this server never sends tokens off the machine')
  }
  url.pathname = '/'; url.search = ''; url.hash = ''
  return url
}
let BASE
try { BASE = loopbackBase(process.env.DSH_SUPERAGENT_URL || 'http://127.0.0.1:3082') } catch (error) {
  process.stderr.write(`dsh-superagent-control: ${error.message}\n`); process.exit(1)
}

// ---------------------------------------------------------------- secrets hygiene
const secrets = new Set()
const redact = value => {
  let text = String(value).replace(/token=[A-Za-z0-9_-]+/gi, 'token=[REDACTED]')
  for (const secret of secrets) if (secret && secret.length >= 8) text = text.split(secret).join('[REDACTED]')
  return text
}
const SENSITIVE_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential)/i
const log = message => process.stderr.write(`[dsh-superagent-control] ${redact(message)}\n`)

// ---------------------------------------------------------------- route table: the only doors
const SEG = '[A-Za-z0-9._:~@%-]{1,200}'
const route = (method, pattern, extra = {}) => ({ method, re: new RegExp(`^${pattern}$`), ...extra })
const ROUTES = [
  route('GET', 'state'), route('GET', 'overview'), route('GET', 'sources'), route('GET', 'settings'), route('GET', 'prompts'),
  route('GET', 'models'), route('GET', 'policy/history'), route('GET', 'search'), route('GET', 'threads'), route('GET', `threads/${SEG}`),
  route('GET', 'findings'), route('POST', 'findings/observe'),
  route('POST', `findings/${SEG}/coordinate`),
  route('GET', 'tickets'), route('GET', `tickets/${SEG}`), route('GET', 'decisions'), route('GET', 'decisions/inbox'),
  route('POST', 'decisions/evaluate'), route('POST', 'decisions/inbox'),
  route('POST', `decisions/${SEG}/(resolve|dismiss|restart|stage|submission|discard-staging)`),
  route('POST', 'executor/pause'), route('POST', `policy-sync/${SEG}`), route('POST', 'prompts/preview'),
  route('POST', `sources/${SEG}/labels`), route('POST', `threads/${SEG}/unsubscribe`),
  route('POST', `tickets/${SEG}/(retry|stop)`), route('POST', `triggers/${SEG}/requeue`),
  route('POST', 'setup/check', { restarts: true }),
  route('PUT', 'settings/(policy|eval|executor|models|source:[A-Za-z0-9._-]{1,64})'), route('PUT', 'prompts'),
]
function matchRoute(method, rel) {
  if (typeof rel !== 'string' || rel.includes('..') || /%2e|%2f|%5c/i.test(rel) || /[\s?#\\]/.test(rel)) return undefined
  return ROUTES.find(candidate => candidate.method === method && candidate.re.test(rel))
}
const seg = value => encodeURIComponent(String(value))

// ---------------------------------------------------------------- auth (only when the service asks)
const cookies = new Map()
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
function absorbCookies(res) {
  const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie()
    : res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []
  for (const line of lines) {
    const pair = line.split(';')[0]; const i = pair.indexOf('=')
    if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
  }
}
function findToken() {
  if (process.env.DSH_SUPERAGENT_TOKEN) return process.env.DSH_SUPERAGENT_TOKEN.trim()
  const dir = process.env.DSH_SUPERAGENT_LOG_DIR || path.join(__dirname, '..', 'dsh-superagent', '.artifacts')
  let files
  try {
    files = fs.readdirSync(dir).filter(name => /^dsh-superagent-.*\.log$/.test(name))
      .map(name => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs })).sort((a, b) => b.time - a.time)
  } catch { return undefined }
  for (const file of files.slice(0, 3)) {
    let text = ''
    try { // the "dsh web: …?token=…" line is printed once, near the start of each service log
      const fd = fs.openSync(path.join(dir, file.name), 'r')
      const buffer = Buffer.alloc(131072); const n = fs.readSync(fd, buffer, 0, buffer.length, 0); fs.closeSync(fd)
      text = buffer.subarray(0, n).toString('utf8')
    } catch { continue }
    const match = [...text.matchAll(/token=([A-Za-z0-9_-]{16,})/g)].pop()
    if (match) return match[1]
  }
  return undefined
}
class Failure extends Error { constructor(message, status) { super(message); this.status = status } }

// The ONLY place that touches the network. Method is validated by the caller against ROUTES.
function http(method, url, { headers = {}, body, redirect = 'follow' } = {}) {
  return fetch(url, { method, headers, body, redirect, signal: AbortSignal.timeout(TIMEOUT_MS) })
}
async function authenticate() {
  const token = findToken()
  if (!token) throw new Failure('The service asked for authentication but no token was found. Set DSH_SUPERAGENT_TOKEN, or DSH_SUPERAGENT_LOG_DIR to the folder holding the service logs.', 401)
  secrets.add(token)
  const res = await http('GET', new URL(`/?token=${encodeURIComponent(token)}`, BASE), { headers: { 'x-orchestrator-request': '1' }, redirect: 'manual' })
  absorbCookies(res); await res.body?.cancel()
  if (res.status >= 400 || !cookies.size) throw new Failure(`The service rejected the token (HTTP ${res.status}). Tokens change on every restart; try again after the service is up.`, res.status)
}
// Parallel calls (harness_status fires three) must share one login, not stampede the token endpoint.
let authInFlight
function authenticateOnce() {
  if (!authInFlight) authInFlight = authenticate().finally(() => { authInFlight = undefined })
  return authInFlight
}
async function readText(res) {
  const text = await res.text()
  if (text.length > MAX_BODY) throw new Failure('The service response was too large to return.', 502)
  return text
}

/** method: GET | POST | PUT. rel: path under /orchestrator/api/. */
async function api(method, rel, { query, body } = {}) {
  const matched = matchRoute(method, rel)
  if (!matched) throw new Failure(`Route not permitted: ${method} ${rel}`, 400)
  if (method !== 'GET' && READONLY) throw new Failure('This server is running read-only (DSH_MCP_READONLY=1).', 403)
  if (matched.restarts && !ALLOW_RESTART) throw new Failure('This route restarts the dsh-superagent service. Agents restarting their own host caused the earlier stop/start churn, so it is off. Set DSH_MCP_ALLOW_RESTART=1 to allow it.', 403)
  // Every tool, including the generic escape hatch, shares this typed-action boundary.
  const decisionMutation = method !== 'GET' && rel.match(/^decisions\/([^/]+)\/(?:resolve|dismiss|restart|stage|submission|discard-staging)$/)
  if (decisionMutation) ordinaryDecision(await findDecision(decodeURIComponent(decisionMutation[1])))
  const url = new URL(`/orchestrator/api/${rel}`, BASE)
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  const payload = body === undefined ? undefined : JSON.stringify(body)
  let status = 0
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = { 'x-orchestrator-request': '1', accept: 'application/json' }
      if (payload !== undefined) headers['content-type'] = 'application/json'
      const sentCookie = cookieHeader()
      if (sentCookie) headers.cookie = sentCookie
      let res
      try { res = await http(method, url, { headers, body: payload }) } catch (error) {
        const cause = error && (error.cause?.code || error.name)
        throw new Failure(cause === 'TimeoutError' ? 'The service did not answer in time.' : `dsh-superagent is not reachable at ${BASE.origin} (${cause || 'network error'}). It may be stopped or restarting.`, 0)
      }
      status = res.status
      const text = await readText(res)
      if ((status === 401 || status === 403) && attempt === 0) {
        // Another call may already have refreshed the session; otherwise drop the stale cookie and log in once.
        if (cookieHeader() === sentCookie) { cookies.clear(); await authenticateOnce() } else if (!cookies.size) await authenticateOnce()
        continue
      }
      let value
      try { value = text ? JSON.parse(text) : {} } catch { value = { raw: text.slice(0, 500) } }
      if (!res.ok) {
        const detail = value && typeof value.error === 'string' ? value.error : `HTTP ${status}`
        const hint = status === 409 ? ' (stale revision: re-read the current value and retry)' : status === 404 && !text ? ' (the service routes are not mounted; it may be restarting)' : ''
        throw new Failure(`${detail}${hint}`, status)
      }
      return value
    }
    throw new Failure('Authentication did not succeed.', status)
  } finally {
    if (method !== 'GET') audit({ method, rel, status, body })
  }
}
function audit({ method, rel, status, body, tool }) {
  try {
    const entry = { time: new Date().toISOString(), tool: tool || currentTool, method, route: rel, status,
      bodyKeys: body && typeof body === 'object' ? Object.keys(body) : undefined,
      bodySha256: body === undefined ? undefined : crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16) }
    fs.appendFileSync(AUDIT_LOG, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  } catch (error) { log(`audit log write failed: ${error.message}`) }
}
let currentTool = 'unknown'

// ---------------------------------------------------------------- shaping
function slim(value, depth = 4, arr = 25, str = 400) {
  if (typeof value === 'string') return value.length > str ? `${value.slice(0, str)}…[+${value.length - str} chars]` : value
  if (value === null || typeof value !== 'object') return value
  if (depth <= 0) return Array.isArray(value) ? `[array of ${value.length}]` : '{…}'
  if (Array.isArray(value)) {
    const out = value.slice(0, arr).map(item => slim(item, depth - 1, arr, str))
    if (value.length > arr) out.push(`…[+${value.length - arr} more]`)
    return out
  }
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : slim(v, depth - 1, arr, str)
  return out
}
const iso = ms => typeof ms === 'number' ? new Date(ms).toISOString() : undefined
function summarizeDecision(item, { context = false, prompts = false } = {}) {
  const rec = item.recommendation || {}
  return {
    id: item.id, status: item.status, actionMode: item.actionMode,
    ...(item.finding ? { finding: { id: item.finding.id, revision: item.finding.revision, state: item.finding.state, job: item.finding.job } } : {}),
    urgency: item.urgency, ticketTitle: item.ticketTitle, trigger: item.trigger,
    question: item.question, sessionId: item.sessionId, ticketId: item.ticketId, createdAt: iso(item.createdAt),
    choices: (item.choices || []).map(c => ({ id: c.id, label: c.label, description: c.description,
      ...(prompts && c.prompt ? { prompt: slim(c.prompt, 1, 1, 1000) } : {}) })),
    recommendation: { recommendedValue: rec.recommendedValue, confidence: rec.confidence, provider: rec.provider, rationale: slim(rec.rationale || '', 1, 1, 400) },
    resolvedChoice: item.resolvedChoice, resolutionBasis: item.resolutionBasis,
    staged: item.staging ? { choiceId: item.staging.choiceId, submissionId: item.staging.submissionId } : undefined,
    invalidation: item.invalidation,
    ...(context && item.context ? { context: slim(item.context, 1, 1, context === true ? 2000 : context) } : {}),
  }
}
const limitOf = (args, fallback = 25) => Math.min(100, Math.max(1, Number.isInteger(args.limit) ? args.limit : fallback))

// ---------------------------------------------------------------- argument validation
const ID = /^[A-Za-z0-9._:~@-]{1,200}$/
function need(args, key, kind, opts = {}) {
  const value = args[key]
  if (value === undefined || value === null) { if (opts.optional) return undefined; throw new Failure(`Missing argument: ${key}`, 400) }
  if (kind === 'id') { if (typeof value !== 'string' || !ID.test(value) || value === '.' || value.includes('..')) throw new Failure(`Invalid ${key}`, 400); return value }
  if (kind === 'string') { if (typeof value !== 'string' || value.length > (opts.max || 1000)) throw new Failure(`Invalid ${key}`, 400); return value }
  if (kind === 'int') { if (!Number.isInteger(value) || value < 0) throw new Failure(`${key} must be a non-negative integer`, 400); return value }
  if (kind === 'bool') { if (typeof value !== 'boolean') throw new Failure(`${key} must be true or false`, 400); return value }
  if (kind === 'object') { if (typeof value !== 'object' || Array.isArray(value)) throw new Failure(`${key} must be an object`, 400); return value }
  throw new Failure(`Unsupported kind ${kind}`, 500)
}
async function findDecision(id) {
  const { items = [] } = await api('GET', 'decisions/inbox')
  const found = items.find(item => item.id === id)
  if (!found) throw new Failure(`No decision with id ${id}`, 404)
  return found
}

// ---------------------------------------------------------------- tools
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const WR = (destructive = false, idempotent = false) => ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false })
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const findingText = maxLength => ({ type: 'string', minLength: 1, maxLength })
const findingFields = {
  dedupKey: findingText(512), title: findingText(512), problem: findingText(16384), scope: findingText(16384), owner: findingText(512),
  kind: { type: 'string', enum: ['fix', 'verification'] }, repository: findingText(512),
  requirements: { type: 'array', minItems: 1, maxItems: 100, items: findingText(16384) },
  occurrence: obj({ id: findingText(512), reference: findingText(16384), evidence: findingText(16384), at: { type: 'string', format: 'date-time' } }, ['id', 'reference', 'evidence']),
  existingDeliveryId: findingText(512), sourceIssue: { type: 'integer', minimum: 1 }, sessionId: findingText(512),
}
const findingSchema = obj(findingFields, ['dedupKey', 'title', 'problem', 'scope', 'owner', 'kind', 'requirements', 'repository', 'occurrence'])
function ordinaryDecision(item) {
  if (item.finding || item.delivery || item.lifecycle || ['finding_triage', 'feature_delivery', 'ticket_lifecycle'].includes(item.actionMode))
    throw new Failure('This is a typed finding/delivery decision. Review and confirm its current action in the harness; generic operations grant no execution or approval.', 409)
  return item
}

const idProp = description => ({ type: 'string', description })

const TOOLS = [
  // ---- reads
  { name: 'harness_status', write: false, annotations: RO,
    description: 'Overall health of dsh-superagent: setup problems, per-part health, overview counts and Source status. Start here.',
    inputSchema: obj(),
    async run() {
      const [state, overview, sources] = await Promise.allSettled([api('GET', 'state'), api('GET', 'overview'), api('GET', 'sources')])
      if ([state, overview, sources].every(r => r.status === 'rejected')) throw state.reason
      const part = r => r.status === 'fulfilled' ? slim(r.value, 5, 20, 300) : { error: redact(r.reason.message) }
      const out = { baseUrl: BASE.origin, mode: READONLY ? 'read-only' : 'read-write', state: part(state), overview: part(overview), sources: part(sources) }
      const health = state.status === 'fulfilled' && state.value && state.value.health
      if (health && typeof health === 'object') out.attention = Object.entries(health).filter(([, v]) => v && v.state && !['ready', 'ok'].includes(v.state)).map(([k, v]) => ({ part: k, state: v.state }))
      return out
    } },
  { name: 'list_tickets', write: false, annotations: RO, description: 'List tickets (work items). Optional state filter, paged.',
    inputSchema: obj({ state: { type: 'string', description: 'Ticket filter as the panel uses it, e.g. a stage name' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } }),
    async run(args) {
      const state = need(args, 'state', 'string', { optional: true, max: 40 })
      if (state !== undefined && !/^[A-Za-z0-9_-]{1,40}$/.test(state)) throw new Failure('Invalid state filter', 400)
      return slim(await api('GET', 'tickets', { query: { state, limit: limitOf(args), offset: args.offset } }), 4, limitOf(args), 300)
    } },
  { name: 'get_ticket', write: false, annotations: RO, description: 'Full detail for one ticket, including assignments and reports.',
    inputSchema: obj({ id: idProp('Ticket id') }, ['id']),
    async run(args) { return slim(await api('GET', `tickets/${seg(need(args, 'id', 'id'))}`), 6, 40, 1500) } },
  { name: 'decision_inbox', write: false, annotations: RO,
    description: 'The shared decision queue: questions the agent raised, their alternatives, the recommendation and status. Defaults to pending.',
    inputSchema: obj({ status: { type: 'string', enum: ['pending', 'resolved', 'stale', 'all'] }, session_id: idProp('Only decisions from this session'),
      limit: { type: 'integer', minimum: 1, maximum: 100 }, include_context: { type: 'boolean', description: 'Add the source conversation excerpt (truncated)' } }),
    async run(args) {
      const status = args.status || 'pending'
      if (!['pending', 'resolved', 'stale', 'all'].includes(status)) throw new Failure('Invalid status', 400)
      const { items = [] } = await api('GET', 'decisions/inbox')
      const counts = items.reduce((c, i) => ({ ...c, [i.status]: (c[i.status] || 0) + 1 }), {})
      const sessionId = args.session_id === undefined ? undefined : need(args, 'session_id', 'id')
      const picked = items.filter(i => (status === 'all' || i.status === status) && (!sessionId || i.sessionId === sessionId))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      return { counts, matched: picked.length, returned: Math.min(picked.length, limitOf(args)), items: picked.slice(0, limitOf(args)).map(i => summarizeDecision(i, { context: args.include_context === true })) }
    } },
  { name: 'get_decision', write: false, annotations: RO, description: 'One decision with its source context and the full continuation prompt for each alternative.',
    inputSchema: obj({ id: idProp('Decision id') }, ['id']),
    async run(args) { return summarizeDecision(await findDecision(need(args, 'id', 'id')), { context: 6000, prompts: true }) } },
  { name: 'get_settings', write: false, annotations: RO, description: 'Current policy, evaluator and executor blocks and Source configs, each with its revision (needed to save).',
    inputSchema: obj(), async run() { return slim(await api('GET', 'settings'), 7, 40, 1500) } },
  { name: 'get_prompts', write: false, annotations: RO, description: 'Prompt configuration with its revision, defaults and sections.',
    inputSchema: obj(), async run() { return slim(await api('GET', 'prompts'), 6, 40, 1500) } },
  { name: 'list_threads', write: false, annotations: RO, description: 'Feature threads the agent is tracking.',
    inputSchema: obj({ limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } }),
    async run(args) { return slim(await api('GET', 'threads', { query: { limit: limitOf(args), offset: args.offset } }), 4, limitOf(args), 300) } },
  { name: 'search', write: false, annotations: RO, description: 'Search tickets, threads and decisions.',
    inputSchema: obj({ q: { type: 'string', maxLength: 200 } }, ['q']),
    async run(args) { return slim(await api('GET', 'search', { query: { q: need(args, 'q', 'string', { max: 200 }) } }), 4, 30, 300) } },

  { name: 'list_findings', write: false, annotations: RO, description: 'Read durable findings, actual advice and execution state. Reading grants no confirmation authority.',
    inputSchema: obj({ state: { type: 'string', enum: ['all', 'awaiting_decision', 'queued', 'deferred', 'running', 'blocked', 'resolved'] }, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
    async run(args) {
      const state = args.state === undefined ? 'all' : need(args, 'state', 'string', { max: 30 })
      if (!['all', 'awaiting_decision', 'queued', 'deferred', 'running', 'blocked', 'resolved'].includes(state)) throw new Failure('Invalid finding state', 400)
      const { items = [] } = await api('GET', 'findings'); const picked = items.filter(item => state === 'all' || item.state === state)
      return { matched: picked.length, returned: Math.min(picked.length, limitOf(args)), items: slim(picked.slice(0, limitOf(args)), 8, 30, 2000) }
    } },
  { name: 'get_finding', write: false, annotations: RO, description: 'Read one finding by durable id, including bounded scope and recommendation. No work is confirmed or sent.',
    inputSchema: obj({ id: idProp('Finding id') }, ['id']),
    async run(args) { const id = need(args, 'id', 'id'); const { items = [] } = await api('GET', 'findings'); const item = items.find(row => row.id === id); if (!item) throw new Failure('Finding not found', 404); return slim(item, 10, 100, 16384) } },
  { name: 'observe_finding', write: true, annotations: WR(false, true), description: 'Record an observation for a canonical finding decision, deduplicated by problem and occurrence. Never confirms, queues, dispatches, publishes or accepts work. Confirm typed choices in the native harness.',
    inputSchema: obj({ finding: findingSchema }, ['finding']),
    async run(args) {
      if (Object.keys(args).some(key => key !== 'finding')) throw new Failure('Observation accepts only finding data, never actor or approval fields', 400)
      const finding = need(args, 'finding', 'object')
      if (Object.keys(finding).some(key => !Object.hasOwn(findingFields, key))) throw new Failure('Unknown finding field; observation cannot grant authority', 400)
      const result = await api('POST', 'findings/observe', { body: finding })
      if (result.execution_authorized !== false) throw new Failure('Unexpected observation response: execution authority must be false', 502)
      return slim(result, 10, 100, 16384)
    } },

  { name: 'coordinate_finding', write: true, annotations: WR(false, false),
    description: 'Advance only an existing natively approved bounded finding through the enabled headless coordination service. Requires an exact revision-bound current-uid mode0600 instruction file; cannot grant first approval, accept evidence, publish or broaden scope.',
    inputSchema: obj({ id: idProp('Existing finding id'), instruction_file: { type: 'string', minLength: 1, maxLength: 4096, description: 'Canonical absolute path to the private revision-bound coordination instruction file' } }, ['id', 'instruction_file']),
    async run(args) {
      if (Object.keys(args).some(key => !['id', 'instruction_file'].includes(key))) throw new Failure('Coordination accepts only existing finding ID and instruction file; authority stays with the protected backend', 400)
      const id = need(args, 'id', 'id')
      const instructionFile = need(args, 'instruction_file', 'string', { max: 4096 })
      if (!path.isAbsolute(instructionFile)) throw new Failure('Instruction file must be an absolute path', 400)
      return slim(await api('POST', `findings/${seg(id)}/coordinate`, { body: { instructionFile } }), 10, 100, 16384)
    } },

  // ---- writes
  { name: 'resolve_decision', write: true, annotations: WR(false, true),
    description: 'Record a choice on a pending decision (POST decisions/:id/resolve). This records the choice in the shared queue; it does not itself send a message into a conversation.',
    inputSchema: obj({ id: idProp('Decision id'), choice_id: idProp('Id of one of the decision\'s choices') }, ['id', 'choice_id']),
    async run(args) {
      const id = need(args, 'id', 'id'), choiceId = need(args, 'choice_id', 'id')
      const item = ordinaryDecision(await findDecision(id))
      if (!(item.choices || []).some(c => c.id === choiceId)) throw new Failure(`Choice ${choiceId} is not one of: ${(item.choices || []).map(c => c.id).join(', ')}`, 400)
      return slim(await api('POST', `decisions/${seg(id)}/resolve`, { body: { choiceId } }), 4, 20, 500)
    } },
  { name: 'dismiss_decision', write: true, annotations: WR(true, true), description: 'Dismiss a decision without choosing (POST decisions/:id/dismiss).',
    inputSchema: obj({ id: idProp('Decision id') }, ['id']),
    async run(args) { const id = need(args, 'id', 'id'); ordinaryDecision(await findDecision(id)); return slim(await api('POST', `decisions/${seg(id)}/dismiss`, { body: {} }), 4, 20, 500) } },
  { name: 'restart_decision', write: true, annotations: WR(false, false),
    description: 'Start a fresh linked decision from a resolved one, keeping the original choice in history (POST decisions/:id/restart).',
    inputSchema: obj({ id: idProp('Resolved decision id'), session_id: idProp('Session the new decision belongs to') }, ['id', 'session_id']),
    async run(args) { return slim(await api('POST', `decisions/${seg(need(args, 'id', 'id'))}/restart`, { body: { sessionId: need(args, 'session_id', 'id') } }), 4, 20, 500) } },
  { name: 'pause_executor', write: true, annotations: WR(false, true), description: 'Pause or resume all ticket processing (POST executor/pause).',
    inputSchema: obj({ paused: { type: 'boolean' } }, ['paused']),
    async run(args) { return slim(await api('POST', 'executor/pause', { body: { paused: need(args, 'paused', 'bool') } }), 3, 10, 300) } },
  { name: 'retry_ticket', write: true, annotations: WR(false, false), description: 'Retry a ticket, as the panel does (POST tickets/:id/retry).',
    inputSchema: obj({ id: idProp('Ticket id') }, ['id']),
    async run(args) { return slim(await api('POST', `tickets/${seg(need(args, 'id', 'id'))}/retry`, { body: {} }), 4, 20, 500) } },
  { name: 'stop_ticket', write: true, annotations: WR(true, true), description: 'Stop a running ticket (POST tickets/:id/stop).',
    inputSchema: obj({ id: idProp('Ticket id') }, ['id']),
    async run(args) { return slim(await api('POST', `tickets/${seg(need(args, 'id', 'id'))}/stop`, { body: {} }), 4, 20, 500) } },
  { name: 'requeue_trigger', write: true, annotations: WR(false, false), description: 'Put a filtered or dropped trigger back in the queue (POST triggers/:id/requeue).',
    inputSchema: obj({ id: idProp('Trigger id') }, ['id']),
    async run(args) { return slim(await api('POST', `triggers/${seg(need(args, 'id', 'id'))}/requeue`, { body: {} }), 4, 20, 500) } },
  { name: 'sync_policy', write: true, annotations: WR(false, true), description: 'Sync a Source\'s allowed list now (POST policy-sync/:id).',
    inputSchema: obj({ source_id: idProp('Source id, e.g. github') }, ['source_id']),
    async run(args) { return slim(await api('POST', `policy-sync/${seg(need(args, 'source_id', 'id'))}`, { body: {} }), 4, 20, 500) } },
  { name: 'save_settings', write: true, annotations: WR(true, false),
    description: 'Save one settings block: policy, eval, executor, models or source:<id> (PUT settings/:block). value is the WHOLE block as get_settings returns it; revision must be the current one or the save is refused. These saves can change execution environment and may restart the service.',
    inputSchema: obj({ block: { type: 'string', description: 'policy | eval | executor | models | source:<id>' }, value: { type: 'object' }, revision: { type: 'integer', minimum: 0 } }, ['block', 'value', 'revision']),
    async run(args) {
      const block = need(args, 'block', 'string', { max: 80 })
      const result = await api('PUT', `settings/${block}`, { body: { value: need(args, 'value', 'object'), revision: need(args, 'revision', 'int') } })
      return { ...slim(result, 3, 20, 400), ...(result && result.restarting ? { note: 'The service reported it is restarting; give it a minute.' } : {}) }
    } },
  { name: 'save_prompts', write: true, annotations: WR(true, false), description: 'Save the prompt configuration (PUT prompts). base_revision must be the current revision.',
    inputSchema: obj({ config: { type: 'object' }, base_revision: { type: 'integer', minimum: 0 } }, ['config', 'base_revision']),
    async run(args) { return slim(await api('PUT', 'prompts', { body: { config: need(args, 'config', 'object'), baseRevision: need(args, 'base_revision', 'int') } }), 3, 20, 400) } },
  { name: 'check_setup', write: true, annotations: WR(true, false),
    description: 'Re-run setup by RESTARTING dsh-superagent (POST setup/check). Disabled unless DSH_MCP_ALLOW_RESTART=1, because restarts end running work.',
    inputSchema: obj(), async run() { return slim(await api('POST', 'setup/check', { body: {} }), 3, 10, 300) } },
  { name: 'api_request', write: true, annotations: WR(true, false),
    description: 'Escape hatch for any other orchestrator route (labels, decision stage/submission/discard-staging, thread unsubscribe, prompt preview, evaluate…). Method and path must match the built-in route table; anything else is refused. GET is allowed too.',
    inputSchema: obj({ method: { type: 'string', enum: ['GET', 'POST', 'PUT'] }, path: { type: 'string', description: 'Path under /orchestrator/api/, e.g. tickets/abc/retry' },
      query: { type: 'object' }, body: { type: 'object' } }, ['method', 'path']),
    async run(args) {
      const method = need(args, 'method', 'string', { max: 4 })
      if (!['GET', 'POST', 'PUT'].includes(method)) throw new Failure('method must be GET, POST or PUT', 400)
      return slim(await api(method, need(args, 'path', 'string', { max: 300 }).replace(/^\/+/, ''), { query: args.query, body: args.body }), 5, 30, 800)
    } },
]
const activeTools = () => TOOLS.filter(tool => !(READONLY && tool.write))

// ---------------------------------------------------------------- MCP over stdio
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`) }
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })
function textResult(value, isError = false) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (text.length > MAX_OUTPUT) text = `${text.slice(0, MAX_OUTPUT)}\n…[truncated ${text.length - MAX_OUTPUT} chars; narrow the request]`
  return { content: [{ type: 'text', text }], isError }
}
async function callTool(name, args) {
  const tool = activeTools().find(candidate => candidate.name === name)
  if (!tool) return null
  currentTool = name
  try { return textResult(await tool.run(args && typeof args === 'object' ? args : {})) } catch (error) {
    return textResult(`Error: ${redact(error && error.message ? error.message : error)}`, true)
  }
}
async function handle(message) {
  if (!message || typeof message !== 'object' || typeof message.method !== 'string') return
  const { id, method, params } = message
  const isRequest = id !== undefined && id !== null
  switch (method) {
    case 'initialize': {
      const wanted = params && params.protocolVersion
      return reply(id, { protocolVersion: PROTOCOLS.includes(wanted) ? wanted : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER,
        instructions: `Controls the local dsh-superagent orchestrator (${BASE.origin}). Mode: ${READONLY ? 'read-only' : 'read-write'}. Call harness_status first. Writes are audited. Re-read (get_settings / get_prompts) before saving, since saves need the current revision.` })
    }
    case 'ping': return isRequest && reply(id, {})
    case 'tools/list': return reply(id, { tools: activeTools().map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) })
    case 'tools/call': {
      const result = await callTool(params && params.name, params && params.arguments)
      return result ? reply(id, result) : fail(id, -32602, `Unknown tool: ${params && params.name}`)
    }
    case 'resources/list': return reply(id, { resources: [] })
    case 'resources/templates/list': return reply(id, { resourceTemplates: [] })
    case 'prompts/list': return reply(id, { prompts: [] })
    default:
      if (method.startsWith('notifications/')) return
      if (isRequest) return fail(id, -32601, `Method not found: ${method}`)
  }
}
if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', line => {
    if (!line.trim()) return
    let message
    try { message = JSON.parse(line) } catch { return fail(null, -32700, 'Parse error') }
    for (const item of Array.isArray(message) ? message : [message]) {
      handle(item).catch(error => { log(`internal error: ${error && error.stack || error}`); if (item && item.id != null) fail(item.id, -32603, 'Internal error') })
    }
  })
  rl.on('close', () => process.exit(0))
  log(`ready: ${READONLY ? 'read-only' : 'read-write'} → ${BASE.origin}; ${activeTools().length} tools; audit ${AUDIT_LOG}`)
}
module.exports = { matchRoute, ROUTES, slim, redact }
