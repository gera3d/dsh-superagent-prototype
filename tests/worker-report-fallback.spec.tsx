// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WorkerReportFallback, workerReportDefinition, workerReportView, WORKER_REPORT_TARGET } from '../src/client/worker-report-fallback.tsx'
import { PublicationDock } from '../src/client/publication-cards.tsx'
import type { PendingDecisionItem } from '../src/core/decision.ts'
import type { Finding } from '../src/app/finding.ts'

const STYLES_CONTENT = readFileSync(resolve(process.cwd(), 'src/client/worker-report.css'), 'utf-8')

globalThis.IS_REACT_ACT_ENVIRONMENT = true
// Native worker-5cc280c130fa6bdea2da00563e04f5c0, seq98/99/102/105:
// same wire shapes, abbreviated recorded summary. No reconstructed assistant text.
const summary = 'Ready for independent Codex review/use: https://github.com/gera3d/superagent-sandbox/pull/164.'
const event = (type: string, seq: number, data: unknown) => ({ type, seq, time: seq, data }) as SessionEventLike
function evidence(text = '', state = 'ready', isError = false) {
  return [
    event('turn/start', 1, { turn: 1 }),
    event('tool/call', 98, { turn: 1, step: 14, callId: 'report-call', name: 'orchestrator_report', arguments: JSON.stringify({ state, pr_number: 164, human_action: null, summary }) }),
    event('tool/result', 99, { turn: 1, step: 14, message: { role: 'tool', toolCallId: 'report-call', content: [{ type: 'text', text: '{"reported":true,"notification":"orchestrator"}' }], isError } }),
    event('assistant/message', 102, { turn: 1, step: 15, message: { role: 'assistant', content: [{ type: 'text', text }] } }),
    event('turn/end', 105, { turn: 1, reason: { kind: 'completed' } }),
  ]
}
// Drive the exact production definition and view registration contracts, not a separate helper parser.
function replay(events: SessionEventLike[]) {
  const definition = workerReportDefinition()
  const contexts = new Map<string, any>()
  for (const entry of events) {
    const match = typeof definition.match === 'function' ? definition.match(entry) : definition.match[entry.type]?.(entry)
    if (!match) continue
    let context = contexts.get(match.id)
    const occurrence = { event: entry, role: match.role, location: { kind: 'unresolved' } } as any
    if (!context) {
      context = { key: `report:${match.id}`, id: match.id, kind: WORKER_REPORT_TARGET, matches: [], start: occurrence, current: new Map() }
      context.state = definition.start(context, occurrence, { previous: () => undefined })
      contexts.set(match.id, context)
    } else context.state = definition.update(context, occurrence)
    context.matches.push(occurrence)
  }
  const nodes = [...contexts.values()].map(context => definition.buildViewNode!(context)!).filter(Boolean)
  return workerReportView().create().replace({ nodes, timeline: { turnOrder: [], turns: new Map() } }) as any
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
it.each(['primary', 'secondary'])('renders actual structured ready evidence with %s worker linkage, without mutating events', async linkage => {
  const events = evidence()
  const before = JSON.stringify(events)
  const report = replay(events)
  expect(report).toEqual({ summary, callId: 'report-call', reportSeq: 98, finalSeq: 102 })
  const fetch = vi.fn(async () => Response.json({ items: [{ id: 'delivery-feature', sessionId: linkage === 'primary' ? 'worker-ticket' : 'elsewhere', ticketTitle: 'Feature delivery', delivery: { id: 'feature', workers: ['ticket'] } }] }))
  vi.stubGlobal('fetch', fetch)
  const source = { subscribe: () => () => {}, getSnapshot: () => report }
  const target = vi.fn(() => source)
  const ctx = { uiConversation: { binding: () => ({ target }) } }
  const container = document.createElement('div'); const root = createRoot(container)
  await act(async () => { root.render(<WorkerReportFallback ctx={ctx as never} sessionId={'worker-ticket' as never} running={false} removed={false} />) })
  expect(target).toHaveBeenCalledWith(WORKER_REPORT_TARGET)
  expect(container.textContent).toContain('Worker report')
  expect(container.textContent).toContain('not accepted delivery')
  expect(container.textContent).toContain(summary)
  expect(container.querySelector('a')?.getAttribute('href')).toBe('#delivery-feature')
  expect(fetch.mock.calls).toHaveLength(1)
  expect(JSON.stringify(events)).toBe(before)
  await act(async () => { root.unmount() })
})
it.each(['Real final response.', ' \nReal final response.\n '])('preserves nonempty native final %j', text => {
  expect(replay(evidence(text))).toBeNull()
})
it.each(['waiting', 'failed', 'blocked', 'dropped'])('does not turn a %s report into ready completion', state => {
  expect(replay(evidence('', state))).toBeNull()
})
it('requires successful report acknowledgement, blank final and completed turn in the same turn', () => {
  expect(replay(evidence('', 'ready', true))).toBeNull()
  expect(replay(evidence().filter(e => e.type !== 'tool/result'))).toBeNull()
  expect(replay(evidence().filter(e => e.type !== 'assistant/message'))).toBeNull()
  expect(replay(evidence().filter(e => e.type !== 'turn/end'))).toBeNull()
  expect(replay([...evidence().slice(0, -1), event('turn/end', 105, { turn: 1, reason: { kind: 'error' } })])).toBeNull()
  expect(replay([...evidence(), event('turn/start', 106, { turn: 2 })])).toBeNull()
})
it('does not promote quoted report prose, malformed arguments or an unrelated acknowledgement', () => {
  const prose = evidence(); prose[1] = event('assistant/message', 98, { turn: 1, message: { content: [{ type: 'text', text: JSON.stringify({ state: 'ready', summary }) }] } })
  expect(replay(prose)).toBeNull()
  const malformed = evidence(); malformed[1] = event('tool/call', 98, { turn: 1, name: 'orchestrator_report', callId: 'report-call', arguments: '{bad' })
  expect(replay(malformed)).toBeNull()
  const unrelated = evidence(); unrelated[2] = event('tool/result', 99, { turn: 1, message: { toolCallId: 'another', isError: false, content: [{ type: 'text', text: '{"reported":true}' }] } })
  expect(replay(unrelated)).toBeNull()
})
it('does not invent a delivery link for unlinked historical worker reports', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [] })))
  const source = { subscribe: () => () => {}, getSnapshot: () => replayed }
  const replayed = replay(evidence())
  const ctx = { uiConversation: { binding: () => ({ target: () => source }) } }
  const container = document.createElement('div'); const root = createRoot(container)
  await act(async () => { root.render(<WorkerReportFallback ctx={ctx as never} sessionId={'worker-ticket' as never} running={false} removed={false} />) })
  expect(container.textContent).toContain('No linked delivery record')
  expect(container.querySelector('a')).toBeNull()
  await act(async () => { root.unmount() })
})

