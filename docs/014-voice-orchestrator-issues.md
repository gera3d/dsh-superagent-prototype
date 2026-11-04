# 014: One Voice Orchestrator → Reviewed GitHub Task Issues

**Status:** Proposed MVP; design only. No issue creation, worker execution, configuration changes, or new authorization is implied.

## 1. Goal and boundary

One persistent Dot conversation accepts a spoken feature request, clarifies missing details, decomposes it into independently reviewable tasks, and publishes the approved tasks as GitHub issues. Voice and typing are two inputs to the same coordinator—not separate agents or competing queues.

This narrows the autonomous-dispatch vision in [013 Dots orchestrator](013-dots-orchestrator.md): issue publication is approval-gated; worker execution is a separate, later approval. Existing Decisions, Next steps, and Make Progress behavior is not changed by this design. Source admission and Mandates still follow [002 Authorization](002-authorization.md).

**MVP:** one explicitly selected repository per plan, one issue per approved task, no background coding workers. Parent issues, native sub-issues, cross-repository batches, and auto-merge are deferred.

## 2. User flow

1. **Speak → confirm:** use existing DSH voice input; show an editable transcript. Recording/transcription never grants permission to write. Ask for the repository or acceptance criteria when ambiguous.
2. **Plan → review:** read project/session summaries and existing repository issues; propose typically 2–6 tasks with acceptance criteria and dependencies. Show duplicate candidates and the exact issue titles, bodies, labels, assignees, repository, and publishing identity.
3. **Approve → publish:** an explicit button approves only selected task issues. Once the host durably records that approval and its batch, publication continues even if the GUI closes or disconnects; show this before confirmation and return issue receipts on reconnect. Editing an unapproved plan invalidates its review, and saying “approve” inside a transcript does not activate the button.

Example: “Add accessible keyboard navigation to the settings screen” → focus-order implementation, keyboard interactions, and regression tests. Publication creates task issues only; it does not start those tasks.

## 3. Plan contract and state

```ts
FeaturePlan = {
  id, revision, repositoryId, repositoryFullName, publishingActorId,
  featureSummary,
  tasks: [{ id, title, body, acceptanceCriteria, dependsOnTaskIds, labels, assignees }]
}
Approval = { id, requestId, planId, revision, selectedTaskIds, payloadDigest, approvedBy,
  state: 'active' | 'revoked', batchId }
IssueBatch = { id, approvalId,
  state: 'ready' | 'publishing' | 'paused' | 'needs_attention' | 'complete' | 'revoked' }
IssueOperation = { id, approvalId, taskId, payloadDigest,
  state: 'queued' | 'in_flight' | 'created' | 'failed' | 'uncertain' | 'cancelled',
  attemptId?, issueNumber?, issueUrl? }
```

These are proposed contracts, not implemented APIs. Validate dependency references/cycles, repository membership, supported labels/assignees, and nonempty acceptance criteria. Task IDs remain stable across edits; revisions change whenever executable publication content changes. Successful issue mappings survive revisions: published tasks are shown as existing issues, not silently re-created.

Plan flow: `draft → needs_clarification | reviewable`. Approval atomically freezes the selected payload, creates one active approval and one `ready` batch, and reserves its `queued` operations. There is at most one batch per approval ID; replay returns that batch rather than creating another. The request ID is allocated before submission, bound to the authenticated owner and payload, and reused after an acknowledgement loss; reusing it with different content is rejected. Jev can recommend or reorder drafts, never grant approval.

### GUI-close decision: continue approved publication

- **Before Approve is submitted:** an unapproved review grants no publication authority; replacing it or closing its GUI invalidates its UI identity and stale callbacks. Once Approve has been submitted, closing is not a retraction: the host may still durably accept it, so a lost acknowledgement requires lookup by the original approval-request identity, never a fresh approval or an assumption that nothing started.
- **After durable approval:** the host owns the frozen batch, independently of browser connections. Closing, refreshing or disconnecting the GUI neither pauses nor revokes it; reconnect reads the same batch and receipts without resubmitting creates. This supports the asynchronous master-agent goal without treating the browser as a worker lease.
- **Scope stays fixed:** the review must warn, “This approved batch continues if you close this page; use Pause or Revoke to stop unstarted operations.” A draft edit cannot mutate an approved batch; replacing its remaining scope requires explicit revocation and a newly reviewed approval. Created issue mappings and unresolved operations survive revisions.

This is the policy for the proposed host-run GitHub publisher, not a change to the existing client-run thread dispatch loop or its close-panel behavior.

### Batch controls and transitions

Pause, Resume and Revoke require the authenticated approval owner. Control changes and operation claims must serialize transactionally, so no new claim can begin after a Pause or Revoke acknowledgement.

- **Normal:** `ready → publishing → complete`; complete means every selected task has a confirmed issue receipt. Claim operations sequentially using an atomic `queued → in_flight` transition while the approval is active and the batch permits publication; persist the attempt identity before the POST, then store `created` and its receipt on confirmation.
- **Pause / Resume:** authenticated Pause atomically prevents new claims and records `paused`; an already claimed request may still complete. Explicit Resume permits `paused | needs_attention → ready` only with an active approval, unchanged scope, valid repository/actor permissions and no in-flight, failed or uncertain operations; it reuses the existing grant and does not retry an attempted operation.
- **Revoke:** authenticated Revoke withdraws unused authority, records `revoked` and cancels queued operations. Already claimed requests may still complete and their late receipts must be recorded; created issues are never deleted as rollback. The old approval cannot resume or authorize a replacement batch.

### Failure, restart and recovery

