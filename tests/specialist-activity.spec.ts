import { expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { STALE_AFTER_MS, activityFromSessionEvents, decisionActivity, deriveActivity } from '../src/core/specialist-activity.ts'
import type { PendingDecisionItem } from '../src/core/decision.ts'

const ev = (type: string, time: number, data: unknown = {}, seq = time) => ({ type, seq, time, data }) as unknown as SessionEvent
const state = (events: SessionEvent[], now: number) => deriveActivity(activityFromSessionEvents(events), now)

it('maps real native session events to each avatar state', () => {
  expect(state([ev('turn/start', 10)], 11)).toMatchObject({ state: 'investigating', stale: false })
  expect(state([ev('turn/start', 10), ev('tool/call', 11, { name: 'read', arguments: '{"path":"a"}' })], 12)).toMatchObject({ state: 'tools', tool: 'read' })
  expect(state([ev('tool/call', 11, { name: 'bash', arguments: '{"command":"pnpm test"}' })], 12).state).toBe('testing')
  expect(state([ev('tool/call', 11, { name: 'bash', arguments: '{"command":"npx vitest run"}' })], 12).state).toBe('testing')
  expect(state([ev('tool/call', 11, { name: 'bash' }), ev('tool/result', 12, { message: { isError: false } })], 13).state).toBe('investigating')
  expect(state([ev('approval/asked', 11), ], 12).state).toBe('waiting')
  expect(state([ev('approval/asked', 11), ev('approval/decided', 12)], 13).state).toBe('investigating')
  expect(state([ev('turn/end', 11, { reason: { kind: 'completed' } })], 12).state).toBe('complete')
  expect(state([ev('turn/end', 11, { reason: { kind: 'error' } })], 12).state).toBe('blocked')
  expect(state([ev('turn/end', 11, { reason: { kind: 'cancelled' } })], 12).state).toBe('blocked')
})

it('settled states persist with age; working states never survive staleness', () => {
  const old = 10 + STALE_AFTER_MS + 1
  for (const events of [[ev('turn/start', 10)], [ev('tool/call', 10, { name: 'bash' })], [ev('tool/call', 10, { name: 'bash', arguments: 'pnpm test' })]])
    expect(state(events, old)).toMatchObject({ state: 'unknown', stale: true, at: 10 })
  expect(state([ev('approval/asked', 10)], old).state).toBe('waiting')
  expect(state([ev('turn/end', 10, { reason: { kind: 'completed' } })], old).state).toBe('complete')
})

it('treats missing, untimed, future and out-of-order evidence as unknown or ordered by time, never working', () => {
  expect(state([], 100)).toMatchObject({ state: 'unknown', stale: false })
  expect(state([{ type: 'turn/start', seq: 1, data: {} } as unknown as SessionEvent], 100).state).toBe('unknown')
  expect(state([ev('turn/start', 1_000_000)], 100)).toMatchObject({ state: 'unknown' })
  expect(state([ev('turn/end', 20, { reason: { kind: 'completed' } }), ev('turn/start', 10)], 30).state).toBe('complete')
  expect(state([ev('mystery/event', 10)], 11).state).toBe('unknown')
})

const base: PendingDecisionItem = { id: 'd', sessionId: 's', ticketTitle: 't', trigger: 'x', status: 'pending', urgency: 'low', createdAt: 1000, context: '', question: 'q', choices: [] } as unknown as PendingDecisionItem
it('derives decision activity from server-owned record fields only', () => {
  const canonical = (leaseExpiresAt: number) => ({ draftRevision: 'r', phase: 'pending' as const, owner: 'o', leaseToken: 'l', leaseExpiresAt })
  expect(decisionActivity(undefined, 5).state).toBe('unknown')
  expect(decisionActivity(undefined, 5, { running: true }).state).toBe('investigating')
  expect(decisionActivity({ ...base, advisor: { status: 'generating' }, canonical: canonical(200_000) }, 100_000).state).toBe('investigating')
  expect(decisionActivity({ ...base, advisor: { status: 'generating' }, canonical: canonical(50_000) }, 100_000)).toMatchObject({ state: 'unknown', stale: true })
  expect(decisionActivity({ ...base, advisor: { status: 'pending' } }, 100_000)).toMatchObject({ state: 'unknown' })
  expect(decisionActivity({ ...base, advisor: { status: 'error', error: 'boom' } }, 5).state).toBe('blocked')
  expect(decisionActivity({ ...base, choices: [{ id: 'a', label: 'A' }] as any }, 5).state).toBe('waiting')
  expect(decisionActivity({ ...base, staging: {} as any }, 5).state).toBe('waiting')
  expect(decisionActivity({ ...base, status: 'resolved', resolvedAt: 9 }, 10)).toMatchObject({ state: 'complete', at: 9 })
  expect(decisionActivity({ ...base, status: 'stale' }, 5).state).toBe('blocked')
})
