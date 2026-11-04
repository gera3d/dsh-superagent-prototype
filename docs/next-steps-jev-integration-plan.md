# Next steps × Jev/Superagent: Opt-in Integration Plan

**Status:** Integration outline approved; shared decision record v1 frozen as the contract basis; resolve-on-send adopted. Implementation planning, implementation, and rollout still require separate explicit approval.

**Decision scope:** This update records the user's contract and policy decisions only. It changes no runtime behavior, profile, activation, configuration, or inbox records. The frozen contract is the `SharedDecisionV1` TypeScript schema approved in this conversation, including its validation invariants and concurrency/idempotency guards. This document summarizes that contract; it does not replace or silently revise it. Any contract amendment requires explicit approval.
**Date:** 2026-11-03

Creating this planning document does not authorize implementation, activation, configuration changes, inbox mutations, builds, installs, restarts, or decision execution. Preserve both projects and their current activation. Earlier removal of Next steps followed conflicting instructions, not reboot cleanup; removal is not an integration strategy.

## 1. Objective and ownership

Keep the preferred compact Next steps end-of-thread appearance, attach Jev/Superagent recommendation details through one shared decisions inbox, and prevent duplicate competing cards without uninstalling either bundle.

| Responsibility | Owner |
| --- | --- |
| Compact end-of-thread card, recommended-choice hierarchy, responsive styling | Next steps renderer |
| Evaluation of genuine alternatives, recommendation, rationale, evaluator provenance | Jev/Superagent configured-model evaluator |
| Canonical decision identity, choices, evaluation state, persistence, resolution/history | Shared decisions inbox |
| Additional inbox presentation and source-session draft handoff | Workstream HUD |
| Evaluation deduplication and per-session renderer ownership | Narrow adapter/coordinator |

The shared inbox is authoritative. Neither the card nor Workstream maintains an independent decision store or independently evaluates the same source.

## 2. Verified source interfaces and limitations

These are source observations, not proof of current activation, effective runtime model selection, or successful live evaluation. No model call is needed to approve this design.

