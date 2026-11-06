/** Isolated component fixture, not native/live acceptance. Never loaded by the real application. */
import { createRoot } from 'react-dom/client'
import { LifecycleCard } from '../../src/client/lifecycle-card.tsx'
import { DeliveryCard } from '../../src/client/delivery-card.tsx'
import type { PendingDecisionItem } from '../../src/core/decision.ts'
const item = { id: 'life-fixture', ticketTitle: 'Historical documentation publication — PR #166', context: 'Recorded publication attempt; verification failed and rollback completed. No feature acceptance is inferred.', status: 'stale', actionMode: 'ticket_lifecycle', choices: [], lifecycle: {
  kind: 'done', assignmentId: 'ended-worker', recovery: true, publication: { id: 'publication-fixture', status: 'rolled_back', repository: 'example/sandbox', prNumber: 166, headSha: 'pinned-head', patchSha256: 'pinned-patch-digest', audit: [], updatedAt: '2026-11-06T10:10:04Z', coordination: { status: 'completed', createdAt: '2026-11-06T10:03:00Z', updatedAt: '2026-11-06T10:10:04Z' }, outcomes: [
    { stage: 'verify', status: 'failed', detail: 'Verification failed; rollback required', startedAt: '2026-11-06T10:04:33Z' },
    { stage: 'rollback', status: 'succeeded', detail: 'Artifact restored; not feature acceptance', startedAt: '2026-11-06T10:09:52Z', finishedAt: '2026-11-06T10:10:04Z' },
  ] },
} } as unknown as PendingDecisionItem
const delivery = { ...item, id: 'delivery-fixture', actionMode: 'feature_delivery', status: 'pending', lifecycle: undefined, delivery: {
  generation: 0, id: 'fixture', title: 'Feature remains active after worker completion', revision: 4, stage: 'review', state: 'awaiting_decision', owner: 'Independent reviewer', bindings: { repository: 'example/sandbox', sourceIssue: 159, baseSha: 'exact-base', headSha: 'exact-head', environment: 'isolated-fixture' }, requirements: ['Review exact changes', 'Verify the delivered behavior', 'Record explicit acceptance evidence'], nextAction: { id: 'review-4', label: 'Review exact head', kind: 'review', revision: 4, fingerprint: 'pinned-scope-evidence' }, recommendation: { actionId: 'review-4', disposition: 'take', kind: 'review', fingerprint: 'pinned-scope-evidence', rationale: 'The implementation worker has ended, but the feature still needs an independent review of the exact head before publication. Review it next; do not infer acceptance from worker completion.', provider: 'Fixture recorded model recommendation', recordedAt: '2026-11-06T10:10:04Z' }, attempts: { review: 1, fix: 0, maxReview: 2, maxFix: 2 }, evidence: [], workers: ['ended-worker'], audit: [{ at: '2026-11-06T10:10:04Z', actor: 'coordinator', event: 'Worker ended; delivery awaits review' }], authorities: ['owner'],
} } as PendingDecisionItem
const mode = (globalThis as any).__fixtureMode ?? 'after'
if (mode === 'publish') {
  const d = delivery.delivery!
  d.stage = 'ready_to_publish'; d.title = 'Publish reviewed multi-repository feature'
  d.nextAction = { id: 'publish-4', kind: 'publish', revision: 4, fingerprint: 'pinned-scope-evidence', label: 'Publish pinned feature' }
  d.recommendation = { ...d.recommendation!, actionId: 'publish-4', disposition: 'take', kind: 'publish', rationale: 'Exact-scope review evidence is recorded. Publish only these pinned component changes, then verify the delivered behavior.' }
  d.preparedPublication = { id: 'fixture-publication', ticketId: 'fixture-worker', decisionId: 'fixture-lifecycle', repository: 'example/backend', pr: 166, headSha: 'backend-head', patchSha256: 'backend-patch', environment: 'isolated-fixture', preparedAt: '2026-11-06T10:10:04Z', scopeSha256: 'full-publication-scope', components: ['orchestrator backend', 'Workstream plugin'], effects: ['Apply pinned backend and plugin changes', 'Rebuild backend and client bundles', 'Restart isolated orchestrator service'], refs: [{ repository: 'example/backend', pr: 166, headSha: 'backend-head', diffSha256: 'backend-patch' }, { repository: 'example/plugins', pr: 29, headSha: 'plugins-head', diffSha256: 'plugins-patch' }] }
}
if (mode === 'recovery') {
  const d = delivery.delivery!
  d.title = 'Observe the existing correction handoff'; d.state = 'blocked'; d.nextAction = undefined; d.recommendation = undefined
  d.blocker = 'External handoff reconciliation budget exhausted'
  d.reconciliation = { id: 'original-outbox-key', actionId: 'opaque-current-recovery-key', revision: d.revision, label: 'Reconcile recorded handoff' }
}
const Card = LifecycleCard
createRoot(document.getElementById('root')!).render(<><header><strong>ISOLATED ACTUAL COMPONENT FIXTURE · {mode.toUpperCase()}</strong><p>Not the user's application. No live acceptance or publication is performed.</p></header>{['delivery', 'publish', 'recovery'].includes(mode) ? <DeliveryCard item={delivery} onConfirm={async () => ({ delivery: delivery.delivery })} onReconcile={async () => ({ requested: true })} /> : <Card item={item} onAction={async () => { throw new Error('Fixture: no publication authorized') }} />}</>)
