# Durable feature delivery contract and operator handoff

## Ownership and authority

The implementation worker and the feature-delivery aggregate have independent lifetimes. A worker report, merged PR, HTTP verification, rollback, model review or model recommendation is **not feature acceptance**. The integration owner retains one aggregate across repository-qualified PR references, ended workers, review/fix generations, publication attempts and explicitly required acceptance evidence.

The initial shared contract was circulated in the isolated ticket workspace before specialist implementation. The executable contract is [feature-delivery.ts](../src/app/feature-delivery.ts). Existing `Ticket.delivery` still means input-delivery failure; it is not reused.

## Actual runtime wiring

1. `Runtime` records **new** `ticket.created` events as honest, unbound delivery tracking with the original source trigger and worker. It never sweeps historical tickets. Unknown SHAs/requirements/targets remain unknown, with no delegated authority or executable action. Working implementation remains Working; an actual blocked/failed worker report remains Blocked with its readable recorded summary even before scope binding. Ready/ended implementation with undefined delivery scope becomes an explicit scope-binding blocker.
2. Explicit local management intake/binding supplies acceptance requirement IDs, target, every repository/PR/head/base, and bounded routine delegation. Already-ready reports enter review automatically. The default coordinator invokes the configured executor model in an **independent tool-free call** over bounded, actual GitHub diffs. It pins every PR base/head and full diff before/after review and cached-result reuse. The review result and actual provider are durable SQL evidence, never publication authority.
3. In-scope failed review findings are routed through the existing Engine note mechanism to one active original implementation owner. The note and its handoff record commit atomically. Reconciliation requires the exact note's native read event and a later fresh ready report; enqueue/old ready text is insufficient. Ended workers are not reopened. Explicit `followFixHeads` permits only expected same-PR/base correction evolution for routine review/fix; prepared publication and old recommendations are invalidated.

Coordinator outbox rows, action identity, evidence fingerprint, scope, confirmation actor/source/reference, leases and retry budgets survive restart. Leases renew during long calls; stop aborts/parks uncertainty. Missing capabilities and unknown mutation outcomes are blockers, not immediate retry loops. Pending handoff reconciliation is due-time bounded and never replays the mutation. Healthy publication/correction adapters schedule read-only observation every sixty seconds for a finite twenty-minute budget, longer than the runner's maximum fifteen-minute individual phase deadline; they do not inherit the generic five-second fallback cadence. If a long-running external operation outlasts that observation budget, its visible revision-bound reconciliation action resumes **only the original adapter's read-only reconciliation**, with the same original action/idempotency key and confirmation; it never invokes execute again. Review/fix loops are finite.

## Canonical views and recommendations

`delivery-${id}` identifies the same item and aggregate revision in Conversation, Decisions and Workstream. Shared rendering shows stage, owner, current recommendation, one concrete confirmation and inspectable full scope/history. Native chat Send and generic inbox actions cannot execute delivery actions. An ended worker cannot retire the aggregate.

Actual Senior Developer advice returns strict `take`/`hold`, exact action ID and evidence fingerprint. A hold is displayed as waiting, not endorsement of Publish. Missing/failed advice is explicit and cannot veto server eligibility; an operator may inspect and explicitly proceed without it. Metadata-only fenced recommendation persistence does not manufacture a new model-approved action ID. Heads, evidence, manifest scope or action changes invalidate advice.

Only source-empty generated advice proven superseded by linked delivery progress or a settled publication attempt is retired. Retirement is persisted before canonical helper lookup/production and staging, in both HTTP deployments. Nonempty genuine questions and pending staged native submissions are preserved.

## Protected publication

Qualified delivery preparation can use only an **existing operator-configured reviewed manifest** and active release owner. It does not create PRs or release candidates. Optional trusted runner `deliveryScope` records environment, unique repository/PR/head/base references, components and human-readable effects. Its whole-normalized-config digest is bound into the delivery action; the existing detached worker independently retains its raw-manifest digest fence.

