/** Read-only completion projection. A worker report is evidence, never delivery acceptance. */
import { useMemo, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { caller, usePoll } from './api.ts'
import { findingMatchesSession } from './finding-association.ts'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationNodeDefinitionInput, ConversationViewDefinition, ConversationViewNode } from '@deepseek-ai/dsh-client-ui-conversation/client'

export const WORKER_REPORT_TARGET = 'superagent-worker-report'
export interface WorkerReport { summary: string; callId: string; reportSeq: number; finalSeq: number }
interface State {
  turn: number; completed: boolean; finalSeq: number; blank: boolean
  calls: ReadonlyMap<string, { summary: string; seq: number }>
  report?: { summary: string; callId: string; reportSeq: number }
}
interface ReportNode extends ConversationViewNode { data: { turn: number; report: WorkerReport | null } }
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewSnapshotMap { 'superagent-worker-report': WorkerReport | null }
}
const object = (value: unknown): Record<string, any> | undefined => value !== null && typeof value === 'object' ? value as Record<string, any> : undefined
const parse = (value: unknown): Record<string, any> | undefined => {
  try { return object(typeof value === 'string' ? JSON.parse(value) : value) } catch { return undefined }
}
const initial = (turn: number): State => ({ turn, completed: false, finalSeq: 0, blank: false, calls: new Map() })
/** Only exact structured tool evidence is admitted; quoted prose and failed reports cannot qualify. */
export function reduceWorkerReport(state: State, event: SessionEventLike): State {
  const data = object(event.data)
  if (!data) return state
  if (event.type === 'tool/call' && data.name === 'orchestrator_report') {
    const args = parse(data.arguments)
    // A later report supersedes earlier ready evidence, including a non-ready/invalid report.
    const calls = new Map<string, { summary: string; seq: number }>()
    if (args?.state === 'ready' && typeof args.summary === 'string' && args.summary.trim()) {
      calls.set(data.callId, { summary: args.summary, seq: event.seq })
    }
    return { ...state, calls, report: undefined }
  }
  if (event.type === 'tool/result') {
    const message = object(data.message)
    const call = state.calls.get(message?.toolCallId)
    if (!call || message?.isError !== false || !Array.isArray(message.content)) return state
    const acknowledged = message.content.some((part: any) => part.type === 'text' && parse(part.text)?.reported === true)
    return acknowledged ? { ...state, report: { summary: call.summary, callId: message.toolCallId, reportSeq: call.seq } } : state
  }
  if (event.type === 'assistant/message') {
    const content = object(data.message)?.content
    const blank = Array.isArray(content) && content.length > 0 && content.every((part: any) => part.type === 'text' && typeof part.text === 'string' && !part.text.trim())
    return { ...state, finalSeq: event.seq, blank }
  }
  if (event.type === 'turn/end') return { ...state, completed: data.reason?.kind === 'completed' }
  return state
}
export function workerReportCompletion(state: State): WorkerReport | null {
  return state.completed && state.blank && state.report && state.finalSeq > state.report.reportSeq
    ? { ...state.report, finalSeq: state.finalSeq } : null
}
const TYPES = new Set(['turn/start', 'tool/call', 'tool/result', 'assistant/message', 'turn/end'])
export function workerReportDefinition(): ConversationNodeDefinitionInput {
  return {
    kind: WORKER_REPORT_TARGET, target: WORKER_REPORT_TARGET,
    match(event) {
      const data = object(event.data)
      return TYPES.has(event.type) && Number.isInteger(data?.turn)
        ? { id: String(data!.turn), role: 'start' } : null
    },
    start(_context, { event }) { return reduceWorkerReport(initial(object(event.data)!.turn), event) },
    update({ state }, { event }) { return reduceWorkerReport(state as State, event) },
    buildViewNode(context) {
      const state = context.state as State | undefined
      return state ? { key: context.key, id: context.id, kind: WORKER_REPORT_TARGET, target: WORKER_REPORT_TARGET,
        data: { turn: state.turn, report: workerReportCompletion(state) } } : null
    },
  }
}
/** Null nodes remain indexed so a new turn/nonempty final clears an older fallback. */
export function workerReportView(): ConversationViewDefinition {
  return { target: WORKER_REPORT_TARGET, isActive: snapshot => !!snapshot, create() {
    const nodes = new Map<string, ReportNode>()
    const result = () => [...nodes.values()].sort((a, b) => b.data.turn - a.data.turn)[0]?.data.report ?? null
    return { empty: null,
      replace({ nodes: next }) { nodes.clear(); for (const node of next) nodes.set(node.key, node as ReportNode); return result() },
      apply({ upserts }) { for (const node of upserts) nodes.set(node.key, node as ReportNode); return result() },
    }
  } }
}
export function WorkerReportSummary({ report, children }: { report: WorkerReport; children?: React.ReactNode }) {
  return <section aria-label="Worker report" data-report-seq={report.reportSeq}>
    <strong>Worker report</strong>
    <p>The final assistant reply was blank. This is the recorded worker report, not accepted delivery.</p>
    <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{report.summary}</div>
    {children}
  </section>
}
const call = caller(() => ({ offline: 'Delivery service is offline.', notRunning: 'Delivery service is not running.',
  serverError: status => `Delivery service error (${status}).`, requestFailed: status => `Delivery request failed (${status}).`,
  setup: () => 'Delivery setup is incomplete.', user: failure => `Delivery request rejected: ${failure.code}` }))
function DeliveryLink({ sessionId }: { sessionId: string }) {
  const { data, error } = usePoll(() => call('GET decisions/inbox'), [sessionId])
  const findings = data?.items.filter(item => findingMatchesSession(item, sessionId)) ?? []
  const items = data?.items.filter(item => item.delivery && (item.sessionId === sessionId
    || item.delivery.workers.some(worker => worker === sessionId || `worker-${worker}` === sessionId))) ?? []
  return <p>{findings.length || items.length ? <>
    {findings.map(item => <span key={item.id}><a href={`#finding-${encodeURIComponent(item.finding!.id)}`}>Finding card: {item.ticketTitle}</a>
      {item.finding!.existingDeliveryId && <> · Linked existing delivery: <code>{item.finding!.existingDeliveryId}</code></>} </span>)}
    {items.map(item => <a key={item.id} href={`#delivery-${encodeURIComponent(item.delivery!.id)}`}>Delivery card: {item.ticketTitle}</a>)}
  </>
    : error ? 'Delivery linkage could not be loaded.' : data ? 'No linked delivery record. Worker readiness is not delivery acceptance.' : 'Loading delivery linkage…'}</p>
}
/** Uses the host's existing loaded event window; no history writes, model calls or guessed output. */
export function WorkerReportFallback({ ctx, sessionId, running, removed }: {
  ctx: Context; sessionId: SessionId; running: boolean; removed: boolean
}) {
  const source = useMemo(() => ctx.uiConversation.binding(sessionId).target(WORKER_REPORT_TARGET), [ctx, sessionId])
  const report = useSyncExternalStore<WorkerReport | null | undefined>(source.subscribe, source.getSnapshot, source.getSnapshot)
  if (running || removed || !report) return null
  return <WorkerReportSummary report={report}>
    <DeliveryLink sessionId={sessionId} />
  </WorkerReportSummary>
}
