# Canonical Next steps publication (issue 157)

All routes use `/orchestrator/api/`, existing same-origin header `x-orchestrator-request: 1`, JSON bodies and `Cache-Control: no-store`. Main management and independent inbox provider implement the identical contract over the existing SQLite inbox. No optional service becomes required; native decisionSubmission proof/staging contract is unchanged. Presentation no longer forcibly belongs to Agent-Mini: Next steps can claim the existing dock handshake when installed, while the inline dock remains the fallback.

## Identity and reads

Every producer request includes `sessionId`, `sourceMessageId`, `sourceTurn` (integer), `sourceSeq` (integer), `draftRevision` (nonempty stable string/hash). The backend flushes/reads complete durable history, validates the latest completed noninterrupted source and rejects later human messages/turn starts, cancelled turns, stale/closed records and mismatched coordinates/revisions with 409. These are server-owned checks, never browser assertions.

`GET decisions/inbox` remains the read contract. `item.id` retains the existing source identity. `item.status` is human resolution state (`pending`, `resolved`, `stale`); `item.canonical.phase` is producer state (`pending`, `ready`, `scored`). Generation pending has no placeholder choices. `advisor.status` remains compatible with existing pending/error display. Canonical errors are explicit `canonical.error`; missing scores remain empty distribution, never fabricated probabilities.

## Lease and mutations

1. `POST decisions/canonical/claim`: identity + `{owner, purpose?: 'score'}` → `{item, claimed, leaseToken?, leaseExpiresAt?}`. Owner is a stable producer-instance ID shared by all tabs using that host; host reloads acquire a new owner after lease expiry. A 120-second durable CAS lease deduplicates tabs, retries and reloads. Same owner gets the current token during its lease; another owner gets `claimed:false`. Expiry allows takeover with a new token. Ready records normally return false; `purpose:'score'` permits ready-but-unscored takeover without changing choices. Scored/staged records are readable but never claimed. Keep early drafting local until the source is durably completed.
2. `POST decisions/canonical/publish`: identity + `{leaseToken, model, options:[{id,label,prompt,why,recommended,added?}]}` → `{item}`. Exactly 2–4 distinct options, exactly one recommendation. IDs, labels, full prompts and input order are retained verbatim: no recommendation-first reorder, padding or pruning. Ready cards are durable before scoring. Repeating identical choices is idempotent; a competing set returns 409. First publication preserves legacy shown/hidden option history; legacy 4–6 normalization remains only on legacy capture/history paths, not this contract. Late capture and legacy publication cannot overwrite a canonical set.
3. `POST decisions/canonical/score`: identity + `{leaseToken, evaluation:{recommendedValue,confidence,rationale,distribution:[{id,probability}],provider,latencyMs}}` → `{item}`. Published IDs and their exact order must match distribution; no choice rewrite is accepted. Scores are valid finite probabilities summing to one. The actual evaluator may change the recommendation to another published ID. Scores update the same option-set revision in place; identical retry is idempotent. An expired token must reclaim with `purpose:'score'`.

`POST decisions/canonical/fail`: identity + `{leaseToken,error}` → `{item}`. Generation failure leaves phase pending, exposes advisor error and releases the lease for retry. Scoring failure leaves ready choices and recommendation intact with an explicit error and no fabricated scores. Successful scoring clears the canonical error; scored records ignore late failure writes. HTTP 400 means invalid payload, 404 missing operation, 409 means refresh/reconcile rather than generating an independent competing decision.

## Staging and native Send

Publication/scoring fail with 409 once a draft is staged. Claim returns that staged item with `claimed:false`, so polling cannot hide it. Stale/resolved items cannot be republished. SQLite guards prevent legacy writers removing canonical source/revision or changing published choices. Explicit legacy history restoration cannot replace canonical choices.

Selection only stages through existing `/:id/stage`, `/:id/submission`, and `/:id/discard-staging`; only a matching durable native admission resolves. `/:id/resolve` is proof-only and does not call `sessions.prompt` or invent native proof. No synchronization operation sends, executes, merges, applies, restarts or deploys.

## Verification and limitations

Focused backend tests cover capture-before-helper/helper-before-capture, pending→ready→scored, exact choice identity/order/prompt, concurrent SQLite connections, reload lease persistence, expired scoring takeover, failure retention, wrong identity/revision, interrupted/cancelled/continued sources, staging locks and native Send proof. Independent-provider tests exercise actual HTTP handlers and GET projection equality. These are synthetic tests, not real model/app evidence.

Lease expiry can allow duplicate compute if an old producer runs beyond 120 seconds, but only the current token can publish; there is no heartbeat route. Revision changes on the same source are intentionally rejected rather than offering implicit regeneration. Explicit history remains preserved and inspectable. The integration owner must provide ordinary-human-turn evidence across conversation, Decisions and Workstream. Transport unavailable must be displayed as unavailable, not represented as canonical success.

Rollback: revert this isolated source patch and rebuild affected artifacts in an explicitly authorized rollout; no migration/data removal is required. No installation, running server, commit, push or deployment is performed by this implementation.