- **Stop:** a definitive non-creation failure records `failed`; a timeout, lost acknowledgement, or crash with an `in_flight` operation records `uncertain`. Either moves a non-revoked batch to `needs_attention` and blocks new claims. Existing successful receipts remain visible, including when only part of a batch succeeded; an unresolved attempt is never converted back to queued by expiring a claim.
- **Restart:** GUI closure is not a failure. After a host restart, ready/publishing batches may continue only never-claimed queued operations, after revalidating the durable approval and repository/actor; paused and revoked batches stay stopped. Any abandoned in-flight claim becomes uncertain and blocks continuation until reconciliation.
- **Recover explicitly:** reconciliation may read GitHub automatically but must verify a matching operation marker, repository, actor and approved payload before recording an issue as created. No search match is not proof of non-creation. After a `needs_attention` halt is reconciled, remaining queued work requires explicit Resume; proof that an uncertain task was not created changes it to failed, and retrying a definitively uncreated task requires fresh reviewed approval after revoking any older batch still capable of publishing it. If the outcome remains unknown, leave it blocked or revoke the remainder—never silently retry or reset its attempt history.

## 4. Architecture: reuse the host, add one issue boundary

| Responsibility | Design |
| --- | --- |
| Voice and conversation | Existing DSH GUI and speech input feed one persistent coordinator Session; no new application server or parallel master agent. TTS reports status, not privileged commands. |
| Planning | Extend the proposal-only approach in [Dot backend](../src/app/dot.ts), using the configured model and a validated task schema. Treat transcripts, repository text and issue bodies as untrusted input. |
| Review UI | Reuse the explicit selection/review pattern in [Dot chat](../src/client/dot-chat.tsx). Add a distinct `create_issue` operation; do not route issue publication through the existing thread execution adapter. |
| Durable publication | A proposed host-side issue service owns plan revisions, approval consumption, batch scheduling and an operation ledger in the existing SQLite store; publication does not depend on a mounted browser component. Do not repurpose or silently alter the shared decision-inbox contract. |
| GitHub adapter | Reuse the configured-account, repository-restricted [Commands transport](../src/infra/commands.ts). Resolve and display the actual actor; keep credentials host-side. Revalidate repository identity, issue support and write permissions immediately before publication. |

Read-only repository metadata on 2026-11-03 confirmed that [gera3d/dsh-superagent-prototype](https://github.com/gera3d/dsh-superagent-prototype) has Issues enabled. This is not proof that the eventual deployment account has write access; runtime preflight remains required.

## 5. Write safety and duplicate handling

- **Host-enforced consent:** the authenticated approval endpoint verifies the owner, revision and payload digest, then atomically persists the approval, batch and reserved operation IDs before acknowledging success. Double-clicks, reconnects and concurrent requests reuse the same approval-request identity and return the existing batch; browser review IDs alone are not durable authorization. Subsequent claims enforce the active grant and persisted batch controls before contacting GitHub.
- **Deduplicate before approval:** collapse exact normalized issue payloads while retaining the first occurrence. Search existing issues, including closed ones, and let the user choose reuse versus a genuinely new task; similarity alone must not silently discard work. An opaque operation marker in each approved issue body supports reconciliation after a lost acknowledgement.
- **Fail safely:** persist successful issue URLs immediately and stop new claims on the first failure/uncertain write, even if the GUI is closed. Reconcile using the marker and paginated issue reads, applying the recovery rules above rather than blindly repeating a POST. GitHub creation is not transactionally atomic with the local ledger, and search can lag—do not promise global exactly-once delivery or delete successful issues as rollback.

Publishing must not accidentally trigger existing GitHub intake. Preflight the configured admission rules, including self-authored issues, title triggers, labels and assignment. Block publication if it would start workers without separately approved execution; do not silently disable watchers or add execution-triggering tags. Dependency IDs live in the approved plan and initial issue bodies; later link edits require their own reviewed operation.

Raw audio and transcripts stay out of public issue bodies by default. Publish only reviewed task content; redact secrets and private context before preview. Conversation retention and external transcription/model disclosure must follow explicit settings. Recommendations and model-reported confidence are advisory, not authorization or calibrated safety guarantees.

## 6. Delivery plan and acceptance

1. **Read-only voice planner:** connect existing speech input to the coordinator; persist transcripts/plans; add task-schema validation, dependency checks, duplicate detection and editable previews. Acceptance: a spoken feature produces reviewable tasks with zero GitHub writes or worker starts.
2. **Approved issue publisher:** implement durable approval/batch/operation records, host scheduling and the restricted GitHub adapter; ship owner-authorized Pause/Resume/Revoke endpoints and GUI controls before enabling publication. Acceptance: only selected reviewed tasks publish; closing the GUI after approval does not stop a healthy batch; reconnect and duplicate Approve requests recover the same batch without another create attempt. Test edits and stale callbacks before submission, closing before/after an approval acknowledgement, serialized Pause/Revoke versus claims, partial success, and host crashes on either side of a POST. Ready queued work resumes after restart only when authorized; in-flight uncertainty stops publication until the explicit recovery rules are satisfied.
3. **Status and optional execution:** show persistent batch history, issue links, dependency status and concise voice updates; restore the existing Pause/Resume/Revoke controls on reconnect. Add issue-to-worker handoff only as a separately reviewed capability using existing authorization rules. Acceptance: reconnect restores receipts and controls without reapproval; completed issues remain visible after pause/revocation; issue publication alone cannot launch a worker, even with intake configured, and no Make Progress setting bypasses this publication approval.

Use mocked speech/model/GitHub adapters first. Finish with an explicitly approved test in a sandbox repository and browser network evidence covering no writes before Approve, no duplicate create attempts on ordinary delivery/replay, and safe recovery from an uncertain result.