Preparation and publication compare unique exact reference sets independent of ordering. The runner validates **all** scoped remote heads/bases before evidence and every non-rollback phase. Legacy manifests remain usable by the legacy protected route but cannot invent a feature target/component scope. Rollback restoration remains possible if a remote PR moved.

Delivery publication consumes actual durable trusted local confirmation through the existing protected route. A string intake authority, model verdict, recommendation or ordinary delegation cannot become a human click. Existing own-merge, active-owner, patch, one-use grant, process and serialized-live-publication fences remain. Published reconciliation must identify this exact request and actor. A successful primary snapshot cannot count as publication evidence for uncovered repositories or an arbitrary target.

Preparation failures have bounded safe reevaluation and an explicit revision-fenced recheck. Unknown mutation outcomes are not cleared by that operation. Required native/browser verification has **no fabricated default adapter**: it remains a named blocker until the operator supplies exact externally observed evidence through the audited command below.

## HTTP contract

All routes retain existing loopback, same-origin and trusted-local operator envelope checks. They are a local management trust boundary, not authentication against hostile code running as the same OS user.

- `GET /orchestrator/api/deliveries`: canonical aggregate snapshots.
- `POST /orchestrator/api/deliveries`: strict explicit intake; server assigns operator authority, not a caller-supplied permission list. No publication delegation is accepted.
- `POST /orchestrator/api/deliveries/:id/bind`: `{revision,intake}` defines an unbound new job's exact scope under recorded operator provenance.
- `POST /orchestrator/api/deliveries/:id/confirm`: **only** `{revision,actionId}`. The server obtains actor, source and exact current scope; stale/repeated/concurrent confirmations fail safely.
- `POST /orchestrator/api/deliveries/:id/recheck`: **only** `{revision}`. Reevaluate unavailable preparation; never resume uncertain publication.
- `POST /orchestrator/api/deliveries/:id/reconcile`: **only** `{revision,actionId}` using the current opaque recovery identity. Observe the original parked handoff with its unchanged idempotency key/confirmation/target; no new mutation, publication permission or execute replay.

## Backfill and observed acceptance

[Bounded backfill input and guide](018-delivery-backfill.md) covers **only sandbox #159/#160** using actual immutable source/evidence PRs and recorded deployment/rollback history. Preview is read-only; explicit operator apply is hash-bound and idempotent, queues nothing and reopens no workers. Historical Mac-lock/quota observations are not asserted to be current.

[Operator evidence command](../scripts/delivery-evidence.ts) records exact-bound external publication/verification/native evidence with revision, reference, requirement and reviewed-request-hash fences. Optional acceptance is a separate explicit hash-bound instruction and still passes the aggregate's full acceptance invariant. Failed, uncertain and rolled-back history remains append-only. This is an operator boundary, not a browser automation capability or a tool available to the reviewer model.

## Release and rollback

1. Independently review the final immutable backend/plugin/evidence PR heads and full-suite comparison against backend `f388ad81988eaee2037a88b65e6554b0ebee4839` and plugins `2721b197ef44d0b682303733e575fd13a015d261`. Preserve installed customizations; these changes were built/tested only in isolated workspaces.
2. Codex/operator owns the finite substantive #167 release package, merge, live apply/build/restart and native browser acceptance through the already-installed protected publication card. The worker does not touch live sources/services, credentials or model settings. Keep approved heads/manifests frozen during approval/publication.
3. Retain exact dirty preimages and built assets for reverse deployment. Roll back only the reviewed source/artifact scope through the protected runner, not whole trees/databases. New SQLite tables are additive; preserve deliveries, original worker records, evidence, attempts and audit across rollback. Older binaries may ignore the new tables but must not erase them.

Before/After screenshots are explicitly isolated **actual-component fixture comparisons**, not native live acceptance. The operator must verify all three real consumers, one-click behavior and two concurrent deliveries after deployment; neither merge nor this document closes those requirements.
