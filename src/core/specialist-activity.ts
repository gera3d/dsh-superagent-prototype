/**
 * Event → avatar state. Pure. The avatar may only show what native evidence supports:
 *  - no evidence, or working evidence older than STALE_AFTER_MS, is `unknown` (rendered as NOT working);
 *  - `waiting`, `blocked`, `complete` and `idle` are facts about a settled situation, so they persist and show age.
 *
 * Normalized-event shape is the same idea as Pixel Agents' provider events (tool start/end, permission, session
 * end; MIT, https://github.com/pablodelucca/pixel-agents @ b1bafd0). It is inspiration only: no code is copied.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PendingDecisionItem } from './decision.ts'
import { WORKING_STATES, type ActivityState } from './specialist-profile.ts'

export const STALE_AFTER_MS = 90_000

export type ActivityEvent =
  | { type: 'turn_start'; at: number }
  | { type: 'thinking'; at: number }
  | { type: 'tool_start'; at: number; tool: string; testing?: boolean }
  | { type: 'tool_end'; at: number; failed?: boolean }
  | { type: 'approval_asked'; at: number }
  | { type: 'approval_decided'; at: number }
  | { type: 'turn_end'; at: number; outcome: 'completed' | 'failed' | 'cancelled' }
  | { type: 'idle'; at: number }

export interface Activity {
  state: ActivityState | 'unknown'
  /** True when working evidence expired; the UI must not animate. */
  stale: boolean
  /** Epoch ms of the evidence that produced the state; undefined when there is none. */
  at?: number
  /** Plain-text, accessible explanation of why this state is shown. */
  reason: string
  /** Last tool name when the state is `tools`/`testing`. */
  tool?: string
}

const TEST_COMMAND = /\b(vitest|jest|pytest|mocha|playwright|tsc\b|typecheck|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|typecheck)|cargo\s+test|go\s+test)\b/i

/** Maps real Session events (types observed in `@deepseek-ai/dsh-session`) into normalized activity events. */
export function activityFromSessionEvents(events: readonly SessionEvent[]): ActivityEvent[] {
  const out: ActivityEvent[] = []
  for (const event of events) {
    const at = typeof event.time === 'number' ? event.time : undefined
    if (at === undefined) continue // No timestamp, no evidence of when it happened.
    const data = event.data as any
    switch (event.type as string) {
      case 'turn/start': out.push({ type: 'turn_start', at }); break
      case 'assistant/message': out.push({ type: 'thinking', at }); break
      case 'tool/call': out.push({ type: 'tool_start', at, tool: String(data?.name ?? 'tool'), testing: TEST_COMMAND.test(`${data?.name ?? ''} ${data?.arguments ?? ''}`.slice(0, 2000)) }); break
      case 'tool/result': out.push({ type: 'tool_end', at, failed: data?.message?.isError === true }); break
      case 'approval/asked': out.push({ type: 'approval_asked', at }); break
      case 'approval/decided': out.push({ type: 'approval_decided', at }); break
      case 'turn/end': out.push({ type: 'turn_end', at, outcome: data?.reason?.kind === 'completed' ? 'completed' : ['aborted', 'interrupted', 'cancelled'].includes(data?.reason?.kind) ? 'cancelled' : 'failed' }); break
    }
  }
  return out
}

/**
 * Re-evaluates an already derived activity at a later `now`. Working evidence ages into `unknown`/stale without any new
 * event or prop change, so a UI timer can call this alone. Settled states are facts and persist.
 */
export function applyStaleness(activity: Activity, now: number): Activity {
  if (activity.stale || activity.state === 'unknown' || activity.at === undefined || !WORKING_STATES.includes(activity.state)) return activity
  if (now - activity.at <= STALE_AFTER_MS) return activity
  return { state: 'unknown', stale: true, at: activity.at, reason: `Last ${activity.state} evidence is ${Math.round((now - activity.at) / 1000)}s old; not shown as working` }
}

