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

Final full-suite comparison and artifact hashes are recorded below once qualification finishes. Raw machine reports remain local and are not published.

## Visual evidence

Both code PRs include clearly labelled Before and After images from the actual Workstream application/shared card rendered in isolation at the same 1440×1200 viewport, dark theme, UTC, finding scenario and revision. Baseline source is the exact plugins revision above. The comparison preserves the original History accessibility-only observation and root's visual correction, without asserting an unconfirmed rendering defect or repair. Supplementary blocked-review evidence shows explicit current-job evidence selection, requirement acknowledgement and the distinct no-repair-needed outcome. Images/provenance/reproducer live in the companion plugins PR; these are fixture captures, not live acceptance.

## Release and rollback

Review both pinned code PR heads together and preserve installed customizations when applying the scoped changes. No auto-merge is enabled. Root owns merge/deployment and any narrow external MCP companion patch. Findings/queue tables are additive; source/asset rollback must preserve their durable observations, confirmations, jobs and audit history. Root must not resolve History as a repair solely because an accessibility tree was empty, and must not duplicate `sandbox-160-browser` when dispatching its remaining verification.
