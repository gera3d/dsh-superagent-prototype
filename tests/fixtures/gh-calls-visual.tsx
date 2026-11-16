/** Isolated fixture: the real Ticket page and Source status components rendered against canned API answers. Never loaded by the real application. */
import { createRoot } from 'react-dom/client'
import { en } from '../../src/client/locales.ts'
import { PanelProvider } from '../../src/client/provider.tsx'
import { TicketPage } from '../../src/client/ticket.tsx'
import { SourceStatus } from '../../src/client/source.tsx'
import type { T } from '../../src/client/text.ts'

const translator = (dictionary: Record<string, string>): T => ((key: string, params?: Record<string, unknown>) => {
  const template = dictionary[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}) as T
const actor = { source: 'github', id: 'gera3d', name: { zh: 'gera3d', en: 'gera3d' } }
const ticket = {
  id: 't1', title: 'Worker gh wrapper: count calls per ticket', state: 'open', stage: 'working', actions: { retry: false, stop: true }, strength: 'explicit',
  attention: undefined, assignments: 1, inputs: 0, undelivered: 0, sessionId: 'worker-t1', directory: '/w/t1', summary: 'working on it',
  createdAt: '2026-11-13T22:00:00Z', updatedAt: '2026-11-13T23:00:00Z', paused: false, decision: undefined,
  mandate: { strength: 'explicit', policyVersion: 'abcdef1234567890', basis: { via: 'addressed', sender: 'gera3d', addressed: 'mention' }, actor, scope: 'Count gh calls' },
  basis: { facts: [], legacy: false }, environment: [{ key: 'DSH_SUPERAGENT_GITHUB_NUMBER', value: '204', description: { zh: '编号', en: 'Number' }, owner: 'github' }],
  channels: [{ source: 'github', url: 'https://github.com/gera3d/superagent-sandbox/issues/204', label: { zh: 'GitHub #204', en: 'GitHub #204' } }],
  assignments_: [], threads: [], inputs_: [],
}
const ghCalls = { total: 14, hours: [{ hour: '2026-11-13T22', count: 6 }, { hour: '2026-11-13T23', count: 8 }],
  commands: [{ name: 'api repos/:o/:r/issues/:n/comments', count: 5 }, { name: 'pr view', count: 4 }, { name: 'api rate_limit', count: 3 }, { name: 'repo clone', count: 2 }] }
const health = (name: string) => ({ name, state: 'ready', detail: '' })
const source = (id: string, title: string, extra: object) => ({ id, title: { zh: title, en: title }, installed: true, enabled: true, state: 'ready',
  health: [health(id)], stats: { received: 31, filtered: 4, lastAt: '2026-11-13T23:00:00Z' }, filtered: [], dropped: [], ...extra })
const state = { setup: { problem: null }, load: { running: 1 } }
const mode = (globalThis as any).__fixtureMode ?? 'after'
const page = (globalThis as any).__fixturePage ?? 'ticket'
const answer = (path: string): unknown => {
  if (path === 'state') return state
  if (path.startsWith('tickets/')) return { ...ticket, assignments: [{ id: 'a1', state: 'running', createdAt: '2026-11-13T22:00:00Z', startedAt: '2026-11-13T22:01:00Z' }],
    inputs: [], ...mode === 'after' ? { ghCalls } : {} }
  if (path === 'sources') return [source('feishu', 'Feishu', {}), source('github', 'GitHub', mode === 'after' ? { workerCalls: { hour: '2026-11-13T23', total: 38 } } : {})]
  return {}
}
globalThis.fetch = (async (url: string) => new Response(JSON.stringify(answer(String(url).replace('/orchestrator/api/', ''))), { status: 200 })) as typeof fetch
createRoot(document.getElementById('root')!).render(<PanelProvider t={translator(en)}>
  <header style={{ border: '1px solid #8b949e', padding: 8, color: '#d29922', marginBottom: 12 }}>
    <strong>ISOLATED ACTUAL COMPONENT FIXTURE · {mode.toUpperCase()} · {page === 'ticket' ? 'Ticket page' : 'Source status'}</strong>
  </header>
  <div className="dt-page"><div className="dt-column">{page === 'ticket' ? <TicketPage id="t1" /> : <SourceStatus />}</div></div>
</PanelProvider>)
