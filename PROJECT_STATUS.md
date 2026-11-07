# DeepSeek Harness project status

Updated November 06, 2026 at 5:00 PM PST. This is the current working record; older handoff snapshots are historical.

## Goal

Finish the recovery and test-baseline cleanup, then add quota-aware routing settings so exhausted subscriptions can be temporarily parked and restored to their saved priority. Keep Codex as the control/review layer and use economical DeepSeek harness workers.

## Routing and spend

Worker, helper and evaluator are configured for Flash 1017 through the pinned Particle AI flex OpenRouter route; scorer uses the configured evaluator, and the default harness model is the same pinned route. Existing subscription connections and keys are preserved. The application still has a direct DeepSeek availability fallback; OpenAI is absent from the active worker ladder. Latest OpenRouter key-wide usage increase since the initial qualification baseline: **$0.1977**; this can include other callers sharing the key. New routine work is authorized; no top-ups or credential changes.

## Active work

| Work | State | Owner and next step |
|---|---|---|
| Provider recovery | Revised patch reviewed; 65 independent tests pass; artifact PR merged | Codex integration and deployment |
| Instruction and migration | PR returned; correction requested to preserve installed merge/publication behavior | Same harness worker and PR, then Codex review |
| Settings navigation | Patch returned in PR #187; review pending | Codex review and integration |
| Concurrent finding dispatch | PR #186 returned; native ticket requests review | Codex review and integration |
| Subscription-aware routing controls | PR #185 returned; native ticket requests review | Codex review and integration |
| Native evidence capture | PR #189 returned; native ticket requests review | Codex review and integration |

Configured capacity is **3** workers; current native executor snapshot reports **0 running, 0 executor-queued**, unpaused and healthy. The separate finding queue can still contain waiting work. Conversation autopilot is not required for these dispatches.

The voice transcript claimed the newer combined changes were deployed with 88/89 passing tests. That claim is not supported by the current saved artifacts or native ticket state; treat the newer deployment as unverified until exact source, build and live evidence are reconciled.

## Next decisions

No user approval is needed to continue the authorized plan. Codex must review recovery PR changes before accepting them, combine independent patches, run integration checks and verify any deployment. Subscription controls should preserve the normal priority order and expose temporary availability/conservation settings rather than remove accounts.

## Risks and verified results

- **Live and verified:** transient launch-backoff repair; inbox reads and canonical card publication during history recovery. The inbox responded in about 2.2 seconds during pending recovery; independent checks passed 22 tests, type checks and build.
- **Review blocker:** the instruction/migration draft restored generic merge wording that could alter the installed authorized publication workflow. Correction requested on the same PR; it is not accepted.
- **Source publication:** the two already-live fixes are merged in [the backend source PR](https://github.com/gera3d/dsh-superagent-prototype/pull/32), targeting `superagent-core`. New recovery changes await combined deployment.
- **Parallelism gap:** the finding queue currently blocks another finding while any finding is running, even with worker capacity set to three. Two worker conversations can overlap during review correction; settings navigation remains waiting behind the finding gate. Do not call that third job running.
- **Known follow-up:** a startup helper fallback can produce unscored cards. Later live cards scored successfully. Background history recovery and protected staging remain separate.

Evidence: [current execution record](token-optimization/execution-status.json), [live deployment record](token-optimization/combined-deployment.json), [routine routing authorization](token-optimization/routine-rollout-authorized.json), [parallel worker authorization](token-optimization/concurrent-cleanup-authorized.json). Update this file at dispatch, review, deployment, verification or blocker milestones—not for unchanged polling.
