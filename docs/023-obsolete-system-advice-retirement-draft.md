# Draft: guarded retirement of seven obsolete system-advice cards

Status: DESIGN ONLY, November 9, 2026. User authorized a reviewable draft; recommendation-quality repair is now the implementation priority. This document does not authorize or perform retirement, implementation, activation or deployment.

## Scope and expected result

Add one bounded administrative transition using existing decision state: `pending -> stale`, with `invalidation` and an explicit reason. Never resolve a choice, stage/send a reply, accept a finding/delivery, publish, delete history or manufacture a close-out event. If the live count remains15 and all seven pass action-time checks, the visible pending count becomes8. The three unbound delivery gates, ordinary conversation and four newly surfaced closure cards remain untouched.

Only reviewed manifest `obsolete-system-advice-seven-v1` is eligible for an initial implementation. Server-owned exact membership, not caller-provided wildcard rules:

| Decision ID | Ticket (session is worker- plus ticket) | Accepted parent |
|---|---|---|
| chat-a71ba8a1a0abcfc469fd1bcb06174d0f | 7c017292cef5dee4d08138181ec47a40 | advisor12779824-b82e-484d-9502-d2150ba58aa1 |
| chat-eb937970f942747759f30c87b8476336 | 9c5b2ece23fdad8dac34df578f472f96 | same advisor |
| chat-73ef3245326f1665e339f404def676f1 | e10f46849fff53974766d4e277bf75a4 | allowancef9335259-b51c-4e97-9750-3923b7e2138b |
| chat-232dc268b70284e055005e01c8f9ee17 | 4a0294860ae0175497227ed31645062e | same allowance |
| chat-b6913f776e0ff17c81b5a644625f22eb | e7d7391862548043bf9967ab1459dfda | reporting51f309ca-d396-4983-a55d-ef4432a8572f |
| chat-6f63c615b6048ded5cd2c534fe9540cf | fd09fd8ae2c9f3619b81a8b353c14215 | publication investigationa1707f3a-a020-4b8b-8374-50887c5e3265 |
| chat-917a1a95b4ca62ade3ff9ab51f5f4511 | 775c713393968c216c6cce864c65727a | cost verification1accfa18-853b-42e5-8a9b-f24375d50d3e |

Investigation/verification acceptance does not authorize publication, cost repairs or another feature. The exact old choices remain historical; retirement is not a quality score or proof that every option was wrong.

## Existing source contracts

- `src/core/decision.ts`: `pending/resolved/stale`, `stage_response`, canonical source coordinates, optional `resolutionRevision`, `invalidation`, immutable choices/option history and native submission proof.
- `DecisionInbox.invalidate` sets stale plus invalidation; `save(previous)` already compares the entire serialized previous row. **All seven live targets currently lack resolutionRevision/resolutionPolicy.** Do not invent revision0 as a sufficient CAS fence or migrate them merely to retire them: preview the explicit absent revision and a full-row digest, and compare the actual stored row transactionally.
- `Finding.resolution` carries outcome, evidence reference, exact requirements, acceptance timestamp/actor/job. Parent revisions alone are insufficient: some observations update audit without incrementing revision.
- `reconcileInboxCurrency` currently excludes nonempty-context generic advice. `dismiss` is for unavailable admission decisions; compatibility `put` cannot overwrite these canonical rows. None is a safe retirement substitute. Direct database edits/CLI workarounds remain excluded.

## Proposed additive interface — not present or enabled

Proposed native Decision Desk entry: **Review obsolete system advice (7)**. It opens a preview showing each old question/options, exact accepted parent/evidence, retirement reason, and exclusions. It never opens the worker conversation to generate more advice. Confirmation label: **Move these seven cards to history**; copy states that nothing is sent, executed or accepted.

Proposed routes `POST /decisions/retirement/preview` and `POST /decisions/retirement/confirm` call one new bounded domain operation. These routes do not exist today. Reuse the current loopback management/native `localApproval` boundary; confirm requires actual native approval. Do not extend MCP/headless authority or forge browser headers. Preview is read-only and creates no decision/model request.

