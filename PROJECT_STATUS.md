# DeepSeek Harness project status

Updated November 06, 2026 at 8:10 PM PST. Owner: Codex. This is the current handoff checkpoint; use it with the linked live evidence before reporting completion.

## Active feature experiment — job cost summary

[Superagent issue #190](https://github.com/gera3d/superagent-sandbox/issues/190) is created for one DeepSeek worker. Scope: a completed-job receipt using actual model/provider and native token/cache usage, with candid actual/estimated/unknown cost and coverage. No worker merge, deployment, live edits, premium fallback, credential changes or specialist fan-out.

**Current stage: awaiting native GitHub intake.** The harness GitHub poller is rate-limited: REST core remaining 0 of 5000; reset reported for November 06 at 8:14:06 PM PST. The issue was created through the existing connected GitHub tool. No duplicate job or alternate intake has been used. Codex will observe normal pickup after the limit resets; no settings/authentication changes.

**Decision owner: Gera.** Worker completion must yield a useful Senior Developer recommendation in the same thread and shared inbox. Gera chooses which prompt/action to send. Codex must not quietly advance that transition using earlier broad release approval. Any manual nudge, missing card, unsupported action or view mismatch is a recorded workflow gap, not a successful experiment. Implementation completion alone does not mean deployed or verified.

## Previous release — goal and result

The authorized routine cleanup and economical routing rollout are **deployed and verified**. [Backend release PR #33](https://github.com/gera3d/dsh-superagent-prototype/pull/33) merged to `superagent-core` at `fb591843c3f9ff19965a49e45a4157ed195fc890`. The deployed source/assets were compared against the qualified candidate; rollback copies preserve the preceding source, assets and SQLite snapshots.

## Current routing and capacity

**Conserve mode ON.** Worker, orchestrator/evaluator, helper and automatic recommendation ranker resolve to the qualified Flash 1017 Particle AI flex OpenRouter preset. Existing saved credentials and provider connections are unchanged. Google/Antigravity and Anthropic are marked exhausted; OpenAI is temporarily conserved. The normal hierarchy and role choices are preserved beneath the override. When subscriptions return, explicitly mark those providers available and disable conservation to use the saved priorities again. Reset dates are manual reminders, not automatic quota detection. No top-ups or new keys.

Capacity: **three workers**, executor unpaused. Final native snapshot: **zero running, zero queued, zero worker reviews awaiting action**; all ten health components, including GitHub, ready. Conversation autopilot remains opt-in and was not required for this rollout.

## Completed work

| Item | Evidence and result |
|---|---|
| Launch/startup fixes | Earlier live behavior retained; post-restart inbox responded during pending history recovery in 2.818 seconds, later 0.695 seconds with recovery complete |
| Provider recovery cleanup | Generic transient backoff and immediate quota/cooldown/429 availability handling covered; native finding resolved against release evidence |
| Instruction/migration cleanup | Installed named merge CLI and exact-head publication behavior retained; short worker instructions and legacy limits/member identities verified; native finding resolved |
| Subscription conservation | Saved priorities preserved, portable default and explicit qualified preset, parked routes fail closed, existing managed requests guarded; native UI showed all four effective routes on Particle |
| Concurrent finding dispatch | FIFO/capacity, ordinary worker accounting, same-finding quiescence, pause and duplicate-admission regressions pass; configured capacity three |
| Settings navigation | All seven groups opened with matching headings; returning from Execution restored Deployment; native finding resolved |
| Operator evidence card | Native record, explicit verified attestation, recorded-evidence selection, requirement acknowledgment and separate acceptance tested end to end; request without local approval rejected with 403 |

Artifact PRs 183, 185, 186, 187 and 189 are closed as superseded by the corrected combined source release; PR 181 remains merged as historical evidence. Tracking issues 182, 184 and 188 are closed completed. Original artifact drafts must not be applied independently.

## Validation and limits

Final full suite: **2154 passed, two skipped, zero failures** (120 passing files). Type check and build pass. The initial full-run failures were corrected and rechecked before this final run. Live service PID at verification: 61929.

The scheduler concurrency behavior is regression-tested; no additional three-job production stress run was created. Two optional tests remain skipped. Conservation changes apply at subsequent managed requests, not by cancelling a request already in flight. Custom external ranker endpoints remain independently configured; the live ranker uses the managed automatic route. The earlier unsupported voice claim of completed deployment and 88/89 tests is superseded by this verified record.

## Next action

The earlier release remains complete. Follow issue #190 through native worker pickup and completion; observe the in-thread Senior Developer recommendation, then leave its next choice for Gera. Keep this checkpoint current and record interventions explicitly.

Durable evidence: [release verification](docs/evidence/routine-cleanup-live-2026-11-06.json), [review and release notes](reports/ROUTINE_CLEANUP_RELEASE.md). Native screenshots and detailed rollback/runtime records are retained locally in the cockpit project's `token-optimization` directory.
