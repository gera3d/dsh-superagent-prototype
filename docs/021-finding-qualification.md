# Finding-triage qualification (issue171)

## Revisions and deployment boundary

Backend baseline: `8ed680f372e8def2902e2727c013cc9b247a5767` on `superagent-core`.
Plugins baseline: `d1b9ae959f705bd6199409339e31a51ae04a8903` on `main`.

All work, builds and tests use isolated checkouts. Installed sources/assets, services, credentials, configured models/routing and authenticated browser sessions were not changed. Root independently reviews and qualifies a release, then uses the actual finding workflow for History verification and the existing autopilot pilot. No real repair, pilot completion, deployment or native production acceptance is claimed by this implementation.

## Runtime evidence versus test doubles

The production composition root constructs `FindingRuntime` with the actual Engine, Store, configured LLM service and real executor quiescence check. The real `DshExecutor`/`Effects` durable launch path and atomic rollback are exercised in isolated regressions. A registered-HTTP Runtime regression covers observation-only intake, strict browser confirmation, one actual native session creation, duplicate/stale handling, canonical worker-session association and explicit current-job evidence/no-repair-needed acceptance.

LLM responses, host session/controller services and native background completion are controlled test inputs; these are wiring/domain regressions, not an assertion that a real model or live production browser completed the acceptance cases. Separate consumer regressions mount the actual Conversation dock with a SQLite no-origin finding, exercise already-mounted session switches, and preserve the unchanged canonical record in Workstream. Generic source-empty advisor retirement is durable before lookup/staging and does not retire genuine source questions or staged submissions.

The observation-only CLI uses real ephemeral loopback HTTP in its transport regression and exposes no action endpoint, actor override or spoofed browser approval envelope. Root's external MCP fixed-route allowlist can add only `GET findings` and `POST findings/observe`; the CLI provides a usable read/observe bootstrap without that companion patch.

## Verification record

The frozen complete-suite comparison is pinned to backend candidate **`4b85c5ae486da2c438857c4e1b7d04bf0b64b085`**, before root's later presentation/ownership/GitHub-seam corrections. Both revisions ran sequentially with identical `vitest run --maxWorkers=1 --reporter=json` flags and unchanged test deadlines. The running comparison was preserved, not restarted or duplicated.

| Frozen full suite | Total | Passed | Failed | Skipped | Raw local report SHA-256 |
| --- | ---: | ---: | ---: | ---: | --- |
| Exact baseline | 2043 | 2031 | 10 | 2 | `24932a7a97ed86b6e93338c5073dc34907369fa7310bc004f34e8bbba6302ec5` |
| Candidate `4b85c5a` | 2108 | 2096 | 10 | 2 | `e82a8da75403e6ff7f4afd79d1728d58fa86e1319a9f4dc3afb1a9ab34db28f6` |

Both commands exit 1 because the **same ten known assertions fail**; the whole suite is not green. Exact file/assertion/normalized-error-hash sets match: **`b997de6dbc24841c8bc4708af1cffe9bb1006e79064af4cae137dced292294a9`**. No baseline assertions were removed or changed status. All 65 added assertions pass: core6, finding-advice1, finding-card18, finding-consumers3, observation-CLI2, finding-runtime12, finding-store22, registered Runtime/HTTP1. [Sanitized machine-readable manifest](finding-qualification.json) accounts for every added identity and all ten known failure identities/hashes; raw machine reports remain local.

Normalization removes stack-frame lines and machine-dependent paths/timing from each failure message, then SHA-256 hashes the normalized error and sorted file/assertion/error records. Earlier nonserial preparation runs exposed missing sibling layout and scheduling flakes; those raw reports were retained locally and were not waived as new known failures. The paired serial run above establishes the exact complete-suite baseline.

### Justified post-freeze checks

Root requested compact presentation, explicit current/superseded ownership and qualification of the existing GitHub-native lifecycle after the full run had frozen. The final tree therefore has scoped follow-up corrections rather than a second claimed complete-suite run:

- Actual configured PR claim/follow and `pollRound` review/CI cases found that unconditional finding-ready retirement bypassed the normal open-PR lifecycle. Ready with open follows now retains the same assignment. New review input/progress invalidates old evidence; protected finding review reconciles first and retires prior live work before retry/defer/accept. Store/core/native tests and actual registered Runtime/HTTP lifecycle tests cover these changes.
- Generic synthetic advice retirement is extended to genuinely owned work; the active owner/progress/next step and read-only superseded relationship are shared across views. Earliest dropped-attempt history, immutable primary source and a unique later explicit continuation handle the actual issue171 ordering and different generated scope strings. Ambiguity refuses inference; mandates/runtime records are unchanged. A real mounted Conversation dock test covers old and active threads.
- The default finding face is compact while bounded effects remain discoverable and blocked evidence/required acknowledgement remain explicit. Paired captures are refreshed. Root's MCP source-only patch and inventory are pinned separately below.

Final bounded integration pass: **227/227** impacted core/store/runtime/consumer/currency/CLI/docs assertions pass; the separate registered Runtime/GitHub filter passes **4/4**, with 96 unrelated Runtime cases deliberately unselected. It includes the three new GitHub lifecycle cases plus the existing observation/confirmation/evidence route case. All **11 post-freeze added assertion identities** pass: currency1, ownership-dock1, compact-card1, finding-runtime3, finding-store2, GitHub Runtime3. The manifest lists every identity and raw report hash. A newly added dock fixture's incomplete metadata caused a strict typecheck failure; its fixture was made complete (no unsafe cast), the single consumer case was rechecked, and the final typecheck, backend build, inbox build and whitespace checks all pass. No later complete-suite run or globally green result is implied.

Earlier plugin verification remains valid for unchanged plugin production sources: Next steps17 tests and Workstream67 tests, with both typechecks/builds passing. Post-freeze plugin changes are evidence/provenance only; changed shared backend cards are covered by the focused integration pass.

### Root-supplied bridge artifact

Root-owned MCP integration record (`docs/integration/README.md`) pins only the reviewed source patch and inventory. Patch SHA-256: `511aa7d2c62c5847f721bf0a1e5e311a6288b594f273e73f515a46ae9cbc5394`; inventory SHA-256: `4d5ea1eb27810c84d7bfd9955148f8956b870598446f9be051e3942e5008669e`. The inventory's122 passing isolated mock checks are root-provided evidence, not a worker rerun or live acceptance claim. Root alone applies the installed bridge after combined review.

## Visual evidence

Both code PRs include clearly labelled Before and After images from the actual Workstream application/shared card rendered in isolation at the same 1440×1200 viewport, dark theme, UTC, finding scenario and revision. Baseline source is the exact plugins revision above. The comparison preserves the original History accessibility-only observation and root's visual correction, without asserting an unconfirmed rendering defect or repair. Supplementary blocked-review evidence shows explicit current-job evidence selection, requirement acknowledgement and the distinct no-repair-needed outcome. Images/provenance/reproducer live in the companion plugins PR; these are fixture captures, not live acceptance.

## Release and rollback

Review both pinned code PR heads together and preserve installed customizations when applying the scoped changes. No auto-merge is enabled. Root owns merge/deployment and any narrow external MCP companion patch. Findings/queue tables are additive; source/asset rollback must preserve their durable observations, confirmations, jobs and audit history. Root must not resolve History as a repair solely because an accessibility tree was empty, and must not duplicate `sandbox-160-browser` when dispatching its remaining verification.