it.each(['current', 'prior'] as const)('links a %s verification job to its mounted canonical finding without adding delivery workers', async job => {
  const ticketId = 'f1169468a82e551dd2804f270f3d12bf', sessionId = `worker-${ticketId}`
  const finding: Finding = { id: 'b54e2231-2571-4f67-be82-c31ccfc18913', dedupKey: 'history-verification', title: 'Verify History',
    problem: 'History accessibility snapshot needs visual verification', scope: 'Verify History only; no repair authorized', owner: 'local-operator', kind: 'verification',
    repository: 'gera3d/superagent-sandbox', requirements: ['Inspect native History'], occurrences: [], revision: 3, state: 'blocked', choices: [],
    existingDeliveryId: 'auto-5ee3dda6e61420b3b927164ed5f4b98a',
    job: { id: 'current-job', ticketId: job === 'current' ? ticketId : 'replacement-verification-ticket', assignmentId: 'assignment' },
    priorJobs: job === 'prior' ? [{ id: 'prior-job', ticketId, assignmentId: 'prior-assignment' }] : [],
    reports: [], audit: [], createdAt: '2026-11-06T19:00:00.000Z', updatedAt: '2026-11-06T19:01:00.000Z' }
  const item: PendingDecisionItem = { id: `finding-${finding.id}`, finding, actionMode: 'finding_triage', ticketId: finding.job!.ticketId,
    ticketTitle: finding.title, trigger: 'finding', status: 'pending', urgency: 'medium', createdAt: 0, context: finding.scope, question: 'Review evidence', choices: [],
    recommendation: { recommendedValue: '', confidence: 0, distribution: [], rationale: '', provider: '', latencyMs: 0 } }
  // The original delivery owns only its implementation worker, not this verification assignment.
  const original = { id: `delivery-${finding.existingDeliveryId}`, ticketTitle: 'Original issue171 delivery', sessionId: 'worker-5ee3dda6e61420b3b927164ed5f4b98a',
    delivery: { id: finding.existingDeliveryId, workers: ['5ee3dda6e61420b3b927164ed5f4b98a'] } }
  const items = [item, original], before = JSON.stringify(items), events = evidence(), eventsBefore = JSON.stringify(events)
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items })))
  const report = replay(events), source = { subscribe: () => () => {}, getSnapshot: () => report }
  const ctx = { uiConversation: { binding: () => ({ target: () => source }) } }
  const container = document.createElement('div'), root = createRoot(container)
  try {
    await act(async () => root.render(<><PublicationDock sessionId={sessionId} /><WorkerReportFallback ctx={ctx as never} sessionId={sessionId as never} running={false} removed={false} /></>))
    const link = [...container.querySelectorAll('a')].find(anchor => anchor.textContent === 'Finding card: Verify History')!
    expect(link).toBeDefined()
    expect(link.getAttribute('href')).toBe(`#finding-${finding.id}`)
    expect(container.querySelector(`[id="${link.getAttribute('href')!.slice(1)}"]`)).not.toBeNull()
    expect(container.textContent).toContain(`Linked existing delivery: ${finding.existingDeliveryId}`)
    expect(container.textContent).not.toContain('No linked delivery record')
    expect(container.querySelectorAll('.dt-finding-card')).toHaveLength(1)
    expect(container.querySelectorAll('[aria-label^="Feature delivery:"]')).toHaveLength(0)
    expect(JSON.stringify(items)).toBe(before); expect(JSON.stringify(events)).toBe(eventsBefore)
  } finally { await act(async () => root.unmount()) }
})