/** Derives the state from the LAST event. The caller supplies `now`; nothing here reads a clock. */
export function deriveActivity(events: readonly ActivityEvent[], now: number): Activity {
  const last = events.reduce<ActivityEvent | undefined>((best, event) => !best || event.at >= best.at ? event : best, undefined)
  if (!last || !Number.isFinite(last.at)) return { state: 'unknown', stale: false, reason: 'No native activity evidence' }
  if (last.at > now + 60_000) return { state: 'unknown', stale: false, reason: 'Activity timestamp is in the future; ignored' }
  const state = ((): ActivityState => {
    switch (last.type) {
      case 'turn_start': case 'thinking': case 'tool_end': case 'approval_decided': return 'investigating'
      case 'tool_start': return last.testing ? 'testing' : 'tools'
      case 'approval_asked': return 'waiting'
      case 'turn_end': return last.outcome === 'completed' ? 'complete' : 'blocked'
      case 'idle': return 'idle'
    }
  })()
  const tool = last.type === 'tool_start' ? last.tool : undefined
  const reasons: Record<ActivityState, string> = { idle: 'Session is idle', investigating: 'Turn in progress', tools: `Running tool ${tool ?? ''}`.trim(), testing: `Running checks via ${tool ?? 'a tool'}`,
    waiting: 'Waiting for an approval or a person', blocked: 'Last turn ended without completing', complete: 'Last turn completed' }
  if (WORKING_STATES.includes(state) && now - last.at > STALE_AFTER_MS)
    return { state: 'unknown', stale: true, at: last.at, reason: `Last ${state} evidence is ${Math.round((now - last.at) / 1000)}s old; not shown as working` }
  return { state, stale: false, at: last.at, reason: reasons[state], ...(tool ? { tool } : {}) }
}

/**
 * Activity of the shared decision record, from server-owned fields only. The canonical lease starts 120 s before it
 * expires (`claimCanonical`), which is the only timestamp the record has for an in-flight advisor.
 */
export function decisionActivity(item: PendingDecisionItem | undefined, now: number, session?: { running: boolean }): Activity {
  if (!item) return session?.running ? { state: 'investigating', stale: false, at: now, reason: 'Conversation is running (native session flag)' } : { state: 'unknown', stale: false, reason: 'No recorded decision for this conversation' }
  if (item.invalidation || item.status === 'stale') return { state: 'blocked', stale: false, at: item.invalidation?.at, reason: 'Decision was invalidated' }
  if (item.advisor?.status === 'error' || item.canonical?.error) return { state: 'blocked', stale: false, reason: `Advice failed: ${(item.canonical?.error ?? item.advisor?.error ?? 'error').slice(0, 120)}` }
  if (item.status === 'resolved') return { state: 'complete', stale: false, at: item.resolvedAt, reason: 'Decision resolved by a confirmed native Send' }
  if (item.staging) return { state: 'waiting', stale: false, reason: 'Choice staged; waiting for you to Send' }
  const canonical = item.canonical
  const generating = item.advisor?.status === 'generating' || (item.advisor?.status === 'pending' && !!canonical)
  if (generating && canonical && canonical.phase === 'pending') {
    const started = canonical.leaseExpiresAt - 120_000
    if (canonical.leaseExpiresAt > now) return { state: 'investigating', stale: false, at: started, reason: 'Advisor holds a live lease' }
    return { state: 'unknown', stale: true, at: started, reason: 'Advisor lease expired without a result; not shown as working' }
  }
  if (item.advisor?.status === 'pending' || item.advisor?.status === 'generating') return { state: 'unknown', stale: false, reason: 'Advice requested; no live producer evidence' }
  if (item.choices.length && item.status === 'pending') return { state: 'waiting', stale: false, at: item.createdAt, reason: 'Advice ready; waiting for your choice' }
  return { state: 'unknown', stale: false, reason: 'No activity evidence' }
}