- Next steps already injects `decisionInbox`, uses `findSource`, `publishAdvisor`, and `advisorState`, and exposes `nextStepsAdvisor.suggest`: [host source](../../dsh-next-steps/src/index.ts#L127-L215).
- The compact Next steps renderer currently has a primary auto-submit action. The proposed integrated renderer must replace that action with draft-only staging: [client source](../../dsh-next-steps/src/client/index.tsx#L130-L174).
- Superagent defines choices, recommendation/rationale, model-reported scores, evaluator identity, and pending/resolved/stale records: [decision contract](../src/core/decision.ts#L1-L47).
- The evaluator uses the source session's configured model or the configured default, with a tool-free auxiliary call: [evaluator source](../src/app/decision-evaluator.ts#L7-L33). Vendor-specific Jev endpoints are not implemented; explicit vendor selections are rejected: [evaluation validation](../src/core/decision.ts#L52-L80). “Jev” here names the intended recommendation role, not an assumed external API. Scores are subjective, not calibrated probabilities of success.
- The inbox already supports durable source deduplication, advisor enrichment, stale invalidation, and draft-only resolution: [inbox source](../src/app/decision-inbox.ts#L52-L177).
- Superagent's inline renderer currently evaluates alternatives and inserts a draft before resolving: [inline flow](../src/client/inline-decision.tsx#L45-L92).
- Workstream consumes the same inbox and revalidates a decision before draft insertion and resolution: [handoff source](../../dsh-workstream/src/client/handoff.tsx#L19-L35).

The existing bridge is the starting point. Server-owned evaluation coordination, explicit renderer ownership, structured evaluation revisions, and unified staging semantics are proposed additions—not claims about existing behavior.

## 3. Opt-in integration and duplicate-card prevention

Integration remains disabled unless explicitly enabled in a separately approved future rollout. This document changes no defaults or activation.

### Ownership protocol

1. A coordinator exposes integration capability and effective renderer ownership per session. Ownership is explicit, not inferred from DOM presence, plugin load order, or which bundle loads first.
2. In integrated mode, **Next steps exclusively owns the compact decision card in the conversation dock**. Superagent's inline decision renderer becomes a data consumer/provider participant and does not mount a competing choice card for that session.
3. Both bundles remain installed. Suppression applies only to the overlapping integrated conversation surface, not Superagent's inbox view, Workstream, or either project's unrelated features.
4. Workstream continues to render the same canonical record in its HUD/inbox. This is an intentional second surface, not a duplicate conversation card.
5. Capability registration and teardown must handle late loads and reloads. Ownership changes must be coordinated so two choice renderers are never active simultaneously.
6. If the preferred renderer is unavailable, expose an unavailable/status notice and retain access through the shared inbox. Do not silently activate a legacy auto-send renderer. Any fallback renderer must use the same safe staging contract and acquire ownership explicitly.

Do not hide duplicates with CSS, uninstall a bundle, or alter the active profile as a shortcut. In non-integrated mode, existing behavior remains outside this proposal; enabling or changing that behavior requires separate approval.

### One evaluation, one record

- Deduplicate by source identity and evaluation revision on the server, across tabs and consumers—not merely with browser-local in-flight maps.
- Consumers request or observe the canonical result; they do not each launch their own evaluator.
- An evaluation fingerprint covers source content, stable alternatives, and evaluator/prompt version. Routine remounts and reloads reuse the persisted result.
- Explicit retry/refresh creates a controlled new evaluation revision. Results apply only if the source and record revision still match and the decision remains eligible.
- Use conditional updates so late evaluation results cannot resurrect a resolved/stale record or replace a newer selection.

## 4. Canonical data contract and attached details

Extend the existing inbox contract rather than create a parallel persistence layer.

- **Version and identity:** `schemaVersion: 1`; immutable canonical decision ID with uniqueness on `(sessionId, sourceMessageId)`. Turn/sequence coordinates are provenance, not substitute canonical identity. Legacy records lacking message identity require explicit migration/reconciliation.
- **Classification:** `mutually_exclusive`, `open_followup`, or `sequential_tasks`, as frozen in `SharedDecisionV1`.
- **Choices:** stable IDs, labels, optional descriptions, and complete draft prompts. IDs do not change when recommendation order changes. Preserve explicit alternatives rather than inventing replacement branches.
- **Recommendation:** recommended choice ID and rationale. Optional model-reported scores are clearly labeled; absence is not represented as measured zero confidence.
- **Evaluator metadata:** provider, model, evaluator/prompt version, evaluation revision/fingerprint, timing, and available/error state. Prefer structured fields over parsing a display string.
- **Lifecycle:** pending/resolved/stale state remains separate from evaluation and staging/submission. Adopt `resolutionPolicy: "on_send"`; staging requires a durable selection marker and leaves lifecycle pending. Resolution requires `basis: "submitted"` and confirmed submission of the linked response. The frozen schema retains its other policy/null representations for explicit contract coverage, not as enabled alternatives or silent fallback.
- **Guards and provenance:** retain the frozen schema's source/alternatives/evaluation fingerprints, record and evaluation revisions, conditional updates, evaluation leases, durable operation-id ledger, timestamps, invalidation/resolution metadata, and companion audit history. Complete choice text is `draftPrompt`; draft contents remain in composer persistence, with safe linkage in the decision record.
- **Safety:** draft-only staging; no recommendation or resolution grants execution authority.

The coordinator validates and persists evaluator output onto the canonical record. The Next steps renderer maps that record into its existing recommended-choice hierarchy, shows rationale and evaluator identity directly, and exposes extended provenance/scores through accessible details. Workstream reads the same fields and state. Do not manufacture provider identity or calibrated confidence.

Open-ended follow-ups may offer response/clarification drafting without scored ranking. Sequential tasks retain their ordering and must not be evaluated as mutually exclusive alternatives. Whether these unscored items belong in the same inbox is an explicit product decision.

## 5. Lifecycle and safe staging

```text
Completed assistant turn
  -> extract genuine alternatives
  -> evaluate once
  -> upsert canonical inbox record
  -> render Next steps card and shared inbox/Workstream
  -> user stages a choice into the source composer
  -> persist staging linkage and synchronize pending/staged status
  -> user explicitly sends the linked response
  -> confirmed linked submission resolves the decision; never implies execution
```

Operational requirements:

1. Accept completed, non-interrupted source turns; do not extract decisions from streaming commentary, quoted examples, code, or ordinary task lists.
2. Revalidate source identity and state before publishing evaluation results and before staging a choice. Newer turns/messages invalidate obsolete pending decisions.
3. Staging is an explicit user action. It uses safe insertion into the correct session, preserves existing draft text and attachments, persists the draft, and never calls submit/send or executes work.
4. Use the canonical complete choice prompt consistently across surfaces. If insertion is locked or the draft changes concurrently, retain the draft and ask the user to retry rather than replacing text.
5. Synchronize shared selection/status only under the chosen policy. Display selection, evaluation, and synchronization failures separately.
6. Draft storage and inbox persistence are not assumed to be one atomic transaction. If insertion succeeds but synchronization fails, preserve the inserted text and offer idempotent status retry without inserting it twice.
7. Resolve conflicts across tabs/surfaces explicitly; never silently overwrite another recorded choice. A staged draft is not proof of submission or execution.

## 6. Resolution semantics: resolve-on-send adopted

**Adopted policy: resolve-on-send.** Staging preserves the draft and records a staged-selection marker while the decision remains pending. Resolve only after confirmed submission of that linked response, never merely after staging, abandonment, an unrelated later message, or successful execution.

Previously inspected inline and Workstream flows resolve after staging. That is existing behavior, not the approved integration policy. No runtime behavior changes through this documentation update; aligning those flows requires separate implementation approval.

The comparison below is retained to make the tradeoffs explicit. Resolve-on-staging is the non-adopted alternative, not an optional fallback.

| Policy | State transition | Benefits | Costs and required rules |
| --- | --- | --- | --- |
| **Resolve on staging** | After successful draft insertion/persistence, record the choice and resolve the inbox item. | Closest to current inline/Workstream behavior; simple cross-surface synchronization; removes already-handled items from the pending queue. | A resolved item may never be sent. UI must say “choice staged/recorded,” not “executed” or “sent.” Define explicit reopen/reselection behavior for discarded or changed drafts. |
| **Resolve on send** | Staging records a selection marker while status remains pending; confirmed submission of the linked draft resolves the item. | Pending state better reflects an unsent response; discarding a draft need not falsely close the decision. | Requires reliable draft/submission linkage, tracking across reloads and handoffs, and rules for edited drafts. Any later unrelated message must not resolve it. Define what happens after confirmed submission followed by model failure/cancellation. |

For resolve-on-send, resolve means the linked response was successfully submitted—not that requested work completed. Define the exact submission confirmation boundary before coding. Prevent repeated staging while a valid staged selection already exists, and provide explicit change/discard controls.

### Draft preservation and abandonment cases

The resolve-on-send column below specifies the adopted contract requirements, not implemented behavior. The resolve-on-staging column is retained only for comparison. Persist the complete source-session draft, including pre-existing text and attachment references, before acknowledging successful staging. Preserve the user's insertion position and subsequent edits; never replace the draft with a saved choice prompt during recovery. Verify existing draft/attachment persistence guarantees before promising recovery across browser close or reboot. If persistence fails, retain available composer content, show the failure, and do not mark staging successful or resolve the item.

| Case | Resolve on staging | Resolve on send |
| --- | --- | --- |
| User navigates away, switches sessions, closes the tab, or otherwise abandons the composer without sending | The item remains resolved as **choice staged, not sent**; abandonment does not automatically reopen it. Restore the persisted draft on return. Provide an explicit reopen/change-choice action, subject to stale-source checks. | The item remains pending with its staged-selection marker; abandonment does not resolve it. Restore the persisted draft and marker on return without inserting the choice again. The inbox must distinguish “staged, awaiting send” from “not yet selected.” |
| User explicitly discards the draft or removes the staged choice text | Do not automatically reopen or erase history. Offer explicit reopening/reselection, preserving the previous selection as history. Never reconstruct discarded text automatically. | Clear the staged linkage on explicit discard; the decision remains pending if its source is still current. If edits remove or materially change the choice, invalidate or request reconfirmation of the linkage rather than treating a later unrelated send as that choice. Never reconstruct discarded text automatically. |
| Draft or attachment data is unavailable on return | Keep the recorded staged resolution, but report that the draft could not be recovered; do not claim it was sent. Offer explicit recovery/reopening without overwriting any current draft. | Keep the decision pending and flag the staged linkage as unrecoverable/unverified. Require explicit restaging or reconfirmation; never resolve based on the marker alone. |
| A newer message/turn supersedes the source while the user is away | Preserve resolved history and any draft; block reopening against the obsolete source. Explain that the retained draft may no longer apply. | Mark the obsolete decision stale, preserve the draft without sending/deleting it, and invalidate its staged linkage. A later send must not silently resolve that stale record. |
| Submission fails, or succeeds but the assistant subsequently fails/is cancelled | The item remains resolved on the basis of staging; submission outcome is separate and must be labeled honestly. Preserve unsent content on submission failure. | Failed/unconfirmed submission leaves it pending and preserves the draft; reconcile uncertain acknowledgements by submission identity before retrying. Once linked submission is confirmed, it remains resolved even if subsequent assistant work fails/is cancelled—resolution does not mean execution succeeded. |

Abandonment has **no automatic send, execution, timeout resolution, draft deletion, or cross-policy transition**. Navigation is not explicit discard. Discarding or reopening one decision must not erase unrelated draft text or attachments. Selecting another choice requires explicit user intent and safe insertion/replacement of only verified linked content; otherwise preserve the draft and ask for manual editing.

If insertion/persistence succeeds but inbox synchronization fails, keep the draft, expose the unsynchronized state, and retry only the conditional inbox update. If another surface has already selected a conflicting choice, preserve local content and ask the user to reconcile it; do not silently overwrite either selection or draft.

**Tradeoff summary:** resolve-on-staging keeps the queue tidy but can hide abandoned, unsent responses among resolved items. Resolve-on-send keeps those responses visibly outstanding but adds durable draft/submission linkage, reconciliation, and pending-queue complexity. Neither policy may equate an abandoned composer with authorization.

**Decision recorded:** resolve-on-send is adopted, and shared decision record v1 is frozen as the contract basis. Abandoning the composer leaves the decision pending/staged and preserves the persisted draft; returning must not duplicate insertion. Explicit discard clears staging linkage without erasing unrelated text or attachments. Failed/unconfirmed submission preserves the draft and pending state; source invalidation makes the decision stale without deleting the draft. Confirmed linked submission resolves it even if subsequent assistant execution fails. The exact host acknowledgement boundary and recovery guarantees must be verified before any separately approved implementation; they cannot weaken these contract requirements.

## 7. Phased implementation proposal

The sequence below is retained as an outline only; recording the contract decision does not authorize further implementation planning or execution. Both require separate explicit approval.

1. **Contract alignment:** use frozen `SharedDecisionV1` and adopted resolve-on-send semantics without redesigning source identity or classification. Settle remaining evaluator selection/fallback and refresh questions through explicit approval. Verify actual configured evaluator capabilities without assuming a Jev API.
2. **Coordinator and persistence:** reuse the shared inbox; introduce server-side single-flight/revision controls, stable choice mapping, validated evaluation enrichment, and conditional updates.
3. **Presentation adapter:** preserve Next steps styling; attach canonical rationale/evaluator details; implement safe draft-only staging and explicit ownership negotiation with Superagent.
4. **Consumer alignment:** unify Workstream and inline prompt/staging/state handling; preserve resolved history and stale conflict behavior.
5. **Validation:** exercise the acceptance matrix below before proposing rollout.
6. **Separate opt-in rollout approval:** present exact proposed configuration differences and rollback. Re-read current profile state immediately before any approved change; detect concurrent edits and never overwrite them blindly. Rollback must preserve both bundles, inbox history, and drafts.

## 8. Acceptance criteria

- **Dedupe:** one record and one evaluation per source/revision under multiple mounts, tabs, retries, and concurrent consumers.
- **Renderer ownership:** integrated sessions show exactly one compact conversation choice card; both bundles remain installed. Late loads and ownership teardown cannot produce duplicate competing cards or unsafe fallback.
- **Session isolation:** cards, choices, draft handoffs, and status updates cannot cross session boundaries.
- **Synchronization:** Next steps, Superagent inbox, and Workstream agree on choice IDs, recommendation, selection, and lifecycle state.
- **Classification:** quoted alternatives, code, open questions, and sequential tasks do not become falsely scored mutually exclusive decisions.
- **Errors:** evaluator timeout, invalid output, or unavailable model leaves an honest unavailable state and safe manual choices; retries never send or execute.
- **Draft preservation:** existing text, attachments, and concurrent edits survive staging; partial synchronization failure cannot duplicate insertion.
- **Resolution:** test adopted resolve-on-send: staging/abandonment remains pending; returning restores without duplicate insertion; discard clears linkage only; failed/unconfirmed sends retain drafts; only confirmed linked submission resolves. Test edited drafts, reselection, repeated clicks, uncertain acknowledgements, stale sources, and cross-tab conflicts. Never imply execution.
- **History:** resolved items remain read-only and inspectable; stale items cannot be staged or revived by late evaluations.
- **Responsive UI:** preserve compact recommended-choice prominence, readable rationale/evaluator details, keyboard access, and narrow-layout usability.
- **Persistence:** reload/reboot preserves decisions, evaluator provenance, history, and the approved staged/submission linkage without unnecessary reevaluation.
- **Profile safety:** future rollout detects concurrent profile edits and fails safely; no bundle is removed to avoid rendering conflicts.

## 9. Open approval questions

1. Which host acknowledgement establishes confirmed linked submission, and how will uncertain acknowledgements and draft recovery be verified while preserving the frozen resolve-on-send contract?
2. Which effective configured evaluator owns scoring? Is fallback allowed, and how is provenance displayed?
3. Should open-ended follow-ups share the inbox as unscored items?
4. Should refresh only reevaluate fixed alternatives (preferred), or may it regenerate alternatives under a new explicit revision?
5. Is unavailable notice plus shared-inbox access sufficient when the preferred renderer is absent, or is a separately approved safe fallback required?

**Next action:** await explicit approval before further implementation planning, implementation, or project/profile changes. The outline and v1 contract basis are approved and resolve-on-send is adopted; remaining questions do not reopen those decisions. No implementation, activation, or configuration change follows automatically from this document.
