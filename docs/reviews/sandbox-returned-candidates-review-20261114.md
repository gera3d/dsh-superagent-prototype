# Returned Sandbox candidates: independent review

Review date: November 14, 2026 Pacific. Source code, isolated tests, canonical handoffs, CI, deployment and native acceptance are separate stages.

## Focused review results

| Lane and exact source head | Independent result | Remaining blocker / original-owner continuation |
|---|---|---|
| Storage [PR123](https://github.com/gera3d/dsh-superagent-prototype/pull/123), `6823d8acc46007d137ce1276396dea13915646b8` | 33 focused tests pass; six previous independent counterexamples pass. Two additional synthetic checks fail: dependency target escapes the allowed root; writable pool with self-authored attestation qualifies without trusted inventory/immutability verification. | [Same issue230 correction](https://github.com/gera3d/superagent-sandbox/issues/230#issuecomment-6887007933). Actual dependency trees remain unqualified. No installation, reuse or storage recovery is claimed. |
| Lifecycle [PR231](https://github.com/gera3d/superagent-sandbox/pull/231), `495a7afbc013f1f03a3daf4fafe3817f3a82ccc2` | 14 pure Node tests pass; prior malformed-collection/recovery/status/context failures are corrected. Four new checks fail: missing lifecycle state, missing header revision, NaN brief revision, duplicate canonical tool IDs with conflicting counts. | [Same issue218 correction](https://github.com/gera3d/superagent-sandbox/issues/218#issuecomment-6887008130). Required validation, uniqueness and accurate provenance/queue claims must be corrected. These are custom domain tests, not installed/native DSH recovery proof. |
| Brief `49449c1aa98a58743de8b0d1e0fa87a7f434b518` | 14 focused tests pass, plus earlier independently checked ID/snapshot/original-ask boundaries. Expanded component counterexample fails: it simultaneously says model unavailable and primary model healthy. | [Same issue216 component/source-handoff continuation](https://github.com/gera3d/superagent-sandbox/issues/216#issuecomment-6887031413). Correct unsupported health wording, then prepare/reuse a draft source PR from the existing branch. Mounting/persistence/shared runtime remain deferred. |
| Fallback [PR121](https://github.com/gera3d/dsh-superagent-prototype/pull/121), `a16daa1a802cdf9d0e5d4a42ff67c8b5f3bb4529` | Four independent actual-SDK ToolRuntime checks pass, including pre-effect persistence refusal and post-effect persistence/recovery uncertainty. This clears the specific durability blocker at the earlier reviewed head. | [Source review receipt](https://github.com/gera3d/dsh-superagent-prototype/pull/121#issuecomment-6887056859). Exact-head CI is green, but canonical ready report is still waiting, with no consumed ready hash. Complete remaining exact-head runtime review/handoff before release or shared-file ownership transfer. |

The storage CI log confirms two architecture-inventory failures, with 2,548 tests passing and three skipped. Its missing module/test rows remain serialized behind the fallback owner's shared inventory. Lifecycle PR231 has no GitHub checks; no green CI is implied. Brief review initially needed a correction to the private test runner's file roots; the final component failure is a rendered assertion, not that runner setup error.

Current lifecycle provenance no longer includes the machine paths identified in the previous review. Prior published history remains exposed; sanitization of the current file is not historical erasure. No history rewrite was performed or requested. Blanket process VERIFIED/QUEUED labels remain under correction rather than accepted evidence.

## Actual pickup and retained gates

All three new continuations were admitted through normal intake into their original assignments. Storage input was read at 01:06:12 UTC, lifecycle at 01:06:13, and brief at 01:06:14 on November 15 (November 14 Pacific). The load snapshot reports **three running, zero queued, maximum three**. Their canonical report projections remain waiting; read/pickup is not completion. Exact private identities and request receipts remain local.

- Sound215's old working/progress projection is not an active fourth request. Its concrete serialized next stage is to review/apply the existing adapter's executor wiring after217 releases the shared runtime, retain the 14 mocked checks, and keep actual sound/native verification separate. No real audio or notification was produced.
- Intake225 retains consumed ready result with assisted-reporting limitation; no duplicate copy task.
- Reporting226 and layout227 retain consumed ready hashes and their existing protected native publication/verification gates; no unsupported release bypass.
- Shared decisions228 retains consumed ready result and the repository-publication denial. No repeated denied lookup, alternate account or credential was attempted.
- Computer-use229 retains consumed ready result for its noninteractive audit only. No new interactive action or permission is inferred.

No live restart, deployment, provider probe, profile/routing/reserve/account/access/spending change, dependency installation, large clone/build, disk measurement, cleanup or migration occurred in this review stage. Original scopes, failed evidence and file ownership remain intact. Private paths, storage measurements, runtime fingerprints, traces and detailed audit artifacts are excluded from this public record.
