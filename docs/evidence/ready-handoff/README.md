# Ready handoff — isolated component evidence

[Before](<before.png>) → [After](<after.png>): real, unchanged [DeliveryCard](<../../../src/client/delivery-card.tsx>) rendered with the same deterministic auto-unbound delivery at `stage: review`, `state: blocked`, and the same still-running native assignment with `report.state: ready`. These are **component fixtures, not live acceptance**; both images say so. No installed app, live browser, service, endpoint, or sandbox172 was accessed.

Before uses the actual `deriveDeliveryWork` from `git show 4972e30cd711c076ac58db43564d064d31c316cb:src/app/delivery-currency.ts`, retained verbatim as [baseline-helper.ts](<baseline-helper.ts>). After uses the actual current [helper](<../../../src/app/delivery-currency.ts>), not a reimplementation. The [fixture](<fixture.tsx>) assigns `delivery.work` directly from each helper's map. Only the helper selection and fixture heading differ; input equality is checked during capture.

Before shows `review · blocked` without the ready report. After shows the component's existing `review · owned / in progress` label, delivery-owner handoff instructions, and the ready report, explicitly requesting no duplicate implementation run. This is ownership of the review handoff, not evidence that review is running or acceptance was granted. Both show “Not accepted. No confirmation currently offered.” and no action buttons. The unchanged component's generic `owned / in progress` wording is intentionally preserved.

## Identity and reproduction

Capture-time backend HEAD: `4972e30cd711c076ac58db43564d064d31c316cb`; the merged base `c3d896b763fb3223a30cde8b76cd6a2de8d15be0` has byte-identical helper/component sources. After is identified by the exact helper hash below; the follow-up PR description pins its integrated commit. Capture verifies DeliveryCard and its controls are byte-identical to the baseline.

- Baseline helper SHA-256: `2ce176fa4981fd0d7b4c80b6a3ccac46764c83e06f11a6d6a9b2187ff5e2d3f7`
- After helper SHA-256: `da36b606da730f3c914352840529aacb86e771b2f5c3085d96a444f182f14a62`
- DeliveryCard SHA-256: `ea5d2a9c9e4687512de0fa9c518657251ffdba87e39033d32ca575866eac6664`

Run from backend: `node docs/evidence/ready-handoff/capture.mjs`. The [capture script](<capture.mjs>) uses existing esbuild/React/Playwright dependencies at `../plugins/docs/evidence/finding-triage/node_modules`, builds only the fixture into memory, and injects it with `page.setContent`/`addScriptTag`. It starts fresh ephemeral unauthenticated Chromium, blocks every network request, and closes the browser. No HTTP server, generated HTML/bundle, new dependencies, full compiler run, test suite, source edits, plugin edits, or commits are involved.

Both captures: **1280×1200**, device scale 1, dark, UTC, en-US; Chromium `158.0.8127.18`. [Provenance](<provenance.json>) records full source/image hashes and exact paired inputs plus actual helper results.

| Image | SHA-256 |
| --- | --- |
| [before.png](<before.png>) | `1346dc520b601de96aeee86465829fc8f19c9b757bcc8915a122a6cf87a30a8e` |
| [after.png](<after.png>) | `dea69fd6de16fd2ebe6d54eb55dfc85f1857ac9b448be4409683be4219a6d856` |

Visual inspection confirmed the paired images and labels. Capture-only assertions confirmed equal inputs, absent/present ownership region before/after, no action buttons, and no browser errors. The capture process reran no regression suites. Separately, the bounded helper/dock regression run passed 3/3 tests; typecheck and backend/inbox builds passed. The earlier serial complete-suite comparison was not restarted.
