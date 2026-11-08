/** Durable, revisioned observations of release steps completed outside a worker conversation. Data only: never authority. */
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export const PROGRESS_KINDS = ['branch_pushed', 'pr_opened', 'checks', 'review', 'merged', 'deployed', 'verified'] as const
export type ProgressKind = typeof PROGRESS_KINDS[number]
const RANK: Record<ProgressKind, number> = { branch_pushed: 1, pr_opened: 2, checks: 3, review: 4, merged: 5, deployed: 6, verified: 7 }
const sha = z.string().regex(/^[0-9a-f]{40}$/, 'A full 40-character lowercase commit SHA is required')

export const ProgressObservationSchema = z.object({
  ticketId: z.string().min(1).max(300).transform(id => id.replace(/^worker-/, '')), jobId: z.string().min(1).max(300).optional(),
  kind: z.enum(PROGRESS_KINDS), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), branch: z.string().min(1).max(300), commit: sha, baseSha: sha.optional(),
  pr: z.number().int().positive().optional(), outcome: z.enum(['passed', 'failed', 'pending']).optional(),
  evidence: z.string().min(1).max(1000), observedAt: z.string().refine(v => Number.isFinite(Date.parse(v)), 'observedAt must be an ISO time'),
  owner: z.string().min(1).max(120), environment: z.string().trim().min(1).max(300).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.kind !== 'branch_pushed' && v.pr === undefined) ctx.addIssue({ code: 'custom', message: `${v.kind} requires its pull request number`, path: ['pr'] })
  if (['merged', 'deployed', 'verified'].includes(v.kind) && v.outcome !== 'passed') ctx.addIssue({ code: 'custom', message: 'Completed release stages require a passed outcome', path: ['outcome'] })
  if ((v.kind === 'deployed' || v.kind === 'verified') && !v.environment) ctx.addIssue({ code: 'custom', message: 'Deployed/verified observations require the exact target environment', path: ['environment'] })
  if (v.kind === 'checks' && !v.outcome) ctx.addIssue({ code: 'custom', message: 'checks requires an outcome', path: ['outcome'] })
})
export type ProgressInput = z.input<typeof ProgressObservationSchema>
export interface ProgressProvenance { source: 'operator' | 'external'; reference: string; actor?: string }
export interface ProgressObservation extends Omit<z.output<typeof ProgressObservationSchema>, 'observedAt'> {
  seq: number; observedAt: number; recordedAt: number; provenance: ProgressProvenance
  /** Always none: an observation never grants execution, publication, acceptance or any other authority. */
  authority: 'none'
}
/** Folded current state; `revision` is the seq of the observation that last changed it. */
export interface ProgressView {
  ticketId: string; jobId?: string; kind: ProgressKind; repository: string; branch: string; commit: string; baseSha?: string; pr?: number; outcome?: string
  environment?: string; owner: string; remaining: string; evidence: string; observedAt: number; changedAt: number; revision: number; observations: number
  supersededCommits: string[]; provenance: ProgressProvenance; authority: 'none'
}
export function remainingStage(kind: ProgressKind, outcome?: string): string {
  if (kind === 'verified') return 'Recorded verification complete for this exact source and target; no repeat implementation, merge or deployment. Any separate acceptance decision remains protected.'
  if (kind === 'deployed') return 'Verify the deployed feature in the recorded target'
  if (kind === 'merged') return 'Deploy the reviewed source to the authorized target, then verify it'
  if (kind === 'branch_pushed') return 'Open an exact-base pull request, then exact-head checks and source review'
  if (kind === 'pr_opened') return 'Exact-head checks, then source review'
  if (kind === 'checks') return outcome === 'passed' ? 'Source review' : 'Fix or rerun the exact-head checks, then source review'
  if (kind === 'review' && outcome && outcome !== 'passed') return 'Resolve the reported source review findings before release'
  return 'Release operator confirmation and acceptance; this observation grants neither'
}

