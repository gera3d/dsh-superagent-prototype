# DeepSeek Harness project status

Updated November 06, 2026 at 09:31 PM PST. Owner: Codex. This is the current handoff checkpoint; use it with the linked live evidence before reporting completion.

## Resolved repair — recommendation selection and delivery handoff

[Plugin issue #12](https://github.com/gera3d/dsh-plugins/issues/12), owner Codex, explicitly authorized by Gera. **Reviewed, merged, deployed and native reply preparation verified.** [Plugin PR #13](https://github.com/gera3d/dsh-plugins/pull/13) separates manual reply preparation from automation eligibility, shows progress, suppresses duplicate clicks and cancels on thread changes. [Backend PR #34](https://github.com/gera3d/dsh-superagent-prototype/pull/34) adds explicit linked recommendation correction, server-owned handoff context and truthful delivery ownership. Privileged action, source/CAS and native Send proof guards remain.

In the actual cost-summary thread, clicking **Review patch and test evidence — 78%** inserted its exact full prompt and enabled Send. **The reply is prepared and deliberately UNSENT.** The original premature recommendation remains immutable superseded history; current canonical decision is `chat-fa5cbd2de5d26ca29e192a9a3903f1d6`. The delivery shows `ready for your next step`, owner `user`, with missing release preparation explained. Autopilot OFF. Cost-summary artifact PR #191 remains unmerged and undeployed.

Qualification: 22 Node and 184 UI/behavior tests pass. Backend full suite: 2,158 pass / two skip / one unchanged CLI 5-second timeout; its exact focused rerun passes. Focused contracts, final types and build pass. Rollback sources/assets and SQLite snapshot retained. All ten health components including GitHub ready; executor unpaused; zero running/queued. Evidence: [native handoff verification](docs/evidence/recommendation-handoff-live-2026-11-06.json). Local screenshots: `token-optimization/recommendation-handoff/live-corrected-recommendation.png` and `live-prepared-reply.png`.

Startup limitation: saved-history restoration still gates decision writes globally. This repair adds cancellation to manual preparation; it does not remove that existing startup gate. Verify recovery before reporting a post-restart action ready.

## Resolved bug — missing Senior Developer scores

[Plugin issue #9](https://github.com/gera3d/dsh-plugins/issues/9) is authorized by Gera's screenshot/report. Owner: Codex; no duplicate harness worker. Reproduced in the actual PR #191 worker thread and in regression tests. Cause: host and UI permanently excluded fallback-generated suggestions from scoring, suppressed explicit retry and hid valid persisted distributions.

**State: deployed and live verified.** Plugin [PR #10](https://github.com/gera3d/dsh-plugins/pull/10) restores real scoring of fallback suggestions; [PR #11](https://github.com/gera3d/dsh-plugins/pull/11) prevents a persistence restore marker from invalidating the existing turn hash. Qualification: 22 host/parser tests, 181 UI/behavior tests and 16 backend contract tests pass; type check/build pass. Rollback sources and assets are retained.

At the earlier scoring-only checkpoint, the original decision and all four exact prompts were unchanged. After browser reload, the actual thread and shared inbox both show **62%, 18%, 12%, 8%**, supplied by the configured OpenRouter/Particle evaluator. Canonical phase is `scored`. No choice was staged or selected; autopilot remains OFF and fallback provenance remains blocked for unattended execution. No worker was nudged or user response sent. The executor is unpaused, with zero running/queued jobs. Cost-summary PR #191 remains unmerged and undeployed. Live evidence: [scoring verification](docs/evidence/senior-developer-scoring-2026-11-06.json); local screenshot `token-optimization/scoring-repair/live-scored-thread.png`.

Scoring repair was explicitly authorized by Gera after the workflow experiment exposed it; this operator repair is not counted as autonomous success of that experiment.

The later recommendation/context repair above supersedes this scoring-only checkpoint. Cost-summary release preparation and the user-owned continuation remain pending.

## Active feature experiment — job cost summary

[Superagent issue #190](https://github.com/gera3d/superagent-sandbox/issues/190) is created for one DeepSeek worker. Scope: a completed-job receipt using actual model/provider and native token/cache usage, with candid actual/estimated/unknown cost and coverage. No worker merge, deployment, live edits, premium fallback, credential changes or specialist fan-out.

**Current stage: worker ready; reviewed next-step reply prepared but UNSENT.** Native ticket `85f05a35653102da234bed56549c26dd` reported ready at 8:28:04 PM Pacific on November 06. [Artifact PR #191](https://github.com/gera3d/superagent-sandbox/pull/191) remains open and unmerged, with code head `0e4039b` and artifact head `1b2bf4d18cabc034fd04c253c985891850d14616`. Worker-reported checks: 19 focused and 206 adjacent tests, type check and build passed. Code remains isolated; this feature is not deployed. Monetary cost is honestly unavailable without price metadata; the feature reports recorded worker-session token/cache/route usage and labels estimates/coverage limitations.

**Workflow experiment result: partial; operator repair verified, user-owned continuation pending.** The first recommendation incorrectly requested live screenshots before deployment and initially could not be staged. Gera explicitly authorized repair. The old decision `chat-80b012401cd8db18bcf529d6cf9b79ee` is now stale with unchanged choices and a linked current replacement. Its three appropriate preparation/review choices have real configured-model scores of **78%, 10%, 12%** in the thread and inbox.

The highest-rated reply was clicked for the authorized native test. It is now in the composer with Send enabled, linked as pending staging; **no native submission, worker continuation, feature merge or feature deployment occurred.** The user can edit or send it. Delivery scope remains unbound because a real source release revision, target and acceptance checks still need preparation. The card explains this and identifies the user's next step instead of implying active implementation. Autopilot remains OFF. The repair involved Codex intervention and therefore is not counted as autonomous experiment acceptance.

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

Gera can review/edit the already prepared **Review patch and test evidence (78%)** reply and press native Send to continue the same cost-summary worker. Do not send it for the user. Then observe the worker review, its next Senior Developer recommendation, preparation of an actual source release candidate and explicit delivery binding, and eventual live verification. Cost-summary PR #191 is still only an artifact handoff. Keep that distinction and record any further manual intervention.

Durable evidence: [release verification](docs/evidence/routine-cleanup-live-2026-11-06.json), [review and release notes](reports/ROUTINE_CLEANUP_RELEASE.md). Native screenshots and detailed rollback/runtime records are retained locally in the cockpit project's `token-optimization` directory.
