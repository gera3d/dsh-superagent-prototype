/**
 * Thread-native release handoff for an unbound (auto-tracked) worker delivery.
 *
 * One protected local-operator click binds the delivery to a scope derived only from verified facts: the worker's own
 * ticket and ready report, its single GitHub PR thread, and the trusted fixed local project release profile
 * (`publication-runner.json`: `pins`, `deliveryScope`). Nothing is guessed: any unknown becomes a concrete missing input with
 * an owner. The bind records intake-delegated routine steps (review, fix, verify) that the existing durable delivery
 * coordinator then executes. Publication and acceptance are never delegated here; they stay explicit.
 */
import type { Ticket } from '../core/model.ts'
import { DeliveryConflict, deliveryFingerprint, type Delivery, type DeliveryCreate, type DeliveryStore } from './feature-delivery.ts'
import type { LifecyclePublication } from './lifecycle-publication.ts'

export interface HandoffMissing { field: string; detail: string; owner: string }
export interface DeliveryHandoff {
  status: 'ready' | 'needs_inputs'
  /** Who must act next for the handoff to advance. */
  owner: string
  missing: HandoffMissing[]
  /** Verified facts the click would bind. Present only when every derived fact is known. */
  preview?: { repository: string; pr: number; headSha: string; baseSha: string; environment: string; sourceIssue: number; manifestSha256?: string; components?: string[]; effects?: string[] }
  /** Exactly what the click starts, so the card never implies more than it does. */
  starts: string[]
}
export interface HandoffContext {
  ticket(id: string): Ticket | undefined
  publication?: Pick<LifecyclePublication, 'pinsFor' | 'scopeFor'>
}
export const HANDOFF_ACTOR = 'local-operator'
const STARTS = [
  'Independent Harness review of the exact pinned PR head and diff',
  'Pinned checks, including local attested check reports from `localEvidence.checks`, as the targeted-test evidence',
  'Release preparation against the pinned manifest. Publish and accept stay separate explicit confirmations',
]
const PROFILE = 'project release profile (publication-runner.json)'
const ready = (ticket: Ticket) => ticket.assignments.at(-1)?.report?.state === 'ready'

function profileMissing(repository: string, pr: number): HandoffMissing[] {
  return [{ field: 'pins', owner: PROFILE, detail: `No trusted pins for ${repository} PR #${pr}: set pins.repository, pins.prNumber, pins.headSha and pins.patchSha256 to this PR's exact head (plus patch.path/patch.sha256, scripts and cwd).` }]
}