Preview accepts only the reviewed manifest ID. Server returns sorted exact IDs, eligible/ineligible reasons, current source identity, nullable resolutionRevision, full-row digests, parent proof digests, counts and an expiring canonical preview digest. It exposes no lease tokens, credentials or arbitrary write fields. A digest is a conflict check, never an authorization token.

Confirm supplies manifest ID, exact preview digest, exact row list and operation/idempotency ID. Server reconstructs the proof from canonical storage; client assertions do not establish eligibility. A changed, expired or incomplete preview returns409 and zero transitions. No auto-retry, widening to all pending rows, or silently dropping conflicted targets. A new explicit preview is required.

## Eligibility rechecked inside the single transaction

1. Exact allowlisted row and source: generated canonical `chat-*`, `stage_response`, `pending`, published ready/scored producer, matching session/message/sequence/turn/draftRevision and advisor provenance. Ordinary user questions, lifecycle/finding/delivery actions, restart/correction children and unknown source ownership fail closed.
2. No invalidation, staging, draft-response binding, selected/resolved choice, submission/candidate proof or in-flight producer generation/lease. Native composer text remains untouched. Do not discard an unsubmitted user draft.
3. Join the actual ticket mandate to the exact parent and recorded current/prior job lineage; verify ticket/assignment are ended and no worker/background/queued continuation is active for the relevant scope.
4. Parent is currently resolved with the expected verified native resolution, exact evidence reference/requirements/actor/time/job and matching proof fingerprint. Source advice predates that acceptance. New failures, reopened work, changed authority/evidence or a later human continuation invalidate the preview, even if the parent revision number did not change.
5. Accepted verification/investigation stays verification/investigation. Explicitly exclude new product choices, user follow-ups and unsupported release authority. The manifest cannot make the three unbound delivery gates eligible.

Use the shared Store transaction and the existing full-row CAS semantics; do not bypass canonical/native-submission SQL guards. All seven updates and a proposed append-only retirement receipt commit together, or none do. Publish UI/change notifications only after commit. A receipt records operation ID, manifest/version, native actor/provenance, time, before/after fingerprints, exact parent proof/evidence and reasons; it serves as the durable per-source retirement tombstone. Existing choices, prompts, scores, hidden options, option sets and submission/history fields are retained unchanged. `resolvedChoice` is not created.

An identical retry after response loss returns the committed receipt without new effects/audit. Reusing an operation ID with a different payload is409. A row retired by a different operation is a conflict unless the server proves an identical already-committed retirement. Staging/sending and retiring racing on the same previous snapshot cannot both win. A later explicit user request is new work, not reversal of historical retirement.

## Prevent recreation without blanket suppression

Before model generation/canonical claim and compatibility capture, consult the receipt for the exact retired session/message/seq/turn/draftRevision. Return the same stale historical row or an explicit no-action result; do not regenerate it under another ID. Reuse current put/canonicalSource non-resurrection guards. The same source cannot bypass a tombstone through a cosmetic new key. A genuinely new human request/source turn or separately approved work remains eligible normally; never suppress all advice for that session or parent.

## Required future acceptance cases — not run in this draft

- Exact seven eligible rows retire once;15 becomes8 only if no other changes. Eight excluded rows preserve choices, history, draft and status.
- Legacy targets with absent revision are protected by exact full-row CAS; changed scores/options/producer lease/source/parent audit invalidate preview.
- Staging, native submission, restart, active work or a new human request racing confirmation causes409 with no partial retirement.
- Parent acceptance/evidence/requirements changes, missing proof or wrong ticket/job lineage refuse retirement; accepted source remains unchanged.
- Repeated view/capture/model callback cannot recreate the seven identical source decisions; a new genuine request still receives useful options.
- Rollback/error between writes leaves all rows and receipt unchanged; lost response replay returns the same receipt.
- Native history visibly retains old choices and reason/parent/evidence; no reply, worker, publication, acceptance, privilege change or new scope occurs.

Owner: Harness would implement a separately authorized slice; Codex independently reviews exact source, qualifies races/native behavior, prepares rollback and follows authorized release gates. Current priority is recommendation quality. No retirement task has been created or executed. See [the separate quality assessment](reviews/advisor-option-quality-2026-11-09.md); reducing inbox count is not evidence of better recommendations.
