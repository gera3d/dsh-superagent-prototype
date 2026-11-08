/** Optional independent inbox deployment: reload this plugin without stopping the orchestrator or its agents. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { DatabaseSync } from 'node:sqlite'
import { isAbsolute, dirname } from 'node:path'
import { loadLifecyclePublication } from './publication-context.ts'
import { DeliveryStore } from './feature-delivery.ts'
import { FindingStore, projectFindings } from './finding.ts'
import { ProgressStore } from './progress.ts'
import { projectDeliveries, reconcileInboxCurrency } from './delivery-runtime.ts'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { DecisionInboxItem, DecisionStageRequest, DecisionSubmissionRequest, DecisionDiscardRequest, DecisionRestartRequest, canonicalOperation, sameOrigin } from './http.ts'
import { DecisionInbox, InboxError, decisionQuestion, registerDecisionCapture, ticketDecisions, submitDecision, stageDecision, restartDecision } from './decision-inbox.ts'
import { parseInlineAlternatives } from '../client/inline-alternatives.ts'
import type { Ticket } from '../core/index.ts'
import { SettingsSchema } from '../policy.ts'
import { KV } from '../kv.ts'

/** Retire old heuristic false positives without resetting capture cursors or changing recorded choices. */
export function revalidateCapturedDecisions(db: DatabaseSync, inbox: DecisionInbox): number {
  let retired = 0
  const save = db.prepare("UPDATE decision_inbox SET value = ? WHERE id = ? AND value = ? AND json_extract(value, '$.status') = 'pending'")
  for (const item of inbox.list()) {
    if (item.status !== 'pending' || !item.id.startsWith('chat-') || item.ticketId || item.advisor?.key || item.staging) continue
    if (parseInlineAlternatives(item.context) || decisionQuestion(item.context)) continue
    const reason = 'No direct question or next-step offer remains after excluding quoted text, code and URLs.'
    retired += Number(save.run(JSON.stringify({ ...item, status: 'stale', staleReason: reason, invalidation: { at: Date.now(), reason },
      ...(item.resolutionPolicy === 'on_send' ? { resolutionRevision: (item.resolutionRevision ?? 0) + 1 } : {}) }), item.id, JSON.stringify(item)).changes)
  }
  return retired
}

