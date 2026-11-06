# Findings → Senior Developer decision → bounded native work

## Canonical pre-work record

`FindingStore` persists an observation before a worker or PR exists. The stable dedup key identifies one bounded problem; immutable scope, acceptance requirements, owner, repository, source occurrence/evidence and optional existing delivery link are retained. Further occurrences are append-only. Unknown heads, deployment targets and publication grants are never invented. Conflicting reuse of a dedup key fails rather than silently broadening work.

Conversation, Decisions and Workstream consume the same `finding-<id>` projection and revision. Conversation association includes the observation origin and actual current/prior native job sessions, with bare ticket/`worker-` session normalization; external observations need no invented origin session. Superseded source-empty generic advisor choices in finding-owned execution threads are durably retired before canonical lookup or native staging. Genuine source questions and staged submissions remain intact. `orchestrator_finding_observe` is available to native main/worker sessions: it records data and requests advice, but cannot confirm work. HTTP management intake offers the same boundary. No scan or automatic live-case backfill runs during installation.

## Advice is real, confirmation is separate

The configured executor-model route makes an independent tool-free Senior Developer call over bounded finding context. Strict output must echo the finding ID, revision and an eligible typed choice, with a reason. Actual provider/model attribution is stored. Invalid/unavailable advice is shown honestly and never replaced by fabricated approval. A failed call does not start work; the local operator may explicitly choose a disclosed typed action without advice.

`Fix now` (`Run verification` for verification findings), `Queue next` and `Defer` are not chat suggestions. Ordinary draft staging, native Send and autopilot cannot execute them. Only a protected server route records `local-operator` confirmation of the current revision and choice. The existing loopback, same-origin and browser fetch-envelope checks remain. This is a trusted-local-process boundary, not authentication against hostile code running as the same OS user.

## Queue rule and exactly-once handoff

Both execution choices enter one durable monotonically ordered FIFO. Neither preempts an already confirmed finding. `Queue next` starts on the next coordinator pass when no finding is running; it does not require another click when the queue is otherwise empty. Ordinary executor concurrency/capacity and paused processing still apply. Defer enters no queue and starts nothing; it remains visible in History with an explicit Revisit action.

The runtime selects the next finding, invokes the real Engine and writes native ticket/assignment attribution in one shared SQLite transaction. Engine uses a dedicated local finding origin, not a forged GitHub mention. The job key is deterministic for the confirmed revision; retries/restarts return its original ticket, and changed scope fails closed. Real `DshExecutor` preparation and durable `Effects` launch machinery are used. Generic retry, resurrection, automatic escalation and uncertain host-restart replay cannot create another assignment for that finding ticket. Final finding reports retire the old native assignment and invoke the existing executor stop path, retaining the report without resolving the finding. Dispatch waits until prior finding turns, descendants, stopping operations and owned background jobs are actually quiescent; a domain report alone cannot release overlapping replacement work. Recovery requires a fresh finding decision and confirmation.

An existing delivery is linked by ID, immutable original scope/history and a native assignment relation. Open deliveries receive an audit relation, not a fake implementation worker/evidence. Terminal deliveries remain immutable; a separate finding can still verify a new observation without reviving the old worker. No duplicate feature delivery is created. Delivery acceptance is withheld while any linked finding remains unresolved, including deferred findings; publication/acceptance authority is never granted by triage.

## Completion and evidence review

Ready, failed, blocked, dropped, idle, ended and merged are not resolution. Actual native reports are linked to the finding and expose a current explicit evidence/recovery decision. Evidence is bound to the current job and review revision; previous-attempt evidence cannot accept a new attempt. Failed/blocked/dropped reports cannot be accepted as successful evidence.

The local operator can explicitly accept current ready/verified evidence after acknowledging the full original acceptance requirements, reopen the same bounded scope for fresh advice/confirmation, or defer. Acceptance resolves only the finding, never publishes or accepts a delivery. `no_repair_needed` records an unsupported observation resolved by verification, distinctly from a verified repair. Prior jobs, evidence and decisions remain in history. New observations never silently revive a resolved finding.

## Protected HTTP interfaces

- Bootstrap without an MCP route-table change: `node --experimental-strip-types scripts/finding-observe.ts --url http://127.0.0.1:PORT --list` or replace `--list` with `--input observation.json`. The CLI supports only read/observe, rejects non-loopback/credentialed origins and never sends spoofed browser approval headers or action commands. Run against the root-qualified release only; this implementation did not submit the real cases.
- `GET /orchestrator/api/findings`; `POST /orchestrator/api/findings/observe` accepts the strict observation schema through the existing loopback management transport without browser approval. It records external-observer provenance and returns `execution_authorized:false`; it cannot confirm, queue, revisit, review or grant actor authority. The fixed-route MCP companion needs only these read/observe routes, not privileged routes.
- `POST /orchestrator/api/findings` is the optional protected local-operator intake of the same schema; native `orchestrator_finding_observe` records model-session/ticket provenance. Observations and model recommendations are never audited as human confirmations.
- `POST /orchestrator/api/findings/:id/confirm`: `{revision, choiceId}` where choice is `fix_now`, `queue_next` or `defer`.
- `POST /orchestrator/api/findings/:id/revisit`: `{revision}`; only deferred decisions reopen.
- `POST /orchestrator/api/findings/:id/evidence`: `{revision,reference,evidence,nextDecision,verified}` records an operator's actual external observation against the current dispatched job. It never accepts the finding; false/unverified evidence cannot support acceptance.
- `POST /orchestrator/api/findings/:id/review`: `{revision, decision, evidenceReference?, requirements?, outcome?}`; decision is `accept_evidence`, `retry_scope` or `defer`. Acceptance requires current-job eligible evidence and exact full requirements; outcome may be `verified` or `no_repair_needed`.

All action/evidence mutation routes require the existing protected local browser envelope; observation-only intake deliberately does not. Caller actors, commands and publication permissions are rejected. Observation tooling is data-only; no model tool can call confirmation/review. Long native summaries are displayed as bounded excerpts with original length/hash and the unchanged durable report reference. An invalid individual report becomes a concrete blocked finding rather than stopping reconciliation or starving the FIFO.

## Root-owned qualification cases

1. **History verification, not a claimed rendering repair.** The original report inferred a blank History panel from an empty accessibility tree. Root's later full-window screenshot showed populated History. Preserve both observations in one verification finding; verify the visible result and determine whether any repair is actually needed. A supported no-repair result must carry evidence and `no_repair_needed`, not a passed repair claim.
2. **Existing autopilot pilot.** Link remaining ordinary-conversation verification to `sandbox-160-browser` and its original requirements/history. Do not create a second feature or reopen the ended original worker. Root qualifies/deploys this workflow before authorizing the actual case.
3. **Proactive versus explicit authority.** A dropped incompatible inferred worker stays dropped. A current explicit local finding confirmation creates a fresh bounded native assignment; neither a note nor model advice upgrades the old session.

Implementation/test qualification is isolated. No production sources/assets, services, credentials, routing/model configuration or authenticated browser are changed; root independently reviews, releases and runs the real cases. Before/After component captures demonstrate rendering only, not native production acceptance. Rollback restores reviewed source/assets while preserving additive finding/queue SQL tables and history.
