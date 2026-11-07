# DeepSeek Harness project status

Updated November 06, 2026 at 9:01 PM PST. Owner: Codex. This is the current handoff checkpoint; use it with the linked live evidence before reporting completion.

## Active repair — recommendation selection and delivery handoff

[Plugin issue #12](https://github.com/gera3d/dsh-plugins/issues/12), owner Codex, explicitly authorized by Gera. Native click reproduction: highest-scored suggestion is rejected before staging because the autopilot exact-prompt allowlist is reused for manual selection. Screenshot retained at `token-optimization/recommendation-click-blocked.png`.

Implementation in qualification: separate manual reply preparation from automation eligibility; show preparation in progress; preserve privileged-action guards and native Send proof; explicitly replace incorrect recommendations with a linked revision while retaining immutable history; ground advice in server-owned artifact/release readiness; show the ready unbound delivery as awaiting the user's next step. **Not deployed or verified yet.** Cost-summary artifact PR #191 stays unmerged; no reply sent on Gera's behalf.

## Resolved bug — missing Senior Developer scores

[Plugin issue #9](https://github.com/gera3d/dsh-plugins/issues/9) is authorized by Gera's screenshot/report. Owner: Codex; no duplicate harness worker. Reproduced in the actual PR #191 worker thread and in regression tests. Cause: host and UI permanently excluded fallback-generated suggestions from scoring, suppressed explicit retry and hid valid persisted distributions.

**State: deployed and live verified.** Plugin [PR #10](https://github.com/gera3d/dsh-plugins/pull/10) restores real scoring of fallback suggestions; [PR #11](https://github.com/gera3d/dsh-plugins/pull/11) prevents a persistence restore marker from invalidating the existing turn hash. Qualification: 22 host/parser tests, 181 UI/behavior tests and 16 backend contract tests pass; type check/build pass. Rollback sources and assets are retained.

The original decision and all four exact prompts are unchanged. After browser reload, the actual thread and shared inbox both show **62%, 18%, 12%, 8%**, supplied by the configured OpenRouter/Particle evaluator. Canonical phase is `scored`. No choice was staged or selected; autopilot remains OFF and fallback provenance remains blocked for unattended execution. No worker was nudged or user response sent. The executor is unpaused, with zero running/queued jobs. Cost-summary PR #191 remains unmerged and undeployed. Live evidence: [scoring verification](docs/evidence/senior-developer-scoring-2026-11-06.json); local screenshot `token-optimization/scoring-repair/live-scored-thread.png`.

Scoring repair was explicitly authorized by Gera after the workflow experiment exposed it; this operator repair is not counted as autonomous success of that experiment.

Other handoff-context and delivery-binding defects below remain separate unresolved items; scoring alone will not make an inappropriate recommendation safe.

## Active feature experiment — job cost summary

[Superagent issue #190](https://github.com/gera3d/superagent-sandbox/issues/190) is created for one DeepSeek worker. Scope: a completed-job receipt using actual model/provider and native token/cache usage, with candid actual/estimated/unknown cost and coverage. No worker merge, deployment, live edits, premium fallback, credential changes or specialist fan-out.

**Current stage: worker ready; user choice deliberately unselected.** Native ticket `85f05a35653102da234bed56549c26dd` reported ready at 8:28:04 PM Pacific on November 06. [Artifact PR #191](https://github.com/gera3d/superagent-sandbox/pull/191) remains open and unmerged, with code head `0e4039b` and artifact head `1b2bf4d18cabc034fd04c253c985891850d14616`. Worker-reported checks: 19 focused and 206 adjacent tests, type check and build passed. Code remains isolated; this feature is not deployed. Monetary cost is honestly unavailable without price metadata; the feature reports recorded worker-session token/cache/route usage and labels estimates/coverage limitations.

**Workflow experiment result: partial, not accepted.** The shared inbox automatically received four prompts for the correct worker session, decision `chat-80b012401cd8db18bcf529d6cf9b79ee`. However:

- Recommended “Request live cockpit capture” asks for the new feature in the live app before deployment, outside the worker's authorized scope.
- “Review and merge PR #191” pre-fills an unsupported claim that the user reviewed it and treats the sandbox artifact merge as shipping the real backend change.
- The real delivery is `review / blocked` with no executable action: confirmed delivery target and acceptance requirements have not been bound. The intake requested an artifact handoff, so a deployable backend candidate still needs preparation. Keep the approval boundary; expose the missing preparation as the correct next step.
- **Scoring gap resolved:** the original unscored observation is retained in the experiment record. Plugin repairs #10/#11 now produce the same genuine 62/18/12/8 percent distribution in thread and inbox, with unchanged choices.

No recommendation was clicked, no follow-up was sent to the worker, and no merge/deployment occurred. Native thread-card verification is now complete after the Mac was unlocked: the same four prompts appear in the actual worker thread; they were initially Not scored, and now display real matching scores after the authorized repair. The delivery card says implementation reported ready but no confirmation is currently offered. Autopilot is OFF. No choice was selected. Screenshot retained locally as `token-optimization/job-cost-summary-native-handoff.png`. The observer only opened/refreshed the UI and read status/inbox data; these actions did not advance the job.

Intake initially waited for GitHub REST quota reset, then started normally at 8:14:54 PM Pacific. No duplicate job, alternate intake, manual retry or restart was used.

**Decision owner: Gera.** Worker completion must yield a useful Senior Developer recommendation in the same thread and shared inbox. Gera chooses which prompt/action to send. Codex must not quietly advance that transition using earlier broad release approval. Any manual nudge, missing card, unsupported action or view mismatch is a recorded workflow gap, not a successful experiment. Implementation completion alone does not mean deployed or verified.

## Previous release — goal and result

The authorized routine cleanup and economical routing rollout are **deployed and verified**. [Backend release PR #33](https://github.com/gera3d/dsh-superagent-prototype/pull/33) merged to `superagent-core` at `fb591843c3f9ff19965a49e45a4157ed195fc890`. The deployed source/assets were compared against the qualified candidate; rollback copies preserve the preceding source, assets and SQLite snapshots.

## Current routing and capacity

**Conserve mode ON.** Worker, orchestrator/evaluator, helper and automatic recommendation ranker resolve to the qualified Flash 1017 Particle AI flex OpenRouter preset. Existing saved credentials and provider connections are unchanged. Google/Antigravity and Anthropic are marked exhausted; OpenAI is temporarily conserved. The normal hierarchy and role choices are preserved beneath the override. When subscriptions return, explicitly mark those providers available and disable conservation to use the saved priorities again. Reset dates are manual reminders, not automatic quota detection. No top-ups or new keys.

Capacity: **three workers**, executor unpaused. At the previous release checkpoint: **zero running, zero queued, zero worker reviews awaiting action**; all ten health components, including GitHub, ready. Conversation autopilot remains opt-in and was not required for this rollout.

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

The earlier release remains complete. Issue #190 implementation is ready in isolation. The next useful response is to review/prepare the actual backend candidate and its explicit delivery binding before requesting live verification. The current Senior Developer prompts do not express that path correctly; leave the choice unselected and treat this as a recommendation/context handoff defect, not a successful end-to-end test. Keep this checkpoint current and record interventions explicitly.

Durable evidence: [release verification](docs/evidence/routine-cleanup-live-2026-11-06.json), [review and release notes](reports/ROUTINE_CLEANUP_RELEASE.md). Native screenshots and detailed rollback/runtime records are retained locally in the cockpit project's `token-optimization` directory.
