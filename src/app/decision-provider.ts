/** Independently reloadable configured-model evaluator; does not own or stop agent Sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { z } from 'zod'
import { evaluateDecision } from '../core/decision.ts'
import { configuredDecisionReply } from './decision-evaluator.ts'
import { sameOrigin } from './http.ts'

export const inject = ['webServer', 'llm', 'agents']
const Request = z.object({ context: z.string().max(30000), question: z.string().max(4000),
  sessionId: z.string().min(1).max(300).optional(), provider: z.literal('auto').optional(),
  choices: z.array(z.object({ id: z.string().min(1).max(200), label: z.string().min(1).max(2000), description: z.string().max(4000).optional() })).min(2).max(12) })
export function apply(ctx: Context) {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Decision evaluator requires a loopback server')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/orchestrator/api/decisions/evaluate', handler: async (req, res) => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    if (!sameOrigin(req, ctx.webServer.port)) { reply(403, { error: 'Same-origin management request required' }); return }
    if (req.method !== 'POST') { reply(405, { error: 'POST required' }); return }
    try {
      let size = 0; const chunks: Buffer[] = []
      for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 128 * 1024) { reply(400, { error: 'Decision request exceeds size limit' }); return }; chunks.push(bytes) }
      const payload = Request.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      reply(200, await evaluateDecision(payload, request => configuredDecisionReply(ctx, request)))
    } catch { reply(400, { error: 'Invalid decision request' }) }
  } }))
}