it('aligns the fallback with composer column and theme tokens, providing bounded readable scroll container and keyboard accessibility', async () => {
  const events = evidence()
  const report = replay(events)
  const source = { subscribe: () => () => {}, getSnapshot: () => report }
  const ctx = { uiConversation: { binding: () => ({ target: () => source }) } }
  const container = document.createElement('div'), root = createRoot(container)
  try {
    await act(async () => root.render(<WorkerReportFallback ctx={ctx as never} sessionId={'worker-ticket' as never} running={false} removed={false} />))
    const section = container.querySelector<HTMLElement>('section.dt-worker-report')!
    expect(section).not.toBeNull()
    expect(section.getAttribute('aria-label')).toBe('Worker report')
    expect(section.getAttribute('data-report-seq')).toBe('98')

    // Scoped style element is mounted and stylesheet uses composer column and theme tokens
    const style = section.querySelector('style')!
    expect(style).not.toBeNull()
    expect(STYLES_CONTENT).toContain('var(--dsh-composer-side-clearance')
    expect(STYLES_CONTENT).toContain('var(--dsh-composer-card-max-width')
    expect(STYLES_CONTENT).toContain('var(--dsw-alias-bg-layer-1)')
    expect(STYLES_CONTENT).toContain('var(--dsw-alias-border-l2)')
    expect(STYLES_CONTENT).toContain('var(--dsw-alias-label-primary)')
    expect(STYLES_CONTENT).toContain('max-height: min(240px, 25vh)')
    expect(STYLES_CONTENT).not.toMatch(/@media\s*\(max-width:\s*520px\)\s*\{[^}]*\.dt-worker-report\s*\{[^}]*width:\s*100%/)
    expect(STYLES_CONTENT).not.toMatch(/@media\s*\(max-width:\s*520px\)\s*\{[^}]*\.dt-worker-report\s*\{[^}]*margin/)
    expect(STYLES_CONTENT).toContain('@media (max-width: 520px)')
    expect(STYLES_CONTENT).toContain('@media (prefers-reduced-motion: reduce)')

    // Header & title
    const header = section.querySelector('.dt-worker-report-header')!
    expect(header).not.toBeNull()
    expect(header.querySelector('.dt-worker-report-title')?.textContent).toBe('Worker report')
    expect(header.querySelector('.dt-worker-report-badge')?.textContent).toBe('Recorded fallback')
    expect(header.querySelector('svg')).not.toBeNull()

    // Provenance warning
    const provenance = section.querySelector('.dt-worker-report-provenance')!
    expect(provenance.textContent).toBe('The final assistant reply was blank. This is the recorded worker report, not accepted delivery.')

    // Bounded readable body with keyboard accessibility
    const body = section.querySelector<HTMLElement>('.dt-worker-report-body')!
    expect(body).not.toBeNull()
    expect(body.getAttribute('role')).toBe('region')
    expect(body.getAttribute('aria-label')).toBe('Worker report content')
    expect(body.getAttribute('tabindex')).toBe('0')
    expect(body.textContent).toBe(summary)
  } finally { await act(async () => root.unmount()) }
})