export const name = 'dsh-decision-inbox'
export const inject = ['webServer', 'sessionPersistence', 'tools']
export function apply(ctx: Context, config: { database: string }): void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Decision inbox requires a loopback server')
  if (!config?.database || !isAbsolute(config.database) || !existsSync(config.database)) throw new Error('database must name an existing absolute orchestrator.sqlite file')
  ctx.effect(() => {
    // A second SQLite connection shares the durable inbox without taking the orchestrator lock or migrating its schema.
    const db = new DatabaseSync(config.database)
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL')
    const registrations = new Map<string, () => void>()
    const registerResolution = (id: string) => {
      for (const segment of new Set([encodeURIComponent(id), id])) {
        for (const operation of ['resolve', 'stage', 'submission', 'discard-staging', 'restart']) {
          const path = `/orchestrator/api/decisions/${segment}/${operation}`
          if (!registrations.has(path)) registrations.set(path, ctx.webServer.register({ kind: 'exact', path, handler }))
        }
      }
    }
    const inbox = new DecisionInbox(db, item => registerResolution(item.id))
    // Read the same versioned settings without opening/migrating a second runtime Store.
    const adviceSettings = () => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kv'").get()) return undefined
      const pointer = db.prepare('SELECT value FROM kv WHERE key=?').get(KV.settings.revision)
      if (!pointer) return undefined
      const version = db.prepare('SELECT value FROM kv WHERE key=?').get(KV.settings.version(JSON.parse(String(pointer.value))))
      return version ? SettingsSchema.parse(JSON.parse(String(version.value)).settings) : undefined
    }
    const publication = loadLifecyclePublication(dirname(config.database))
    const deliveries = new DeliveryStore(db)
    const findings = new FindingStore(db)
    const progress = new ProgressStore(db)
    const currency = () => reconcileInboxCurrency(inbox, deliveries, publication, findings, progress)
    const projectedList = () => { currency(); return projectFindings(findings, projectDeliveries(deliveries, publication?.project?.(inbox.list()) ?? inbox.list())) }
    const projectedGet = (id: string) => projectedList().find(item => item.id === id)
    revalidateCapturedDecisions(db, inbox)
    const capture = registerDecisionCapture(ctx, () => inbox)
    // Recovery only decides when older sessions' questions appear. Reads of the persisted inbox and canonical
    // writes (which validate their own server-owned durable source per request) must not queue behind it.
    let recovered = false
    void capture.ready.then(() => { recovered = true })
    let closed = false
    const refreshTickets = () => {
      const tickets = db.prepare('SELECT value FROM ticket').all().map(row => JSON.parse(String(row.value)) as Ticket)
      inbox.syncTickets(ticketDecisions(tickets))
    }
    const handler: WebRoute['handler'] = async (req, res) => {
      const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)) }
      if (!sameOrigin(req, ctx.webServer.port)) { send(403, { error: 'Same-origin management request required' }); return }
      try {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname
        const canonical = /^\/orchestrator\/api\/decisions\/canonical\/(claim|publish|score|fail)$/.exec(path)
        const inboxRead = path === '/orchestrator/api/decisions/inbox' && req.method === 'GET'
        // Native stage/submission/restart validate their durable target; discard is bound to an exact staging attempt.
        // Waiting for unrelated historical sessions here makes a current recommendation hang after restart.
        const nativeTarget = /\/(stage|submission|restart|discard-staging)$/.test(path)
        if (!inboxRead && !canonical && !nativeTarget) await capture.ready
        if (closed) { send(503, { error: 'Inbox provider is reloading' }); return }
        currency()
        if (inboxRead) {
          refreshTickets()
          await publication?.refresh?.()
          const items = projectedList()
          for (const item of items) registerResolution(item.id)
          send(200, { items, recovery: { pending: !recovered } }); return
        }
        const resolve = /^\/orchestrator\/api\/decisions\/([^/]+)\/(resolve|stage|submission|discard-staging|restart)$/.exec(path)
        if (req.method !== 'POST' || (!canonical && !resolve && path !== '/orchestrator/api/decisions/inbox')) { send(404, { error: 'Unknown inbox operation' }); return }
        let size = 0; const chunks: Buffer[] = []
        for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 128 * 1024) throw new InboxError(400, 'Request exceeds 131072 bytes'); chunks.push(bytes) }
        let body: unknown
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new InboxError(400, 'The request body is not JSON') }
        if (canonical) {
          const result = await canonicalOperation(ctx, inbox, canonical[1]!, body, adviceSettings())
          currency()
          send(200, { ...result, item: projectedGet(result.item.id) ?? result.item }); return
        }
        if (resolve) {
          let id: string
          try { id = decodeURIComponent(resolve[1]!) } catch { throw new InboxError(400, 'Malformed decision id') }
          if (id.startsWith('dec-')) refreshTickets()
          const operation = resolve[2]
          if (operation === 'restart') send(200, await restartDecision(ctx, inbox, id, DecisionRestartRequest.parse(body)))
          else if (operation === 'stage') send(200, await stageDecision(ctx, inbox, id, DecisionStageRequest.parse(body)))
          else if (operation === 'submission') send(200, await submitDecision(ctx, inbox, id, DecisionSubmissionRequest.parse(body)))
          else if (operation === 'discard-staging') send(200, inbox.discardStaging(id, DecisionDiscardRequest.parse(body).attemptId))
          else send(200, inbox.resolve(id, z.object({ choiceId: z.string().min(1).max(200) }).strict().parse(body).choiceId))
          return
        }
        const item = DecisionInboxItem.parse(body)
        if (new Set(item.choices.map(choice => choice.id)).size !== item.choices.length) throw new InboxError(400, 'Choice ids must be distinct')
        const saved = inbox.put(item)
        registerResolution(saved.id)
        send(200, { ok: true, id: saved.id })
      } catch (error) {
        send(error instanceof InboxError ? error.status : error instanceof z.ZodError ? 400 : 500,
          { error: error instanceof Error ? error.message : String(error) })
      }
    }
    const unprovide = ctx.provide?.('decisionInbox', {
      ready: capture.ready, list: projectedList, get: projectedGet,
      findSource: (source: Parameters<DecisionInbox['findSource']>[0]) => { currency(); return inbox.findSource(source) },
      publishAdvisor: (input: Parameters<DecisionInbox['publishAdvisor']>[0]) => { const item = inbox.publishAdvisor(input); currency(); return projectedGet(item.id) ?? item },
      ensureAdvisor: (input: Parameters<DecisionInbox['ensureAdvisor']>[0]) => { const item = inbox.ensureAdvisor(input); currency(); return projectedGet(item.id) ?? item },
      advisorState: (id: string, state: Parameters<DecisionInbox['advisorState']>[1]) => inbox.advisorState(id, state),
    })
    const inboxPath = '/orchestrator/api/decisions/inbox'
    registrations.set(inboxPath, ctx.webServer.register({ kind: 'exact', path: inboxPath, handler }))
    for (const operation of ['claim', 'publish', 'score', 'fail']) {
      const path = `/orchestrator/api/decisions/canonical/${operation}`
      registrations.set(path, ctx.webServer.register({ kind: 'exact', path, handler }))
    }
    for (const item of inbox.list()) registerResolution(item.id)
    return async () => { closed = true; unprovide?.(); for (const dispose of registrations.values()) dispose(); registrations.clear(); capture.dispose(); await capture.ready; db.close() }
  })
}
