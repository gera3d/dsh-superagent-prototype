# Reject thread-handoff R1 candidate 1d07c8c

Exact head `1d07c8c83525ac6f642ea08d2b77018a7238dda7`, base `2405aa1d679a8e2b8af022d06fe48d756154453e`. No changes installed. Worker123 focused tests/10 suites, types and build passed, but independent root production-path audit **4 failures / 0 passed**, three tiny suites:

1. Unknown `reply_to_trigger_id` is silently discarded and ready report consumed.
2. Foreign human trigger is rejected by real Engine, then catch strips identity and commits ready anyway. Reject invalid correlation/askers; only exact reached current automatic coordination receipts may be treated as non-human correlation.
3. HTTP runner outcome `http 200 ok` becomes passed verification for requirement `native-click`. Preserve distinct automated proof and actual native operator attestation through thread UI. Never assign all requirements from runner health.
4. Historical-completed stale delivery is treated as active and suppresses later ordinary advice. Use canonical historical completion/current source semantics and preserve later human requests.

Additionally **missing implementation, not qualified**: rendering existing delivery cards does not dispatch review/tests or create a current exact reviewed release package. Current default adapter consumes old static operator manifest (PR195), cannot prepare this task. Build bounded actual same-thread review/test/preparation handoff with canonical job lineage and trusted local project profile, preserving exact protected native publish confirmation. Full real flow must be demonstrated; mocks of a ready manifest are not sufficient.

Executable audit sources are beside this review: `thread-handoff-r1-root-{report-identity,native-evidence,history-association}.audit.spec.ts`. Imports are repository tests-relative; copy each into isolated `tests/` before running. Actual result: `docs/evidence/thread-handoff-r1-root-audit.log`.

Correct in same R1 isolated checkout with cumulative exact-base patch; no rediscovery, no source/live routing edits or publication. Preserve initial scope and original accepted history. Codex retains bootstrap deployment and actual native full-flow verification. This review is a correction, not acceptance or new authority.