it('preserves layout and bounds long reports without overflowing or losing whitespace', async () => {
  const longSummary = 'Paragraph 1: Initial analysis complete.\n\n' +
    'Paragraph 2: Long lines with specialized tokens '.repeat(20) + '\n\n' +
    'Paragraph 3: ' + 'Final verification step.\n'.repeat(10)
  const events = [
    event('turn/start', 1, { turn: 1 }),
    event('tool/call', 50, { turn: 1, step: 2, callId: 'long-call', name: 'orchestrator_report', arguments: JSON.stringify({ state: 'ready', summary: longSummary }) }),
    event('tool/result', 51, { turn: 1, step: 2, message: { role: 'tool', toolCallId: 'long-call', content: [{ type: 'text', text: '{"reported":true}' }], isError: false } }),
    event('assistant/message', 52, { turn: 1, step: 3, message: { role: 'assistant', content: [{ type: 'text', text: '' }] } }),
    event('turn/end', 53, { turn: 1, reason: { kind: 'completed' } }),
  ]
  const report = replay(events)
  expect(report?.summary).toBe(longSummary)
  const source = { subscribe: () => () => {}, getSnapshot: () => report }
  const ctx = { uiConversation: { binding: () => ({ target: () => source }) } }
  const container = document.createElement('div'), root = createRoot(container)
  try {
    await act(async () => root.render(<WorkerReportFallback ctx={ctx as never} sessionId={'worker-long' as never} running={false} removed={false} />))
    const body = container.querySelector<HTMLElement>('.dt-worker-report-body')!
    expect(body.textContent).toBe(longSummary)
    expect(body.style.whiteSpace).toBe('pre-wrap')
    expect(body.style.overflowWrap).toBe('anywhere')
  } finally { await act(async () => root.unmount()) }
})

it('switches sessions cleanly without leaving stale fallback visible or contaminating other conversations', async () => {
  const events = evidence()
  const report = replay(events)
  const snapshotMap: Record<string, any> = {
    'session-with-report': report,
    'session-clean': null,
  }
  const ctx = {
    uiConversation: {
      binding: (sid: string) => ({
        target: () => ({
          subscribe: () => () => {},
          getSnapshot: () => snapshotMap[sid] ?? null,
        }),
      }),
    },
  }
  const container = document.createElement('div'), root = createRoot(container)
  try {
    // 1. Session with report shows fallback
    await act(async () => root.render(<WorkerReportFallback ctx={ctx as never} sessionId={'session-with-report' as never} running={false} removed={false} />))
    expect(container.querySelectorAll('.dt-worker-report')).toHaveLength(1)

    // 2. Switch to session without report -> fallback immediately unmounts, nothing left in DOM
    await act(async () => root.render(<WorkerReportFallback ctx={ctx as never} sessionId={'session-clean' as never} running={false} removed={false} />))
    expect(container.querySelectorAll('.dt-worker-report')).toHaveLength(0)

    // 3. Running state hides fallback
    await act(async () => root.render(<WorkerReportFallback ctx={ctx as never} sessionId={'session-with-report' as never} running={true} removed={false} />))
    expect(container.querySelectorAll('.dt-worker-report')).toHaveLength(0)

    // 4. Removed state hides fallback
    await act(async () => root.render(<WorkerReportFallback ctx={ctx as never} sessionId={'session-with-report' as never} running={false} removed={true} />))
    expect(container.querySelectorAll('.dt-worker-report')).toHaveLength(0)
  } finally { await act(async () => root.unmount()) }
})