/** Sqlite-backed, append-only progress observations; reads fold them into current progress and never write deliveries, findings or the inbox. */
export class ProgressStore {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS progress_observation(seq INTEGER PRIMARY KEY AUTOINCREMENT, dedup_key TEXT NOT NULL UNIQUE, ticket TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS progress_observation_ticket ON progress_observation(ticket, seq);`)
  }
  /** Idempotent: an identical fact is returned unchanged. Out-of-order or older facts are kept as history without regressing current progress. */
  observe(raw: ProgressInput, provenance: ProgressProvenance, now = Date.now()): { observation: ProgressObservation; duplicate: boolean } {
    const input = ProgressObservationSchema.parse(raw)
    const key = JSON.stringify([input.ticketId, input.kind, input.repository, input.branch, input.commit, input.pr, input.outcome, input.jobId, input.observedAt, input.evidence, input.owner, input.environment])
    const existing = this.db.prepare('SELECT seq, value FROM progress_observation WHERE dedup_key=?').get(key)
    if (existing) return { observation: { ...JSON.parse(String(existing.value)), seq: Number(existing.seq) }, duplicate: true }
    const { observedAt, ...rest } = input
    const value = { ...rest, observedAt: Date.parse(observedAt), recordedAt: now, provenance, authority: 'none' as const }
    const seq = Number(this.db.prepare('INSERT INTO progress_observation(dedup_key,ticket,value) VALUES (?,?,?)').run(key, input.ticketId, JSON.stringify(value)).lastInsertRowid)
    return { observation: { ...value, seq }, duplicate: false }
  }
  history(ticketId: string): ProgressObservation[] {
    return this.db.prepare('SELECT seq, value FROM progress_observation WHERE ticket=? ORDER BY seq').all(ticketId.replace(/^worker-/, ''))
      .map(row => ({ ...JSON.parse(String(row.value)), seq: Number(row.seq) }) as ProgressObservation)
  }
  tickets(): string[] { return this.db.prepare('SELECT DISTINCT ticket FROM progress_observation').all().map(row => String(row.ticket)) }
  current(ticketId: string): ProgressView | undefined { return foldProgress(this.history(ticketId)) }
}

/** A newer-observed head replaces an older one; positive progress advances while newer failed/pending checks invalidate readiness. */
export function foldProgress(history: readonly ProgressObservation[]): ProgressView | undefined {
  let state: ProgressView | undefined, headAt = 0
  const old = new Set<string>()
  for (const o of history) {
    const fields = { ticketId: o.ticketId, ...o.jobId ? { jobId: o.jobId } : {}, kind: o.kind, repository: o.repository, branch: o.branch, commit: o.commit,
      ...o.baseSha ? { baseSha: o.baseSha } : {}, ...o.pr ? { pr: o.pr } : {}, ...o.outcome ? { outcome: o.outcome } : {}, ...o.environment ? { environment: o.environment } : {}, owner: o.owner, remaining: remainingStage(o.kind, o.outcome),
      evidence: o.evidence, observedAt: o.observedAt, changedAt: o.recordedAt, revision: o.seq, provenance: o.provenance, authority: 'none' as const }
    const sameHead = state && state.commit === o.commit && state.branch === o.branch && state.repository === o.repository
    if (!state) { state = { ...fields, observations: 1, supersededCommits: [] }; headAt = o.observedAt; continue }
    const count = state.observations + 1
    if (!sameHead) {
      if (o.observedAt < headAt) { state = { ...state, observations: count }; continue }
      if (state.commit !== o.commit) old.add(state.commit)
      old.delete(o.commit); state = { ...fields, observations: count, supersededCommits: [...old] }; headAt = o.observedAt; continue
    }
    headAt = Math.max(headAt, o.observedAt)
    // A newer failure/pending result overrides an earlier positive review; later reruns remain distinct facts.
    const blocking = (o.kind === 'checks' || o.kind === 'review') && o.outcome !== undefined && o.outcome !== 'passed' && o.observedAt >= state.observedAt
    const further = blocking || RANK[o.kind] > RANK[state.kind] && o.observedAt >= state.observedAt || RANK[o.kind] === RANK[state.kind] && o.observedAt >= state.observedAt
    state = further ? { ...fields, observations: count, supersededCommits: state.supersededCommits } : { ...state, observations: count }
  }
  return state
}
