# Bounded proposal: installed SDK cancellation fixture

Status: prepared for approval; execution and dependency reuse are NOT authorized by discovery or by observation6890607302.

## Why approval is needed

The standing capacity scope prohibits dependency reuse. Importing the installed SDK tree into an isolated test would reuse dependencies beyond the current worker fixture, even without copying, linking or modifying them. Existing source-review/merge authority does not remove this explicit boundary.

Read-only inspection establishes that the sanctioned host contains the loop driver and its coherent service dependencies. The worker SDK tree differs. The host manifest declares a testkit whose directory is absent; no testkit installation is proposed. Exact source paths, versions and fingerprints are retained privately.

## One proposed approval

Permit the original217 owner to use the already-installed, privately pinned coherent SDK dependency tree read-only in one isolated cancellation fixture, solely to qualify original AC11. No code/package import, execution, copy or link has occurred under this proposal.

Proposed execution limits, if separately approved:

1. One serialized local process, with a30-second hard timeout, using a fixture-local in-memory Context/AgentLoop and synthetic adapter only. No live Harness process/session/store/configuration is attached; no network/provider/account request, listener port, credentials or saved routing are used.
2. Verify compatibility before requesting a synthetic stream. Hold the fake adapter stream pending; use original real Agent.cancel through the actual executor deadline path; assert that the real request signal aborts and no late retry/fallback/tool effect occurs. Stop on any compatibility gap; do not silently substitute mocks, modify installed dependencies or introduce a new API.
3. Preserve exact original ticket/assignment/branch/history, strict KV durability and prior independently passing controls. Record results privately and append a sanitized observation through the supported original evidence path. This does not grant ready/acceptance, merge/deployment, restart, provider/order/reserve/access/spending changes, dependency installation/pooling/reuse outside this one fixture, filesystem cleanup or an operator reconciliation authority path.

AC24 remains separately unavailable. The canonical report remains waiting. Native publication/evidence/acknowledgement gates remain unchanged.

## Next action

Obtain the owner's explicit approval for the single fixture dependency-reuse exception above. Until then, retain this proposal as read-only and do not dispatch its execution.
