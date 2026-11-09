# Exact legacy reconciliation review blockers

Candidate 262eef8cb2af7bf7b921791077e43ed661d9c7d5. Five failed/one passed independent production-store audit; no candidate installed or receipt applied.

1. Same allowlisted ID with another original source repository is wrongly reconciled. Require exact gera3d/superagent-sandbox plus original ID/issue/worker/trigger/unbound stage and mandate identity, not title equivalence.
2. Missing original worker row is treated as no active work. Require actual ended original ticket and fail closed when its table/row/provenance is missing.
3. Malformed worker JSON is swallowed. Reject unsupported/malformed worker evidence without mutations.
4. Additional linked active worker is ignored. This scope has exactly one original worker per record; reject extra worker linkage rather than hiding active scope.

5. Fresh adviceContext ignores historical metadata and still emits UNBOUND DELIVERY GATE, enabling completed-work advice to return on opening the original thread. Expose truthful historical completion/no further original-release action in shared helper/fallback/ranking context without claiming typed acceptance; preserve genuine later human requests. The independent sixth context case proves this against actual production adviceContext.

Copy docs/reviews/legacy-delivery-262eef8.audit.spec.ts to tests/root-legacy.audit.spec.ts; preserve positive case and prior tests. Also skip historical-completion rows in normal worker synchronization: later old-worker notifications must not mutate/reopen their completion metadata or block unrelated runtime processing. Add a repeated runtime wake regression and preserve later genuine human requests.

Reuse the r1 isolated repo/checkpoint and corrected logic; do not rediscover or reimplement original features. Return actual HEAD, focused tests/types/build and structured current identity-bound report. No live edits, release, new scope or new user approval. Codex owns release and actual exact three receipts after proof.