/** Derive what the click would bind, or exactly what is missing. Pure: reads the current ticket and the trusted profile. */
export function planReleaseHandoff(delivery: Delivery, ctx: HandoffContext): { handoff: DeliveryHandoff; intake?: Omit<DeliveryCreate, 'requirements' | 'authorities'> } {
  const missing: HandoffMissing[] = []
  const owner = delivery.owner
  const workers = delivery.workers.map(id => ctx.ticket(id))
  const tickets = workers.filter((t): t is Ticket => !!t)
  if (!tickets.length || tickets.length !== workers.length) missing.push({ field: 'worker ticket', owner, detail: 'The delivery has no recorded worker ticket to take a ready report or PR from.' })
  for (const ticket of tickets) {
    if (ticket.ended?.by === 'human') missing.push({ field: 'worker report', owner: `worker-${ticket.id}`, detail: `worker-${ticket.id} was ended by a person; its report cannot start a release handoff.` })
    else if (!ready(ticket)) missing.push({ field: 'worker report', owner: `worker-${ticket.id}`, detail: `worker-${ticket.id} has not recorded a ready report yet.` })
  }
  const prs = tickets.flatMap(ticket => (ticket.follows ?? []).filter(f => /^github:[1-9]\d*$/.test(f.thread)).map(f => Number(f.thread.slice(7))))
  const pr = new Set(prs).size === 1 ? prs[0] : undefined
  if (tickets.length && pr === undefined) missing.push({ field: 'pull request', owner: tickets[0] ? `worker-${tickets[0].id}` : owner, detail: prs.length ? 'The worker follows more than one GitHub thread; exactly one PR must identify the release artifact.' : 'The worker has no followed GitHub PR thread, so no artifact head can be verified. Open the PR from the worker branch.' })
  const repository = delivery.bindings.repository
  let preview: DeliveryHandoff['preview']
  let intake: Omit<DeliveryCreate, 'requirements' | 'authorities'> | undefined
  if (pr !== undefined) {
    const pins = ctx.publication?.pinsFor(repository, pr)
    const scope = pins ? ctx.publication?.scopeFor?.(repository, pr) : undefined
    if (!ctx.publication || !pins) missing.push(...profileMissing(repository, pr))
    else if (!scope) missing.push({ field: 'deliveryScope', owner: PROFILE, detail: 'Set deliveryScope.environment, deliveryScope.refs, deliveryScope.components and deliveryScope.effects so the deployment target and every repository/PR head are explicit.' })
    else {
      const primary = scope.refs.find(ref => ref.repository === pins.repository && ref.pr === pins.prNumber && ref.headSha === pins.headSha)
      if (!primary) missing.push({ field: 'deliveryScope.refs', owner: PROFILE, detail: 'deliveryScope.refs must contain the primary pins.repository/pins.prNumber/pins.headSha entry.' })
      else if (!primary.baseSha) missing.push({ field: 'deliveryScope.refs[].baseSha', owner: PROFILE, detail: 'Pin baseSha on the primary deliveryScope.refs entry; the Harness will not infer a base.' })
      else {
        const sourceIssue = delivery.bindings.sourceIssue > 0 ? delivery.bindings.sourceIssue : pr
        preview = { repository, pr, headSha: pins.headSha, baseSha: primary.baseSha, environment: scope.environment, sourceIssue,
          manifestSha256: scope.manifestSha256,
          components: [...scope.components], effects: [...scope.effects] }
        intake = { id: delivery.id, title: delivery.title, owner: delivery.owner,
          bindings: { repository, sourceIssue, baseSha: primary.baseSha, headSha: pins.headSha, environment: scope.environment, refs: structuredClone(scope.refs) },
          workers: [...delivery.workers], delegatedActions: ['review', 'fix', 'verify'] }
      }
    }
  }
  const ok = !missing.length && !!preview && !!intake
  return { handoff: { status: ok ? 'ready' : 'needs_inputs', owner: ok ? 'You (one confirmation starts the routine steps)' : missing[0]?.owner ?? owner, missing, ...(ok ? { preview } : {}), starts: [...STARTS] }, ...(ok ? { intake } : {}) }
}

/** Raised when a release handoff cannot start because verified inputs are missing; carries the exact missing list. */
export class HandoffBlocked extends DeliveryConflict {
  constructor(readonly handoff: DeliveryHandoff) {
    super(`Release handoff cannot start: ${handoff.missing.map(m => `${m.field}: ${m.detail}`).join(' | ')}`)
  }
}
export interface StartHandoffRequest { revision: number; requirements: string[] }
/** Normalize operator-confirmed acceptance requirements. They are typed by the person, never derived from prose. */
export function handoffRequirements(value: unknown): string[] {
  if (!Array.isArray(value)) throw new DeliveryConflict('Acceptance requirements must be a list')
  const list = value.map(item => typeof item === 'string' ? item.trim() : '')
  if (!list.length || list.length > 20 || list.some(item => !item || item.length > 500 || item.startsWith('intake:')) || new Set(list).size !== list.length) throw new DeliveryConflict('Provide 1-20 distinct acceptance requirements (each up to 500 characters)')
  return list
}
/** Bind the exact reviewed scope under the protected local operator click. Throws {@link HandoffBlocked} listing every missing input. */
export function startReleaseHandoff(store: DeliveryStore, ctx: HandoffContext, id: string, request: StartHandoffRequest, reference: string): Delivery {
  const requirements = handoffRequirements(request.requirements)
  const current = store.get(id)
  if (!current?.scopeBinding || current.revision !== request.revision) throw new DeliveryConflict('Stale or already-bound delivery; refresh before preparing the release handoff')
  const { handoff, intake } = planReleaseHandoff(current, ctx)
  if (handoff.status !== 'ready' || !intake) throw new HandoffBlocked(handoff)
  const input: DeliveryCreate = { ...intake, requirements, authorities: [HANDOFF_ACTOR] }
  return store.bindScope(id, request.revision, input, { actor: HANDOFF_ACTOR, source: 'local_operator', reference, scope: deliveryFingerprint(input) })
}
